//! Running `rh` and Git for an agent: bounded in number across the run, bounded in time, and
//! killed when the run drops them.
//!
//! Every child gets the agent's own `RAILHEAD_HOME`, `RAILHEAD_AGENT` and Git author, no stdin,
//! and no stderr: what `rh` and Git write there can quote the backend or the repository, which
//! are untrusted. `rh` runs with `--json` and its one envelope is decoded; nothing else of its
//! output is kept. Stdout is read through a byte limit, and a child that writes past it is killed
//! at once.
//!
//! A child whose agent is stopped mid-command is not killed outright: it is asked to stop with
//! `SIGTERM` and handed to the run's [`Reaper`], which gives every such child [`STOP_GRACE`] to
//! exit, kills what is left, and reaps them all before the run removes its clones.

use std::ffi::OsStr;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use railhead_protocol::{AgentErrorCode, InboxDigest};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use tokio::io::AsyncReadExt as _;
use tokio::process::{Child, Command};
use tokio::sync::Semaphore;

/// How long a stopped child has to exit after `SIGTERM` before it is killed.
pub const STOP_GRACE: Duration = Duration::from_secs(5);

/// Largest output read from one child, in bytes. `rh` bounds a response at 1 MiB.
const MAX_OUTPUT_BYTES: usize = 2 * 1024 * 1024;

/// An error code from `rh`: the backend's, or one `rh` raised itself.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum Code {
    /// The backend's code.
    Agent(AgentErrorCode),
    /// `rh`'s own code, such as `git` or `timeout`.
    Local(String),
}

impl Code {
    /// The code as `rh` printed it.
    #[must_use]
    pub fn wire(&self) -> String {
        match self {
            Self::Agent(code) => serde_json::to_value(code)
                .ok()
                .and_then(|value| value.as_str().map(str::to_owned))
                .unwrap_or_default(),
            Self::Local(code) => code.clone(),
        }
    }
}

/// A refusal `rh` reported. Its message is untrusted and not kept.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejection {
    /// What went wrong.
    pub code: Code,
    /// Whether repeating the command may succeed.
    pub retryable: bool,
    /// How long to wait first, in milliseconds.
    pub retry_after_ms: Option<u64>,
    /// The command `rh` suggests next, such as `rh sync`.
    pub next: Option<String>,
}

/// A successful `rh` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Envelope<T> {
    /// The command's result.
    pub data: T,
    /// Pending inbox items carried on the result.
    pub inbox: Option<InboxDigest>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Printed<T> {
    Success {
        #[allow(dead_code)]
        ok: True,
        data: T,
        inbox: Option<InboxDigest>,
    },
    Failure {
        #[allow(dead_code)]
        ok: False,
        error: Rejection,
    },
}

/// `true`, and nothing else.
#[derive(Deserialize)]
#[serde(try_from = "bool")]
struct True;

impl TryFrom<bool> for True {
    type Error = &'static str;
    fn try_from(value: bool) -> Result<Self, Self::Error> {
        value.then_some(Self).ok_or("expected true")
    }
}

/// `false`, and nothing else.
#[derive(Deserialize)]
#[serde(try_from = "bool")]
struct False;

impl TryFrom<bool> for False {
    type Error = &'static str;
    fn try_from(value: bool) -> Result<Self, Self::Error> {
        (!value).then_some(Self).ok_or("expected false")
    }
}

/// Why a child failed.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// It could not be started.
    #[error("starting {program}: {source}")]
    Spawn {
        /// The program.
        program: &'static str,
        /// Why.
        #[source]
        source: io::Error,
    },
    /// It outlived the command timeout and was killed.
    #[error("{0} timed out")]
    TimedOut(&'static str),
    /// Git exited with a failure.
    #[error("git {0} failed")]
    Git(&'static str),
    /// `rh` printed something other than one envelope.
    #[error("rh printed no envelope")]
    Malformed,
    /// It wrote more than [`MAX_OUTPUT_BYTES`] to stdout and was killed.
    #[error("{0} wrote more output than the limit")]
    TooMuchOutput(&'static str),
    /// `rh` reported a refusal.
    #[error("rh reported {}", .0.code.wire())]
    Rejected(Rejection),
}

impl Error {
    /// The code a `failed` event carries.
    #[must_use]
    pub fn code(&self) -> String {
        match self {
            Self::Spawn { .. } => "spawn".to_owned(),
            Self::TimedOut(_) => "timeout".to_owned(),
            Self::Git(_) => "git".to_owned(),
            Self::Malformed => "malformed".to_owned(),
            Self::TooMuchOutput(_) => "output_too_large".to_owned(),
            Self::Rejected(rejection) => rejection.code.wire(),
        }
    }

    /// Whether repeating the step may succeed, and after how long at least.
    #[must_use]
    pub fn retry(&self) -> Option<Duration> {
        match self {
            Self::TimedOut(_) | Self::Git(_) => Some(Duration::ZERO),
            Self::Rejected(rejection) if rejection.retryable => Some(Duration::from_millis(
                rejection.retry_after_ms.unwrap_or_default(),
            )),
            Self::Rejected(_) | Self::Spawn { .. } | Self::Malformed | Self::TooMuchOutput(_) => {
                None
            }
        }
    }

    /// The backend's code, when it sent one.
    #[must_use]
    pub const fn agent_code(&self) -> Option<AgentErrorCode> {
        match self {
            Self::Rejected(Rejection {
                code: Code::Agent(code),
                ..
            }) => Some(*code),
            _ => None,
        }
    }
}

/// The settings one agent's children run with.
#[derive(Debug, Clone)]
pub struct AgentEnv {
    /// The agent's name, also its Git author.
    pub name: String,
    /// Its `RAILHEAD_HOME`.
    pub home: PathBuf,
}

/// The children of stopped agents, asked to stop and waiting to be reaped.
#[derive(Debug, Clone, Default)]
pub struct Reaper(Arc<Mutex<Vec<Child>>>);

impl Reaper {
    fn adopt(&self, child: Child) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(child);
    }

    /// Waits up to `grace` for every adopted child to exit, then kills and reaps the rest.
    pub async fn reap(&self, grace: Duration) {
        let mut children =
            std::mem::take(&mut *self.0.lock().unwrap_or_else(PoisonError::into_inner));
        // A wait that fails leaves the child to the kill below.
        let _ = tokio::time::timeout(grace, async {
            for child in &mut children {
                let _ = child.wait().await;
            }
        })
        .await;
        for child in &mut children {
            // `kill` fails only when the child already exited, which is the outcome wanted.
            let _ = child.kill().await;
        }
    }
}

/// A running child. Dropped before it was waited on, as when its agent is aborted, it is asked
/// to stop and handed to the [`Reaper`].
struct Running<'a> {
    child: Option<Child>,
    reaper: &'a Reaper,
}

impl Running<'_> {
    fn child(&mut self) -> Result<&mut Child, Error> {
        self.child.as_mut().ok_or(Error::TimedOut("child"))
    }

    /// Kills the child now and reaps it.
    async fn kill(mut self) {
        if let Some(mut child) = self.child.take() {
            // `kill` fails only when the child already exited.
            let _ = child.kill().await;
        }
    }

    /// The child was waited on: nothing is left to stop.
    fn finished(mut self) {
        self.child = None;
    }
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        terminate(&mut child);
        self.reaper.adopt(child);
    }
}

/// Asks `child` to stop: `SIGTERM` on Unix, so it can clean up, and a kill elsewhere.
fn terminate(child: &mut Child) {
    #[cfg(unix)]
    {
        use rustix::process::{Pid, Signal, kill_process};
        if let Some(pid) = child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .and_then(Pid::from_raw)
        {
            // It may have exited already; the reaper reaps it either way.
            let _ = kill_process(pid, Signal::TERM);
            return;
        }
    }
    // Fails only when the child already exited.
    let _ = child.start_kill();
}

/// Starts children within the run's bounds.
#[derive(Debug, Clone)]
pub struct Runner {
    rh: PathBuf,
    timeout: Duration,
    permits: Arc<Semaphore>,
    reaper: Reaper,
}

impl Runner {
    /// A runner for `rh` at `rh`, at most `concurrency` children at once, each within `timeout`.
    #[must_use]
    pub fn new(rh: PathBuf, concurrency: u32, timeout: Duration) -> Self {
        let permits = usize::try_from(concurrency).unwrap_or(1).max(1);
        Self {
            rh,
            timeout,
            permits: Arc::new(Semaphore::new(permits)),
            reaper: Reaper::default(),
        }
    }

    /// Where the children of stopped agents go, for the run to reap before it removes its clones.
    #[must_use]
    pub fn reaper(&self) -> Reaper {
        self.reaper.clone()
    }

    /// Runs `rh --json <args>` in `dir` as the agent and decodes its envelope.
    ///
    /// # Errors
    ///
    /// [`Error::Rejected`] with `rh`'s code when it reports a failure, otherwise as [`Error`].
    pub async fn rh<T: DeserializeOwned>(
        &self,
        agent: &AgentEnv,
        dir: &Path,
        args: &[&str],
    ) -> Result<Envelope<T>, Error> {
        let mut command = Command::new(&self.rh);
        command.arg("--json").args(args);
        let stdout = self.output("rh", agent, dir, command).await?;
        match serde_json::from_slice::<Printed<T>>(&stdout.bytes) {
            Ok(Printed::Success { data, inbox, .. }) if stdout.success => {
                Ok(Envelope { data, inbox })
            }
            Ok(Printed::Failure { error, .. }) if !stdout.success => Err(Error::Rejected(error)),
            Ok(_) | Err(_) => Err(Error::Malformed),
        }
    }

    /// Runs `git <args>` in `dir` as the agent and returns its first line of output.
    ///
    /// # Errors
    ///
    /// [`Error::Git`] when Git fails, otherwise as [`Error`].
    pub async fn git(
        &self,
        agent: &AgentEnv,
        dir: &Path,
        action: &'static str,
        args: &[&str],
    ) -> Result<String, Error> {
        let text = self.git_text(agent, dir, action, args).await?;
        Ok(text.lines().next().unwrap_or_default().to_owned())
    }

    /// Runs `git <args>` in `dir` as the agent and returns all its output, at most
    /// [`MAX_OUTPUT_BYTES`].
    ///
    /// # Errors
    ///
    /// [`Error::Git`] when Git fails, otherwise as [`Error`].
    pub async fn git_text(
        &self,
        agent: &AgentEnv,
        dir: &Path,
        action: &'static str,
        args: &[&str],
    ) -> Result<String, Error> {
        let mut command = Command::new("git");
        command
            .args(args)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_AUTHOR_NAME", &agent.name)
            .env("GIT_COMMITTER_NAME", &agent.name)
            .env("GIT_AUTHOR_EMAIL", format!("{}@swarm.invalid", agent.name))
            .env(
                "GIT_COMMITTER_EMAIL",
                format!("{}@swarm.invalid", agent.name),
            );
        for key in [
            "GIT_DIR",
            "GIT_WORK_TREE",
            "GIT_INDEX_FILE",
            "GIT_OBJECT_DIRECTORY",
            "GIT_COMMON_DIR",
        ] {
            command.env_remove(key);
        }
        let output = self.output("git", agent, dir, command).await?;
        if !output.success {
            return Err(Error::Git(action));
        }
        Ok(String::from_utf8_lossy(&output.bytes).into_owned())
    }

    async fn output(
        &self,
        program: &'static str,
        agent: &AgentEnv,
        dir: &Path,
        mut command: Command,
    ) -> Result<Output, Error> {
        // The semaphore is never closed, so acquiring fails only if it were.
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|_| Error::TimedOut(program))?;
        command
            .current_dir(dir)
            .env("RAILHEAD_HOME", &agent.home)
            .env("RAILHEAD_AGENT", OsStr::new(&agent.name))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let child = command
            .spawn()
            .map_err(|source| Error::Spawn { program, source })?;
        let mut running = Running {
            child: Some(child),
            reaper: &self.reaper,
        };
        let stdout = running.child()?.stdout.take();
        let outcome = tokio::time::timeout(self.timeout, async {
            let mut bytes = Vec::new();
            if let Some(stdout) = stdout {
                // One byte past the limit is enough to know it was crossed.
                let limit =
                    u64::try_from(MAX_OUTPUT_BYTES).map_or(u64::MAX, |n| n.saturating_add(1));
                stdout
                    .take(limit)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|source| Error::Spawn { program, source })?;
            }
            if bytes.len() > MAX_OUTPUT_BYTES {
                return Err(Error::TooMuchOutput(program));
            }
            let status = running
                .child()?
                .wait()
                .await
                .map_err(|source| Error::Spawn { program, source })?;
            Ok(Output {
                success: status.success(),
                bytes,
            })
        })
        .await;
        match outcome {
            Ok(Ok(output)) => {
                running.finished();
                Ok(output)
            }
            Ok(Err(error)) => {
                running.kill().await;
                Err(error)
            }
            Err(_) => {
                running.kill().await;
                Err(Error::TimedOut(program))
            }
        }
    }
}

struct Output {
    success: bool,
    bytes: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Waits up to five seconds for `path` to appear.
    #[cfg(unix)]
    async fn appears(path: &Path) -> anyhow::Result<()> {
        for _ in 0..500 {
            if path.exists() {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        anyhow::bail!("{} never appeared", path.display())
    }

    /// A child running `script` under `sh`, stopped as an aborted agent's is once its trap is set
    /// (the script touches `$1`).
    #[cfg(unix)]
    async fn abandoned(reaper: &Reaper, script: &str) -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let ready = dir.path().join("ready");
        let child = Command::new("sh")
            .args(["-c", script, "sh"])
            .arg(&ready)
            .kill_on_drop(true)
            .spawn()?;
        appears(&ready).await?;
        drop(Running {
            child: Some(child),
            reaper,
        });
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_stopped_child_is_asked_to_stop_and_reaped_after_it_exits() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let done = dir.path().join("done");
        let reaper = Reaper::default();
        // It cleans up on SIGTERM, slowly.
        abandoned(
            &reaper,
            &format!(
                "trap 'sleep 0.3; touch {}; exit 0' TERM; touch \"$1\"; while :; do sleep 0.05; done",
                done.display()
            ),
        )
        .await?;
        reaper.reap(STOP_GRACE).await;
        assert!(done.exists(), "reaped before the child finished stopping");
        assert!(
            reaper
                .0
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .is_empty()
        );
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_child_that_ignores_the_request_is_killed_after_the_grace() -> anyhow::Result<()> {
        let reaper = Reaper::default();
        abandoned(
            &reaper,
            "trap '' TERM; touch \"$1\"; while :; do sleep 0.05; done",
        )
        .await?;
        let started = std::time::Instant::now();
        reaper.reap(Duration::from_millis(200)).await;
        let took = started.elapsed();
        assert!(
            took >= Duration::from_millis(200) && took < STOP_GRACE,
            "{took:?}"
        );
        Ok(())
    }

    #[tokio::test]
    async fn nothing_to_reap_returns_at_once() {
        let started = std::time::Instant::now();
        Reaper::default().reap(STOP_GRACE).await;
        assert!(started.elapsed() < STOP_GRACE);
    }

    #[derive(Debug, Deserialize, PartialEq, Eq)]
    struct Data {
        n: u64,
    }

    fn decode(json: &str) -> Option<Printed<Data>> {
        serde_json::from_str(json).ok()
    }

    #[test]
    fn envelopes_decode_by_their_ok_flag() -> anyhow::Result<()> {
        assert!(matches!(
            decode(r#"{"ok":true,"data":{"n":1},"inbox":null,"next":null}"#),
            Some(Printed::Success {
                data: Data { n: 1 },
                inbox: None,
                ..
            })
        ));
        let failure = decode(
            r#"{"ok":false,"error":{"code":"no_work","message":"x","retryable":true,
                "retryAfterMs":250,"next":"rh work"}}"#,
        );
        let Some(Printed::Failure { error, .. }) = failure else {
            anyhow::bail!("not a failure");
        };
        assert_eq!(error.code, Code::Agent(AgentErrorCode::NoWork));
        let error = Error::Rejected(error);
        assert_eq!(error.code(), "no_work");
        assert_eq!(error.retry(), Some(Duration::from_millis(250)));
        assert_eq!(error.agent_code(), Some(AgentErrorCode::NoWork));
        Ok(())
    }

    #[test]
    fn a_local_code_is_kept_and_a_final_refusal_is_not_retried() -> anyhow::Result<()> {
        let Some(Printed::Failure { error, .. }) = decode(
            r#"{"ok":false,"error":{"code":"untrusted_remote","message":"x",
                "retryable":false,"retryAfterMs":null,"next":null}}"#,
        ) else {
            anyhow::bail!("not a failure");
        };
        let error = Error::Rejected(error);
        assert_eq!(error.code(), "untrusted_remote");
        assert_eq!((error.retry(), error.agent_code()), (None, None));
        Ok(())
    }

    #[test]
    fn a_mismatched_or_garbled_envelope_is_refused() {
        assert!(decode(r#"{"ok":false,"data":{"n":1},"inbox":null}"#).is_none());
        assert!(decode(r#"{"ok":"yes","data":{"n":1},"inbox":null}"#).is_none());
        assert!(decode("rh: not json").is_none());
    }

    #[tokio::test]
    async fn a_child_past_its_timeout_is_killed() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let script = dir.path().join("slow-rh");
        std::fs::write(&script, "#!/bin/sh\nexec sleep 5\n")?;
        #[cfg(unix)]
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
        let runner = Runner::new(script, 1, Duration::from_millis(100));
        let agent = AgentEnv {
            name: "swarm-00".to_owned(),
            home: dir.path().to_owned(),
        };
        let started = std::time::Instant::now();
        let result = runner.rh::<Data>(&agent, dir.path(), &["status"]).await;
        assert!(matches!(result, Err(Error::TimedOut("rh"))), "{result:?}");
        assert!(started.elapsed() < Duration::from_secs(2));
        Ok(())
    }

    #[tokio::test]
    async fn a_missing_program_cannot_start() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let runner = Runner::new(dir.path().join("no-rh"), 1, Duration::from_secs(1));
        let agent = AgentEnv {
            name: "swarm-00".to_owned(),
            home: dir.path().to_owned(),
        };
        let result = runner.rh::<Data>(&agent, dir.path(), &["status"]).await;
        assert!(matches!(result, Err(Error::Spawn { program: "rh", .. })));
        Ok(())
    }

    fn script(dir: &Path, name: &str, body: &str) -> anyhow::Result<PathBuf> {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n"))?;
        #[cfg(unix)]
        std::fs::set_permissions(&path, std::os::unix::fs::PermissionsExt::from_mode(0o755))?;
        Ok(path)
    }

    fn output_of(
        runner: &Runner,
        dir: &Path,
        program: &Path,
    ) -> impl Future<Output = Result<Output, Error>> {
        let agent = AgentEnv {
            name: "swarm-00".to_owned(),
            home: dir.to_owned(),
        };
        let command = Command::new(program);
        let runner = runner.clone();
        let dir = dir.to_owned();
        async move { runner.output("rh", &agent, &dir, command).await }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_child_printing_past_the_limit_is_killed_while_it_runs() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let pid_file = dir.path().join("pid");
        let program = script(
            dir.path(),
            "chatty-rh",
            &format!("echo $$ > '{}'\nexec yes swarm", pid_file.display()),
        )?;
        let runner = Runner::new(program.clone(), 1, Duration::from_secs(60));
        let started = std::time::Instant::now();
        let result = output_of(&runner, dir.path(), &program).await;
        assert!(
            matches!(result, Err(Error::TooMuchOutput("rh"))),
            "{:?}",
            result.err()
        );
        // Well within the command timeout: the limit, not the timeout, stopped it.
        assert!(started.elapsed() < Duration::from_secs(20));
        let pid = std::fs::read_to_string(&pid_file)?;
        let alive = std::process::Command::new("kill")
            .args(["-0", pid.trim()])
            .stderr(Stdio::null())
            .status()?;
        assert!(!alive.success(), "the child is still running");
        Ok(())
    }

    #[tokio::test]
    async fn output_up_to_the_limit_is_kept_and_one_byte_more_is_refused() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let runner = Runner::new(PathBuf::from("rh"), 1, Duration::from_secs(60));
        let exact = script(
            dir.path(),
            "exact",
            &format!("head -c {MAX_OUTPUT_BYTES} /dev/zero"),
        )?;
        let output = output_of(&runner, dir.path(), &exact).await?;
        assert!(output.success);
        assert_eq!(output.bytes.len(), MAX_OUTPUT_BYTES);
        let over = script(
            dir.path(),
            "over",
            &format!("head -c {} /dev/zero", MAX_OUTPUT_BYTES + 1),
        )?;
        let result = output_of(&runner, dir.path(), &over).await;
        assert!(
            matches!(result, Err(Error::TooMuchOutput("rh"))),
            "{:?}",
            result.err()
        );
        assert_eq!(Error::TooMuchOutput("rh").code(), "output_too_large");
        assert_eq!(Error::TooMuchOutput("rh").retry(), None);
        Ok(())
    }
}
