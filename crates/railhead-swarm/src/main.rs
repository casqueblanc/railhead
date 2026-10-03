//! `railhead-swarm`: runs N simulated agents against one Railhead repository and prints what
//! happens as JSON lines.
//!
//! Each simulated agent is a real `rh` process with its own `RAILHEAD_HOME`, identity and Git
//! clones, so a run exercises the agent wire, claims, the push fence, `rh ready` and the train as
//! a coding agent would. The agents are scripted: what they edit comes from the scenario's seeded
//! plan. Every line printed is marked simulated, and the summary is labelled as measured on a
//! simulated run.
//!
//! Agent `i` is named `swarm-NN` and uses `<homes>/swarm-NN` as its `RAILHEAD_HOME`, which must
//! already hold that agent, joined to the scenario's origin and repository. The driver checks each
//! identity before any agent runs and refuses to start on a mismatch. Clones go in a temporary
//! directory that is removed when the run ends, on Ctrl-C included; every child process is killed
//! first, on an error included. Each agent's progress is kept in `<homes>/progress/swarm-NN.json`,
//! so running a stopped scenario again resumes it; a record that is damaged or belongs to another
//! scenario file stops the run until `--discard-progress` removes it. A run holds an
//! operating-system lock on `<homes>/progress/swarm-NN.lock` for each agent while it runs, so a
//! second run on the same homes refuses to start; the lock ends with the process, so a run that
//! was killed leaves nothing to clean up before the next. Ctrl-C is listened for before anything
//! else, so one pressed during startup still stops the run cleanly.
//!
//! The exit code is 0 only when every agent finished every planned task; 1 when an agent failed or
//! stalled, or the run timed out; 130 on Ctrl-C; 2 when the run could not start. A task whose claim
//! closed without a closed reason is reported as unverified, not as a failure, until
//! casqueblanc/railhead#237 adds that reason to the agent wire.
//!
//! ```text
//! railhead-swarm --scenario crates/railhead-swarm/scenarios/local.json \
//!     --homes ~/.railhead-swarm --rh target/debug/rh > run.jsonl
//! ```

mod agent;
mod confined;
mod events;
mod plan;
mod process;
mod progress;
mod scenario;

use std::future::Future;
use std::io::{self, Read as _, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Context as _;
use clap::Parser;
use tokio::sync::mpsc;
use tokio::task::JoinSet;

use crate::agent::{Agent, Landings, Shared};
use crate::events::{Emitter, Event, StopReason, Writer};
use crate::plan::Plan;
use crate::process::{AgentEnv, Reaper, Runner, STOP_GRACE};
use crate::progress::{HomeLock, Progress, ProgressFile, RunKey};
use crate::scenario::{MAX_SCENARIO_BYTES, Scenario};

/// Largest identity record read from an agent home, in bytes.
const MAX_IDENTITY_BYTES: u64 = 64 * 1024;

/// Run simulated agents, each a real `rh` process, against one Railhead repository.
#[derive(Debug, Parser)]
#[command(name = "railhead-swarm", version, about)]
struct Cli {
    /// The scenario file (JSON).
    #[arg(long, value_name = "FILE")]
    scenario: PathBuf,

    /// The directory holding each agent's `RAILHEAD_HOME`, as `swarm-00`, `swarm-01`, ...
    #[arg(long, value_name = "DIR")]
    homes: PathBuf,

    /// The `rh` binary the agents run.
    #[arg(long, value_name = "PATH", default_value = "rh")]
    rh: PathBuf,

    /// Where the run's temporary directory of clones is made. Defaults to the system's.
    #[arg(long, value_name = "DIR")]
    workdir: Option<PathBuf>,

    /// Removes every agent's progress record first, so the scenario starts over instead of
    /// resuming.
    #[arg(long)]
    discard_progress: bool,
}

/// The name of agent `index`.
fn agent_name(index: u32) -> String {
    format!("swarm-{index:02}")
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(&cli).await {
        Ok(Ended {
            stopped_by: StopReason::Interrupted,
            ..
        }) => ExitCode::from(130),
        Ok(Ended {
            succeeded: true, ..
        }) => ExitCode::SUCCESS,
        Ok(Ended {
            succeeded: false, ..
        }) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("railhead-swarm: {error:#}");
            ExitCode::from(2)
        }
    }
}

/// Reads the scenario and the key its progress records are bound to.
fn read_scenario(path: &Path) -> anyhow::Result<(Scenario, RunKey)> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("opening the scenario {}", path.display()))?;
    let mut text = String::new();
    let limit = u64::try_from(MAX_SCENARIO_BYTES)?.saturating_add(1);
    file.take(limit)
        .read_to_string(&mut text)
        .with_context(|| format!("reading the scenario {}", path.display()))?;
    let scenario = Scenario::parse(&text)?;
    let key = RunKey::new(scenario.seed, text.as_bytes());
    Ok((scenario, key))
}

/// The part of an `rh` identity record the driver checks.
#[derive(serde::Deserialize)]
struct Joined {
    origin: String,
    repo: String,
}

/// Checks that agent `name`'s home holds that agent, joined to the scenario's origin and
/// repository, so no `rh` command can reach another one.
fn check_home(scenario: &Scenario, home: &Path, name: &str) -> anyhow::Result<()> {
    let path = home.join("agents").join(name).join("identity.json");
    let file = std::fs::File::open(&path)
        .with_context(|| format!("{} holds no agent {name}", home.display()))?;
    let mut text = String::new();
    file.take(MAX_IDENTITY_BYTES)
        .read_to_string(&mut text)
        .with_context(|| format!("reading {}", path.display()))?;
    let joined: Joined = serde_json::from_str(&text)
        .with_context(|| format!("{} is not an agent identity", path.display()))?;
    anyhow::ensure!(
        scenario.admits(&joined.origin, &joined.repo),
        "agent {name} in {} joined another origin or repository than the scenario names",
        home.display()
    );
    Ok(())
}

/// The progress file in `dir` of the agent at `index` and the record an earlier run of `key` left
/// there for its edits in `plan`, or none after removing it when `discard`.
fn load_progress(
    dir: &Path,
    index: u32,
    key: &RunKey,
    plan: &Plan,
    discard: bool,
) -> anyhow::Result<(ProgressFile, Option<Progress>)> {
    let name = agent_name(index);
    let file = ProgressFile::new(dir, &name);
    if discard {
        file.clear()
            .with_context(|| format!("discarding the progress of {name}"))?;
        return Ok((file, None));
    }
    let record = file
        .load(key, plan.agent(usize::try_from(index)?))
        .map_err(|error| anyhow::anyhow!("{error}; run with --discard-progress to start over"))?;
    Ok((file, record))
}

/// Ctrl-C, recorded from the moment the listener is made: until then the default action would
/// end the process without removing its clones.
struct Interrupt(
    #[cfg(unix)] tokio::signal::unix::Signal,
    #[cfg(windows)] tokio::signal::windows::CtrlC,
);

impl Interrupt {
    fn listen() -> io::Result<Self> {
        #[cfg(unix)]
        let listener = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt());
        #[cfg(windows)]
        let listener = tokio::signal::windows::ctrl_c();
        listener.map(Self)
    }

    /// Resolves on the first Ctrl-C since [`Interrupt::listen`], one before this call included.
    async fn recv(&mut self) {
        // `None` means no further signal can arrive, so the run is never interrupted.
        if self.0.recv().await.is_none() {
            std::future::pending::<()>().await;
        }
    }
}

/// How a run ended.
struct Ended {
    stopped_by: StopReason,
    succeeded: bool,
}

async fn run(cli: &Cli) -> anyhow::Result<Ended> {
    let mut interrupt = Interrupt::listen().context("listening for Ctrl-C")?;
    let (scenario, key) = read_scenario(&cli.scenario)?;
    let homes = (0..scenario.agents)
        .map(|index| {
            let name = agent_name(index);
            let home = cli.homes.join(&name);
            check_home(&scenario, &home, &name)?;
            Ok(home)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let progress = cli.homes.join("progress");
    // Declared before the clones, so the locks are released only after the clones are removed.
    let _locks = (0..scenario.agents)
        .map(|index| HomeLock::acquire(&progress, &agent_name(index)))
        .collect::<Result<Vec<_>, _>>()?;
    let plan = Plan::new(
        scenario.seed,
        scenario.agents,
        scenario.rounds,
        scenario.mix,
    );
    let saved = (0..scenario.agents)
        .map(|index| load_progress(&progress, index, &key, &plan, cli.discard_progress))
        .collect::<anyhow::Result<Vec<_>>>()?;
    let mut builder = tempfile::Builder::new();
    builder.prefix("railhead-swarm-");
    let clones = match &cli.workdir {
        Some(dir) => builder.tempdir_in(dir),
        None => builder.tempdir(),
    }
    .context("creating the run's temporary directory")?;

    let started = Instant::now();
    let (events, mut received) = Emitter::channel();
    let runner = Runner::new(
        cli.rh.clone(),
        scenario.bounds.concurrency,
        scenario.bounds.command_timeout,
    );
    let reaper = runner.reaper();
    let shared = Arc::new(Shared {
        runner,
        events,
        bounds: scenario.bounds,
        fork_prefix: scenario.repository.fork_prefix(&scenario.origin),
        deadline: started
            .checked_add(scenario.bounds.run_timeout)
            .context("the run timeout is out of range")?,
        landings: Mutex::new(Landings::default()),
    });
    let mut writer = Writer::new(io::stdout(), started);
    writer.write(&Event::RunStarted {
        seed: scenario.seed,
        agents: scenario.agents,
        rounds: scenario.rounds,
        repository: scenario.repository.to_string(),
    })?;

    // Every agent is prepared before any runs, so a failure here leaves nothing to stop.
    let mut prepared = Vec::with_capacity(homes.len());
    for ((slot, home), (progress, saved)) in (0..scenario.agents).zip(homes).zip(saved) {
        let name = agent_name(slot);
        let workdir = clones.path().join(&name);
        std::fs::create_dir(&workdir).with_context(|| format!("creating {}", workdir.display()))?;
        prepared.push(Agent {
            slot,
            progress,
            saved,
            env: AgentEnv { name, home },
            workdir,
            edits: plan.agent(usize::try_from(slot)?).to_vec(),
            key: key.clone(),
        });
    }
    let mut agents = JoinSet::new();
    for agent in prepared {
        agents.spawn(agent.run(Arc::clone(&shared)));
    }
    // The agents hold the only emitters now, so the stream ends when the last agent does.
    drop(shared);

    let run_timeout = scenario.bounds.run_timeout;
    let stop = async move {
        tokio::select! {
            biased;
            () = interrupt.recv() => StopReason::Interrupted,
            () = tokio::time::sleep(run_timeout) => StopReason::TimedOut,
        }
    };
    let stopped_by = supervise(&mut writer, &mut agents, &reaper, &mut received, stop).await?;
    while let Ok(event) = received.try_recv() {
        writer.write(&event)?;
    }
    let summary = writer.finish(stopped_by)?;
    clones
        .close()
        .context("removing the run's temporary directory")?;
    Ok(Ended {
        stopped_by,
        succeeded: summary.succeeded(scenario.agents),
    })
}

/// Writes the agents' events until the last agent ends or `stop` resolves, then stops every
/// agent and waits for it, whatever ended the loop, a write error included. Aborting an agent
/// asks its running child to stop; the reaper waits for each such child, killing it after
/// [`STOP_GRACE`], so none outlives this and writes into a clone the run is about to remove.
async fn supervise<W: Write>(
    writer: &mut Writer<W>,
    agents: &mut JoinSet<()>,
    reaper: &Reaper,
    received: &mut mpsc::Receiver<Event>,
    stop: impl Future<Output = StopReason>,
) -> io::Result<StopReason> {
    let outcome = async {
        tokio::pin!(stop);
        loop {
            tokio::select! {
                biased;
                reason = &mut stop => break Ok(reason),
                event = received.recv() => match event {
                    Some(event) => writer.write(&event)?,
                    None => break Ok(StopReason::Completed),
                },
            }
        }
    }
    .await;
    agents.abort_all();
    while agents.join_next().await.is_some() {}
    reaper.reap(STOP_GRACE).await;
    outcome
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::events::AgentState;

    /// Sets its flag when dropped, as an agent's children are killed when it is.
    struct Child(Arc<AtomicBool>);

    impl Drop for Child {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    /// Standard output closed under the run, as when it is piped to `head`.
    struct Closed;

    impl Write for Closed {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn agent_holding(agents: &mut JoinSet<()>) -> Arc<AtomicBool> {
        let killed = Arc::new(AtomicBool::new(false));
        let child = Child(Arc::clone(&killed));
        agents.spawn(async move {
            let _child = child;
            std::future::pending::<()>().await;
        });
        killed
    }

    #[tokio::test]
    async fn a_write_error_stops_and_joins_every_agent_before_returning() -> anyhow::Result<()> {
        let (events, mut received) = Emitter::channel();
        let mut agents = JoinSet::new();
        let killed = agent_holding(&mut agents);
        events
            .emit(Event::AgentState {
                agent: agent_name(0),
                state: AgentState::Claiming,
            })
            .await;
        let mut writer = Writer::new(Closed, Instant::now());
        let outcome = supervise(
            &mut writer,
            &mut agents,
            &Reaper::default(),
            &mut received,
            std::future::pending(),
        )
        .await;
        assert!(outcome.is_err_and(|error| error.kind() == io::ErrorKind::BrokenPipe));
        assert!(agents.is_empty());
        assert!(killed.load(Ordering::SeqCst));
        Ok(())
    }

    #[tokio::test]
    async fn a_stop_also_stops_and_joins_every_agent() -> anyhow::Result<()> {
        let (_events, mut received) = Emitter::channel();
        let mut agents = JoinSet::new();
        let killed = agent_holding(&mut agents);
        let mut writer = Writer::new(Vec::new(), Instant::now());
        let stopped = supervise(
            &mut writer,
            &mut agents,
            &Reaper::default(),
            &mut received,
            async { StopReason::TimedOut },
        )
        .await?;
        assert_eq!(stopped, StopReason::TimedOut);
        assert!(agents.is_empty());
        assert!(killed.load(Ordering::SeqCst));
        Ok(())
    }

    #[tokio::test]
    async fn the_stream_ends_when_the_last_agent_does() -> anyhow::Result<()> {
        let (events, mut received) = Emitter::channel();
        drop(events);
        let mut agents = JoinSet::new();
        let mut writer = Writer::new(Vec::new(), Instant::now());
        let stopped = supervise(
            &mut writer,
            &mut agents,
            &Reaper::default(),
            &mut received,
            std::future::pending(),
        )
        .await?;
        assert_eq!(stopped, StopReason::Completed);
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_stopped_run_returns_only_after_its_children_exited() -> anyhow::Result<()> {
        use std::os::unix::fs::PermissionsExt as _;

        let dir = tempfile::tempdir()?;
        let clone = dir.path().join("clone");
        std::fs::create_dir(&clone)?;
        let done = dir.path().join("done");
        // An `rh` that is still writing into its clone when it is asked to stop.
        let rh = dir.path().join("rh");
        std::fs::write(
            &rh,
            format!(
                "#!/bin/sh\ntrap 'sleep 0.3; touch {}; exit 0' TERM\nwhile :; do touch {}/x; sleep 0.05; done\n",
                done.display(),
                clone.display()
            ),
        )?;
        std::fs::set_permissions(&rh, std::fs::Permissions::from_mode(0o755))?;
        let runner = Runner::new(rh, 1, std::time::Duration::from_secs(60));
        let reaper = runner.reaper();
        let env = AgentEnv {
            name: agent_name(0),
            home: dir.path().to_owned(),
        };
        let (_events, mut received) = Emitter::channel();
        let mut agents = JoinSet::new();
        let workdir = clone.clone();
        agents.spawn(async move {
            let _ = runner
                .rh::<serde_json::Value>(&env, &workdir, &["work"])
                .await;
        });
        let mut writer = Writer::new(Vec::new(), Instant::now());
        // Stopped once the child is running with its trap set.
        let running = clone.join("x");
        let stopped = supervise(&mut writer, &mut agents, &reaper, &mut received, async {
            for _ in 0..500 {
                if running.exists() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
            StopReason::Interrupted
        })
        .await?;
        assert_eq!(stopped, StopReason::Interrupted);
        assert!(done.exists(), "returned before the child finished stopping");
        // Nothing writes into the clone any more, so removing it succeeds and stays removed.
        std::fs::remove_dir_all(&clone)?;
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(!clone.exists());
        Ok(())
    }

    #[test]
    fn agents_are_named_by_index() {
        assert_eq!(agent_name(0), "swarm-00");
        assert_eq!(agent_name(63), "swarm-63");
    }

    #[test]
    fn the_command_line_needs_a_scenario_and_homes() {
        assert!(Cli::try_parse_from(["railhead-swarm"]).is_err());
        assert!(Cli::try_parse_from(["railhead-swarm", "--scenario", "s.json"]).is_err());
        let cli =
            Cli::try_parse_from(["railhead-swarm", "--scenario", "s.json", "--homes", "homes"]);
        assert!(cli.is_ok_and(|cli| cli.rh == Path::new("rh")
            && cli.workdir.is_none()
            && !cli.discard_progress));
    }

    #[test]
    fn a_scenario_file_is_read_whole_or_refused() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        let path = dir.path().join("scenario.json");
        assert!(read_scenario(&path).is_err());
        std::fs::write(&path, " ".repeat(MAX_SCENARIO_BYTES + 1))?;
        let error = read_scenario(&path).err().map(|e| e.to_string());
        assert_eq!(
            error.as_deref(),
            Some("the scenario is larger than 65536 bytes")
        );
        Ok(())
    }

    fn scenario() -> anyhow::Result<Scenario> {
        Ok(Scenario::parse(
            r#"{"seed": 1, "origin": "http://127.0.0.1:8787", "repository": "casqueblanc/demo",
                "rounds": 1, "mix": {"disjoint": 1, "sameFileHunks": 0, "overlapping": 0}}"#,
        )?)
    }

    fn home_with(identity: &str) -> anyhow::Result<tempfile::TempDir> {
        let home = tempfile::tempdir()?;
        let dir = home.path().join("agents/swarm-00");
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("identity.json"), identity)?;
        Ok(home)
    }

    #[test]
    fn a_home_joined_to_the_scenario_repository_is_accepted() -> anyhow::Result<()> {
        let home = home_with(
            r#"{"name":"swarm-00","agentId":"agt_swarm00","origin":"http://127.0.0.1:8787",
                "repo":"casqueblanc/demo"}"#,
        )?;
        check_home(&scenario()?, home.path(), "swarm-00")
    }

    #[test]
    fn a_home_joined_elsewhere_or_missing_is_refused() -> anyhow::Result<()> {
        let scenario = scenario()?;
        let other = home_with(
            r#"{"name":"swarm-00","origin":"http://127.0.0.1:8787","repo":"casqueblanc/other"}"#,
        )?;
        let error = check_home(&scenario, other.path(), "swarm-00").err();
        assert!(error.is_some_and(|e| {
            e.to_string()
                .contains("joined another origin or repository")
        }),);
        let origin = home_with(r#"{"origin":"http://127.0.0.1:9999","repo":"casqueblanc/demo"}"#)?;
        assert!(check_home(&scenario, origin.path(), "swarm-00").is_err());
        let damaged = home_with("not json")?;
        assert!(check_home(&scenario, damaged.path(), "swarm-00").is_err());
        // No identity of that name.
        assert!(check_home(&scenario, origin.path(), "swarm-01").is_err());
        Ok(())
    }
}
