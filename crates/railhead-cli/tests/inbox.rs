//! `rh sync`, `rh ack` and `rh ask` end to end.
//!
//! Each test runs the built binary against a temporary identity store and a wiremock server that
//! answers with the A01 wire fixtures. `rh ask` runs inside a Git repository configured as the
//! claim's clone. "Sends nothing" and "acknowledges nothing" are asserted on the server's request
//! log, never inferred from the output.

use std::fs;
use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use ssh_key::rand_core::OsRng;
use ssh_key::{Algorithm, LineEnding, PrivateKey};
use wiremock::matchers::{body_json, header, method, path, query_param};
use wiremock::{Mock, MockServer, Respond, ResponseTemplate};

const TOKEN: &str = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ3RfYXRsYXMwMSJ9.c2lnbmF0dXJlLXNlY3JldA";
/// The token a login during the test issues.
const FRESH: &str = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ3RfYXRsYXMwMSJ9.ZnJlc2gtc2VjcmV0";
const PREFIX: &str = "/agent/v1/casqueblanc/demo";
const CHALLENGE: &str = "chl_3q27HkVb0nZ8pXa1";
const EXPIRES: u64 = 1_790_000_060_000;
const QUESTION: &str = "Should uploads above 10 MB be rejected or chunked?";

struct World {
    server: MockServer,
    home: tempfile::TempDir,
    /// A Git repository configured as `atlas`'s clone of claim `clm_42abcd`, at generation 1.
    clone: tempfile::TempDir,
    outside: tempfile::TempDir,
}

fn write_private(path: &Path, contents: &str) -> anyhow::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(contents.as_bytes())?;
    Ok(())
}

fn git(dir: &Path, args: &[&str]) -> anyhow::Result<()> {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .status()?;
    anyhow::ensure!(status.success(), "git {args:?} failed");
    Ok(())
}

/// `atlas`'s session record for `origin`, expiring at `expires_at`.
fn session_record(origin: &str, token: &str, expires_at: u64) -> String {
    json!({"agentId": "agt_atlas01", "origin": origin, "repo": "casqueblanc/demo",
        "token": token, "expiresAt": expires_at})
    .to_string()
}

/// A store with `atlas` (with a session valid until 2100) and `boreas` (with neither key nor
/// session), and `atlas`'s clone, all on `origin`.
fn world_at(server: MockServer, origin: &str) -> anyhow::Result<World> {
    let home = tempfile::tempdir()?;
    for (name, id) in [("atlas", "agt_atlas01"), ("boreas", "agt_boreas01")] {
        let dir = home.path().join("agents").join(name);
        fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        for private in [home.path().join("agents"), dir.clone()] {
            fs::set_permissions(
                &private,
                std::os::unix::fs::PermissionsExt::from_mode(0o700),
            )?;
        }
        let record =
            json!({"name": name, "agentId": id, "origin": origin, "repo": "casqueblanc/demo"});
        write_private(&dir.join("identity.json"), &record.to_string())?;
    }
    write_private(
        &home.path().join("agents/atlas/session"),
        &session_record(origin, TOKEN, 4_102_444_800_000),
    )?;

    let clone = tempfile::tempdir()?;
    git(clone.path(), &["init", "--quiet"])?;
    git(
        clone.path(),
        &["config", "railhead.identity", "agt_atlas01"],
    )?;
    git(clone.path(), &["config", "railhead.generation", "1"])?;
    let remote = format!("{origin}/git/casqueblanc/demo/claims/clm_42abcd.git");
    git(clone.path(), &["remote", "add", "origin", &remote])?;
    Ok(World {
        server,
        home,
        clone,
        outside: tempfile::tempdir()?,
    })
}

async fn world() -> anyhow::Result<World> {
    let server = MockServer::start().await;
    let origin = server.uri();
    world_at(server, &origin)
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

    fn at(&self, pointer: &str) -> anyhow::Result<Value> {
        Ok(self
            .json()?
            .pointer(pointer)
            .cloned()
            .unwrap_or(Value::Null))
    }
}

fn command(world: &World, dir: &Path, agent: Option<&str>, args: &[&str]) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rh"));
    command
        .args(args)
        .current_dir(dir)
        .env("RAILHEAD_HOME", world.home.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env_remove("RAILHEAD_AGENT")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(agent) = agent {
        command.env("RAILHEAD_AGENT", agent);
    }
    command
}

fn finish(output: &Output) -> anyhow::Result<Run> {
    let run = Run {
        code: output.status.code(),
        stdout: String::from_utf8(output.stdout.clone())?,
        stderr: String::from_utf8(output.stderr.clone())?,
    };
    for stream in [&run.stdout, &run.stderr] {
        assert!(
            !stream.contains("c2lnbmF0dXJl") && !stream.contains("ZnJlc2g"),
            "token leaked: {stream}"
        );
    }
    Ok(run)
}

/// `rh` as `atlas`, outside any clone.
fn rh(world: &World, args: &[&str]) -> anyhow::Result<Run> {
    finish(&command(world, world.outside.path(), Some("atlas"), args).output()?)
}

/// `rh` inside `atlas`'s clone.
fn rh_in_clone(world: &World, args: &[&str]) -> anyhow::Result<Run> {
    finish(&command(world, world.clone.path(), None, args).output()?)
}

/// The fixture exchange named `name`.
fn exchange(file: &str, name: &str) -> anyhow::Result<Value> {
    let path = format!(
        "{}/../../fixtures/protocol/wire/agent/{file}",
        env!("CARGO_MANIFEST_DIR")
    );
    let corpus: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    corpus
        .pointer("/exchanges")
        .and_then(Value::as_array)
        .and_then(|exchanges| {
            exchanges
                .iter()
                .find(|exchange| exchange.pointer("/name") == Some(&json!(name)))
        })
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("{file} has no exchange {name:?}"))
}

fn json_response(status: u16, body: &Value) -> ResponseTemplate {
    ResponseTemplate::new(status).set_body_raw(body.to_string(), "application/json")
}

/// The response of the fixture exchange named `name`.
fn fixture(file: &str, name: &str) -> anyhow::Result<ResponseTemplate> {
    let exchange = exchange(file, name)?;
    let status = exchange
        .pointer("/response/status")
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
        .ok_or_else(|| anyhow::anyhow!("{file} {name:?} has no status"))?;
    let body = exchange
        .pointer("/response/body")
        .ok_or_else(|| anyhow::anyhow!("{file} {name:?} has no body"))?;
    Ok(json_response(status, body))
}

async fn answer(world: &World, verb: &str, route: &str, response: ResponseTemplate) {
    Mock::given(method(verb))
        .and(path(format!("{PREFIX}{route}")))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(response)
        .mount(&world.server)
        .await;
}

/// How long a held response is delayed: far beyond any `--wait` a test passes.
const HOLD: Duration = Duration::from_secs(20);
/// Room for process exit after a wait ends. A wait plus this stays well under [`HOLD`], so a CLI
/// that waited for the held answer still fails.
const EXIT_SLACK: Duration = Duration::from_secs(10);

/// A response held for [`HOLD`] that records when each request arrived, so a test times the CLI's
/// wait from the request it held, not from process start, which a loaded machine delays.
#[derive(Clone)]
struct Held {
    response: ResponseTemplate,
    arrivals: Arc<Mutex<Vec<Instant>>>,
}

impl Held {
    fn new(response: ResponseTemplate) -> Self {
        Self {
            response: response.set_delay(HOLD),
            arrivals: Arc::default(),
        }
    }

    /// How long the latest held request stayed open before `rh` exited at `exited`.
    fn open_until(&self, exited: Instant) -> anyhow::Result<Duration> {
        let arrivals = self.arrivals.lock().unwrap_or_else(PoisonError::into_inner);
        let arrived = arrivals
            .last()
            .ok_or_else(|| anyhow::anyhow!("no request was held"))?;
        Ok(exited.duration_since(*arrived))
    }
}

impl Respond for Held {
    fn respond(&self, _: &wiremock::Request) -> ResponseTemplate {
        self.arrivals
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(Instant::now());
        self.response.clone()
    }
}

/// The requests the server received on `route`.
async fn received(world: &World, route: &str) -> Vec<wiremock::Request> {
    let path = format!("{PREFIX}{route}");
    world
        .server
        .received_requests()
        .await
        .unwrap_or_default()
        .into_iter()
        .filter(|request| request.url.path() == path)
        .collect()
}

async fn requests(world: &World) -> usize {
    world
        .server
        .received_requests()
        .await
        .map_or(0, |requests| requests.len())
}

/// How many acknowledgements the server received, on any item.
async fn acks(world: &World) -> usize {
    world
        .server
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .filter(|request| request.url.path().ends_with("/ack"))
        .count()
}

fn inbox_item(item: u64) -> Value {
    json!({"item": item, "claimId": "clm_42abcd", "queuedAt": 1_789_999_997_000_u64,
        "entry": {"kind": "conflict", "otherClaimId": "clm_43abcd", "path": "src/upload.ts"},
        "decision": null})
}

fn page(items: &[Value], pending: u64) -> ResponseTemplate {
    json_response(
        200,
        &json!({"ok": true, "data": {"items": items, "pending": pending},
            "inbox": {"items": [], "pending": pending}, "next": null}),
    )
}

// =======================================================================================
// rh sync

#[tokio::test]
async fn sync_prints_each_item_in_the_fixed_format_and_acknowledges_nothing() -> anyhow::Result<()>
{
    let world = world().await?;
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/inbox")))
        .and(query_param("limit", "16"))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(fixture(
            "inbox.json",
            "returns unacknowledged items oldest first",
        )?)
        .mount(&world.server)
        .await;

    // The whole page, so a stray line such as the inbox footer, which would send the agent back
    // to rh sync under the items it was just shown, fails the test.
    let text = rh(&world, &["sync", "--limit", "16"])?;
    assert_eq!(text.code, Some(0), "{}", text.stderr);
    assert_eq!(
        text.stdout,
        format!(
            "2 unacknowledged items, oldest first\n\
             \n\
             [17] rework for claim \"clm_42abcd\"\n\
             \x20    decision: \"dec_upload1\" v2, supersedes v1, recorded by \"usr_lemarier\" through Railhead\n\
             \x20    question: \"{QUESTION}\"\n\
             \x20    chosen: \"chunk\" \"Upload them in chunks\"\n\
             \x20    was: \"reject\" \"Reject them\"\n\
             \x20    scope: \"src/upload.ts\"\n\
             \x20    action: rework required; redo work that relied on the earlier version\n\
             \x20    acknowledge: rh ack 17 --plan <plan>\n\
             \n\
             [18] conflict for claim \"clm_42abcd\"\n\
             \x20    overlaps: claim \"clm_43abcd\" on \"src/upload.ts\"\n\
             \x20    action: redo the change on the new base\n\
             \x20    acknowledge: rh ack 18 --plan <plan>\n\
             next: rh ack\n"
        )
    );

    let json = rh(&world, &["--json", "sync", "--limit", "16"])?;
    assert_eq!(json.at("/ok")?, json!(true));
    assert_eq!(json.at("/data/items/0/item")?, json!(17));
    assert_eq!(
        json.at("/data/items/0/decision/option/key")?,
        json!("chunk")
    );
    assert_eq!(
        json.at("/data/items/1/ack")?,
        json!("rh ack 18 --plan <plan>")
    );
    assert_eq!(json.at("/next")?, json!("rh ack"));
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn sync_with_an_empty_inbox_passes_on_the_backends_next_command() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "GET",
        "/inbox",
        fixture("inbox.json", "an empty inbox")?,
    )
    .await;
    let run = rh(&world, &["sync"])?;
    assert_eq!(
        (run.code, run.stdout.as_str()),
        (Some(0), "inbox: nothing to acknowledge\n")
    );
    // No page size was named, so none is sent.
    let sent = received(&world, "/inbox").await;
    assert_eq!(sent.first().map(|request| request.url.query()), Some(None));
    Ok(())
}

#[tokio::test]
async fn sync_refuses_a_page_that_repeats_an_item_and_prints_none_of_it() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "GET",
        "/inbox",
        page(&[inbox_item(17), inbox_item(17)], 2),
    )
    .await;
    let run = rh(&world, &["--json", "sync"])?;
    assert_eq!(run.code, Some(1));
    assert_eq!(run.at("/error/code")?, json!("malformed_response"));
    assert!(!run.stdout.contains("clm_43abcd"), "{}", run.stdout);

    let text = rh(&world, &["sync"])?;
    assert_eq!(text.stdout, "");
    assert!(
        text.stderr
            .starts_with("rh: inbox item 17 is repeated or out of order"),
        "{}",
        text.stderr
    );
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn sync_refuses_an_empty_page_while_items_are_pending() -> anyhow::Result<()> {
    let world = world().await?;
    answer(&world, "GET", "/inbox", page(&[], 3)).await;
    let run = rh(&world, &["--json", "sync"])?;
    assert_eq!(
        (run.code, run.at("/error/code")?),
        (Some(1), json!("malformed_response"))
    );

    let text = rh(&world, &["sync"])?;
    assert_eq!(text.code, Some(1));
    assert_eq!(text.stdout, "");
    assert!(
        text.stderr
            .starts_with("rh: the inbox returned no items but says 3 are pending"),
        "{}",
        text.stderr
    );
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn sync_refuses_a_page_larger_than_it_asked_for() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "GET",
        "/inbox",
        page(&[inbox_item(17), inbox_item(18)], 5),
    )
    .await;
    let text = rh(&world, &["sync", "--limit", "1"])?;
    assert_eq!(text.code, Some(1));
    assert_eq!(text.stdout, "");
    assert!(
        text.stderr
            .starts_with("rh: the inbox returned more items than its page of 1"),
        "{}",
        text.stderr
    );

    // Without --limit, the backend's default page of 16 is the bound.
    world.server.reset().await;
    let items: Vec<_> = (1..=17).map(inbox_item).collect();
    answer(&world, "GET", "/inbox", page(&items, 17)).await;
    let run = rh(&world, &["--json", "sync"])?;
    assert_eq!(
        (run.code, run.at("/error/code")?),
        (Some(1), json!("malformed_response"))
    );
    assert!(!run.stdout.contains("clm_43abcd"), "{}", run.stdout);
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn sync_shows_how_many_items_wait_beyond_the_page() -> anyhow::Result<()> {
    let world = world().await?;
    answer(&world, "GET", "/inbox", page(&[inbox_item(18)], 5)).await;
    let run = rh(&world, &["sync", "--limit", "1"])?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    // The count beyond the page is the last word before next; no inbox footer repeats it.
    assert_eq!(
        run.stdout,
        "1 unacknowledged item, oldest first\n\
         \n\
         [18] conflict for claim \"clm_42abcd\"\n\
         \x20    overlaps: claim \"clm_43abcd\" on \"src/upload.ts\"\n\
         \x20    action: redo the change on the new base\n\
         \x20    acknowledge: rh ack 18 --plan <plan>\n\
         \n\
         4 more pending; acknowledge these, then run rh sync again\n\
         next: rh ack\n"
    );
    Ok(())
}

#[tokio::test]
async fn sync_refuses_an_out_of_range_page_size_before_sending() -> anyhow::Result<()> {
    let world = world().await?;
    for limit in ["0", "65", "-1", "many"] {
        let run = rh(&world, &["--json", "sync", "--limit", limit])?;
        assert_eq!(run.code, Some(2), "{limit}");
        assert_eq!(run.at("/error/code")?, json!("invalid_input"), "{limit}");
    }
    assert_eq!(requests(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn sync_reports_a_refusal_and_a_malformed_answer() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "GET",
        "/inbox",
        fixture("inbox.json", "refuses an expired session")?,
    )
    .await;
    let run = rh(&world, &["--json", "sync"])?;
    assert_eq!(
        (run.code, run.at("/error/code")?),
        (Some(1), json!("unauthenticated"))
    );

    world.server.reset().await;
    answer(
        &world,
        "GET",
        "/inbox",
        ResponseTemplate::new(200).set_body_raw("<html>not json</html>", "application/json"),
    )
    .await;
    let run = rh(&world, &["--json", "sync"])?;
    assert_eq!(run.at("/error/code")?, json!("malformed_response"));
    assert!(!run.stdout.contains("not json"), "{}", run.stdout);
    Ok(())
}

#[tokio::test]
async fn sync_with_a_lapsed_session_logs_in_once_and_uses_the_new_token() -> anyhow::Result<()> {
    let world = world().await?;
    let origin = world.server.uri();
    let atlas = world.home.path().join("agents/atlas");
    fs::remove_file(atlas.join("session"))?;
    write_private(&atlas.join("session"), &session_record(&origin, TOKEN, 1))?;
    let key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519)?;
    write_private(&atlas.join("key"), &key.to_openssh(LineEnding::LF)?)?;

    let message = format!(
        "railhead-login-v1\norigin={origin}\nrepo=casqueblanc/demo\nagent=agt_atlas01\nchallenge={CHALLENGE}\nexpires={EXPIRES}\n"
    );
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/session/challenge")))
        .respond_with(json_response(
            200,
            &json!({"ok": true, "data": {"challengeId": CHALLENGE, "expiresAt": EXPIRES,
                "message": message}, "inbox": null, "next": null}),
        ))
        .expect(1)
        .mount(&world.server)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/session")))
        .respond_with(json_response(
            200,
            &json!({"ok": true, "data": {"token": FRESH, "expiresAt": 4_102_444_800_000_u64,
                "agent": {"agentId": "agt_atlas01", "name": "atlas", "ownerId": "usr_lemarier",
                "state": "confirmed"}, "repoId": "rep_demo0001"}, "inbox": null, "next": null}),
        ))
        .expect(1)
        .mount(&world.server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/inbox")))
        .and(header("authorization", format!("Bearer {FRESH}").as_str()))
        .respond_with(fixture("inbox.json", "an empty inbox")?)
        .expect(1)
        .mount(&world.server)
        .await;

    let run = rh(&world, &["sync"])?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(run.stdout, "inbox: nothing to acknowledge\n");
    let stored: Value = serde_json::from_str(&fs::read_to_string(atlas.join("session"))?)?;
    assert_eq!(stored.pointer("/token"), Some(&json!(FRESH)));
    // The lapsed token was never sent.
    let sent = world.server.received_requests().await.unwrap_or_default();
    assert!(sent.iter().all(|request| {
        request
            .headers
            .get("authorization")
            .is_none_or(|value| value.to_str().ok() != Some(&format!("Bearer {TOKEN}")))
    }));
    Ok(())
}

#[tokio::test]
async fn an_agent_without_a_session_sends_nothing() -> anyhow::Result<()> {
    let world = world().await?;
    for args in [
        &["--json", "sync"][..],
        &["--json", "ack", "17", "--plan", "Switch to chunks"],
        &["--json", "ask", "--question", "qst_upload1"],
    ] {
        let run = finish(&command(&world, world.outside.path(), Some("boreas"), args).output()?)?;
        assert_eq!(run.at("/error/code")?, json!("no_session"), "{args:?}");
        assert_eq!(run.at("/error/next")?, json!("rh join"), "{args:?}");
    }
    assert_eq!(requests(&world).await, 0);
    Ok(())
}

// =======================================================================================
// rh ack

#[tokio::test]
async fn ack_records_the_agents_plan_for_one_item() -> anyhow::Result<()> {
    let world = world().await?;
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/inbox/17/ack")))
        .and(body_json(json!({"plan": "Switch the handler to chunks"})))
        .respond_with(fixture("ack.json", "acknowledges the item with a plan")?)
        .expect(1)
        .mount(&world.server)
        .await;
    let run = rh(
        &world,
        &["ack", "17", "--plan", "Switch the handler to chunks"],
    )?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(
        run.stdout,
        "acknowledged item 17\nplan: \"Switch the handler to chunks\"\nnext: rh ready\n"
    );
    assert_eq!(run.stderr, "");
    Ok(())
}

#[tokio::test]
async fn a_repeated_ack_keeps_the_first_plan_and_says_so() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/inbox/17/ack",
        fixture("ack.json", "a repeat returns the first acknowledgement")?,
    )
    .await;
    let run = rh(&world, &["--json", "ack", "17", "--plan", "Something else"])?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(run.at("/data/repeated")?, json!(true));
    assert_eq!(run.at("/data/plan")?, json!("Switch the handler to chunks"));
    assert_eq!(run.at("/next")?, json!("rh ready"));
    assert_eq!(
        run.stderr,
        "rh: item 17 was already acknowledged; its first plan stands and this one was not recorded\n"
    );
    Ok(())
}

#[tokio::test]
async fn ack_of_an_item_not_pending_is_refused_with_a_way_back() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/inbox/17/ack",
        fixture("ack.json", "refuses an item that is not this agent's")?,
    )
    .await;
    let run = rh(
        &world,
        &["ack", "17", "--plan", "Switch the handler to chunks"],
    )?;
    assert_eq!((run.code, run.stdout.as_str()), (Some(1), ""));
    assert_eq!(
        run.stderr,
        "rh: item 17 is not pending in this agent's inbox; rh sync lists the items that are\n\
         rh: ack: This agent has no inbox item 17.\nnext: rh status\n"
    );
    Ok(())
}

#[tokio::test]
async fn ack_refuses_an_answer_for_another_item() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/inbox/18/ack",
        fixture("ack.json", "acknowledges the item with a plan")?,
    )
    .await;
    let run = rh(&world, &["--json", "ack", "18", "--plan", "Rebase"])?;
    assert_eq!(run.at("/error/code")?, json!("malformed_response"));
    assert_eq!(run.at("/error/next")?, json!("rh sync"));
    Ok(())
}

#[tokio::test]
async fn ack_checks_the_item_and_plan_before_sending() -> anyhow::Result<()> {
    let world = world().await?;
    let longest = "p".repeat(4000);
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/inbox/17/ack")))
        .and(body_json(json!({"plan": longest})))
        .respond_with(fixture("ack.json", "acknowledges the item with a plan")?)
        .expect(1)
        .mount(&world.server)
        .await;
    let too_long = "p".repeat(4001);
    for (args, exit) in [
        (vec!["--json", "ack", "17", "--plan", "  \t "], 1),
        (vec!["--json", "ack", "17", "--plan", &too_long], 1),
        (vec!["--json", "ack", "17"], 2),
        (vec!["--json", "ack", "0", "--plan", "x"], 2),
        (vec!["--json", "ack", "9007199254740992", "--plan", "x"], 2),
    ] {
        let run = rh(&world, &args)?;
        assert_eq!(run.code, Some(exit), "{args:?}");
        assert_eq!(run.at("/error/code")?, json!("invalid_input"), "{args:?}");
    }
    assert_eq!(requests(&world).await, 0);
    // The longest plan the protocol allows is sent.
    let run = rh(&world, &["--json", "ack", "17", "--plan", &longest])?;
    assert_eq!(run.code, Some(0), "{}", run.stdout);
    Ok(())
}

// =======================================================================================
// rh ask

fn ask_args<'a>(text: &'a str, scope: &'a str) -> Vec<&'a str> {
    vec![
        "--json",
        "ask",
        text,
        "--option",
        "reject=Reject them",
        "--option",
        "chunk=Upload them in chunks",
        "--scope",
        scope,
    ]
}

#[tokio::test]
async fn ask_returns_at_once_with_a_fresh_request_id() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/claims/clm_42abcd/questions",
        fixture("ask.json", "asks the owner and returns at once")?,
    )
    .await;
    let run = rh_in_clone(&world, &ask_args(QUESTION, "src/upload.ts"))?;
    assert_eq!(run.code, Some(0), "{}", run.stdout);
    assert_eq!(run.at("/data/question/questionId")?, json!("qst_upload1"));
    assert_eq!(run.at("/data/question/state")?, json!("open"));
    assert_eq!(run.at("/data/timedOut")?, json!(false));

    let sent = received(&world, "/claims/clm_42abcd/questions").await;
    let body: Value =
        serde_json::from_slice(&sent.first().map(|r| r.body.clone()).unwrap_or_default())?;
    let request_id = body
        .pointer("/requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    assert_eq!(run.at("/data/requestId")?, json!(request_id));
    assert!(
        request_id.len() == 36
            && request_id.starts_with("req_")
            && request_id
                .strip_prefix("req_")
                .is_some_and(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit())),
        "{request_id}"
    );
    assert_eq!(
        body,
        json!({"generation": 1, "requestId": request_id, "text": QUESTION,
            "options": [{"key": "reject", "label": "Reject them"},
                {"key": "chunk", "label": "Upload them in chunks"}],
            "scope": ["src/upload.ts"]})
    );

    // A second ask is a new question, under a new key.
    let again = rh_in_clone(&world, &ask_args(QUESTION, "src/upload.ts"))?;
    assert_ne!(again.at("/data/requestId")?, json!(request_id));
    // Asking polls nothing and acknowledges nothing.
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 0);
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn ask_reports_a_reused_request_id_and_a_stale_generation() -> anyhow::Result<()> {
    let world = world().await?;
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/claims/clm_42abcd/questions")))
        .respond_with(fixture(
            "ask.json",
            "refuses a reused request id with a different question",
        )?)
        .up_to_n_times(1)
        .mount(&world.server)
        .await;
    answer(
        &world,
        "POST",
        "/claims/clm_42abcd/questions",
        fixture("ask.json", "refuses a stale generation")?,
    )
    .await;
    let mut args = ask_args("Another question?", "src/upload.ts");
    args.extend(["--request-id", "req_upload0000000001"]);
    let reused = rh_in_clone(&world, &args)?;
    assert_eq!(reused.at("/error/code")?, json!("idempotency_mismatch"));
    let sent = received(&world, "/claims/clm_42abcd/questions").await;
    let body: Value =
        serde_json::from_slice(&sent.first().map(|r| r.body.clone()).unwrap_or_default())?;
    assert_eq!(
        body.pointer("/requestId"),
        Some(&json!("req_upload0000000001"))
    );

    let stale = rh_in_clone(&world, &ask_args(QUESTION, "src/upload.ts"))?;
    assert_eq!(stale.at("/error/code")?, json!("stale_generation"));
    assert_eq!(stale.at("/error/next")?, json!("rh status"));
    Ok(())
}

#[tokio::test]
async fn ask_checks_the_question_before_sending() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/claims/clm_42abcd/questions",
        fixture("ask.json", "accepts a scope of exactly the byte limit")?,
    )
    .await;
    let limit = exchange("ask.json", "accepts a scope of exactly the byte limit")?;
    let largest: Vec<String> = limit
        .pointer("/request/body/scope")
        .and_then(Value::as_array)
        .map(|paths| {
            paths
                .iter()
                .filter_map(|p| p.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    anyhow::ensure!(!largest.is_empty(), "the fixture has no scope");

    let one_option = vec![
        "--json",
        "ask",
        QUESTION,
        "--option",
        "reject=Reject them",
        "--scope",
        "src",
    ];
    let no_scope = vec![
        "--json", "ask", QUESTION, "--option", "a=A", "--option", "b=B",
    ];
    let blank = ask_args("   ", "src");
    let escaping = ask_args(QUESTION, "../secrets");
    // The limit's scope with one byte more.
    let (last, rest) = largest
        .split_last()
        .ok_or_else(|| anyhow::anyhow!("the fixture has no scope"))?;
    let extra = format!("{last}x");
    let mut too_large = vec![
        "--json",
        "ask",
        QUESTION,
        "--option",
        "reject=Reject them",
        "--option",
        "chunk=Upload them in chunks",
    ];
    for path in rest {
        too_large.extend(["--scope", path]);
    }
    too_large.extend(["--scope", &extra]);
    let mut bad_key = ask_args(QUESTION, "src");
    bad_key.extend(["--request-id", "not-a-key"]);
    for args in [
        &one_option,
        &no_scope,
        &blank,
        &escaping,
        &too_large,
        &bad_key,
    ] {
        let run = rh_in_clone(&world, args)?;
        assert_eq!(run.code, Some(1), "{args:?}");
        assert_eq!(
            run.at("/error/code")?,
            json!("invalid_input"),
            "{:?}",
            run.stdout
        );
    }
    let outside = rh(&world, &ask_args(QUESTION, "src"))?;
    assert_eq!(outside.at("/error/code")?, json!("no_clone"));
    assert_eq!(requests(&world).await, 0);

    // A scope of exactly the byte limit is sent.
    let mut exact = vec![
        "--json",
        "ask",
        QUESTION,
        "--option",
        "reject=Reject them",
        "--option",
        "chunk=Upload them in chunks",
    ];
    for path in &largest {
        exact.extend(["--scope", path]);
    }
    let run = rh_in_clone(&world, &exact)?;
    assert_eq!(run.code, Some(0), "{}", run.stdout);
    Ok(())
}

#[tokio::test]
async fn ask_wait_long_polls_until_the_answer_and_acknowledges_nothing() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/claims/clm_42abcd/questions",
        fixture("ask.json", "asks the owner and returns at once")?,
    )
    .await;
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/questions/qst_upload1")))
        .respond_with(fixture(
            "question.json",
            "a long poll that times out is still open",
        )?)
        .up_to_n_times(1)
        .mount(&world.server)
        .await;
    answer(
        &world,
        "GET",
        "/questions/qst_upload1",
        fixture("question.json", "an answered question carries the decision")?,
    )
    .await;

    let mut args = ask_args(QUESTION, "src/upload.ts");
    args.remove(0);
    args.extend(["--wait", "60"]);
    let run = rh_in_clone(&world, &args)?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert!(
        run.stdout.starts_with(
            "question qst_upload1 is answered\n     decision: \"dec_upload1\" v1, recorded by \"usr_lemarier\" through Railhead\n"
        ),
        "{}",
        run.stdout
    );
    assert!(
        run.stdout
            .contains("     chosen: \"reject\" \"Reject them\"\n")
    );
    assert!(run.stdout.ends_with("next: rh sync\n"), "{}", run.stdout);
    assert!(
        run.stderr.contains(
            "waiting up to 60 s for the answer to qst_upload1; if interrupted, resume with rh ask --question qst_upload1 --wait 60"
        ),
        "{}",
        run.stderr
    );

    let polls = received(&world, "/questions/qst_upload1").await;
    assert_eq!(polls.len(), 2);
    for poll in &polls {
        let wait: u64 = poll
            .url
            .query_pairs()
            .find(|(key, _)| key == "waitMs")
            .and_then(|(_, value)| value.parse().ok())
            .unwrap_or(0);
        assert!((23_000..=25_000).contains(&wait), "{wait}");
    }
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn ask_wait_stops_when_the_wait_runs_out() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "GET",
        "/questions/qst_upload1",
        fixture("question.json", "a long poll that times out is still open")?,
    )
    .await;
    let started = Instant::now();
    let run = rh(
        &world,
        &["--json", "ask", "--question", "qst_upload1", "--wait", "2"],
    )?;
    let elapsed = started.elapsed();
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(run.at("/data/timedOut")?, json!(true));
    assert_eq!(run.at("/data/question/state")?, json!("open"));
    assert_eq!(run.at("/next")?, json!("rh ask"));
    // The fake answers at once, so polls are spaced a second apart rather than repeated in a loop,
    // and the first asks to be held for the whole wait.
    let polls = received(&world, "/questions/qst_upload1").await;
    assert!((2..=3).contains(&polls.len()), "{} polls", polls.len());
    let first_wait = polls
        .first()
        .and_then(|poll| poll.url.query_pairs().find(|(key, _)| key == "waitMs"))
        .and_then(|(_, value)| value.parse::<u64>().ok())
        .unwrap_or(0);
    assert!((1_000..=2_000).contains(&first_wait), "{first_wait}");
    assert!(
        elapsed >= Duration::from_secs(2) && elapsed < Duration::from_secs(10),
        "{elapsed:?}"
    );

    let text = rh(&world, &["ask", "--question", "qst_upload1", "--wait", "1"])?;
    assert_eq!(
        text.stdout,
        "question qst_upload1 is still open after 1 s\n\
         wait again with: rh ask --question qst_upload1 --wait 1\nnext: rh ask\n"
    );
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn ask_wait_is_bounded_and_a_question_id_is_checked() -> anyhow::Result<()> {
    let world = world().await?;
    for args in [
        &["--json", "ask", "--question", "qst_upload1", "--wait", "0"][..],
        &[
            "--json",
            "ask",
            "--question",
            "qst_upload1",
            "--wait",
            "3601",
        ],
        &["--json", "ask", "--question", "../status"],
        &[
            "--json",
            "ask",
            "--question",
            "qst_upload1",
            "--scope",
            "src",
        ],
        &["--json", "ask"],
    ] {
        let run = rh(&world, args)?;
        assert_eq!(run.code, Some(2), "{args:?}");
        assert_eq!(run.at("/error/code")?, json!("invalid_input"), "{args:?}");
    }
    assert_eq!(requests(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn ask_reports_a_refused_or_inconsistent_question() -> anyhow::Result<()> {
    let world = world().await?;
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/questions/qst_upload1")))
        .respond_with(fixture(
            "question.json",
            "refuses a question the agent did not ask",
        )?)
        .up_to_n_times(1)
        .mount(&world.server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/questions/qst_upload1")))
        .respond_with(fixture(
            "question.json",
            "the decisions module is not installed",
        )?)
        .up_to_n_times(1)
        .mount(&world.server)
        .await;
    // Another question's answer, sent for this one.
    let mut other = exchange("question.json", "an answered question carries the decision")?
        .pointer("/response/body")
        .cloned()
        .unwrap_or(Value::Null);
    if let Some(id) = other.pointer_mut("/data/questionId") {
        *id = json!("qst_other01");
    }
    answer(
        &world,
        "GET",
        "/questions/qst_upload1",
        json_response(200, &other),
    )
    .await;

    let args = ["--json", "ask", "--question", "qst_upload1", "--wait", "30"];
    let refused = rh(&world, &args)?;
    assert_eq!(refused.at("/error/code")?, json!("not_found"));
    let unavailable = rh(&world, &args)?;
    assert_eq!(unavailable.at("/error/code")?, json!("unavailable"));
    let inconsistent = rh(&world, &args)?;
    assert_eq!(inconsistent.at("/error/code")?, json!("malformed_response"));
    // Each failure ended the wait at its first poll.
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 3);
    Ok(())
}

/// A refusal with `code`, sent with the status the protocol fixes for it.
fn refusal(status: u16, code: &str, retry_after_ms: Option<u64>) -> ResponseTemplate {
    json_response(
        status,
        &json!({"ok": false, "error": {"code": code, "message": "Try again later.",
            "retryable": true, "retryAfterMs": retry_after_ms, "next": null}}),
    )
}

#[tokio::test]
async fn ask_wait_polls_again_after_a_busy_refusal_once_the_advised_delay_has_passed()
-> anyhow::Result<()> {
    let world = world().await?;
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/questions/qst_upload1")))
        .respond_with(refusal(503, "busy", Some(1_500)))
        .up_to_n_times(1)
        .mount(&world.server)
        .await;
    answer(
        &world,
        "GET",
        "/questions/qst_upload1",
        fixture("question.json", "an answered question carries the decision")?,
    )
    .await;

    let started = Instant::now();
    let run = rh(
        &world,
        &["--json", "ask", "--question", "qst_upload1", "--wait", "10"],
    )?;
    let elapsed = started.elapsed();
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(run.at("/data/question/state")?, json!("answered"));
    assert_eq!(run.at("/data/timedOut")?, json!(false));
    assert!(
        run.stderr.contains("polling again in 2 s"),
        "{}",
        run.stderr
    );
    assert!(!run.stderr.contains("Try again later."), "{}", run.stderr);
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 2);
    assert!(
        elapsed >= Duration::from_millis(1_500) && elapsed < Duration::from_secs(10),
        "{elapsed:?}"
    );
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn ask_wait_ends_on_a_refusal_it_cannot_retry_within_the_wait() -> anyhow::Result<()> {
    let world = world().await?;
    // The advised delay outlasts the wait, so the refusal ends it at once.
    answer(
        &world,
        "GET",
        "/questions/qst_upload1",
        refusal(429, "rate_limited", Some(5_000)),
    )
    .await;
    let started = Instant::now();
    let limited = rh(
        &world,
        &["--json", "ask", "--question", "qst_upload1", "--wait", "2"],
    )?;
    assert_eq!(limited.code, Some(1), "{}", limited.stderr);
    assert_eq!(limited.at("/error/code")?, json!("rate_limited"));
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 1);

    // A retryable failure that does not ask to come back later is not polled again.
    world.server.reset().await;
    answer(
        &world,
        "GET",
        "/questions/qst_upload1",
        refusal(500, "internal", None),
    )
    .await;
    let internal = rh(
        &world,
        &["--json", "ask", "--question", "qst_upload1", "--wait", "5"],
    )?;
    assert_eq!(internal.at("/error/code")?, json!("internal"));
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 1);
    Ok(())
}

/// Whether any request to `route` carried a `waitMs` query parameter.
async fn any_wait(world: &World, route: &str) -> bool {
    received(world, route)
        .await
        .iter()
        .any(|request| request.url.query_pairs().any(|(key, _)| key == "waitMs"))
}

#[tokio::test]
async fn ask_question_without_wait_reads_it_once_and_acknowledges_nothing() -> anyhow::Result<()> {
    let world = world().await?;
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/questions/qst_upload1")))
        .respond_with(fixture(
            "question.json",
            "a long poll that times out is still open",
        )?)
        .up_to_n_times(1)
        .mount(&world.server)
        .await;
    answer(
        &world,
        "GET",
        "/questions/qst_upload1",
        fixture("question.json", "an answered question carries the decision")?,
    )
    .await;

    let open = rh(&world, &["--json", "ask", "--question", "qst_upload1"])?;
    assert_eq!(open.code, Some(0), "{}", open.stderr);
    assert_eq!(open.at("/data/question/questionId")?, json!("qst_upload1"));
    assert_eq!(open.at("/data/question/state")?, json!("open"));
    assert_eq!(open.at("/data/requestId")?, Value::Null);
    assert_eq!(open.at("/data/waitedSeconds")?, Value::Null);
    assert_eq!(open.at("/data/timedOut")?, json!(false));
    assert_eq!(open.at("/next")?, Value::Null);

    let answered = rh(&world, &["ask", "--question", "qst_upload1"])?;
    assert_eq!(answered.code, Some(0), "{}", answered.stderr);
    assert!(
        answered.stdout.starts_with(
            "question qst_upload1 is answered\n     decision: \"dec_upload1\" v1, recorded by \"usr_lemarier\" through Railhead\n"
        ),
        "{}",
        answered.stdout
    );
    assert!(
        answered.stdout.ends_with("next: rh sync\n"),
        "{}",
        answered.stdout
    );

    // One read each, never held, and nothing else sent.
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 2);
    assert!(!any_wait(&world, "/questions/qst_upload1").await);
    assert_eq!(requests(&world).await, 2);
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn ask_question_without_wait_refuses_another_questions_answer() -> anyhow::Result<()> {
    let world = world().await?;
    let mut other = exchange("question.json", "an answered question carries the decision")?
        .pointer("/response/body")
        .cloned()
        .unwrap_or(Value::Null);
    for pointer in ["/data/questionId", "/data/decision/questionId"] {
        if let Some(id) = other.pointer_mut(pointer) {
            *id = json!("qst_other01");
        }
    }
    answer(
        &world,
        "GET",
        "/questions/qst_upload1",
        json_response(200, &other),
    )
    .await;

    let run = rh(&world, &["--json", "ask", "--question", "qst_upload1"])?;
    assert_ne!(run.code, Some(0), "{}", run.stdout);
    assert_eq!(run.at("/error/code")?, json!("malformed_response"));
    assert_eq!(run.at("/data")?, Value::Null);
    assert!(!run.stdout.contains("qst_other01"), "{}", run.stdout);
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 1);
    assert!(!any_wait(&world, "/questions/qst_upload1").await);
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn an_ask_whose_answer_is_lost_names_the_key_to_reconcile_it() -> anyhow::Result<()> {
    // A backend that reads the request and closes the connection without answering: a dropped
    // connection is reported as unreachable, as every other command reports it.
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    let origin = format!("http://{}", listener.local_addr()?);
    // Accept until a deadline, so a run that never connects fails its assertions, not the job.
    listener.set_nonblocking(true)?;
    let closer = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let _ = stream.set_nonblocking(false);
                    let mut buffer = [0_u8; 4096];
                    let _ = std::io::Read::read(&mut stream, &mut buffer);
                    return;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return,
            }
        }
    });
    let world = world_at(MockServer::start().await, &origin)?;
    let run = rh_in_clone(&world, &ask_args(QUESTION, "src/upload.ts"))?;
    let _ = closer.join();
    assert_eq!(run.code, Some(1), "{}", run.stdout);
    assert_eq!(run.at("/error/code")?, json!("unreachable"));
    assert_eq!(run.at("/error/retryable")?, json!(true));
    assert_eq!(run.at("/error/next")?, json!("rh ask"));
    let message = run.at("/error/message")?;
    let message = message.as_str().unwrap_or_default();
    let key = message
        .split_whitespace()
        .find(|word| word.starts_with("req_"))
        .unwrap_or_default();
    assert!(
        message.starts_with("the question may or may not have been recorded; repeat the same rh ask with --request-id req_")
            && key.len() == 36,
        "{message}"
    );
    Ok(())
}

#[tokio::test]
async fn an_ask_answered_badly_or_refused_for_now_still_names_its_key() -> anyhow::Result<()> {
    let world = world().await?;
    let route = format!("{PREFIX}/claims/clm_42abcd/questions");
    // Answered with an answered question that carries no decision.
    let inconsistent = json!({"ok": true, "data": {"questionId": "qst_upload1",
        "decisionId": "dec_upload1", "state": "answered", "decision": null},
        "inbox": null, "next": null});
    for response in [
        ResponseTemplate::new(200).set_body_raw("<html>oops</html>", "application/json"),
        json_response(200, &inconsistent),
        json_response(
            500,
            &json!({"ok": false, "error": {"code": "internal", "message": "Try again.",
                "retryable": true, "retryAfterMs": null, "next": null}}),
        ),
    ] {
        Mock::given(method("POST"))
            .and(path(route.clone()))
            .respond_with(response)
            .up_to_n_times(1)
            .mount(&world.server)
            .await;
    }
    let mut runs = Vec::new();
    for _ in 0..3 {
        runs.push(rh_in_clone(&world, &ask_args(QUESTION, "src/upload.ts"))?);
    }
    let keys: Vec<String> = received(&world, "/claims/clm_42abcd/questions")
        .await
        .iter()
        .filter_map(|request| serde_json::from_slice::<Value>(&request.body).ok())
        .filter_map(|body| {
            body.pointer("/requestId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    anyhow::ensure!(keys.len() == 3, "{keys:?}");
    for ((run, key), code) in
        runs.iter()
            .zip(&keys)
            .zip(["malformed_response", "malformed_response", "internal"])
    {
        assert_eq!(run.code, Some(1), "{}", run.stdout);
        assert_eq!(run.at("/error/code")?, json!(code));
        assert_eq!(run.at("/error/retryable")?, json!(true));
        assert_eq!(run.at("/error/next")?, json!("rh ask"));
        let named = format!("--request-id {key}");
        let message = run.at("/error/message")?;
        assert!(
            message.as_str().is_some_and(|text| text.contains(&named)),
            "{key} not named in the error: {message}"
        );
    }
    assert!(!runs.iter().any(|run| run.stdout.contains("oops")));
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn an_interrupted_wait_leaves_the_question_to_resume() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "GET",
        "/questions/qst_upload1",
        fixture("question.json", "a long poll that times out is still open")?
            .set_delay(Duration::from_secs(20)),
    )
    .await;
    let child = command(
        &world,
        world.outside.path(),
        Some("atlas"),
        &["--json", "ask", "--question", "qst_upload1", "--wait", "60"],
    )
    .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while received(&world, "/questions/qst_upload1").await.is_empty() {
        anyhow::ensure!(Instant::now() < deadline, "the poll never arrived");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let interrupted = Instant::now();
    rustix::process::kill_process(
        rustix::process::Pid::from_child(&child),
        rustix::process::Signal::INT,
    )?;
    let run = finish(&child.wait_with_output()?)?;
    assert!(interrupted.elapsed() < Duration::from_secs(5));
    assert_eq!(run.code, None, "the process was not stopped by the signal");
    assert_eq!(run.stdout, "", "a partial result was printed");
    assert!(
        run.stderr
            .contains("resume with rh ask --question qst_upload1 --wait 60"),
        "{}",
        run.stderr
    );
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 1);
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

/// Waits until the server has received a request on `route`.
async fn arrived(world: &World, route: &str) -> anyhow::Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while received(world, route).await.is_empty() {
        anyhow::ensure!(Instant::now() < deadline, "no request on {route}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn an_ask_interrupted_in_flight_has_already_named_its_key() -> anyhow::Result<()> {
    let world = world().await?;
    let route = "/claims/clm_42abcd/questions";
    // The first ask is recorded but its answer is held until the process is gone.
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}{route}")))
        .respond_with(
            fixture("ask.json", "asks the owner and returns at once")?
                .set_delay(Duration::from_secs(20)),
        )
        .up_to_n_times(1)
        .mount(&world.server)
        .await;
    answer(
        &world,
        "POST",
        route,
        fixture("ask.json", "asks the owner and returns at once")?,
    )
    .await;
    let child = command(
        &world,
        world.clone.path(),
        None,
        &ask_args(QUESTION, "src/upload.ts"),
    )
    .spawn()?;
    arrived(&world, route).await?;
    rustix::process::kill_process(
        rustix::process::Pid::from_child(&child),
        rustix::process::Signal::INT,
    )?;
    let run = finish(&child.wait_with_output()?)?;
    assert_eq!(run.code, None, "the process was not stopped by the signal");
    assert_eq!(run.stdout, "", "a partial result was printed");

    let sent = received(&world, route).await;
    let first: Value =
        serde_json::from_slice(&sent.first().map(|r| r.body.clone()).unwrap_or_default())?;
    let key = first
        .pointer("/requestId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    assert!(key.starts_with("req_"), "{first}");
    assert!(
        run.stderr.contains(&format!(
            "if interrupted, repeat the same rh ask with --request-id {key} "
        )),
        "{}",
        run.stderr
    );

    // Repeating the ask with that key sends the same key, so the backend finds the question.
    let mut args = ask_args(QUESTION, "src/upload.ts");
    args.extend(["--request-id", &key]);
    let again = rh_in_clone(&world, &args)?;
    assert_eq!(again.code, Some(0), "{}", again.stdout);
    assert_eq!(again.at("/data/requestId")?, json!(key));
    assert!(!again.stderr.contains("asking with"), "{}", again.stderr);
    let keys: Vec<Value> = received(&world, route)
        .await
        .iter()
        .filter_map(|request| serde_json::from_slice::<Value>(&request.body).ok())
        .filter_map(|body| body.pointer("/requestId").cloned())
        .collect();
    assert_eq!(keys, vec![json!(key), json!(key)]);
    Ok(())
}

#[tokio::test]
async fn a_held_poll_ends_at_the_wait_deadline() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/claims/clm_42abcd/questions",
        fixture("ask.json", "asks the owner and returns at once")?,
    )
    .await;
    // The backend holds every poll far beyond the wait, then answers.
    let stall = Held::new(fixture(
        "question.json",
        "an answered question carries the decision",
    )?);
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/questions/qst_upload1")))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(stall.clone())
        .mount(&world.server)
        .await;

    // Asked and waited on: the wait ends with the question as asked, before the held answer.
    let mut args = ask_args(QUESTION, "src/upload.ts");
    args.extend(["--wait", "2"]);
    let started = Instant::now();
    let run = rh_in_clone(&world, &args)?;
    let exited = Instant::now();
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    let elapsed = exited.duration_since(started);
    assert!(elapsed >= Duration::from_secs(2), "{elapsed:?}");
    let open = stall.open_until(exited)?;
    assert!(open < Duration::from_secs(2) + EXIT_SLACK, "{open:?}");
    assert_eq!(run.at("/data/timedOut")?, json!(true));
    assert_eq!(run.at("/data/question/state")?, json!("open"));
    assert_eq!(run.at("/next")?, json!("rh ask"));
    let polls = received(&world, "/questions/qst_upload1").await;
    assert_eq!(polls.len(), 1);
    let held = polls
        .first()
        .and_then(|poll| poll.url.query_pairs().find(|(key, _)| key == "waitMs"))
        .and_then(|(_, value)| value.parse::<u64>().ok())
        .unwrap_or(u64::MAX);
    assert!((1_000..=1_500).contains(&held), "{held}");

    // Resumed: nothing of the question is known, so the timeout says how to wait again.
    let started = Instant::now();
    let run = rh(
        &world,
        &["--json", "ask", "--question", "qst_upload1", "--wait", "1"],
    )?;
    let exited = Instant::now();
    let elapsed = exited.duration_since(started);
    assert!(elapsed >= Duration::from_secs(1), "{elapsed:?}");
    let open = stall.open_until(exited)?;
    assert!(open < Duration::from_secs(1) + EXIT_SLACK, "{open:?}");
    assert_eq!(run.code, Some(1), "{}", run.stdout);
    assert_eq!(run.at("/error/code")?, json!("timeout"));
    assert_eq!(run.at("/error/retryable")?, json!(true));
    assert_eq!(run.at("/error/next")?, json!("rh ask"));
    let message = run.at("/error/message")?;
    assert!(
        message.as_str().is_some_and(
            |text| text.ends_with("wait again with rh ask --question qst_upload1 --wait 1")
        ),
        "{message}"
    );
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 2);
    assert_eq!(acks(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_session_renewal_during_a_wait_ends_at_the_deadline() -> anyhow::Result<()> {
    let world = world().await?;
    let origin = world.server.uri();
    let atlas = world.home.path().join("agents/atlas");
    fs::remove_file(atlas.join("session"))?;
    write_private(&atlas.join("session"), &session_record(&origin, TOKEN, 1))?;
    let key = PrivateKey::random(&mut OsRng, Algorithm::Ed25519)?;
    write_private(&atlas.join("key"), &key.to_openssh(LineEnding::LF)?)?;
    let message = format!(
        "railhead-login-v1\norigin={origin}\nrepo=casqueblanc/demo\nagent=agt_atlas01\nchallenge={CHALLENGE}\nexpires={EXPIRES}\n"
    );
    let challenge = json_response(
        200,
        &json!({"ok": true, "data": {"challengeId": CHALLENGE, "expiresAt": EXPIRES,
            "message": message}, "inbox": null, "next": null}),
    );
    // The first login's challenge is held far beyond the wait.
    let stall = Held::new(challenge.clone());
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/session/challenge")))
        .respond_with(stall.clone())
        .up_to_n_times(1)
        .mount(&world.server)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/session/challenge")))
        .respond_with(challenge)
        .mount(&world.server)
        .await;
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/session")))
        .respond_with(json_response(
            200,
            &json!({"ok": true, "data": {"token": FRESH, "expiresAt": 4_102_444_800_000_u64,
                "agent": {"agentId": "agt_atlas01", "name": "atlas", "ownerId": "usr_lemarier",
                "state": "confirmed"}, "repoId": "rep_demo0001"}, "inbox": null, "next": null}),
        ))
        .mount(&world.server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("{PREFIX}/questions/qst_upload1")))
        .and(header("authorization", format!("Bearer {FRESH}").as_str()))
        .respond_with(fixture(
            "question.json",
            "an answered question carries the decision",
        )?)
        .mount(&world.server)
        .await;

    let args = ["--json", "ask", "--question", "qst_upload1", "--wait", "2"];
    let started = Instant::now();
    let run = rh(&world, &args)?;
    let exited = Instant::now();
    let elapsed = exited.duration_since(started);
    assert!(elapsed >= Duration::from_secs(2), "{elapsed:?}");
    let open = stall.open_until(exited)?;
    assert!(open < Duration::from_secs(2) + EXIT_SLACK, "{open:?}");
    assert_eq!(run.code, Some(1), "{}", run.stdout);
    assert_eq!(run.at("/error/code")?, json!("timeout"));
    assert_eq!(run.at("/error/next")?, json!("rh ask"));
    // The login stopped at its challenge, and no poll was sent.
    assert_eq!(received(&world, "/session").await.len(), 0);
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 0);

    // A renewal that answers in time is used for the poll.
    let run = rh(&world, &args)?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(run.at("/data/question/state")?, json!("answered"));
    assert_eq!(run.at("/data/timedOut")?, json!(false));
    let stored: Value = serde_json::from_str(&fs::read_to_string(atlas.join("session"))?)?;
    assert_eq!(stored.pointer("/token"), Some(&json!(FRESH)));
    Ok(())
}

#[tokio::test]
async fn a_wait_that_fails_after_asking_names_the_question_to_resume() -> anyhow::Result<()> {
    let world = world().await?;
    let route = "/claims/clm_42abcd/questions";
    answer(
        &world,
        "POST",
        route,
        fixture("ask.json", "asks the owner and returns at once")?,
    )
    .await;
    for response in [
        json_response(
            500,
            &json!({"ok": false, "error": {"code": "internal", "message": "Try again.",
                "retryable": true, "retryAfterMs": null, "next": null}}),
        ),
        ResponseTemplate::new(200).set_body_raw("<html>oops</html>", "application/json"),
    ] {
        Mock::given(method("GET"))
            .and(path(format!("{PREFIX}/questions/qst_upload1")))
            .respond_with(response)
            .up_to_n_times(1)
            .mount(&world.server)
            .await;
    }
    let mut args = ask_args(QUESTION, "src/upload.ts");
    args.extend(["--wait", "30"]);
    let refused = rh_in_clone(&world, &args)?;
    let malformed = rh_in_clone(&world, &args)?;

    let keys: Vec<String> = received(&world, route)
        .await
        .iter()
        .filter_map(|request| serde_json::from_slice::<Value>(&request.body).ok())
        .filter_map(|body| {
            body.pointer("/requestId")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    anyhow::ensure!(keys.len() == 2, "{keys:?}");
    for ((run, key), (code, retryable, next)) in [&refused, &malformed].iter().zip(&keys).zip([
        ("internal", true, json!("rh ask")),
        ("malformed_response", false, Value::Null),
    ]) {
        assert_eq!(run.code, Some(1), "{}", run.stdout);
        assert_eq!(run.at("/error/code")?, json!(code));
        assert_eq!(run.at("/error/retryable")?, json!(retryable));
        assert_eq!(run.at("/error/next")?, next);
        let message = run.at("/error/message")?;
        let expected = format!(
            "question qst_upload1 was asked with --request-id {key}; resume with rh ask --question qst_upload1 --wait 30"
        );
        assert!(
            message
                .as_str()
                .is_some_and(|text| text.contains(&expected)),
            "{message}"
        );
    }
    assert!(!malformed.stdout.contains("oops"));
    // Each wait failed at its one poll; nothing was asked again.
    assert_eq!(received(&world, "/questions/qst_upload1").await.len(), 2);
    assert_eq!(acks(&world).await, 0);
    Ok(())
}
