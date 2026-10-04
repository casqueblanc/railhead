//! `rh work`, `rh claim`, `rh ready` and `rh status` end to end.
//!
//! Each test runs the built binary against a temporary identity store, a wiremock server that
//! answers with the A01 wire fixtures, and a real bare Git repository standing in for the claim's
//! fork. Git reaches the fork through a `url.<fork>.insteadOf` rewrite of the Railhead fork URL, so
//! the clone's `origin` remote keeps the address the backend named. "Sends nothing" is asserted on
//! the server's request log.

use std::fs;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

use serde_json::{Value, json};
use wiremock::matchers::{body_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const TOKEN: &str = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ3RfYXRsYXMwMSJ9.c2lnbmF0dXJlLXNlY3JldA";
const PREFIX: &str = "/agent/v1/casqueblanc/demo";
const FORK_PATH: &str = "/git/casqueblanc/demo/claims/clm_42abcd.git";

struct World {
    server: MockServer,
    home: tempfile::TempDir,
    work: tempfile::TempDir,
    /// The bare repository standing in for the claim's fork.
    fork: PathBuf,
    /// The global Git config the binary and its Git see.
    git_config: PathBuf,
    /// The commit the fork's `main` holds.
    fork_head: String,
}

fn git_env(command: &mut Command, git_config: &Path) {
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", git_config)
        .env("GIT_AUTHOR_NAME", "atlas")
        .env("GIT_AUTHOR_EMAIL", "atlas@example.invalid")
        .env("GIT_COMMITTER_NAME", "atlas")
        .env("GIT_COMMITTER_EMAIL", "atlas@example.invalid");
}

fn git_in(world: &World, dir: &Path, args: &[&str]) -> anyhow::Result<String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(dir).args(args);
    git_env(&mut command, &world.git_config);
    let output = command.output()?;
    anyhow::ensure!(output.status.success(), "git {args:?} failed");
    Ok(String::from_utf8(output.stdout)?.trim_end().to_owned())
}

/// `atlas`'s stored session record: [`TOKEN`], issued by `origin` and valid until 2100.
fn session_record(origin: &str) -> String {
    json!({"agentId": "agt_atlas01", "origin": origin, "repo": "casqueblanc/demo",
        "token": TOKEN, "expiresAt": 4_102_444_800_000_u64})
    .to_string()
}

fn write_private(path: &Path, contents: &str) -> anyhow::Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(contents.as_bytes())?;
    Ok(())
}

/// A store with `atlas` (with a session) and `boreas` (without one), a fork with one commit on
/// `main`, and Git configured to reach the fork's Railhead URL on disk.
async fn world() -> anyhow::Result<World> {
    // A server of its own rather than one from wiremock's pool: a pooled server keeps its port from
    // test to test, so a request a process from an earlier test sends late would be counted here.
    let server = MockServer::builder().start().await;
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
        let record = json!({"name": name, "agentId": id, "origin": server.uri(),
            "repo": "casqueblanc/demo"});
        write_private(&dir.join("identity.json"), &record.to_string())?;
    }
    write_private(
        &home.path().join("agents/atlas/session"),
        &session_record(&server.uri()),
    )?;

    let work = tempfile::tempdir()?;
    let fork = work.path().join("fork.git");
    let git_config = work.path().join("gitconfig");
    let mut world = World {
        server,
        home,
        work,
        fork,
        git_config,
        fork_head: String::new(),
    };
    point_fork_at(&world, &world.fork)?;
    let seed = world.work.path().join("seed");
    fs::create_dir(&seed)?;
    git_in(
        &world,
        &seed,
        &["init", "--quiet", "--initial-branch", "main"],
    )?;
    fs::write(seed.join("README.md"), "demo\n")?;
    git_in(&world, &seed, &["add", "README.md"])?;
    git_in(&world, &seed, &["commit", "--quiet", "-m", "base"])?;
    let fork = world.fork.display().to_string();
    git_in(
        &world,
        world.work.path(),
        &["init", "--quiet", "--bare", &fork],
    )?;
    git_in(&world, &seed, &["push", "--quiet", &fork, "main"])?;
    world.fork_head = git_in(&world, &seed, &["rev-parse", "HEAD"])?;
    Ok(world)
}

/// Makes Git fetch the claim's fork URL from `target`.
fn point_fork_at(world: &World, target: &Path) -> anyhow::Result<()> {
    let config = format!(
        "[url \"file://{}\"]\n\tinsteadOf = {}{FORK_PATH}\n",
        target.display(),
        world.server.uri()
    );
    fs::write(&world.git_config, config)?;
    Ok(())
}

impl World {
    /// The working directory, as the binary sees it once symbolic links are resolved.
    fn outside(&self) -> PathBuf {
        fs::canonicalize(self.work.path()).unwrap_or_else(|_| self.work.path().to_owned())
    }

    fn clone_dir(&self) -> PathBuf {
        self.outside().join("demo-clm_42abcd")
    }
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

    fn error_code(&self) -> anyhow::Result<Value> {
        Ok(self
            .json()?
            .pointer("/error/code")
            .cloned()
            .unwrap_or(Value::Null))
    }
}

fn rh(world: &World, dir: &Path, agent: Option<&str>, args: &[&str]) -> anyhow::Result<Run> {
    rh_with(world, dir, agent, &[], args)
}

/// `rh` with extra environment variables.
fn rh_with(
    world: &World,
    dir: &Path,
    agent: Option<&str>,
    env: &[(&str, &str)],
    args: &[&str],
) -> anyhow::Result<Run> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rh"));
    command
        .args(args)
        .envs(env.iter().copied())
        .current_dir(dir)
        .env("RAILHEAD_HOME", world.home.path())
        .env_remove("RAILHEAD_AGENT")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    git_env(&mut command, &world.git_config);
    if let Some(agent) = agent {
        command.env("RAILHEAD_AGENT", agent);
    }
    let Output {
        status,
        stdout,
        stderr,
    } = command.output()?;
    let run = Run {
        code: status.code(),
        stdout: String::from_utf8(stdout)?,
        stderr: String::from_utf8(stderr)?,
    };
    for stream in [&run.stdout, &run.stderr] {
        assert!(!stream.contains("c2lnbmF0dXJl"), "token leaked: {stream}");
    }
    Ok(run)
}

/// The response of the fixture exchange named `name`, with the fixture origin replaced by the
/// mock server's.
fn fixture(world: &World, file: &str, name: &str) -> anyhow::Result<ResponseTemplate> {
    let path = format!(
        "{}/../../fixtures/protocol/wire/agent/{file}",
        env!("CARGO_MANIFEST_DIR")
    );
    let corpus: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    let exchange = corpus
        .pointer("/exchanges")
        .and_then(Value::as_array)
        .and_then(|exchanges| {
            exchanges
                .iter()
                .find(|exchange| exchange.pointer("/name") == Some(&json!(name)))
        })
        .ok_or_else(|| anyhow::anyhow!("{file} has no exchange {name:?}"))?;
    let status = exchange
        .pointer("/response/status")
        .and_then(Value::as_u64)
        .and_then(|status| u16::try_from(status).ok())
        .ok_or_else(|| anyhow::anyhow!("{file} {name:?} has no status"))?;
    let body = exchange
        .pointer("/response/body")
        .ok_or_else(|| anyhow::anyhow!("{file} {name:?} has no body"))?
        .to_string()
        .replace("https://railhead.dev", &world.server.uri());
    Ok(ResponseTemplate::new(status).set_body_raw(body, "application/json"))
}

async fn answer(world: &World, verb: &str, route: &str, response: ResponseTemplate) {
    Mock::given(method(verb))
        .and(path(format!("{PREFIX}{route}")))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .respond_with(response)
        .mount(&world.server)
        .await;
}

async fn requests(world: &World) -> usize {
    world
        .server
        .received_requests()
        .await
        .map_or(0, |requests| requests.len())
}

/// Each request the server received, as `METHOD path`, in arrival order.
async fn routes(world: &World) -> Vec<String> {
    world
        .server
        .received_requests()
        .await
        .unwrap_or_default()
        .iter()
        .map(|request| format!("{} {}", request.method, request.url.path()))
        .collect()
}

fn git_config_value(world: &World, dir: &Path, key: &str) -> anyhow::Result<String> {
    git_in(world, dir, &["config", "--local", "--get", key])
}

#[tokio::test]
async fn work_clones_the_fork_binds_the_agent_and_prints_the_task() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "claims the next ready issue")?,
    )
    .await;

    let run = rh(&world, &world.outside(), Some("atlas"), &["--json", "work"])?;
    assert_eq!(run.code, Some(0), "{}", run.stdout);
    let envelope = run.json()?;
    assert_eq!(
        envelope.pointer("/data/claim/claimId"),
        Some(&json!("clm_42abcd"))
    );
    assert_eq!(envelope.pointer("/data/resumed"), Some(&json!(false)));
    assert_eq!(
        envelope.pointer("/data/clone/state"),
        Some(&json!("created"))
    );
    assert_eq!(
        envelope.pointer("/data/claim/task/title"),
        Some(&json!("Handle large uploads"))
    );
    assert_eq!(envelope.pointer("/inbox/pending"), Some(&json!(0)));

    let clone = world.clone_dir();
    assert_eq!(
        envelope.pointer("/data/clone/dir"),
        Some(&json!(clone.display().to_string()))
    );
    let uri = world.server.uri();
    for (key, value) in [
        ("railhead.identity", "agt_atlas01".to_owned()),
        ("railhead.generation", "1".to_owned()),
        ("remote.origin.url", format!("{uri}{FORK_PATH}")),
        (
            "remote.upstream.url",
            format!("{uri}/git/casqueblanc/demo.git"),
        ),
        (
            "remote.upstream.pushurl",
            "upstream-is-read-only".to_owned(),
        ),
        ("credential.useHttpPath", "true".to_owned()),
        ("branch.main.remote", "origin".to_owned()),
    ] {
        assert_eq!(git_config_value(&world, &clone, key)?, value, "{key}");
    }
    let helpers = git_in(
        &world,
        &clone,
        &["config", "--local", "--get-all", "credential.helper"],
    )?;
    let helpers: Vec<&str> = helpers.lines().collect();
    assert_eq!(helpers.first(), Some(&""), "{helpers:?}");
    assert!(
        helpers
            .get(1)
            .is_some_and(|helper| helper.ends_with("' credential")),
        "{helpers:?}"
    );
    assert_eq!(helpers.len(), 2);
    assert_eq!(
        git_in(&world, &clone, &["rev-parse", "HEAD"])?,
        world.fork_head
    );
    assert!(clone.join("README.md").is_file());
    let litter: Vec<_> = fs::read_dir(world.work.path())?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().contains("rh-partial"))
        .collect();
    assert!(litter.is_empty(), "{litter:?}");

    Ok(())
}

#[tokio::test]
async fn status_inside_a_clone_prints_the_task_and_the_inbox() -> anyhow::Result<()> {
    let world = world().await?;
    let work = fixture(&world, "work.json", "claims the next ready issue")?;
    answer(&world, "POST", "/work", work).await;
    assert_eq!(
        rh(&world, &world.outside(), Some("atlas"), &["work"])?.code,
        Some(0)
    );
    let clone = world.clone_dir();

    // Inside the clone the agent is bound: status needs no RAILHEAD_AGENT.
    let status = fixture(
        &world,
        "status.json",
        "shows the agent, its claim and its inbox first",
    )?;
    answer(&world, "GET", "/status", status).await;
    let run = rh(&world, &clone, None, &["status"])?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    let expected = format!(
        "agent \"atlas\" (\"agt_atlas01\"), confirmed\nclaim \"clm_42abcd\"\n\
         issue \"iss_upload1\", working, generation 1\ntask: \"Handle large uploads\"\n\
         \x20 \"Uploads above 10 MB fail. Follow the decision.\"\nclone: {}\n\
         inbox item 17: rework for decision \"dec_upload1\" v2\n\
         inbox: 1 unacknowledged; read them with rh sync\nnext: rh sync\n",
        clone.display()
    );
    assert_eq!(run.stdout, expected);
    Ok(())
}

#[tokio::test]
async fn a_repeated_claim_resumes_the_same_clone_and_keeps_edits() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/claims",
        fixture(&world, "claim.json", "claims the named issue")?,
    )
    .await;
    let first = rh(
        &world,
        &world.outside(),
        Some("atlas"),
        &["claim", "iss_upload1"],
    )?;
    assert_eq!(first.code, Some(0), "{}", first.stderr);
    assert!(
        first.stdout.starts_with("claimed \"clm_42abcd\"\n"),
        "{}",
        first.stdout
    );
    assert!(
        first.stdout.contains("task: \"Handle large uploads\""),
        "{}",
        first.stdout
    );

    // The agent edits a tracked file, adds an untracked one and commits locally.
    let clone = world.clone_dir();
    fs::write(clone.join("notes.txt"), "draft\n")?;
    git_in(&world, &clone, &["add", "notes.txt"])?;
    git_in(&world, &clone, &["commit", "--quiet", "-m", "wip"])?;
    let local_head = git_in(&world, &clone, &["rev-parse", "HEAD"])?;
    fs::write(clone.join("README.md"), "edited\n")?;
    fs::write(clone.join("scratch.txt"), "untracked\n")?;

    // The fork is unreachable now, so a reuse that fetched or re-cloned would fail.
    // Settings Railhead owns gain second values, which plain `git config` refuses to replace.
    git_in(
        &world,
        &clone,
        &["remote", "set-branches", "--add", "origin", "spike"],
    )?;
    git_in(
        &world,
        &clone,
        &[
            "config",
            "--add",
            "remote.upstream.pushurl",
            "file:///elsewhere.git",
        ],
    )?;

    point_fork_at(&world, &world.work.path().join("gone.git"))?;
    world.server.reset().await;
    let resumed = ResponseTemplate::new(200).set_body_raw(
        resumed_claim_body(&world, "claim.json")?,
        "application/json",
    );
    answer(&world, "POST", "/claims", resumed).await;

    for (dir, agent, args) in [
        (clone.clone(), None, vec!["--json", "claim", "iss_upload1"]),
        (
            world.outside(),
            Some("atlas"),
            vec!["--json", "claim", "iss_upload1"],
        ),
        (
            world.outside(),
            Some("atlas"),
            vec!["--json", "claim", "iss_upload1", "--dir", "demo-clm_42abcd"],
        ),
    ] {
        let run = rh(&world, &dir, agent, &args)?;
        assert_eq!(run.code, Some(0), "{args:?}: {}", run.stdout);
        let envelope = run.json()?;
        assert_eq!(envelope.pointer("/data/resumed"), Some(&json!(true)));
        assert_eq!(
            envelope.pointer("/data/clone/state"),
            Some(&json!("reused"))
        );
        assert_eq!(fs::read_to_string(clone.join("README.md"))?, "edited\n");
        assert_eq!(
            fs::read_to_string(clone.join("scratch.txt"))?,
            "untracked\n"
        );
        assert_eq!(git_in(&world, &clone, &["rev-parse", "HEAD"])?, local_head);
    }
    for (key, value) in [
        ("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"),
        ("remote.upstream.pushurl", "upstream-is-read-only"),
    ] {
        let values = git_in(&world, &clone, &["config", "--local", "--get-all", key])?;
        assert_eq!(values, value, "{key}");
    }
    // No second clone appeared beside the first.
    let clones = fs::read_dir(world.work.path())?
        .filter_map(std::result::Result::ok)
        .filter(|entry| entry.file_name().to_string_lossy().starts_with("demo-"))
        .count();
    assert_eq!(clones, 1);
    Ok(())
}

/// The first exchange of `file` with `resumed` set, as the backend answers a repeated claim.
fn resumed_claim_body(world: &World, file: &str) -> anyhow::Result<String> {
    let path = format!(
        "{}/../../fixtures/protocol/wire/agent/{file}",
        env!("CARGO_MANIFEST_DIR")
    );
    let mut corpus: Value = serde_json::from_str(&fs::read_to_string(path)?)?;
    let body = corpus
        .pointer_mut("/exchanges/0/response/body")
        .ok_or_else(|| anyhow::anyhow!("{file} has no first exchange"))?;
    if let Some(resumed) = body.pointer_mut("/data/resumed") {
        *resumed = json!(true);
    }
    Ok(body
        .to_string()
        .replace("https://railhead.dev", &world.server.uri()))
}

#[tokio::test]
async fn a_failed_clone_leaves_nothing_and_the_next_run_recovers() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "claims the next ready issue")?,
    )
    .await;
    point_fork_at(&world, &world.work.path().join("missing.git"))?;

    let failed = rh(&world, &world.outside(), Some("atlas"), &["--json", "work"])?;
    assert_eq!(failed.code, Some(1));
    let envelope = failed.json()?;
    assert_eq!(envelope.pointer("/error/code"), Some(&json!("git")));
    assert_eq!(envelope.pointer("/error/retryable"), Some(&json!(true)));
    let message = envelope
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(
        message.starts_with("fetching the claim's fork: git exited with status"),
        "{message}"
    );
    assert!(
        message.contains("running the command again resumes the claim"),
        "{message}"
    );
    let left: Vec<_> = fs::read_dir(world.work.path())?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("clm_42abcd"))
        .collect();
    assert!(left.is_empty(), "{left:?}");

    point_fork_at(&world, &world.fork)?;
    let recovered = rh(&world, &world.outside(), Some("atlas"), &["--json", "work"])?;
    assert_eq!(recovered.code, Some(0), "{}", recovered.stdout);
    assert_eq!(
        recovered.json()?.pointer("/data/clone/state"),
        Some(&json!("created"))
    );
    assert_eq!(
        git_in(&world, &world.clone_dir(), &["rev-parse", "HEAD"])?,
        world.fork_head
    );
    assert_eq!(requests(&world).await, 2);
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_git_that_never_exits_is_stopped_and_the_next_run_recovers() -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    use std::time::{Duration, Instant};

    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "claims the next ready issue")?,
    )
    .await;
    // The fork's upload pack, which Git starts for the fetch, records its process and never
    // answers. It ignores SIGTERM, so only killing its process group ends it.
    let pid_file = world.work.path().join("upload-pack.pid");
    let hang = world.work.path().join("hang.sh");
    fs::write(
        &hang,
        format!(
            "#!/bin/sh\necho $$ > '{}'\ntrap '' TERM\nwhile :; do sleep 1; done\n",
            pid_file.display()
        ),
    )?;
    fs::set_permissions(&hang, fs::Permissions::from_mode(0o755))?;
    point_fork_at(&world, &world.fork)?;
    let pointed = fs::read_to_string(&world.git_config)?;
    fs::write(
        &world.git_config,
        format!(
            "{pointed}[remote \"origin\"]\n\tuploadpack = {}\n",
            hang.display()
        ),
    )?;
    // The empty target and a directory beside it are both kept as they were.
    fs::create_dir(world.clone_dir())?;
    let beside = world.outside().join("demo-clm_old001");
    fs::create_dir(&beside)?;
    fs::write(beside.join("notes.txt"), "draft\n")?;

    // The limit applies to every Git step of the run, not only the fetch: the init and the config
    // writes before it must each finish within it on a loaded machine, so it leaves them a wide
    // margin. Only the upload pack is meant to reach it.
    let started = Instant::now();
    let stopped = rh_with(
        &world,
        &world.outside(),
        Some("atlas"),
        &[("RAILHEAD_GIT_TIMEOUT", "10")],
        &["--json", "work"],
    )?;
    assert!(started.elapsed() < Duration::from_secs(60));
    assert_eq!(stopped.code, Some(1), "{}", stopped.stdout);
    let envelope = stopped.json()?;
    assert_eq!(envelope.pointer("/error/code"), Some(&json!("git")));
    assert_eq!(envelope.pointer("/error/retryable"), Some(&json!(true)));
    let message = envelope
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(
        message.starts_with(
            "fetching the claim's fork: git was still running after 10 seconds and was stopped"
        ) && message.contains("running the command again resumes the claim"),
        "{message}"
    );
    let pid: i32 = fs::read_to_string(&pid_file)?.trim().parse()?;
    let gone = Instant::now() + Duration::from_secs(5);
    while Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()?
        .success()
    {
        assert!(Instant::now() < gone, "the upload pack {pid} still runs");
        std::thread::sleep(Duration::from_millis(50));
    }
    assert_eq!(fs::read_dir(world.clone_dir())?.count(), 0);
    assert_eq!(fs::read_to_string(beside.join("notes.txt"))?, "draft\n");
    let partial: Vec<_> = fs::read_dir(world.work.path())?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("rh-partial"))
        .collect();
    assert!(partial.is_empty(), "{partial:?}");

    // The same claim, rerun with a Git that answers, resumes into the kept target.
    point_fork_at(&world, &world.fork)?;
    let recovered = rh(&world, &world.outside(), Some("atlas"), &["--json", "work"])?;
    assert_eq!(recovered.code, Some(0), "{}", recovered.stdout);
    assert_eq!(
        recovered.json()?.pointer("/data/clone/state"),
        Some(&json!("created"))
    );
    assert_eq!(
        git_in(&world, &world.clone_dir(), &["rev-parse", "HEAD"])?,
        world.fork_head
    );
    let work = format!("POST {PREFIX}/work");
    assert_eq!(routes(&world).await, [work.as_str(), work.as_str()]);
    Ok(())
}

/// Where the thread that ran an interrupted Git step stalls, through the debug-build hook, so the
/// signal watcher must end `rh` before that thread has cleaned up.
#[cfg(unix)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum Stall {
    /// No stall: the step stops Git and removes its partial clone itself.
    None,
    /// Before the step stops Git: the watcher must kill and reap Git's group and set the partial
    /// clone aside.
    Stop,
    /// After the step set its partial clone aside, before removing it.
    Cleanup,
}

/// Names of the entries in `dir` that contain `part`.
#[cfg(unix)]
fn entries_named(dir: &Path, part: &str) -> anyhow::Result<Vec<String>> {
    Ok(fs::read_dir(dir)?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(part))
        .collect())
}

/// `rh work` whose fetch never ends, ended with `signal`, and with `second` once the first has
/// been seen: its Git process group is gone by the time `rh` exits, `rh` ends as the first signal
/// would have ended it, and no partial clone is left under its staging name. When `stall` keeps
/// the step from cleaning up, `rh` ends at the signal watcher's limit with the partial clone set
/// aside, and the next `rh work` removes it.
#[cfg(unix)]
async fn signal_during_fetch(
    signal: rustix::process::Signal,
    second: Option<rustix::process::Signal>,
    stall: Stall,
) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    use std::os::unix::process::ExitStatusExt as _;
    use std::time::{Duration, Instant};

    /// The signal watcher's limit in `rh`.
    const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "claims the next ready issue")?,
    )
    .await;
    // The fork's upload pack records its own process and its parent, which Git started, and never
    // answers. It ignores SIGTERM, so only killing the process group ends it.
    let pid_file = world.work.path().join("upload-pack.pid");
    let hang = world.work.path().join("hang.sh");
    fs::write(
        &hang,
        format!(
            "#!/bin/sh\necho $$ $PPID > '{0}.tmp'\nmv '{0}.tmp' '{0}'\ntrap '' TERM\n\
             while :; do sleep 1; done\n",
            pid_file.display()
        ),
    )?;
    fs::set_permissions(&hang, fs::Permissions::from_mode(0o755))?;
    point_fork_at(&world, &world.fork)?;
    let pointed = fs::read_to_string(&world.git_config)?;
    fs::write(
        &world.git_config,
        format!(
            "{pointed}[remote \"origin\"]\n\tuploadpack = {}\n",
            hang.display()
        ),
    )?;

    // The Git deadline is far away, so only the signal stops the fetch.
    let mut command = Command::new(env!("CARGO_BIN_EXE_rh"));
    command
        .args(["--json", "work"])
        .current_dir(world.outside())
        .env("RAILHEAD_HOME", world.home.path())
        .env("RAILHEAD_AGENT", "atlas")
        .env("RAILHEAD_GIT_TIMEOUT", "3600")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    match stall {
        Stall::None => command.env_remove("RH_TEST_SHUTDOWN_STALL"),
        Stall::Stop => command.env("RH_TEST_SHUTDOWN_STALL", "stop"),
        Stall::Cleanup => command.env("RH_TEST_SHUTDOWN_STALL", "cleanup"),
    };
    git_env(&mut command, &world.git_config);
    let mut running = command.spawn()?;
    let ready = Instant::now() + Duration::from_secs(60);
    while !pid_file.exists() {
        if Instant::now() > ready || running.try_wait()?.is_some() {
            running.kill()?;
            running.wait()?;
            anyhow::bail!("the fetch never started");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let recorded = fs::read_to_string(&pid_file)?;
    let pids: Vec<i32> = recorded
        .split_whitespace()
        .map(str::parse)
        .collect::<Result<_, _>>()?;
    assert_eq!(pids.len(), 2, "{recorded}");

    let pid = rustix::process::Pid::from_child(&running);
    let started = Instant::now();
    rustix::process::kill_process(pid, signal)?;
    if let Some(second) = second {
        send_second(&world, pid, second, stall)?;
    }
    let output = running.wait_with_output()?;
    let ended = started.elapsed();
    // Stopped by the signal, not by the hour-long deadline or the two-minute stall.
    assert!(ended < Duration::from_secs(30), "{ended:?}");
    if stall != Stall::None {
        // Ended by the watcher's limit, which a second signal does not shorten.
        assert!(ended >= INTERRUPT_GRACE, "{ended:?}");
    }
    assert_eq!(output.status.signal(), Some(signal.as_raw()), "{output:?}");
    assert!(output.stdout.is_empty(), "{output:?}");

    assert_gone(&pids)?;
    assert!(!world.clone_dir().exists());
    let partial = entries_named(world.work.path(), "rh-partial")?;
    assert!(partial.is_empty(), "{partial:?}");
    let discarded = entries_named(world.work.path(), "rh-discard")?;
    if stall == Stall::None {
        assert!(discarded.is_empty(), "{discarded:?}");
        return Ok(());
    }
    // What the stalled step did not remove is left under its discard name alone.
    let [discard] = discarded.as_slice() else {
        anyhow::bail!("expected one discarded clone: {discarded:?}");
    };
    let discard = world.work.path().join(discard);
    assert!(discard.join(".git").is_dir(), "{discarded:?}");
    the_next_run_removes(&world, &discard)
}

/// Sends `signal` to `pid` while `rh` is still cleaning up after the first: once the step has set
/// its clone aside when it stalls there, otherwise a moment after the first.
#[cfg(unix)]
fn send_second(
    world: &World,
    pid: rustix::process::Pid,
    signal: rustix::process::Signal,
    stall: Stall,
) -> anyhow::Result<()> {
    use std::time::{Duration, Instant};

    let seen = Instant::now() + Duration::from_secs(30);
    while stall == Stall::Cleanup
        && entries_named(world.work.path(), "rh-discard")?.is_empty()
        && Instant::now() < seen
    {
        std::thread::sleep(Duration::from_millis(20));
    }
    std::thread::sleep(Duration::from_millis(200));
    rustix::process::kill_process(pid, signal)?;
    Ok(())
}

/// Asserts that no process in `pids` still runs. Checked once, right after `rh` exited: a process
/// killed then may only wait to be reaped.
#[cfg(unix)]
fn assert_gone(pids: &[i32]) -> anyhow::Result<()> {
    for pid in pids {
        let state = Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()?;
        let state = String::from_utf8(state.stdout)?;
        assert!(
            state.trim().is_empty() || state.trim().starts_with('Z'),
            "process {pid} outlived rh: {state}"
        );
    }
    Ok(())
}

/// Runs `rh work` with a fork that answers and asserts that it removes `discard` and builds the
/// clone.
#[cfg(unix)]
fn the_next_run_removes(world: &World, discard: &Path) -> anyhow::Result<()> {
    point_fork_at(world, &world.fork)?;
    let recovered = rh(world, &world.outside(), Some("atlas"), &["--json", "work"])?;
    assert_eq!(recovered.code, Some(0), "{}", recovered.stdout);
    assert_eq!(
        recovered.json()?.pointer("/data/clone/state"),
        Some(&json!("created"))
    );
    assert!(!discard.exists());
    let left = entries_named(world.work.path(), ".rh-")?;
    assert!(left.is_empty(), "{left:?}");
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn sigterm_during_a_fetch_stops_git_before_rh_exits() -> anyhow::Result<()> {
    signal_during_fetch(rustix::process::Signal::TERM, None, Stall::None).await
}

#[cfg(unix)]
#[tokio::test]
async fn sigint_during_a_fetch_stops_git_before_rh_exits() -> anyhow::Result<()> {
    signal_during_fetch(rustix::process::Signal::INT, None, Stall::None).await
}

#[cfg(unix)]
#[tokio::test]
async fn a_stalled_stop_leaves_git_killed_and_the_clone_set_aside() -> anyhow::Result<()> {
    signal_during_fetch(
        rustix::process::Signal::TERM,
        Some(rustix::process::Signal::INT),
        Stall::Stop,
    )
    .await
}

#[cfg(unix)]
#[tokio::test]
async fn a_stalled_cleanup_leaves_the_clone_for_the_next_run_to_remove() -> anyhow::Result<()> {
    signal_during_fetch(
        rustix::process::Signal::INT,
        Some(rustix::process::Signal::TERM),
        Stall::Cleanup,
    )
    .await
}

/// Makes the fork's upload pack run `interloper` once, before the first fetch is answered, so it
/// fills the target while that run is still building its clone.
#[cfg(unix)]
fn interrupt_first_fetch(world: &World, interloper: &str) -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;

    let marker = world.work.path().join("interrupted");
    let shim = world.work.path().join("upload-pack.sh");
    fs::write(
        &shim,
        format!(
            "#!/bin/sh\nif mkdir '{}' 2>/dev/null; then\n(cd '{}' && {interloper}) \
             </dev/null >/dev/null 2>&1\nfi\nexec git upload-pack \"$@\"\n",
            marker.display(),
            world.outside().display()
        ),
    )?;
    fs::set_permissions(&shim, fs::Permissions::from_mode(0o755))?;
    point_fork_at(world, &world.fork)?;
    let pointed = fs::read_to_string(&world.git_config)?;
    fs::write(
        &world.git_config,
        format!(
            "{pointed}[remote \"origin\"]\n\tuploadpack = {}\n",
            shim.display()
        ),
    )?;
    Ok(())
}

fn staging_left(world: &World) -> anyhow::Result<Vec<String>> {
    Ok(fs::read_dir(world.work.path())?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("rh-partial"))
        .collect())
}

#[cfg(unix)]
#[tokio::test]
async fn a_run_that_publishes_second_keeps_the_first_clone_and_reuses_it() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "claims the next ready issue")?,
    )
    .await;
    // While this run fetches, a second run of the same claim publishes its clone at the target
    // and an agent starts editing it.
    let edit = world.clone_dir().join("notes.txt");
    interrupt_first_fetch(
        &world,
        &format!(
            "'{}' --json work && echo draft > '{}'",
            env!("CARGO_BIN_EXE_rh"),
            edit.display()
        ),
    )?;

    let second = rh(&world, &world.outside(), Some("atlas"), &["--json", "work"])?;
    assert_eq!(second.code, Some(0), "{}", second.stdout);
    assert_eq!(
        second.json()?.pointer("/data/clone/state"),
        Some(&json!("reused"))
    );
    assert_eq!(fs::read_to_string(&edit)?, "draft\n");
    assert_eq!(
        git_in(&world, &world.clone_dir(), &["rev-parse", "HEAD"])?,
        world.fork_head
    );
    assert_eq!(
        git_config_value(&world, &world.clone_dir(), "railhead.generation")?,
        "1"
    );
    let partial = staging_left(&world)?;
    assert!(partial.is_empty(), "{partial:?}");
    assert_eq!(requests(&world).await, 2);
    Ok(())
}

#[cfg(unix)]
#[tokio::test]
async fn a_target_filled_during_the_fetch_is_kept_and_refused() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "claims the next ready issue")?,
    )
    .await;
    let target = world.clone_dir();
    interrupt_first_fetch(
        &world,
        &format!(
            "mkdir '{}' && echo mine > '{}/notes.txt'",
            target.display(),
            target.display()
        ),
    )?;

    let refused = rh(&world, &world.outside(), Some("atlas"), &["--json", "work"])?;
    assert_eq!(refused.code, Some(1), "{}", refused.stdout);
    assert_eq!(refused.error_code()?, json!("workspace_conflict"));
    assert_eq!(fs::read_to_string(target.join("notes.txt"))?, "mine\n");
    assert_eq!(fs::read_dir(&target)?.count(), 1);
    let partial = staging_left(&world)?;
    assert!(partial.is_empty(), "{partial:?}");
    Ok(())
}

#[tokio::test]
async fn an_invalid_git_timeout_is_refused() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "claims the next ready issue")?,
    )
    .await;
    point_fork_at(&world, &world.fork)?;
    for value in ["0", "3601", "ten", "-5"] {
        let refused = rh_with(
            &world,
            &world.outside(),
            Some("atlas"),
            &[("RAILHEAD_GIT_TIMEOUT", value)],
            &["--json", "work"],
        )?;
        assert_eq!(refused.error_code()?, json!("invalid_input"), "{value}");
        assert!(!world.clone_dir().exists(), "{value}");
    }
    assert_eq!(requests(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_new_clone_never_removes_a_clone_or_staging_directory_beside_it() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/claims",
        fixture(&world, "claim.json", "claims the named issue")?,
    )
    .await;
    // A real clone of the same claim, at the name older builds used for staging.
    let named = ".demo-clm_42abcd.rh-partial";
    let first = rh(
        &world,
        &world.outside(),
        Some("atlas"),
        &["claim", "iss_upload1", "--dir", named],
    )?;
    assert_eq!(first.code, Some(0), "{}", first.stderr);
    let kept = world.outside().join(named);
    fs::write(kept.join("notes.txt"), "draft\n")?;
    git_in(&world, &kept, &["add", "notes.txt"])?;
    git_in(&world, &kept, &["commit", "--quiet", "-m", "wip"])?;
    let kept_head = git_in(&world, &kept, &["rev-parse", "HEAD"])?;
    fs::write(kept.join("scratch.txt"), "untracked\n")?;
    // Another run's staging directory, still in use.
    let other = world
        .outside()
        .join(".demo-clm_42abcd.rh-partial-999999999-0");
    fs::create_dir(&other)?;
    fs::write(other.join("fetching"), "in progress\n")?;
    let unchanged = |world: &World| -> anyhow::Result<()> {
        assert_eq!(git_in(world, &kept, &["rev-parse", "HEAD"])?, kept_head);
        assert_eq!(fs::read_to_string(kept.join("notes.txt"))?, "draft\n");
        assert_eq!(fs::read_to_string(kept.join("scratch.txt"))?, "untracked\n");
        assert_eq!(fs::read_to_string(other.join("fetching"))?, "in progress\n");
        Ok(())
    };

    world.server.reset().await;
    let resumed = ResponseTemplate::new(200).set_body_raw(
        resumed_claim_body(&world, "claim.json")?,
        "application/json",
    );
    answer(&world, "POST", "/claims", resumed).await;
    let args = ["--json", "claim", "iss_upload1", "--dir", "demo-clm_42abcd"];

    // A failed fetch removes only the run's own staging directory.
    point_fork_at(&world, &world.work.path().join("missing.git"))?;
    let failed = rh(&world, &world.outside(), Some("atlas"), &args)?;
    assert_eq!(failed.error_code()?, json!("git"), "{}", failed.stdout);
    unchanged(&world)?;
    assert!(!world.clone_dir().exists());

    point_fork_at(&world, &world.fork)?;
    let created = rh(&world, &world.outside(), Some("atlas"), &args)?;
    assert_eq!(created.code, Some(0), "{}", created.stdout);
    assert_eq!(
        created.json()?.pointer("/data/clone/state"),
        Some(&json!("created"))
    );
    assert_eq!(
        git_in(&world, &world.clone_dir(), &["rev-parse", "HEAD"])?,
        world.fork_head
    );
    unchanged(&world)?;
    let mut partial: Vec<String> = fs::read_dir(world.work.path())?
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains("rh-partial"))
        .collect();
    partial.sort();
    assert_eq!(partial, [named, ".demo-clm_42abcd.rh-partial-999999999-0"]);
    Ok(())
}

#[tokio::test]
async fn a_mismatched_agent_or_directory_sends_nothing() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "claims the next ready issue")?,
    )
    .await;
    let made = rh(&world, &world.outside(), Some("atlas"), &["work"])?;
    assert_eq!(made.code, Some(0), "{}", made.stderr);
    world.server.reset().await;
    let clone = world.clone_dir();

    // Inside atlas's clone, naming boreas is refused for every command.
    for args in [
        vec!["--json", "work"],
        vec!["--json", "claim", "iss_upload1"],
        vec!["--json", "ready"],
        vec!["--json", "status"],
    ] {
        let run = rh(&world, &clone, Some("boreas"), &args)?;
        assert_eq!(run.code, Some(1), "{args:?}");
        assert_eq!(run.error_code()?, json!("identity_mismatch"), "{args:?}");
    }

    // boreas cannot adopt atlas's clone with --dir, and nobody adopts a directory of other files.
    let foreign = world.work.path().join("foreign");
    fs::create_dir(&foreign)?;
    fs::write(foreign.join("keep.txt"), "mine\n")?;
    let dir = clone.display().to_string();
    for (agent, target) in [
        ("boreas", dir.as_str()),
        ("atlas", "foreign"),
        ("atlas", "fork.git"),
    ] {
        let run = rh(
            &world,
            &world.outside(),
            Some(agent),
            &["--json", "work", "--dir", target],
        )?;
        assert_eq!(run.code, Some(1), "{agent} {target}");
        assert_eq!(
            run.error_code()?,
            json!("workspace_conflict"),
            "{agent} {target}"
        );
    }
    assert_eq!(fs::read_to_string(foreign.join("keep.txt"))?, "mine\n");

    // An invalid issue is refused by the parser, and boreas has no session to send.
    let invalid = rh(
        &world,
        &world.outside(),
        Some("atlas"),
        &["claim", "upload1"],
    )?;
    assert_eq!(invalid.code, Some(2));
    let no_session = rh(
        &world,
        &world.outside(),
        Some("boreas"),
        &["--json", "status"],
    )?;
    assert_eq!(no_session.error_code()?, json!("no_session"));
    assert_eq!(
        no_session.json()?.pointer("/error/next"),
        Some(&json!("rh join"))
    );

    assert_eq!(requests(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_hostile_remote_is_refused_and_nothing_is_cloned() -> anyhow::Result<()> {
    let world = world().await?;
    let body = resumed_claim_body(&world, "work.json")?.replace(
        &format!("{}{FORK_PATH}", world.server.uri()),
        "https://evil.example/steal.git",
    );
    answer(
        &world,
        "POST",
        "/work",
        ResponseTemplate::new(200).set_body_raw(body, "application/json"),
    )
    .await;
    let run = rh(&world, &world.outside(), Some("atlas"), &["--json", "work"])?;
    assert_eq!(run.code, Some(1));
    assert_eq!(run.error_code()?, json!("untrusted_remote"));
    assert!(!world.clone_dir().exists());
    Ok(())
}

#[tokio::test]
async fn work_reports_no_ready_issue_as_retryable() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "no issue is ready")?,
    )
    .await;
    let run = rh(&world, &world.outside(), Some("atlas"), &["--json", "work"])?;
    assert_eq!(run.code, Some(1));
    let envelope = run.json()?;
    assert_eq!(envelope.pointer("/error/code"), Some(&json!("no_work")));
    assert_eq!(envelope.pointer("/error/retryable"), Some(&json!(true)));
    assert_eq!(envelope.pointer("/error/next"), Some(&json!("rh work")));
    assert!(!world.clone_dir().exists());
    Ok(())
}

#[tokio::test]
async fn ready_pins_head_with_the_clone_generation() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "claims the next ready issue")?,
    )
    .await;
    assert_eq!(
        rh(&world, &world.outside(), Some("atlas"), &["work"])?.code,
        Some(0)
    );
    let clone = world.clone_dir();
    fs::write(clone.join("upload.rs"), "fn main() {}\n")?;
    git_in(&world, &clone, &["add", "upload.rs"])?;
    git_in(
        &world,
        &clone,
        &["commit", "--quiet", "-m", "handle uploads"],
    )?;
    let head = git_in(&world, &clone, &["rev-parse", "HEAD"])?;

    world.server.reset().await;
    Mock::given(method("POST"))
        .and(path(format!("{PREFIX}/claims/clm_42abcd/ready")))
        .and(header("authorization", format!("Bearer {TOKEN}").as_str()))
        .and(body_json(json!({"generation": 1, "commit": head})))
        .respond_with(fixture(&world, "ready.json", "pins the commit")?)
        .expect(1)
        .mount(&world.server)
        .await;
    let run = rh(&world, &clone, None, &["ready"])?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert!(
        run.stdout
            .starts_with(&format!("pinned {} for the train\n", "b".repeat(40))),
        "{}",
        run.stdout
    );
    assert!(
        run.stdout
            .contains("issue \"iss_upload1\", ready, generation 1"),
        "{}",
        run.stdout
    );

    // Outside a clone there is nothing to pin, and nothing is sent.
    world.server.reset().await;
    let outside = rh(
        &world,
        &world.outside(),
        Some("atlas"),
        &["--json", "ready"],
    )?;
    assert_eq!(outside.error_code()?, json!("no_clone"));
    assert_eq!(requests(&world).await, 0);

    // A clone whose generation setting was damaged is refused before sending.
    git_in(&world, &clone, &["config", "railhead.generation", "zero"])?;
    let damaged = rh(&world, &clone, None, &["--json", "ready"])?;
    assert_eq!(damaged.error_code()?, json!("invalid_clone"));
    assert_eq!(requests(&world).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_ready_rejection_names_sync_and_ack() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "POST",
        "/work",
        fixture(&world, "work.json", "claims the next ready issue")?,
    )
    .await;
    assert_eq!(
        rh(&world, &world.outside(), Some("atlas"), &["work"])?.code,
        Some(0)
    );
    let clone = world.clone_dir();

    world.server.reset().await;
    answer(
        &world,
        "POST",
        "/claims/clm_42abcd/ready",
        fixture(
            &world,
            "ready.json",
            "refuses while a decision is unacknowledged",
        )?,
    )
    .await;
    let text = rh(&world, &clone, None, &["ready"])?;
    assert_eq!(text.code, Some(1));
    assert_eq!(text.stdout, "");
    assert!(
        text.stderr.starts_with(
            "rh: a decision for this claim is unacknowledged: read it with rh sync, then rh ack each item with a plan\n"
        ),
        "{}",
        text.stderr
    );
    assert!(text.stderr.ends_with("next: rh sync\n"), "{}", text.stderr);

    let json = rh(&world, &clone, None, &["--json", "ready"])?;
    let envelope = json.json()?;
    assert_eq!(
        envelope.pointer("/error/code"),
        Some(&json!("unacked_decision"))
    );
    assert_eq!(envelope.pointer("/error/next"), Some(&json!("rh sync")));
    assert!(json.stderr.contains("rh ack"), "{}", json.stderr);

    // Other refusals pass through without the decision notice.
    world.server.reset().await;
    answer(
        &world,
        "POST",
        "/claims/clm_42abcd/ready",
        fixture(&world, "ready.json", "refuses a stale generation")?,
    )
    .await;
    let stale = rh(&world, &clone, None, &["--json", "ready"])?;
    assert_eq!(stale.error_code()?, json!("stale_generation"));
    assert_eq!(stale.stderr, "");
    Ok(())
}

#[tokio::test]
async fn status_without_a_claim_points_at_work_and_a_revoked_agent_fails() -> anyhow::Result<()> {
    let world = world().await?;
    answer(
        &world,
        "GET",
        "/status",
        fixture(&world, "status.json", "an agent without a claim")?,
    )
    .await;
    let run = rh(&world, &world.outside(), Some("atlas"), &["status"])?;
    assert_eq!(run.code, Some(0), "{}", run.stderr);
    assert_eq!(
        run.stdout,
        "agent \"atlas\" (\"agt_atlas01\"), confirmed\nno claim\nnext: rh work\n"
    );

    world.server.reset().await;
    answer(
        &world,
        "GET",
        "/status",
        fixture(
            &world,
            "status.json",
            "refuses a revoked agent at its next call",
        )?,
    )
    .await;
    let revoked = rh(
        &world,
        &world.outside(),
        Some("atlas"),
        &["--json", "status"],
    )?;
    assert_eq!(revoked.code, Some(1));
    assert_eq!(revoked.error_code()?, json!("identity_revoked"));
    Ok(())
}
