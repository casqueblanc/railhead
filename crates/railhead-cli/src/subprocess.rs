//! Child processes with an overall deadline.
//!
//! On Unix the child leads its own process group, so a child that outlives its deadline is
//! stopped together with everything it started: a Git hook, filter, transport or upload pack.
//!
//! On Unix, `SIGTERM` or `SIGINT` sent to `rh` while a child runs stops that child's process group
//! the same way, so a Git clone cannot outlive `rh` and keep writing into a directory the caller is
//! removing. The caller then reads [`interrupted`] and ends `rh` with [`exit_on`].

use std::io::{self, Read as _};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
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
    /// `rh` received this signal while it ran, and it was stopped.
    #[error("was stopped because rh received signal {0}")]
    Interrupted(i32),
}

/// Runs `command` and waits at most `limit` for it, counted from before it is started, capturing
/// stdout when `capture` is set.
///
/// A child still running at the deadline, or one whose captured stdout is still held open then by a
/// process it started, is stopped and reaped, with its process group on Unix, before this returns.
///
/// # Errors
///
/// [`RunError::Io`] when the child cannot be started or waited for, [`RunError::TimedOut`] when it
/// or its stdout outlived `limit`, [`RunError::Interrupted`] when `rh` received `SIGTERM` or
/// `SIGINT` before or while it ran.
pub fn run(command: &mut Command, limit: Duration, capture: bool) -> Result<Finished, RunError> {
    let deadline = Instant::now().checked_add(limit).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, "the deadline is too far away")
    })?;
    run_until(command, limit, capture, || Ok(deadline))
}

/// [`run`], stopping the child at the time `deadline` returns once the child is running. Tests use
/// it to start a deadline only once the child has set itself up.
fn run_until(
    command: &mut Command,
    limit: Duration,
    capture: bool,
    deadline: impl FnOnce() -> io::Result<Instant>,
) -> Result<Finished, RunError> {
    command.stdout(if capture {
        Stdio::piped()
    } else {
        Stdio::null()
    });
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(command, 0);
    signals::watch()?;
    let _running = signals::Running::enter().map_err(RunError::Interrupted)?;
    let mut child = command.spawn()?;
    let deadline = match deadline() {
        Ok(deadline) => deadline,
        Err(error) => {
            stop(&mut child)?;
            return Err(error.into());
        }
    };
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
        Some(receiver) => loop {
            if let Some(signal) = interrupted() {
                stop(&mut child)?;
                return Err(RunError::Interrupted(signal));
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match receiver.recv_timeout(remaining.min(MAX_POLL)) {
                Ok(Ok(bytes)) => break bytes,
                Ok(Err(error)) => {
                    stop(&mut child)?;
                    return Err(error.into());
                }
                Err(RecvTimeoutError::Timeout) if remaining > MAX_POLL => {}
                Err(RecvTimeoutError::Timeout) => {
                    stop(&mut child)?;
                    return Err(RunError::TimedOut(limit));
                }
                Err(RecvTimeoutError::Disconnected) => {
                    stop(&mut child)?;
                    return Err(io::Error::other("the stdout reader stopped").into());
                }
            }
        },
    };
    let status = match wait_until(&mut child, deadline) {
        Ok(Waited::Exited(status)) => status,
        Ok(Waited::TimedOut) => {
            stop(&mut child)?;
            return Err(RunError::TimedOut(limit));
        }
        Ok(Waited::Interrupted(signal)) => {
            stop(&mut child)?;
            return Err(RunError::Interrupted(signal));
        }
        Err(error) => {
            stop(&mut child)?;
            return Err(error.into());
        }
    };
    Ok(Finished { status, stdout })
}

/// How waiting for a child ended.
enum Waited {
    /// It exited.
    Exited(ExitStatus),
    /// It was still running at the deadline.
    TimedOut,
    /// `rh` received this signal while it was running.
    Interrupted(i32),
}

/// Waits for `child` until `deadline`, or until `rh` receives `SIGTERM` or `SIGINT`.
fn wait_until(child: &mut Child, deadline: Instant) -> io::Result<Waited> {
    let mut pause = Duration::from_millis(5);
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Waited::Exited(status));
        }
        if let Some(signal) = interrupted() {
            return Ok(Waited::Interrupted(signal));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(Waited::TimedOut);
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

/// The signal `rh` received, `SIGTERM` or `SIGINT`, once a child has been run; `None` before then
/// and on platforms other than Unix.
pub fn interrupted() -> Option<i32> {
    signals::received()
}

/// Ends `rh` as `signal` would have, after the child it interrupted was stopped and cleaned up
/// after.
#[cfg(unix)]
pub fn exit_on(signal: i32) -> ! {
    signals::exit_on(signal)
}

/// Ends `rh` as `signal` would have. No signal is ever received here, so nothing calls it.
#[cfg(not(unix))]
pub fn exit_on(signal: i32) -> ! {
    std::process::exit(128_i32.saturating_add(signal))
}

/// `SIGTERM` and `SIGINT`, watched from the first child on.
///
/// A watcher thread records the signal. When no child is running it ends `rh` at once, as the
/// default action would. Otherwise the thread running the child sees the signal within
/// [`MAX_POLL`], stops the child's process group and returns [`RunError::Interrupted`], so its
/// caller can clean up before calling [`exit_on`]; the watcher ends `rh` anyway after
/// [`INTERRUPT_GRACE`](signals::INTERRUPT_GRACE).
#[cfg(unix)]
mod signals {
    use std::io;
    use std::sync::OnceLock;
    use std::sync::atomic::{AtomicI32, AtomicUsize, Ordering};
    use std::thread;
    use std::time::Duration;

    use signal_hook::consts::{SIGINT, SIGTERM};
    use signal_hook::iterator::Signals;

    /// How long `rh` may keep running after a signal that arrived while a child ran: long enough
    /// to stop the child's group and remove what the interrupted step had written.
    pub const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

    /// The signal received, or 0 before any.
    static RECEIVED: AtomicI32 = AtomicI32::new(0);
    /// How many children are running.
    static RUNNING: AtomicUsize = AtomicUsize::new(0);
    /// Whether the watcher started, or why it could not.
    static WATCHER: OnceLock<Result<(), (io::ErrorKind, String)>> = OnceLock::new();

    /// Starts the watcher, once.
    pub fn watch() -> io::Result<()> {
        WATCHER
            .get_or_init(|| start().map_err(|error| (error.kind(), error.to_string())))
            .clone()
            .map_err(|(kind, message)| io::Error::new(kind, message))
    }

    fn start() -> io::Result<()> {
        let mut signals = Signals::new([SIGTERM, SIGINT])?;
        thread::Builder::new()
            .name("rh-signals".to_owned())
            .spawn(move || {
                // The first signal ends `rh`, so the iterator is never resumed.
                if let Some(signal) = signals.forever().next() {
                    // Stored before `RUNNING` is read, as `Running::enter` does the reverse, so
                    // either a child about to start sees the signal or this sees the child.
                    RECEIVED.store(signal, Ordering::SeqCst);
                    if RUNNING.load(Ordering::SeqCst) > 0 {
                        thread::sleep(INTERRUPT_GRACE);
                    }
                    exit_on(signal);
                }
            })?;
        Ok(())
    }

    pub fn received() -> Option<i32> {
        match RECEIVED.load(Ordering::SeqCst) {
            0 => None,
            signal => Some(signal),
        }
    }

    pub fn exit_on(signal: i32) -> ! {
        // Restores the default action and raises the signal, so the parent sees `rh` ended by it.
        // Should that fail, the exit status a shell reports for the signal is used instead.
        let _ = signal_hook::low_level::emulate_default_handler(signal);
        std::process::exit(128_i32.saturating_add(signal))
    }

    /// A running child, counted until dropped.
    pub struct Running(());

    impl Running {
        /// Counts a child about to start, or returns the signal already received instead.
        pub fn enter() -> Result<Self, i32> {
            RUNNING.fetch_add(1, Ordering::SeqCst);
            let running = Self(());
            match received() {
                None => Ok(running),
                Some(signal) => Err(signal),
            }
        }
    }

    impl Drop for Running {
        fn drop(&mut self) {
            RUNNING.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// No signal is watched on platforms other than Unix.
#[cfg(not(unix))]
mod signals {
    use std::io;

    pub fn watch() -> io::Result<()> {
        Ok(())
    }

    pub fn received() -> Option<i32> {
        None
    }

    pub struct Running(());

    impl Running {
        pub fn enter() -> Result<Self, i32> {
            Ok(Self(()))
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::Path;

    /// How long a loaded machine may take to start a child or let it exit. Only a stuck child,
    /// such as one sleeping for ten minutes, takes this long.
    const PATIENCE: Duration = Duration::from_secs(60);

    fn sh(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]).stdin(Stdio::null());
        command
    }

    /// A shell command that starts a background process ignoring `SIGTERM`, which writes its own
    /// process id to `ready` once the signal is ignored, so only the group kill ends it.
    fn stubborn(ready: &Path) -> String {
        format!(
            "sh -c 'trap \"\" TERM; echo $$ > \"$0.tmp\"; mv \"$0.tmp\" \"$0\"; exec sleep 600' '{}' &",
            ready.display()
        )
    }

    /// Waits until `ready` exists, so a deadline starts only once the child's processes are set up.
    fn once_ready(ready: &Path) -> io::Result<()> {
        let until = Instant::now() + PATIENCE;
        while !ready.exists() {
            if Instant::now() > until {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the child never started",
                ));
            }
            thread::sleep(Duration::from_millis(10));
        }
        Ok(())
    }

    /// A deadline `limit` from when `ready` exists.
    fn limit_once_ready(
        ready: &Path,
        limit: Duration,
    ) -> impl FnOnce() -> io::Result<Instant> + '_ {
        move || {
            once_ready(ready)?;
            Ok(Instant::now() + limit)
        }
    }

    fn pid(path: &Path) -> anyhow::Result<i32> {
        Ok(std::fs::read_to_string(path)?.trim().parse()?)
    }

    /// Whether `pid` still runs after [`PATIENCE`]; an orphan killed by the group signal may
    /// remain briefly until init reaps it.
    fn alive(pid: i32) -> bool {
        let Some(pid) = rustix::process::Pid::from_raw(pid) else {
            return false;
        };
        let until = Instant::now() + PATIENCE;
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
        let child = dir.path().join("child");
        let grandchild = dir.path().join("grandchild");
        // The child waits on its stubborn grandchild, so it outlives any deadline.
        let script = format!(
            "echo $$ > '{}'; {} wait",
            child.display(),
            stubborn(&grandchild)
        );
        let started = Instant::now();
        let limit = Duration::from_millis(300);
        let error = run_until(
            &mut sh(&script),
            limit,
            true,
            limit_once_ready(&grandchild, limit),
        )
        .err();
        assert!(
            matches!(error, Some(RunError::TimedOut(stopped)) if stopped == limit),
            "{error:?}"
        );
        // Stopped, not waited out: the grandchild would sleep for ten minutes.
        assert!(started.elapsed() < PATIENCE * 2, "{:?}", started.elapsed());
        for pid in [pid(&child)?, pid(&grandchild)?] {
            assert!(!alive(pid), "process {pid} outlived the deadline");
        }
        Ok(())
    }

    #[test]
    fn a_descendant_holding_stdout_past_the_deadline_is_stopped() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let grandchild = dir.path().join("grandchild");
        // The child exits at once, leaving a stubborn process that keeps stdout open.
        let script = stubborn(&grandchild);
        let started = Instant::now();
        let limit = Duration::from_millis(300);
        let error = run_until(
            &mut sh(&script),
            limit,
            true,
            limit_once_ready(&grandchild, limit),
        )
        .err();
        assert!(
            matches!(error, Some(RunError::TimedOut(stopped)) if stopped == limit),
            "{error:?}"
        );
        assert!(started.elapsed() < PATIENCE * 2, "{:?}", started.elapsed());
        let recorded = pid(&grandchild)?;
        assert!(!alive(recorded), "process {recorded} outlived the deadline");
        Ok(())
    }

    #[test]
    fn a_child_is_stopped_when_its_start_fails() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let grandchild = dir.path().join("grandchild");
        let script = format!("{} wait", stubborn(&grandchild));
        let error = run_until(&mut sh(&script), Duration::from_secs(600), true, || {
            once_ready(&grandchild)?;
            Err(io::Error::other("set-up failed"))
        })
        .err();
        assert!(
            matches!(&error, Some(RunError::Io(io)) if io.to_string() == "set-up failed"),
            "{error:?}"
        );
        let recorded = pid(&grandchild)?;
        assert!(
            !alive(recorded),
            "process {recorded} outlived the failed start"
        );
        Ok(())
    }

    #[test]
    fn a_deadline_fixed_before_the_child_runs_counts_its_start() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let grandchild = dir.path().join("grandchild");
        let script = format!("{} wait", stubborn(&grandchild));
        // As `run` does, the deadline is fixed before the child starts. The child takes longer
        // than that to get going, so it is stopped at once rather than given the whole limit then.
        let limit = PATIENCE * 2;
        let fixed = Instant::now() + Duration::from_millis(300);
        let error = run_until(&mut sh(&script), limit, true, || {
            once_ready(&grandchild)?;
            thread::sleep(fixed.saturating_duration_since(Instant::now()));
            Ok(fixed)
        })
        .err();
        let stopped = Instant::now();
        assert!(
            matches!(error, Some(RunError::TimedOut(reported)) if reported == limit),
            "{error:?}"
        );
        let late = stopped.duration_since(fixed);
        assert!(late < PATIENCE, "{late:?}");
        let recorded = pid(&grandchild)?;
        assert!(!alive(recorded), "process {recorded} outlived the deadline");
        Ok(())
    }

    #[test]
    fn a_limit_too_far_away_starts_nothing() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let marker = dir.path().join("started");
        let script = format!("touch '{}'", marker.display());
        let error = run(&mut sh(&script), Duration::MAX, false).err();
        assert!(
            matches!(&error, Some(RunError::Io(io)) if io.kind() == io::ErrorKind::InvalidInput),
            "{error:?}"
        );
        assert!(!marker.exists());
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
