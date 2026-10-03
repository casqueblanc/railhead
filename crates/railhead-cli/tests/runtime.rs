//! The `rh` binary end to end: dispatch, identity binding, output streams and secrets.
//!
//! Each test runs the built binary against a temporary identity store and, where a clone is
//! needed, a real Git repository whose remote points at a wiremock server. The server records
//! every request, so "sends nothing" is asserted on the server, not inferred from the output.

use std::fs;
use std::io::Write as _;
use std::path::Path;
use std::process::{Command, Output, Stdio};

use serde_json::{Value, json};
use wiremock::MockServer;

const TOKEN: &str = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ3RfYXRsYXMwMSJ9.c2lnbmF0dXJlLXNlY3JldA";
const KEY: &str =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n-----END OPENSSH PRIVATE KEY-----\n";

/// Every command that acts as an agent, with arguments Git or a person would pass.
const AGENT_COMMANDS: [&[&str]; 8] = [
    &["work"],
    &["claim", "iss_upload1"],
    &["ready"],
    &["status"],
    &["sync"],
    &["ack", "17", "--plan", "p"],
    &["ask", "Reject?"],
    &["credential", "get"],
];

struct World {
    home: tempfile::TempDir,
    clone: tempfile::TempDir,
    outside: tempfile::TempDir,
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

/// A store with `atlas` (with a key and a session) and `boreas`, both joined to `origin`, and a
/// clone of an `atlas` claim whose remote is on `origin`.
fn world(origin: &str) -> anyhow::Result<World> {
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
    let atlas = home.path().join("agents/atlas");
    write_private(&atlas.join("key"), KEY)?;
    write_private(&atlas.join("session"), &session_record(origin))?;

    let clone = tempfile::tempdir()?;
    git(clone.path(), &["init", "--quiet"])?;
    git(
        clone.path(),
        &["config", "railhead.identity", "agt_atlas01"],
    )?;
    let remote = format!("{origin}/git/casqueblanc/demo/claims/clm_42abcd.git");
    git(clone.path(), &["remote", "add", "origin", &remote])?;
    Ok(World {
        home,
        clone,
        outside: tempfile::tempdir()?,
    })
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

fn rh(
    world: &World,
    dir: &Path,
    agent: Option<&str>,
    args: &[&str],
    stdin: &str,
) -> anyhow::Result<Run> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rh"));
    command
        .args(args)
        .current_dir(dir)
        .env("RAILHEAD_HOME", world.home.path())
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env_remove("RAILHEAD_AGENT")
        .env_remove("RAILHEAD_INVITE")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(agent) = agent {
        command.env("RAILHEAD_AGENT", agent);
    }
    let mut child = command.spawn()?;
    if let Some(mut input) = child.stdin.take() {
        input.write_all(stdin.as_bytes())?;
    }
    let Output {
        status,
        stdout,
        stderr,
    } = child.wait_with_output()?;
    let run = Run {
        code: status.code(),
        stdout: String::from_utf8(stdout)?,
        stderr: String::from_utf8(stderr)?,
    };
    for stream in [&run.stdout, &run.stderr] {
        assert!(
            !stream.contains(TOKEN) && !stream.contains("c2lnbmF0dXJl"),
            "token leaked: {stream}"
        );
        assert!(!stream.contains("not-a-real-key"), "key leaked: {stream}");
    }
    Ok(run)
}

async fn requests(server: &MockServer) -> usize {
    server
        .received_requests()
        .await
        .map_or(0, |requests| requests.len())
}

#[tokio::test]
async fn version_prints_text_or_one_envelope() -> anyhow::Result<()> {
    let world = world("https://railhead.dev")?;
    let text = rh(&world, world.outside.path(), None, &["version"], "")?;
    assert_eq!(
        (text.code, text.stdout.as_str(), text.stderr.as_str()),
        (Some(0), "rh 0.1.0 (event schema 1)\n", "")
    );
    let json = rh(
        &world,
        world.outside.path(),
        None,
        &["--json", "version"],
        "",
    )?;
    assert_eq!(json.json()?.pointer("/data/eventSchema"), Some(&json!(1)));
    Ok(())
}

#[tokio::test]
async fn a_command_without_an_agent_names_rh_join() -> anyhow::Result<()> {
    let world = world("https://railhead.dev")?;
    let text = rh(&world, world.outside.path(), None, &["status"], "")?;
    assert_eq!(text.code, Some(1));
    assert_eq!(text.stdout, "");
    assert!(
        text.stderr.starts_with("rh: no agent selected"),
        "{}",
        text.stderr
    );
    assert!(text.stderr.ends_with("next: rh join\n"), "{}", text.stderr);

    let json = rh(
        &world,
        world.outside.path(),
        None,
        &["--json", "status"],
        "",
    )?;
    assert_eq!(json.code, Some(1));
    assert_eq!(json.stderr, "");
    let envelope = json.json()?;
    assert_eq!(envelope.pointer("/ok"), Some(&json!(false)));
    assert_eq!(envelope.pointer("/error/code"), Some(&json!("no_identity")));
    assert_eq!(envelope.pointer("/error/next"), Some(&json!("rh join")));

    let unknown = rh(
        &world,
        world.outside.path(),
        Some("nobody"),
        &["--json", "status"],
        "",
    )?;
    assert_eq!(
        unknown.json()?.pointer("/error/code"),
        Some(&json!("no_identity"))
    );
    Ok(())
}

#[tokio::test]
async fn a_mismatched_agent_in_a_clone_sends_nothing() -> anyhow::Result<()> {
    let server = MockServer::start().await;
    let world = world(&server.uri())?;
    for agent in ["boreas", "agt_boreas01", "nobody"] {
        for args in AGENT_COMMANDS {
            let mut argv = vec!["--json"];
            argv.extend_from_slice(args);
            let run = rh(
                &world,
                world.clone.path(),
                Some(agent),
                &argv,
                "protocol=http\n\n",
            )?;
            assert_eq!(run.code, Some(1), "{agent} {args:?}");
            if args == ["credential", "get"] {
                // Git owns stdout in credential mode, even with --json.
                assert_eq!(run.stdout, "", "{agent} {args:?}");
                assert!(
                    run.stderr.contains("this clone belongs to agt_atlas01"),
                    "{}",
                    run.stderr
                );
            } else {
                let envelope = run.json()?;
                assert_eq!(
                    envelope.pointer("/error/code"),
                    Some(&json!("identity_mismatch")),
                    "{agent} {args:?}"
                );
            }
        }
    }
    let flag = rh(
        &world,
        world.clone.path(),
        Some("atlas"),
        &["--agent", "boreas", "--json", "status"],
        "",
    )?;
    assert_eq!(
        flag.json()?.pointer("/error/code"),
        Some(&json!("identity_mismatch"))
    );
    assert_eq!(requests(&server).await, 0);
    Ok(())
}

#[tokio::test]
async fn the_clone_identity_reaches_each_command_entry_point() -> anyhow::Result<()> {
    let server = MockServer::start().await;
    let world = world(&server.uri())?;
    // Outside the clone, the named agent is used: boreas has no session and no key to log in with.
    let outside = rh(
        &world,
        world.outside.path(),
        Some("boreas"),
        &["--json", "sync"],
        "",
    )?;
    assert_eq!(
        outside.json()?.pointer("/error/code"),
        Some(&json!("no_session"))
    );
    let message = outside.json()?.pointer("/error/message").cloned();
    assert!(
        message
            .as_ref()
            .and_then(Value::as_str)
            .is_some_and(|message| message.starts_with("boreas has no session")),
        "{message:?}"
    );
    let join = rh(&world, world.outside.path(), None, &["--json", "join"], "")?;
    assert_eq!(
        join.json()?.pointer("/error/message"),
        Some(&json!("name the invite URL, or set RAILHEAD_INVITE"))
    );
    assert_eq!(requests(&server).await, 0);
    Ok(())
}

#[tokio::test]
async fn credential_mode_writes_nothing_but_the_protocol_on_stdout() -> anyhow::Result<()> {
    let server = MockServer::start().await;
    let world = world(&server.uri())?;
    let request = format!(
        "protocol=http\nhost={}\npath=git/casqueblanc/demo/claims/clm_42abcd.git\n\n",
        server.address()
    );
    // Outcomes Git reports and operations the helper does not know are acknowledged silently.
    for operation in ["store", "erase", "capability"] {
        let run = rh(
            &world,
            world.clone.path(),
            None,
            &["credential", operation, "--json"],
            &request,
        )?;
        assert_eq!(
            (run.code, run.stdout.as_str()),
            (Some(0), ""),
            "{operation}"
        );
    }
    // A refused request is reported on stderr only.
    let hostile = rh(
        &world,
        world.clone.path(),
        None,
        &["credential", "get", "--json"],
        "protocol=http\nhost=evil.example\npath=git/casqueblanc/demo/claims/clm_42abcd.git\n\n",
    )?;
    assert_eq!((hostile.code, hostile.stdout.as_str()), (Some(1), ""));
    assert!(
        hostile.stderr.starts_with("rh: Git asked for another host"),
        "{}",
        hostile.stderr
    );
    // Outside a clone, the helper has no identity to answer for.
    let outside = rh(
        &world,
        world.outside.path(),
        None,
        &["credential", "get"],
        &request,
    )?;
    assert_eq!((outside.code, outside.stdout.as_str()), (Some(1), ""));
    assert!(
        outside.stderr.contains("no agent selected"),
        "{}",
        outside.stderr
    );
    assert_eq!(requests(&server).await, 0);
    Ok(())
}

#[tokio::test]
async fn a_damaged_clone_or_store_stops_before_any_request() -> anyhow::Result<()> {
    let server = MockServer::start().await;
    let first = world(&server.uri())?;
    git(
        first.clone.path(),
        &[
            "remote",
            "set-url",
            "origin",
            "https://evil.example/steal.git",
        ],
    )?;
    let foreign = rh(&first, first.clone.path(), None, &["--json", "status"], "")?;
    assert_eq!(
        foreign.json()?.pointer("/error/code"),
        Some(&json!("invalid_clone"))
    );

    let other = world(&server.uri())?;
    #[cfg(unix)]
    {
        let record = other.home.path().join("agents/atlas/identity.json");
        fs::set_permissions(&record, std::os::unix::fs::PermissionsExt::from_mode(0o644))?;
        let exposed = rh(&other, other.clone.path(), None, &["--json", "status"], "")?;
        let envelope = exposed.json()?;
        assert_eq!(envelope.pointer("/error/code"), Some(&json!("store")));
    }
    let bad_agent = rh(
        &other,
        other.outside.path(),
        Some("Not A Name"),
        &["--json", "status"],
        "",
    )?;
    assert_eq!(
        bad_agent.json()?.pointer("/error/code"),
        Some(&json!("invalid_input"))
    );
    assert_eq!(requests(&server).await, 0);
    Ok(())
}

#[tokio::test]
async fn refused_arguments_print_one_json_failure_and_exit_nonzero() -> anyhow::Result<()> {
    let server = MockServer::start().await;
    let world = world(&server.uri())?;
    let cases: [(&[&str], &str); 6] = [
        (&["--json", "status", "--agent", "Not Valid"], "'Not Valid'"),
        (&["status", "--agent", "Not Valid", "--json"], "'Not Valid'"),
        (&["--json", "status", "--unknown"], "'--unknown'"),
        (&["--json", "deploy"], "'deploy'"),
        (&["--json", "status", "--agent"], "--agent"),
        (&["--json"], "subcommand"),
    ];
    for (args, named) in cases {
        let run = rh(&world, world.clone.path(), None, args, "")?;
        assert_eq!(run.code, Some(2), "{args:?}");
        assert_eq!(run.stderr, "", "{args:?}");
        assert_eq!(run.stdout.lines().count(), 1, "{args:?}: {}", run.stdout);
        let envelope = run.json()?;
        assert_eq!(envelope.pointer("/ok"), Some(&json!(false)), "{args:?}");
        assert_eq!(
            envelope.pointer("/error/code"),
            Some(&json!("invalid_input")),
            "{args:?}"
        );
        assert_eq!(envelope.pointer("/error/retryable"), Some(&json!(false)));
        let message = envelope
            .pointer("/error/message")
            .and_then(Value::as_str)
            .unwrap_or_default();
        assert!(message.contains(named), "{args:?}: {message}");
        assert!(!message.contains('\n'), "{args:?}: {message}");
    }
    assert_eq!(requests(&server).await, 0);
    Ok(())
}

#[tokio::test]
async fn refused_arguments_outside_json_keep_the_parser_output() -> anyhow::Result<()> {
    let world = world("https://railhead.dev")?;
    let text = rh(
        &world,
        world.outside.path(),
        None,
        &["status", "--unknown"],
        "",
    )?;
    assert_eq!((text.code, text.stdout.as_str()), (Some(2), ""));
    assert!(
        text.stderr.contains("unexpected argument '--unknown'"),
        "{}",
        text.stderr
    );

    // Git owns stdout in credential mode, even with --json and a refused argument.
    let credential = rh(
        &world,
        world.clone.path(),
        None,
        &["credential", "get", "--json", "--bogus"],
        "",
    )?;
    assert_eq!((credential.code, credential.stdout.as_str()), (Some(2), ""));
    assert!(
        credential.stderr.contains("'--bogus'"),
        "{}",
        credential.stderr
    );

    // Explicit help and version stay the parser's, on stdout, with success.
    for flag in ["--help", "--version"] {
        let run = rh(&world, world.outside.path(), None, &["--json", flag], "")?;
        assert_eq!(run.code, Some(0), "{flag}");
        assert!(run.stdout.contains("rh"), "{flag}: {}", run.stdout);
        assert!(
            serde_json::from_str::<Value>(&run.stdout).is_err(),
            "{flag}"
        );
    }
    Ok(())
}
