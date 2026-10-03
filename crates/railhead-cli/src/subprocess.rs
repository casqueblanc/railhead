//! Child processes with an overall deadline.
//!
//! On Unix the child leads its own process group, so a child that outlives its deadline is
//! stopped together with everything it started: a Git hook, filter, transport or upload pack.

use std::io::{self, Read as _};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

/// How long a child that outlived its deadline has to exit after `SIGTERM`, so Git can remove its
/// lock files, before its process group is killed.
#[cfg(unix)]
const TERMINATE_GRACE: Duration = Duration::from_secs(1);

/// The longest pause between two checks on a running child.
const MAX_POLL: Duration = Duration::from_millis(100);

/// A child that exited before its deadline.
#[derive(Debug)]
pub struct Finished {
    /// How it exited.
    pub status: ExitStatus,
    /// Everything it wrote to stdout, when stdout was captured; otherwise empty.
    pub stdout: Vec<u8>,
}

/// Why a child produced no [`Finished`].
#[derive(Debug, thiserror::Error)]
pub enum RunError {
    /// It could not be started or waited for.
    #[error("{0}")]
    Io(#[from] io::Error),
    /// It was still running at its deadline and was stopped.
    #[error("was still running after {} seconds and was stopped", .0.as_secs())]
    TimedOut(Duration),
}

/// Runs `command` and waits at most `limit` for it, capturing stdout when `capture` is set.
///
/// A child still running at the deadline, or one whose captured stdout is still held open then by a
/// process it started, is stopped and reaped, with its process group on Unix, before this returns.
///
/// # Errors
///
/// [`RunError::Io`] when the child cannot be started or waited for, [`RunError::TimedOut`] when it
/// or its stdout outlived `limit`.
pub fn run(command: &mut Command, limit: Duration, capture: bool) -> Result<Finished, RunError> {
    let deadline = Instant::now().checked_add(limit).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "the deadline is too far away")
    })?;
    command.stdout(if capture {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(command, 0);
    let mut child = command.spawn()?;
    let stdout = match child.stdout.take() {
        None => None,
        Some(mut pipe) => {
            let (sender, receiver) = mpsc::channel();
            let reader = thread::Builder::new().spawn(move || {
                let mut bytes = Vec::new();
                let read = pipe.read_to_end(&mut bytes).map(|_| bytes);
                // The receiver is gone only when the deadline passed; nothing is left to tell.
                let _ = sender.send(read);
            });
            if let Err(error) = reader {
                stop(&mut child)?;
                return Err(error.into());
            }
            Some(receiver)
        }
    };

    // Captured stdout is collected before the child is reaped: until then its process id, and so
    // its process group id, cannot be reused, and a process it left behind holding stdout can
    // still be stopped with the group.
    let stdout = match stdout {
        None => Vec::new(),
        Some(receiver) => {
            let remaining = deadline.saturating_duration_since(Instant::now());
            match receiver.recv_timeout(remaining) {
                Ok(Ok(bytes)) => bytes,
                Ok(Err(error)) => {
                    stop(&mut child)?;
                    return Err(error.into());
                }
                Err(_) => {
                    stop(&mut child)?;
                    return Err(RunError::TimedOut(limit));
                }
            }
        }
    };
    let status = match wait_until(&mut child, deadline) {
        Ok(Some(status)) => status,
        Ok(None) => {
            stop(&mut child)?;
            return Err(RunError::TimedOut(limit));
        }
        Err(error) => {
            stop(&mut child)?;
            return Err(error.into());
        }
    };
    Ok(Finished { status, stdout })
}

/// Waits for `child` until `deadline`; `None` when it is still running then.
fn wait_until(child: &mut Child, deadline: Instant) -> io::Result<Option<ExitStatus>> {
    let mut pause = Duration::from_millis(5);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        thread::sleep(pause.min(remaining));
        pause = pause.saturating_mul(2).min(MAX_POLL);
    }
}

/// Stops `child` and everything in its process group, then reaps it.
///
/// The child is not reaped until its group has been killed, so the group's id cannot have been
/// reused by an unrelated process when the signal is sent.
#[cfg(unix)]
fn stop(child: &mut Child) -> io::Result<()> {
    use rustix::process::{Pid, Signal, kill_process_group};

    let group = i32::try_from(child.id()).ok().and_then(Pid::from_raw);
    let Some(group) = group else {
        child.kill()?;
        child.wait()?;
        return Ok(());
    };
    // The group may already be empty; that is the outcome wanted.
    let _ = kill_process_group(group, Signal::TERM);
    thread::sleep(TERMINATE_GRACE);
    let _ = kill_process_group(group, Signal::KILL);
    child.wait()?;
    Ok(())
}

/// Stops `child`, then reaps it.
#[cfg(not(unix))]
fn stop(child: &mut Child) -> io::Result<()> {
    // The child may have exited since it was last checked; reaping it is what matters.
    let _ = child.kill();
    child.wait()?;
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn sh(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]).stdin(Stdio::null());
        command
    }

    /// Whether `pid` still runs two seconds from now; an orphan killed by the group signal may
    /// briefly remain until init reaps it.
    fn alive(pid: i32) -> bool {
        let Some(pid) = rustix::process::Pid::from_raw(pid) else {
            return false;
        };
        let until = Instant::now() + Duration::from_secs(2);
        while rustix::process::test_kill_process(pid).is_ok() {
            if Instant::now() > until {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    #[test]
    fn a_child_that_exits_in_time_returns_its_status_and_output() -> anyhow::Result<()> {
        let done = run(&mut sh("echo one; exit 3"), Duration::from_secs(5), true)?;
        assert_eq!(done.status.code(), Some(3));
        assert_eq!(done.stdout, b"one\n");
        let quiet = run(&mut sh("echo one"), Duration::from_secs(5), false)?;
        assert!(quiet.status.success());
        assert_eq!(quiet.stdout, b"");
        Ok(())
    }

    #[test]
    fn a_child_past_its_deadline_is_stopped_with_its_own_children() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let pids = dir.path().join("pids");
        // The child waits on a grandchild that ignores SIGTERM, so only the group kill ends it.
        let script = format!(
            "(trap '' TERM; sleep 600) & echo $! > '{0}'; echo $$ >> '{0}'; wait",
            pids.display()
        );
        let started = Instant::now();
        let error = run(&mut sh(&script), Duration::from_millis(300), true).err();
        assert!(
            matches!(error, Some(RunError::TimedOut(limit)) if limit == Duration::from_millis(300)),
            "{error:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        let recorded = std::fs::read_to_string(&pids)?;
        let recorded: Vec<i32> = recorded.lines().map(str::parse).collect::<Result<_, _>>()?;
        assert_eq!(recorded.len(), 2);
        for pid in recorded {
            assert!(!alive(pid), "process {pid} outlived the deadline");
        }
        Ok(())
    }

    #[test]
    fn a_descendant_holding_stdout_past_the_deadline_is_stopped() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let pid = dir.path().join("pid");
        // The child exits at once, leaving a SIGTERM-ignoring process that keeps stdout open.
        let script = format!("(trap '' TERM; sleep 600) & echo $! > '{}'", pid.display());
        let started = Instant::now();
        let error = run(&mut sh(&script), Duration::from_millis(300), true).err();
        assert!(
            matches!(error, Some(RunError::TimedOut(limit)) if limit == Duration::from_millis(300)),
            "{error:?}"
        );
        assert!(started.elapsed() < Duration::from_secs(10));
        let recorded: i32 = std::fs::read_to_string(&pid)?.trim().parse()?;
        assert!(!alive(recorded), "process {recorded} outlived the deadline");
        Ok(())
    }

    #[test]
    fn a_missing_program_is_an_io_error() {
        let error = run(
            &mut Command::new("/nonexistent/railhead-no-such-program"),
            Duration::from_secs(1),
            false,
        )
        .err();
        assert!(
            matches!(&error, Some(RunError::Io(io)) if io.kind() == io::ErrorKind::NotFound),
            "{error:?}"
        );
    }
}
