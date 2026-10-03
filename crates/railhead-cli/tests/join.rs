//! `rh join` and `rh credential` end to end.
//!
//! Each test runs the built binary against a temporary identity store and a wiremock server that
//! plays the backend. The server checks what a real one would: it verifies every join and login
//! signature against the key the request names, in the `railhead-auth` namespace, and derives the
//! confirmation code from that key and the invite. "Sends nothing" and "signs nothing" are asserted
//! on the server's request log.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};
use ssh_key::{PublicKey, SshSig};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const PREFIX: &str = "/agent/v1/casqueblanc/demo";
const SECRET: &str = "Xb1wU76LGAGoVdSeZlIi2Z01AeN9-MuIrwGfAO2-1ZE";
const INVITE: &str = "inv_abc123";
const AGENT: &str = "agt_atlas01";
/// The token of the first login; every later login gets [`FRESH`].
const TOKEN: &str = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ3RfYXRsYXMwMSJ9.c2Vzc2lvbi10b2tlbg";
const FRESH: &str = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ3RfYXRsYXMwMSJ9.ZnJlc2gtdG9rZW4";
/// How long a session the fake backend issues lasts, as the shared contract sets it.
const SESSION_TTL_MS: u64 = 600_000;
const CHALLENGE: &str = "chl_3q27HkVb0nZ8pXa1";
const EXPIRES: u64 = 1_790_000_060_000;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
        .unwrap_or(0)
}

fn json_response(status: u16, body: &Value) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_raw(body.to_string(), "application/json")
}

fn failure(status: u16, code: &str, message: &str) -> ResponseTemplate {
    json_response(
        status,
        &json!({"ok": false, "error": {"code": code, "message": message,
            "retryable": false, "retryAfterMs": null, "next": null}}),
    )
}

fn ssh_string(bytes: &[u8]) -> Vec<u8> {
    let mut out = u32::try_from(bytes.len())
        .unwrap_or(u32::MAX)
        .to_be_bytes()
        .to_vec();
    out.extend_from_slice(bytes);
    out
}

/// The confirmation code as the backend computes it, independently of the CLI's code.
fn code(public_key: &PublicKey, invite: &str) -> String {
    let blob = public_key.to_bytes().unwrap_or_default();
    let mut input = ssh_string(b"railhead-confirm-v1");
    input.extend(ssh_string(&blob));
    input.extend(ssh_string(invite.as_bytes()));
    let digest = Sha256::digest(&input);
    let mut first = [0_u8; 8];
    for (slot, byte) in first.iter_mut().zip(digest.iter()) {
        *slot = *byte;
    }
    format!("{:06}", u64::from_be_bytes(first) % 1_000_000)
}

fn verifies(public_key: &PublicKey, message: &str, signature: &str) -> bool {
    signature.parse::<SshSig>().is_ok_and(|signature| {
        public_key
            .verify("railhead-auth", message.as_bytes(), &signature)
            .is_ok()
    })
}

/// What the fake backend knows about the one enrollment it holds.
#[derive(Default)]
struct Backend {
    /// Every public key a join named.
    keys: Mutex<Vec<String>>,
    /// Joins answered so far.
    joins: AtomicUsize,
    /// Logins redeemed so far.
    logins: AtomicUsize,
    /// Whether a join was answered confirmed; until then a login is `identity_pending`.
    confirmed: AtomicBool,
    /// The `inbox` and `next` every login answer carries; both `null` when unset.
    notices: Mutex<Option<(Value, Value)>>,
}

impl Backend {
    fn key(&self) -> Option<PublicKey> {
        let keys = self
            .keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        keys.first()
            .and_then(|line| PublicKey::from_openssh(line).ok())
    }

    fn notices(&self) -> (Value, Value) {
        self.notices
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
            .unwrap_or((Value::Null, Value::Null))
    }

    /// Makes every later login report an unacknowledged rework decision and ask for `rh sync`.
    fn report_inbox(&self) {
        *self
            .notices
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some((pending_inbox(), json!("sync")));
    }

    fn keys(&self) -> Vec<String> {
        self.keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// Answers joins: pending for the first `pending` answers, then confirmed. A join whose signature
/// does not verify is refused, as the backend would.
struct Join {
    backend: Arc<Backend>,
    origin: String,
    pending: usize,
    /// Replaces the code the backend returns, to play a backend that registered another key.
    code: Option<String>,
    /// The `pollAfterMs` every answer carries.
    poll_after_ms: u64,
    /// How long every answer after the first takes.
    slow: Option<Duration>,
    /// How long the first answer takes, to play an answer lost on the way.
    lost: Option<Duration>,
}

impl Join {
    fn new(world: &World, pending: usize) -> Self {
        Self {
            backend: Arc::clone(&world.backend),
            origin: world.origin(),
            pending,
            code: None,
            poll_after_ms: 0,
            slow: None,
            lost: None,
        }
    }
}

impl Respond for Join {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let Ok(body) = serde_json::from_slice::<Value>(&request.body) else {
            return failure(400, "invalid_request", "bad body");
        };
        let field = |name: &str| body.get(name).and_then(Value::as_str).unwrap_or_default();
        let line = field("publicKey");
        let Ok(public_key) = PublicKey::from_openssh(line) else {
            return failure(400, "invalid_request", "bad key");
        };
        let message = format!(
            "railhead-join-v1\norigin={}\nrepo=casqueblanc/demo\ninvite={}\nkey={line}\n",
            self.origin,
            field("inviteId")
        );
        if field("inviteSecret") != SECRET || !verifies(&public_key, &message, field("signature")) {
            return failure(403, "join_refused", "This invite cannot be used.");
        }
        self.backend
            .keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(line.to_owned());
        let answered = self.backend.joins.fetch_add(1, Ordering::SeqCst);
        let state = if answered < self.pending {
            "pending"
        } else {
            self.backend.confirmed.store(true, Ordering::SeqCst);
            "confirmed"
        };
        let code = self
            .code
            .clone()
            .unwrap_or_else(|| code(&public_key, field("inviteId")));
        let next = if state == "pending" {
            json!("join")
        } else {
            Value::Null
        };
        let answer = json_response(
            200,
            &json!({"ok": true, "data": {"agent": {"agentId": AGENT, "name": "atlas",
                "ownerId": "usr_lemarier", "state": state}, "code": code,
                "pollAfterMs": self.poll_after_ms}, "inbox": null, "next": next}),
        );
        match (self.lost, self.slow) {
            (Some(delay), _) if answered == 0 => answer.set_delay(delay),
            (_, Some(delay)) if answered > 0 => answer.set_delay(delay),
            _ => answer,
        }
    }
}

/// Redeems a challenge only with a signature by the enrolled key over the exact login message.
struct Session {
    backend: Arc<Backend>,
    origin: String,
}

impl Respond for Session {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or_default();
        let signature = body
            .get("signature")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let message = login_message(&self.origin);
        match self.backend.key() {
            Some(key) if !verifies(&key, &message, signature) => {
                failure(401, "challenge_invalid", "The challenge is invalid.")
            }
            Some(_) if !self.backend.confirmed.load(Ordering::SeqCst) => failure(
                403,
                "identity_pending",
                "The owner has not confirmed this agent.",
            ),
            Some(_) => {
                let token = if self.backend.logins.fetch_add(1, Ordering::SeqCst) == 0 {
                    TOKEN
                } else {
                    FRESH
                };
                let (inbox, next) = self.backend.notices();
                json_response(
                    200,
                    &json!({"ok": true, "data": {"token": token,
                        "expiresAt": now_ms() + SESSION_TTL_MS,
                        "agent": {"agentId": AGENT, "name": "atlas", "ownerId": "usr_lemarier",
                        "state": "confirmed"}, "repoId": "rep_demo0001"},
                        "inbox": inbox, "next": next}),
                )
            }
            None => failure(401, "challenge_invalid", "The challenge is invalid."),
        }
    }
}

/// An inbox digest with an unacknowledged rework decision, two items pending in all.
fn pending_inbox() -> Value {
    json!({"items": [{"item": 17, "claimId": "clm_42abcd", "queuedAt": 1_789_999_996_000_u64,
        "entry": {"kind": "rework", "decision": {"decisionId": "dec_upload1", "version": 2}},
        "decision": {"decisionId": "dec_upload1", "version": 2, "supersedes": 1,
            "questionId": "qst_upload1",
            "question": "Should uploads above 10 MB be rejected or chunked?",
            "option": {"key": "chunk", "label": "Upload them in chunks"},
            "previous": {"key": "reject", "label": "Reject them"},
            "scope": ["src/upload.ts"], "decidedBy": "usr_lemarier",
            "decidedAt": 1_789_999_995_000_u64}}],
        "pending": 2})
}

fn login_message(origin: &str) -> String {
    format!(
        "railhead-login-v1\norigin={origin}\nrepo=casqueblanc/demo\nagent={AGENT}\nchallenge={CHALLENGE}\nexpires={EXPIRES}\n"
    )
}

struct World {
    server: MockServer,
    backend: Arc<Backend>,
    home: Arc<tempfile::TempDir>,
    outside: tempfile::TempDir,
}

impl World {
    fn origin(&self) -> String {
        self.server.uri()
    }

    fn invite(&self) -> String {
        format!("{}/join/casqueblanc/demo/{INVITE}#{SECRET}", self.origin())
    }

    fn agent_dir(&self, name: &str) -> PathBuf {
        self.home.path().join("agents").join(name)
    }

    async fn requests(&self, route: &str) -> usize {
        let path = format!("{PREFIX}{route}");
        self.server
            .received_requests()
            .await
            .unwrap_or_default()
            .iter()
            .filter(|request| request.url.path() == path)
            .count()
    }

    /// Mounts the backend: joins pending for `pending` answers, and a login challenge whose
    /// message is `challenge_message` (the correct one when `None`).
    async fn mount(&self, pending: usize, code: Option<&str>, challenge_message: Option<&str>) {
        let mut join = Join::new(self, pending);
        join.code = code.map(str::to_owned);
        self.mount_join(join).await;
        self.mount_login(challenge_message).await;
    }

    async fn mount_join(&self, join: Join) {
        Mock::given(method("POST"))
            .and(path(format!("{PREFIX}/join")))
            .respond_with(join)
            .mount(&self.server)
            .await;
    }

    async fn mount_login(&self, challenge_message: Option<&str>) {
        let message =
            challenge_message.map_or_else(|| login_message(&self.origin()), str::to_owned);
        Mock::given(method("POST"))
            .and(path(format!("{PREFIX}/session/challenge")))
            .respond_with(json_response(
                200,
                &json!({"ok": true, "data": {"challengeId": CHALLENGE, "expiresAt": EXPIRES,
                    "message": message}, "inbox": null, "next": null}),
            ))
            .mount(&self.server)
            .await;
        Mock::given(method("POST"))
            .and(path(format!("{PREFIX}/session")))
            .respond_with(Session {
                backend: Arc::clone(&self.backend),
                origin: self.origin(),
            })
            .mount(&self.server)
            .await;
    }
}

async fn world() -> anyhow::Result<World> {
    Ok(World {
        server: MockServer::start().await,
        backend: Arc::new(Backend::default()),
        home: Arc::new(tempfile::tempdir()?),
        outside: tempfile::tempdir()?,
    })
}

/// Another backend on its own origin, sharing `world`'s identity store.
async fn elsewhere(world: &World) -> anyhow::Result<World> {
    Ok(World {
        server: MockServer::start().await,
        backend: Arc::new(Backend::default()),
        home: Arc::clone(&world.home),
        outside: tempfile::tempdir()?,
    })
}

/// The session record stored under `name`.
fn stored(world: &World, name: &str) -> anyhow::Result<Value> {
    let text = fs::read_to_string(world.agent_dir(name).join("session"))?;
    Ok(serde_json::from_str(&text)?)
}

/// Replaces the session record stored under `name`, as the store writes it.
fn store_session(world: &World, name: &str, record: &Value) -> anyhow::Result<()> {
    let dir = world.agent_dir(name);
    let staged = dir.join(".tmp-test");
    fs::write(&staged, record.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&staged, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;
    fs::rename(&staged, dir.join("session"))?;
    Ok(())
}

struct Run {
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

impl Run {
    fn json(&self) -> anyhow::Result<Value> {
        Ok(serde_json::from_str(&self.stdout)?)
    }
}

fn command(world: &World, dir: &Path, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rh"));
    command
        .args(args)
        .current_dir(dir)
        .env("RAILHEAD_HOME", world.home.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env_remove("RAILHEAD_AGENT")
        .env_remove("RAILHEAD_INVITE");
    command
}

fn finish(world: &World, output: &Output) -> anyhow::Result<Run> {
    let run = Run {
        code: output.status.code(),
        stdout: String::from_utf8(output.stdout.clone())?,
        stderr: String::from_utf8(output.stderr.clone())?,
    };
    let key = fs::read_to_string(world.agent_dir("inv-abc123").join("key")).unwrap_or_default();
    let key_body = key.lines().nth(1).unwrap_or("no key yet");
    for stream in [&run.stdout, &run.stderr] {
        assert!(!stream.contains(SECRET), "invite secret leaked: {stream}");
        assert!(!stream.contains(key_body), "private key leaked: {stream}");
    }
    Ok(run)
}

fn rh(world: &World, args: &[&str]) -> anyhow::Result<Run> {
    let output = command(world, world.outside.path(), args)
        .stdin(Stdio::null())
        .output()?;
    let run = finish(world, &output)?;
    for stream in [&run.stdout, &run.stderr] {
        assert!(
            !stream.contains(TOKEN) && !stream.contains(FRESH),
            "session leaked: {stream}"
        );
    }
    Ok(run)
}

fn join(world: &World, extra: &[&str]) -> anyhow::Result<Run> {
    let invite = world.invite();
    let mut args = vec!["--json", "join", invite.as_str()];
    args.extend_from_slice(extra);
    rh(world, &args)
}

#[cfg(unix)]
fn mode(path: &Path) -> anyhow::Result<u32> {
    use std::os::unix::fs::PermissionsExt as _;
    Ok(fs::metadata(path)?.permissions().mode() & 0o777)
}

#[tokio::test]
async fn a_join_waits_for_confirmation_then_logs_in() -> anyhow::Result<()> {
    let world = world().await?;
    world.mount(2, None, None).await;
    let run = join(&world, &["--wait", "30"])?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);

    let key = PublicKey::from_openssh(
        world
            .backend
            .keys()
            .first()
            .ok_or_else(|| anyhow::anyhow!("no join"))?,
    )?;
    let expected = code(&key, INVITE);
    assert_eq!(
        run.json()?,
        json!({"ok": true, "data": {"name": "inv-abc123", "agentId": AGENT,
            "displayName": "atlas", "origin": world.origin(), "repo": "casqueblanc/demo",
            "state": "confirmed", "code": expected}, "inbox": null, "next": "rh work"})
    );
    // The code is shown once, on stderr, while the owner has not confirmed.
    assert_eq!(run.stderr.matches(&expected).count(), 1, "{}", run.stderr);
    assert!(run.stderr.contains("ask the owner to match it"));
    assert_eq!(world.requests("/join").await, 3);
    assert_eq!(world.requests("/session").await, 1);

    let dir = world.agent_dir("inv-abc123");
    let session = stored(&world, "inv-abc123")?;
    let expires = session
        .get("expiresAt")
        .and_then(Value::as_u64)
        .unwrap_or_default();
    assert!(expires > now_ms(), "{session}");
    assert_eq!(
        session,
        json!({"agentId": AGENT, "origin": world.origin(), "repo": "casqueblanc/demo",
            "token": TOKEN, "expiresAt": expires})
    );
    let record: Value = serde_json::from_str(&fs::read_to_string(dir.join("identity.json"))?)?;
    assert_eq!(
        record,
        json!({"name": "inv-abc123", "agentId": AGENT, "origin": world.origin(),
            "repo": "casqueblanc/demo"})
    );
    #[cfg(unix)]
    for file in ["key", "session", "identity.json"] {
        assert_eq!(mode(&dir.join(file))?, 0o600, "{file}");
    }
    Ok(())
}

#[tokio::test]
async fn joining_twice_resumes_with_the_same_key() -> anyhow::Result<()> {
    let world = world().await?;
    world.mount(0, None, None).await;
    let first = join(&world, &["--name", "atlas"])?;
    assert_eq!(first.code, Some(0), "{}", first.stderr);
    let key_path = world.agent_dir("atlas").join("key");
    let key = fs::read(&key_path)?;

    let second = join(&world, &["--name", "atlas"])?;
    assert_eq!(second.code, Some(0), "{}", second.stderr);
    assert_eq!(fs::read(&key_path)?, key, "the key was replaced");
    let keys = world.backend.keys();
    assert_eq!(keys.len(), 2);
    assert_eq!(
        keys.first(),
        keys.last(),
        "the second join sent another key"
    );

    // The invite may also come from the environment, which keeps its secret off argv.
    let from_env = command(
        &world,
        world.outside.path(),
        &["--json", "join", "--name", "atlas"],
    )
    .env("RAILHEAD_INVITE", world.invite())
    .stdin(Stdio::null())
    .output()?;
    let run = finish(&world, &from_env)?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(fs::read(&key_path)?, key);
    Ok(())
}

#[tokio::test]
async fn a_resumed_join_shows_the_inbox_its_login_reported() -> anyhow::Result<()> {
    let world = world().await?;
    world.mount(0, None, None).await;
    let first = join(&world, &["--name", "atlas"])?;
    assert_eq!(first.code, Some(0), "{}", first.stderr);
    world.backend.report_inbox();

    let resumed = join(&world, &["--name", "atlas"])?;
    assert_eq!(resumed.code, Some(0), "{}", resumed.stderr);
    let envelope = resumed.json()?;
    assert_eq!(envelope.get("inbox"), Some(&pending_inbox()));
    assert_eq!(envelope.get("next"), Some(&json!("rh sync")));
    assert_eq!(envelope.pointer("/data/agentId"), Some(&json!(AGENT)));

    let invite = world.invite();
    let text = rh(&world, &["join", invite.as_str(), "--name", "atlas"])?;
    assert_eq!(text.code, Some(0), "{}", text.stderr);
    let tail: Vec<&str> = text.stdout.lines().skip(2).collect();
    assert_eq!(
        tail,
        [
            "inbox: 2 unacknowledged; read them with rh sync",
            "next: rh sync"
        ],
        "{}",
        text.stdout
    );
    assert_eq!(world.requests("/session").await, 3);
    Ok(())
}

#[tokio::test]
async fn a_pending_identity_cannot_work() -> anyhow::Result<()> {
    let world = world().await?;
    world.mount(usize::MAX, None, None).await;
    let run = join(&world, &["--wait", "0"])?;
    assert_eq!(run.code, Some(1));
    let envelope = run.json()?;
    assert_eq!(envelope.pointer("/error/code"), Some(&json!("timeout")));
    assert_eq!(envelope.pointer("/error/retryable"), Some(&json!(true)));
    assert_eq!(envelope.pointer("/error/next"), Some(&json!("rh join")));
    let dir = world.agent_dir("inv-abc123");
    assert!(dir.join("identity.json").exists() && dir.join("key").exists());
    assert!(
        !dir.join("session").exists(),
        "a pending agent got a session"
    );
    assert_eq!(world.requests("/session/challenge").await, 0);

    // Every command that acts as the agent stops at the login the backend refuses, before its own
    // request.
    for args in [&["--json", "status"][..], &["--json", "work"]] {
        let output = command(&world, world.outside.path(), args)
            .env("RAILHEAD_AGENT", "inv-abc123")
            .stdin(Stdio::null())
            .output()?;
        let run = finish(&world, &output)?;
        assert_eq!(
            run.json()?.pointer("/error/code"),
            Some(&json!("no_session")),
            "{args:?}"
        );
    }
    assert_eq!(
        world.requests("/status").await + world.requests("/work").await,
        0
    );

    // A bounded wait gives up while the owner still has not confirmed.
    let waited = join(&world, &["--wait", "1"])?;
    assert_eq!(
        waited.json()?.pointer("/error/code"),
        Some(&json!("timeout"))
    );
    assert!(world.requests("/join").await >= 3);
    Ok(())
}

#[tokio::test]
async fn no_ask_starts_after_the_wait() -> anyhow::Result<()> {
    let world = world().await?;
    let mut join = Join::new(&world, usize::MAX);
    join.poll_after_ms = 10_000;
    world.mount_join(join).await;
    world.mount_login(None).await;
    let started = Instant::now();
    let run = self::join(&world, &["--wait", "1"])?;
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    assert_eq!(run.json()?.pointer("/error/code"), Some(&json!("timeout")));
    // The pause the backend asked for outlasts the wait, so only the first ask was sent.
    assert_eq!(world.requests("/join").await, 1);
    Ok(())
}

#[tokio::test]
async fn an_answer_after_the_wait_is_not_waited_for() -> anyhow::Result<()> {
    let world = world().await?;
    let mut join = Join::new(&world, 1);
    // The second ask is confirmed, but its answer takes longer than the wait has left.
    join.slow = Some(Duration::from_secs(5));
    world.mount_join(join).await;
    world.mount_login(None).await;
    let started = Instant::now();
    let run = self::join(&world, &["--wait", "2"])?;
    assert!(
        started.elapsed() < Duration::from_millis(4500),
        "{:?}",
        started.elapsed()
    );
    let envelope = run.json()?;
    assert_eq!(envelope.pointer("/error/code"), Some(&json!("timeout")));
    assert_eq!(envelope.pointer("/error/next"), Some(&json!("rh join")));
    assert_eq!(world.requests("/session/challenge").await, 0);
    // The enrollment is kept for the next run.
    let dir = world.agent_dir("inv-abc123");
    assert!(dir.join("identity.json").exists() && dir.join("key").exists());
    assert!(!dir.join("session").exists());
    Ok(())
}

/// Waits, at most five seconds, for a join run elsewhere to have stored its key.
fn wait_for_key(world: &World, name: &str) -> anyhow::Result<()> {
    let started = Instant::now();
    while !world.agent_dir(name).join("key").exists() {
        anyhow::ensure!(
            started.elapsed() < Duration::from_secs(5),
            "no key was made"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    Ok(())
}

fn spawn_join(world: &World, name: &str) -> anyhow::Result<std::process::Child> {
    let invite = world.invite();
    Ok(command(
        world,
        world.outside.path(),
        &["--json", "join", &invite, "--name", name, "--wait", "30"],
    )
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()?)
}

#[tokio::test]
async fn a_second_join_for_a_name_stops_while_the_first_enrolls() -> anyhow::Result<()> {
    let world = world().await?;
    world.mount(4, None, None).await;
    let other = elsewhere(&world).await?;
    other.mount(0, None, None).await;

    let first = spawn_join(&world, "atlas")?;
    wait_for_key(&world, "atlas")?;
    let second = join(&other, &["--name", "atlas"])?;
    let envelope = second.json()?;
    assert_eq!(envelope.pointer("/error/code"), Some(&json!("store")));
    assert_eq!(envelope.pointer("/error/retryable"), Some(&json!(true)));
    assert_eq!(other.requests("/join").await, 0);

    let first = finish(&world, &first.wait_with_output()?)?;
    assert_eq!(first.code, Some(0), "{}", first.stderr);
    // The name holds the first origin's identity and that origin's session, nothing of the other.
    let record: Value = serde_json::from_str(&fs::read_to_string(
        world.agent_dir("atlas").join("identity.json"),
    )?)?;
    assert_eq!(record.get("origin"), Some(&json!(world.origin())));
    let session = stored(&world, "atlas")?;
    assert_eq!(session.get("origin"), Some(&json!(world.origin())));
    assert_eq!(session.get("token"), Some(&json!(TOKEN)));

    // Once it is free, the name still belongs to the first origin.
    let again = join(&other, &["--name", "atlas"])?;
    assert_eq!(
        again.json()?.pointer("/error/code"),
        Some(&json!("invalid_input"))
    );
    assert_eq!(
        other
            .server
            .received_requests()
            .await
            .map_or(0, |r| r.len()),
        0
    );
    Ok(())
}

#[tokio::test]
async fn a_refused_join_cannot_remove_a_key_another_join_enrolled() -> anyhow::Result<()> {
    let world = world().await?;
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/join")))
        .respond_with(
            failure(403, "join_refused", "This invite cannot be used.")
                .set_delay(Duration::from_millis(1500)),
        )
        .mount(&world.server)
        .await;
    let other = elsewhere(&world).await?;
    other.mount(0, None, None).await;

    // The refused join made the key and holds the name while its answer is on the way.
    let refused = spawn_join(&world, "atlas")?;
    wait_for_key(&world, "atlas")?;
    let racing = join(&other, &["--name", "atlas"])?;
    assert_eq!(racing.json()?.pointer("/error/code"), Some(&json!("store")));
    assert_eq!(other.requests("/join").await, 0);
    let refused = finish(&world, &refused.wait_with_output()?)?;
    assert_eq!(
        refused.json()?.pointer("/error/code"),
        Some(&json!("join_refused"))
    );
    assert!(!world.agent_dir("atlas").join("key").exists());

    // The next join makes its own key, and that key stays: a resumed join sends it again.
    let enrolled = join(&other, &["--name", "atlas"])?;
    assert_eq!(enrolled.code, Some(0), "{}", enrolled.stderr);
    assert!(world.agent_dir("atlas").join("key").exists());
    let resumed = join(&other, &["--name", "atlas"])?;
    assert_eq!(resumed.code, Some(0), "{}", resumed.stderr);
    let keys = other.backend.keys();
    assert_eq!(keys.len(), 2);
    assert_eq!(keys.first(), keys.last());
    Ok(())
}

#[tokio::test]
async fn a_hostile_or_malformed_invite_sends_and_stores_nothing() -> anyhow::Result<()> {
    let world = world().await?;
    world.mount(0, None, None).await;
    let address = world.server.address().to_string();
    let port = world.server.address().port();
    for invite in [
        format!("http://railhead.dev:{port}/join/casqueblanc/demo/{INVITE}#{SECRET}"),
        format!("http://{address}/join/casqueblanc/demo/{INVITE}"),
        format!("http://{address}/join/casqueblanc/{INVITE}#{SECRET}"),
        format!("http://{address}/join/casqueblanc/demo/{INVITE}?next=x#{SECRET}"),
        format!("http://{address}/join/casqueblanc/demo/clm_42abcd#{SECRET}"),
        format!("http://user:pw@{address}/join/casqueblanc/demo/{INVITE}#{SECRET}"),
    ] {
        let run = rh(&world, &["--json", "join", &invite])?;
        assert_eq!(run.code, Some(1), "{invite}");
        assert_eq!(
            run.json()?.pointer("/error/code"),
            Some(&json!("invalid_input")),
            "{invite}"
        );
    }
    let bad_name = rh(
        &world,
        &["--json", "join", &world.invite(), "--name", "../x"],
    )?;
    assert_eq!(bad_name.code, Some(2));
    let missing = rh(&world, &["--json", "join"])?;
    assert_eq!(
        missing.json()?.pointer("/error/message"),
        Some(&json!("name the invite URL, or set RAILHEAD_INVITE"))
    );
    assert!(!world.home.path().join("agents").exists());
    assert_eq!(
        world
            .server
            .received_requests()
            .await
            .map_or(0, |r| r.len()),
        0
    );
    Ok(())
}

#[tokio::test]
async fn a_refused_join_keeps_nothing() -> anyhow::Result<()> {
    let world = world().await?;
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/join")))
        .respond_with(failure(403, "join_refused", "This invite cannot be used."))
        .mount(&world.server)
        .await;
    let run = join(&world, &[])?;
    assert_eq!(run.code, Some(1));
    assert_eq!(
        run.json()?.pointer("/error/code"),
        Some(&json!("join_refused"))
    );
    let dir = world.agent_dir("inv-abc123");
    assert!(!dir.join("key").exists() && !dir.join("identity.json").exists());
    assert!(!dir.join("enrollment.json").exists());
    Ok(())
}

#[tokio::test]
async fn a_failed_rejoin_leaves_a_joined_agent_able_to_log_in() -> anyhow::Result<()> {
    let world = joined().await?;
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/join")))
        .respond_with(failure(500, "internal", "The backend failed."))
        .with_priority(1)
        .mount(&world.server)
        .await;
    let rejoin = join(&world, &[])?;
    assert_eq!(
        rejoin.json()?.pointer("/error/code"),
        Some(&json!("internal"))
    );
    // The name already held its identity, so the join stored no enrollment to finish.
    let dir = world.agent_dir("inv-abc123");
    assert!(!dir.join("enrollment.json").exists());
    assert!(dir.join("identity.json").exists() && dir.join("key").exists());

    expire(&world, now_ms() - 1)?;
    let authorized = Arc::new(Mutex::new(Vec::new()));
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/status")))
        .respond_with(Status {
            authorized: Arc::clone(&authorized),
        })
        .mount(&world.server)
        .await;
    let run = status(&world)?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(
        stored(&world, "inv-abc123")?.get("token"),
        Some(&json!(FRESH))
    );
    Ok(())
}

/// Asserts that a join under `atlas` at `world` stops on the name before sending anything.
async fn refuses_atlas(world: &World) -> anyhow::Result<()> {
    let run = join(world, &["--name", "atlas"])?;
    assert_eq!(
        run.json()?.pointer("/error/code"),
        Some(&json!("invalid_input"))
    );
    assert_eq!(world.requests("/join").await, 0);
    Ok(())
}

#[tokio::test]
async fn a_lost_first_answer_leaves_an_enrollment_only_its_invite_resumes() -> anyhow::Result<()> {
    let world = world().await?;
    let mut first = Join::new(&world, 0);
    first.lost = Some(Duration::from_secs(30));
    world.mount_join(first).await;
    world.mount_login(None).await;
    let other = elsewhere(&world).await?;
    other.mount(0, None, None).await;

    // The backend registers the key, and the join dies before its answer arrives.
    let mut lost = spawn_join(&world, "atlas")?;
    let started = Instant::now();
    while world.backend.keys().is_empty() {
        anyhow::ensure!(
            started.elapsed() < Duration::from_secs(5),
            "no join arrived"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    lost.kill()?;
    lost.wait()?;
    let dir = world.agent_dir("atlas");
    assert!(!dir.join("identity.json").exists());
    let registered = world.backend.keys();
    let path = dir.join("enrollment.json");
    let scope = json!({"origin": world.origin(), "repo": "casqueblanc/demo", "inviteId": INVITE,
        "publicKey": registered.first()});
    let record: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
    assert_eq!(record, scope);
    #[cfg(unix)]
    assert_eq!(mode(&path)?, 0o600);

    // Another invite under the name stops before sending anything.
    let elsewhere = join(&other, &["--name", "atlas"])?;
    let envelope = elsewhere.json()?;
    assert_eq!(
        envelope.pointer("/error/code"),
        Some(&json!("invalid_input"))
    );
    let message = envelope
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(message.contains(INVITE), "{message}");
    assert_eq!(
        other
            .server
            .received_requests()
            .await
            .map_or(0, |r| r.len()),
        0
    );

    // A refused retry of the same invite proves only that it registered nothing itself: the
    // earlier enrollment keeps its scope and key, and the name stays closed to other invites.
    let key = dir.join("key");
    let saved = fs::read(&key)?;
    let wrong = format!(
        "{}/join/casqueblanc/demo/{INVITE}#{}",
        world.origin(),
        "A".repeat(43)
    );
    let refused = rh(
        &world,
        &["--json", "join", wrong.as_str(), "--name", "atlas"],
    )?;
    assert_eq!(
        refused.json()?.pointer("/error/code"),
        Some(&json!("join_refused"))
    );
    assert_eq!(world.requests("/join").await, 2);
    let record: Value = serde_json::from_str(&fs::read_to_string(&path)?)?;
    assert_eq!(record, scope, "a refused retry dropped the enrollment");
    assert_eq!(fs::read(&key)?, saved, "a refused retry dropped the key");
    refuses_atlas(&other).await?;

    // Without the key it registered, the enrollment cannot resume, and no other key is sent.
    fs::remove_file(&key)?;
    let keyless = join(&world, &["--name", "atlas"])?;
    assert_eq!(
        keyless.json()?.pointer("/error/code"),
        Some(&json!("store"))
    );
    assert!(!key.exists(), "a key made for the refused resume was kept");
    assert_eq!(world.requests("/join").await, 2);
    fs::write(&key, &saved)?;
    #[cfg(unix)]
    fs::set_permissions(&key, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;

    // The same invite resumes the enrollment with the key it registered, and finishes it.
    let resumed = join(&world, &["--name", "atlas"])?;
    assert_eq!(resumed.code, Some(0), "{}", resumed.stderr);
    let keys = world.backend.keys();
    assert_eq!(keys.len(), 2);
    assert_eq!(
        keys.first(),
        keys.last(),
        "the resumed join sent another key"
    );
    assert!(dir.join("identity.json").exists());
    assert!(!path.exists(), "the finished enrollment was kept");
    assert_eq!(stored(&world, "atlas")?.get("token"), Some(&json!(TOKEN)));

    // Once it is finished, the name still belongs to the first origin.
    refuses_atlas(&other).await?;
    Ok(())
}

#[tokio::test]
async fn a_backend_that_answers_for_another_key_is_not_trusted() -> anyhow::Result<()> {
    let world = world().await?;
    world.mount(0, Some("000000"), None).await;
    let run = join(&world, &[])?;
    assert_eq!(run.code, Some(1));
    let envelope = run.json()?;
    assert_eq!(
        envelope.pointer("/error/code"),
        Some(&json!("malformed_response"))
    );
    assert!(!world.agent_dir("inv-abc123").join("identity.json").exists());
    assert_eq!(world.requests("/session/challenge").await, 0);
    Ok(())
}

#[tokio::test]
async fn a_challenge_rh_did_not_build_is_never_signed() -> anyhow::Result<()> {
    let world = world().await?;
    let forged = login_message("https://evil.example");
    world.mount(0, None, Some(&forged)).await;
    let run = join(&world, &[])?;
    assert_eq!(run.code, Some(1));
    assert_eq!(
        run.json()?.pointer("/error/code"),
        Some(&json!("malformed_response"))
    );
    assert_eq!(world.requests("/session").await, 0);
    assert!(!world.agent_dir("inv-abc123").join("session").exists());
    Ok(())
}

#[tokio::test]
async fn a_name_that_joined_elsewhere_is_not_reused() -> anyhow::Result<()> {
    let world = world().await?;
    world.mount(0, None, None).await;
    let dir = world.agent_dir("atlas");
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    for private in [world.home.path().join("agents"), dir.clone()] {
        fs::set_permissions(
            &private,
            std::os::unix::fs::PermissionsExt::from_mode(0o700),
        )?;
    }
    let record = json!({"name": "atlas", "agentId": "agt_other01",
        "origin": "https://railhead.dev", "repo": "casqueblanc/demo"});
    let path = dir.join("identity.json");
    fs::write(&path, record.to_string())?;
    #[cfg(unix)]
    fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o600))?;

    let run = join(&world, &["--name", "atlas"])?;
    assert_eq!(
        run.json()?.pointer("/error/code"),
        Some(&json!("invalid_input"))
    );
    assert_eq!(fs::read_to_string(&path)?, record.to_string());
    assert!(!dir.join("key").exists());
    assert_eq!(
        world
            .server
            .received_requests()
            .await
            .map_or(0, |r| r.len()),
        0
    );
    Ok(())
}

// =======================================================================================
// The credential helper

fn git(world: &World, dir: &Path, args: &[&str]) -> anyhow::Result<Output> {
    Ok(Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("RAILHEAD_HOME", world.home.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env_remove("RAILHEAD_AGENT")
        .output()?)
}

/// A clone bound to the joined agent, with the helper configured as `rh claim` configures it.
fn clone(world: &World) -> anyhow::Result<tempfile::TempDir> {
    let clone = tempfile::tempdir()?;
    let origin = world.origin();
    let helper = format!("!'{}' credential", env!("CARGO_BIN_EXE_rh"));
    let fork = format!("{origin}/git/casqueblanc/demo/claims/clm_42abcd.git");
    let upstream = format!("{origin}/git/casqueblanc/demo.git");
    let settings: [&[&str]; 6] = [
        &["init", "--quiet"],
        &["config", "railhead.identity", AGENT],
        &["remote", "add", "origin", &fork],
        &["remote", "add", "upstream", &upstream],
        &["config", "credential.helper", &helper],
        &["config", "credential.useHttpPath", "true"],
    ];
    for args in settings {
        let output = git(world, clone.path(), args)?;
        anyhow::ensure!(output.status.success(), "git {args:?} failed");
    }
    Ok(clone)
}

fn credential(world: &World, dir: &Path, operation: &str, request: &str) -> anyhow::Result<Run> {
    use std::io::Write as _;
    let mut child = command(world, dir, &["credential", operation])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut input) = child.stdin.take() {
        input.write_all(request.as_bytes())?;
    }
    let output = child.wait_with_output()?;
    let run = finish(world, &output)?;
    assert!(
        !run.stderr.contains(TOKEN) && !run.stderr.contains(FRESH),
        "session leaked: {}",
        run.stderr
    );
    Ok(run)
}

async fn joined() -> anyhow::Result<World> {
    let world = world().await?;
    world.mount(0, None, None).await;
    let run = join(&world, &[])?;
    anyhow::ensure!(run.code == Some(0), "join failed: {}", run.stderr);
    Ok(world)
}

fn request(world: &World, path: &str) -> String {
    format!(
        "protocol=http\nhost={}\npath={path}\n\n",
        world.server.address()
    )
}

#[tokio::test]
async fn the_helper_gives_git_the_session_for_the_clone_remotes_only() -> anyhow::Result<()> {
    let world = joined().await?;
    let clone = clone(&world)?;
    let answer = format!("username={AGENT}\npassword={TOKEN}\n");
    for remote in [
        "git/casqueblanc/demo/claims/clm_42abcd.git",
        "git/casqueblanc/demo.git",
    ] {
        let run = credential(&world, clone.path(), "get", &request(&world, remote))?;
        assert_eq!((run.code, run.stdout.as_str()), (Some(0), answer.as_str()));
        assert_eq!(run.stderr, "");
    }

    let address = world.server.address();
    for hostile in [
        format!("protocol=https\nhost={address}\npath=git/casqueblanc/demo.git\n"),
        "protocol=http\nhost=evil.example\npath=git/casqueblanc/demo.git\n".to_owned(),
        format!("protocol=http\nhost={address}\npath=git/casqueblanc/other.git\n"),
        format!("protocol=http\nhost={address}\npath=git/casqueblanc/demo/claims/clm_99zzzz.git\n"),
        format!("protocol=http\nhost={address}\n"),
        format!(
            "protocol=http\nhost={address}\npath=git/casqueblanc/demo.git\nusername=agt_boreas01\n"
        ),
    ] {
        let run = credential(&world, clone.path(), "get", &hostile)?;
        assert_eq!((run.code, run.stdout.as_str()), (Some(1), ""), "{hostile}");
        assert!(
            run.stderr.starts_with("rh: Git asked for"),
            "{}",
            run.stderr
        );
    }

    // Outside a clone there is no remote to answer for, even for a named agent.
    let output = command(&world, world.outside.path(), &["credential", "get"])
        .env("RAILHEAD_AGENT", "inv-abc123")
        .stdin(Stdio::null())
        .output()?;
    let outside = finish(&world, &output)?;
    assert_eq!((outside.code, outside.stdout.as_str()), (Some(1), ""));
    assert!(outside.stderr.contains("only inside a claim's clone"));
    Ok(())
}

#[tokio::test]
async fn the_helper_logs_in_when_the_session_is_gone_and_erase_drops_only_its_token()
-> anyhow::Result<()> {
    let world = joined().await?;
    let clone = clone(&world)?;
    let session = world.agent_dir("inv-abc123").join("session");
    let fork = request(&world, "git/casqueblanc/demo/claims/clm_42abcd.git");
    let fork = fork.trim_end_matches('\n');
    let token = |world: &World| -> anyhow::Result<Option<Value>> {
        Ok(stored(world, "inv-abc123")?.get("token").cloned())
    };

    // A current session is answered from the store, without a login.
    let logins = world.requests("/session").await;
    let current = credential(&world, clone.path(), "get", &format!("{fork}\n"))?;
    assert_eq!(
        current.stdout,
        format!("username={AGENT}\npassword={TOKEN}\n")
    );
    assert_eq!(world.requests("/session").await, logins);

    // A stale erase leaves the current token alone.
    let stale = credential(
        &world,
        clone.path(),
        "erase",
        &format!("{fork}\npassword=a.b.c\n"),
    )?;
    assert_eq!((stale.code, stale.stdout.as_str()), (Some(0), ""));
    assert_eq!(token(&world)?, Some(json!(TOKEN)));

    let erase = credential(
        &world,
        clone.path(),
        "erase",
        &format!("{fork}\npassword={TOKEN}\n"),
    )?;
    assert_eq!((erase.code, erase.stdout.as_str()), (Some(0), ""));
    assert!(!session.exists());

    let run = credential(&world, clone.path(), "get", &format!("{fork}\n"))?;
    assert_eq!(
        (run.code, run.stdout.as_str()),
        (
            Some(0),
            format!("username={AGENT}\npassword={FRESH}\n").as_str()
        )
    );
    // A login that reports no inbox and no next command prints nothing for a person.
    assert_eq!(run.stderr, "");
    assert_eq!(world.requests("/session").await, logins + 1);
    assert_eq!(token(&world)?, Some(json!(FRESH)));
    Ok(())
}

#[tokio::test]
async fn a_credential_login_shows_its_inbox_on_stderr_only() -> anyhow::Result<()> {
    let world = joined().await?;
    let clone = clone(&world)?;
    world.backend.report_inbox();
    let fork = request(&world, "git/casqueblanc/demo/claims/clm_42abcd.git");

    // The stored session is current, so no login runs and there is nothing to report.
    let current = credential(&world, clone.path(), "get", &fork)?;
    assert_eq!(
        (
            current.code,
            current.stdout.as_str(),
            current.stderr.as_str()
        ),
        (
            Some(0),
            format!("username={AGENT}\npassword={TOKEN}\n").as_str(),
            ""
        )
    );

    fs::remove_file(world.agent_dir("inv-abc123").join("session"))?;
    let run = credential(&world, clone.path(), "get", &fork)?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(run.stdout, format!("username={AGENT}\npassword={FRESH}\n"));
    assert_eq!(
        run.stderr,
        format!(
            "logged in again as {AGENT}\ninbox: 2 unacknowledged; read them with rh sync\nnext: rh sync\n"
        )
    );
    // The decision's text stays in the inbox for rh sync; the helper only points to it.
    assert!(!run.stderr.contains("Should uploads"), "{}", run.stderr);
    Ok(())
}

#[tokio::test]
async fn an_erase_racing_a_login_keeps_the_new_session() -> anyhow::Result<()> {
    let world = joined().await?;
    let clone = clone(&world)?;
    let fork = request(&world, "git/casqueblanc/demo/claims/clm_42abcd.git");
    let fork = fork.trim_end_matches('\n');
    let mut fresh = stored(&world, "inv-abc123")?;
    if let Some(slot) = fresh.get_mut("token") {
        *slot = json!(FRESH);
    }

    // A login holds the session lock while Git's erase of the old token starts.
    let lock = fs::File::open(world.agent_dir("inv-abc123").join(".session.lock"))?;
    lock.lock()?;
    let mut erase = command(&world, clone.path(), &["credential", "erase"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(mut input) = erase.stdin.take() {
        use std::io::Write as _;
        input.write_all(format!("{fork}\npassword={TOKEN}\n").as_bytes())?;
    }
    std::thread::sleep(Duration::from_millis(300));
    assert!(erase.try_wait()?.is_none(), "the erase did not wait");
    store_session(&world, "inv-abc123", &fresh)?;
    lock.unlock()?;

    let output = erase.wait_with_output()?;
    let run = finish(&world, &output)?;
    assert_eq!((run.code, run.stdout.as_str()), (Some(0), ""));
    assert_eq!(stored(&world, "inv-abc123")?, fresh);
    Ok(())
}

/// Answers `status` for the agent and records the `Authorization` header of every request.
struct Status {
    authorized: Arc<Mutex<Vec<String>>>,
}

impl Respond for Status {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        let header = request
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default();
        self.authorized
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(header.to_owned());
        json_response(
            200,
            &json!({"ok": true, "data": {"agent": {"agentId": AGENT, "name": "atlas",
                "ownerId": "usr_lemarier", "state": "confirmed"}, "claim": null},
                "inbox": null, "next": null}),
        )
    }
}

/// Runs `rh --json status` as the joined agent, outside any clone.
fn status(world: &World) -> anyhow::Result<Run> {
    let output = command(world, world.outside.path(), &["--json", "status"])
        .env("RAILHEAD_AGENT", "inv-abc123")
        .stdin(Stdio::null())
        .output()?;
    finish(world, &output)
}

/// Rewrites the stored session's expiry to `expires_at`.
fn expire(world: &World, expires_at: u64) -> anyhow::Result<Value> {
    let mut record = stored(world, "inv-abc123")?;
    if let Some(slot) = record.get_mut("expiresAt") {
        *slot = json!(expires_at);
    }
    store_session(world, "inv-abc123", &record)?;
    Ok(record)
}

#[tokio::test]
async fn a_command_logs_in_again_once_its_session_lapses() -> anyhow::Result<()> {
    let world = joined().await?;
    let authorized = Arc::new(Mutex::new(Vec::new()));
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/status")))
        .respond_with(Status {
            authorized: Arc::clone(&authorized),
        })
        .mount(&world.server)
        .await;
    let logins = world.requests("/session").await;

    // Lapsed, then about to lapse: each time the command logs in first and sends only the new
    // session, and the stored session is current again for the next command.
    for expires_at in [now_ms() - 1, now_ms() + 1000] {
        expire(&world, expires_at)?;
        let run = status(&world)?;
        assert_eq!(run.code, Some(0), "{}", run.stderr);
        assert_eq!(
            run.json()?.pointer("/data/agent/agentId"),
            Some(&json!(AGENT))
        );
        let renewed = stored(&world, "inv-abc123")?;
        assert_eq!(renewed.get("token"), Some(&json!(FRESH)));
        let expires = renewed
            .get("expiresAt")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        assert!(expires > now_ms() + 60_000, "{renewed}");
    }
    assert_eq!(world.requests("/session/challenge").await, logins + 2);
    assert_eq!(world.requests("/session").await, logins + 2);

    // A current session is sent as it is, without a login.
    let run = status(&world)?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(world.requests("/session").await, logins + 2);
    let sent = authorized
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    let bearer = format!("Bearer {FRESH}");
    assert_eq!(sent, vec![bearer.clone(), bearer.clone(), bearer]);
    Ok(())
}

#[tokio::test]
async fn a_command_waits_for_a_login_in_progress_and_uses_its_session() -> anyhow::Result<()> {
    let world = joined().await?;
    let authorized = Arc::new(Mutex::new(Vec::new()));
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/status")))
        .respond_with(Status {
            authorized: Arc::clone(&authorized),
        })
        .mount(&world.server)
        .await;
    let lapsed = expire(&world, now_ms() - 1)?;
    let logins = world.requests("/session/challenge").await;

    // Another process holds the session lock while it logs in; the command waits for it.
    let lock = fs::File::open(world.agent_dir("inv-abc123").join(".session.lock"))?;
    lock.lock()?;
    let waiting = command(&world, world.outside.path(), &["--json", "status"])
        .env("RAILHEAD_AGENT", "inv-abc123")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    std::thread::sleep(Duration::from_millis(300));
    let mut fresh = lapsed;
    for (field, value) in [
        ("token", json!(FRESH)),
        ("expiresAt", json!(now_ms() + SESSION_TTL_MS)),
    ] {
        if let Some(slot) = fresh.get_mut(field) {
            *slot = value;
        }
    }
    store_session(&world, "inv-abc123", &fresh)?;
    lock.unlock()?;

    let run = finish(&world, &waiting.wait_with_output()?)?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    // It read the session the other login stored instead of logging in again.
    assert_eq!(world.requests("/session/challenge").await, logins);
    let sent = authorized
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert_eq!(sent, vec![format!("Bearer {FRESH}")]);
    assert_eq!(stored(&world, "inv-abc123")?, fresh);
    Ok(())
}

#[tokio::test]
async fn a_revoked_unconfirmed_or_failed_login_sends_no_request() -> anyhow::Result<()> {
    for (status_code, code, expected) in [
        (403, "identity_revoked", "no_session"),
        (403, "identity_pending", "no_session"),
        (401, "challenge_invalid", "challenge_invalid"),
    ] {
        let world = joined().await?;
        Mock::given(method("POST"))
            .and(path(format!("{PREFIX}/session")))
            .respond_with(failure(status_code, code, "No."))
            .with_priority(1)
            .mount(&world.server)
            .await;
        let lapsed = expire(&world, now_ms() - 1)?;
        let challenges = world.requests("/session/challenge").await;
        let logins = world.requests("/session").await;

        let run = status(&world)?;
        assert_eq!(run.code, Some(1), "{code}");
        let envelope = run.json()?;
        assert_eq!(
            envelope.pointer("/error/code"),
            Some(&json!(expected)),
            "{code}"
        );
        if expected == "no_session" {
            assert_eq!(
                envelope.pointer("/error/next"),
                Some(&json!("rh join")),
                "{code}"
            );
        }
        // One login attempt, the lapsed session kept and never sent.
        assert_eq!(
            world.requests("/session/challenge").await,
            challenges + 1,
            "{code}"
        );
        assert_eq!(world.requests("/session").await, logins + 1, "{code}");
        assert_eq!(world.requests("/status").await, 0, "{code}");
        assert_eq!(stored(&world, "inv-abc123")?, lapsed, "{code}");
    }
    Ok(())
}

#[tokio::test]
async fn commands_refuse_a_foreign_session_without_a_request() -> anyhow::Result<()> {
    let world = joined().await?;
    let current = stored(&world, "inv-abc123")?;
    let mut foreign = current.clone();
    if let Some(slot) = foreign.get_mut("agentId") {
        *slot = json!("agt_boreas01");
    }
    let mut elsewhere = current;
    if let Some(slot) = elsewhere.get_mut("origin") {
        *slot = json!("https://railhead.dev");
    }
    let before = world
        .server
        .received_requests()
        .await
        .map_or(0, |r| r.len());
    for record in [foreign, elsewhere] {
        store_session(&world, "inv-abc123", &record)?;
        for args in [&["--json", "status"][..], &["--json", "work"]] {
            let output = command(&world, world.outside.path(), args)
                .env("RAILHEAD_AGENT", "inv-abc123")
                .stdin(Stdio::null())
                .output()?;
            let run = finish(&world, &output)?;
            assert_eq!(
                run.json()?.pointer("/error/code"),
                Some(&json!("no_session")),
                "{args:?} {record}"
            );
        }
        // The record is neither sent nor replaced by a login.
        assert_eq!(stored(&world, "inv-abc123")?, record);
    }
    assert_eq!(
        world
            .server
            .received_requests()
            .await
            .map_or(0, |r| r.len()),
        before
    );
    Ok(())
}

/// Accepts Git's second request only with the agent's Basic credentials, after asking for them.
struct GitGateway {
    authorized: Arc<Mutex<Vec<String>>>,
}

impl Respond for GitGateway {
    fn respond(&self, request: &Request) -> ResponseTemplate {
        match request
            .headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
        {
            Some(value) => {
                self.authorized
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(value.to_owned());
                ResponseTemplate::new(503)
            }
            None => ResponseTemplate::new(401)
                .insert_header("www-authenticate", "Basic realm=\"railhead\""),
        }
    }
}

#[tokio::test]
async fn git_itself_sends_the_session_through_the_helper() -> anyhow::Result<()> {
    let world = joined().await?;
    let clone = clone(&world)?;
    let authorized = Arc::new(Mutex::new(Vec::new()));
    Mock::given(method("GET"))
        .and(path(
            "/git/casqueblanc/demo/claims/clm_42abcd.git/info/refs",
        ))
        .respond_with(GitGateway {
            authorized: Arc::clone(&authorized),
        })
        .mount(&world.server)
        .await;
    let output = git(&world, clone.path(), &["ls-remote", "origin"])?;
    // The fake gateway refuses the authorized request too, so Git fails; what it sent is the point.
    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr)?;
    assert!(!stderr.contains(TOKEN), "{stderr}");
    let expected = {
        use base64_shim::encode;
        format!("Basic {}", encode(format!("{AGENT}:{TOKEN}").as_bytes()))
    };
    let sent = authorized
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert_eq!(sent, vec![expected]);
    Ok(())
}

#[tokio::test]
async fn git_gets_a_fresh_session_once_the_stored_one_expires() -> anyhow::Result<()> {
    let world = joined().await?;
    let clone = clone(&world)?;
    let authorized = Arc::new(Mutex::new(Vec::new()));
    Mock::given(method("GET"))
        .and(path(
            "/git/casqueblanc/demo/claims/clm_42abcd.git/info/refs",
        ))
        .respond_with(GitGateway {
            authorized: Arc::clone(&authorized),
        })
        .mount(&world.server)
        .await;
    // The stored session lapses within the skew `rh` keeps before expiry.
    let mut expiring = stored(&world, "inv-abc123")?;
    if let Some(slot) = expiring.get_mut("expiresAt") {
        *slot = json!(now_ms() + 1000);
    }
    store_session(&world, "inv-abc123", &expiring)?;
    let logins = world.requests("/session").await;

    let output = git(&world, clone.path(), &["ls-remote", "origin"])?;
    assert!(!output.status.success());
    let expected = {
        use base64_shim::encode;
        format!("Basic {}", encode(format!("{AGENT}:{FRESH}").as_bytes()))
    };
    let sent = authorized
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone();
    assert_eq!(sent, vec![expected]);
    assert_eq!(world.requests("/session").await, logins + 1);
    assert_eq!(
        stored(&world, "inv-abc123")?.get("token"),
        Some(&json!(FRESH))
    );
    Ok(())
}

/// Standard base64, enough to build the header Git sends.
mod base64_shim {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    pub fn encode(input: &[u8]) -> String {
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let bytes = [
                chunk.first().copied().unwrap_or(0),
                chunk.get(1).copied().unwrap_or(0),
                chunk.get(2).copied().unwrap_or(0),
            ];
            let n = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
            for index in 0..4 {
                if index <= chunk.len() {
                    let sextet = (n >> (18 - 6 * index)) & 0x3f;
                    out.push(char::from(
                        ALPHABET
                            .get(usize::try_from(sextet).unwrap_or(0))
                            .copied()
                            .unwrap_or(b'A'),
                    ));
                } else {
                    out.push('=');
                }
            }
        }
        out
    }
}
