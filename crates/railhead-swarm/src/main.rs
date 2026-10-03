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
//! first. Each agent's progress is kept in `<homes>/progress/swarm-NN.json`, so running a stopped
//! scenario again resumes it.
//!
//! The exit code is 0 only when every agent landed every planned task; 1 when the run ended with
//! a task not landed, an agent failed or stalled, or the run timed out; 130 on Ctrl-C; 2 when the
//! run could not start.
//!
//! ```text
//! railhead-swarm --scenario crates/railhead-swarm/scenarios/local.json \
//!     --homes ~/.railhead-swarm --rh target/debug/rh > run.jsonl
//! ```

mod agent;
mod events;
mod plan;
mod process;
mod progress;
mod scenario;

use std::io::{self, Read as _};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use anyhow::Context as _;
use clap::Parser;
use tokio::task::JoinSet;

use crate::agent::{Agent, Landings, Shared};
use crate::events::{Emitter, Event, StopReason, Writer};
use crate::plan::Plan;
use crate::process::{AgentEnv, Runner};
use crate::progress::ProgressFile;
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

fn read_scenario(path: &Path) -> anyhow::Result<Scenario> {
    let file = std::fs::File::open(path)
        .with_context(|| format!("opening the scenario {}", path.display()))?;
    let mut text = String::new();
    let limit = u64::try_from(MAX_SCENARIO_BYTES)?.saturating_add(1);
    file.take(limit)
        .read_to_string(&mut text)
        .with_context(|| format!("reading the scenario {}", path.display()))?;
    Ok(Scenario::parse(&text)?)
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

/// How a run ended.
struct Ended {
    stopped_by: StopReason,
    succeeded: bool,
}

async fn run(cli: &Cli) -> anyhow::Result<Ended> {
    let scenario = read_scenario(&cli.scenario)?;
    let homes = (0..scenario.agents)
        .map(|index| {
            let name = agent_name(index);
            let home = cli.homes.join(&name);
            check_home(&scenario, &home, &name)?;
            Ok(home)
        })
        .collect::<anyhow::Result<Vec<_>>>()?;
    let progress = cli.homes.join("progress");
    let mut builder = tempfile::Builder::new();
    builder.prefix("railhead-swarm-");
    let clones = match &cli.workdir {
        Some(dir) => builder.tempdir_in(dir),
        None => builder.tempdir(),
    }
    .context("creating the run's temporary directory")?;

    let started = Instant::now();
    let (events, mut received) = Emitter::channel();
    let shared = Arc::new(Shared {
        runner: Runner::new(
            cli.rh.clone(),
            scenario.bounds.concurrency,
            scenario.bounds.command_timeout,
        ),
        events,
        bounds: scenario.bounds,
        fork_prefix: scenario.repository.fork_prefix(&scenario.origin),
        landings: Mutex::new(Landings::default()),
    });
    let mut writer = Writer::new(io::stdout(), started);
    writer.write(&Event::RunStarted {
        seed: scenario.seed,
        agents: scenario.agents,
        rounds: scenario.rounds,
        repository: scenario.repository.to_string(),
    })?;

    let plan = Plan::new(
        scenario.seed,
        scenario.agents,
        scenario.rounds,
        scenario.mix,
    );
    let mut agents = JoinSet::new();
    for (slot, home) in (0..scenario.agents).zip(homes) {
        let name = agent_name(slot);
        let workdir = clones.path().join(&name);
        std::fs::create_dir(&workdir).with_context(|| format!("creating {}", workdir.display()))?;
        let agent = Agent {
            slot,
            progress: ProgressFile::new(&progress, &name),
            env: AgentEnv { name, home },
            workdir,
            edits: plan.agent(usize::try_from(slot)?).to_vec(),
            seed: scenario.seed,
        };
        agents.spawn(agent.run(Arc::clone(&shared)));
    }
    // The agents hold the only emitters now, so the stream ends when the last agent does.
    drop(shared);

    let deadline = tokio::time::sleep(scenario.bounds.run_timeout);
    let interrupt = tokio::signal::ctrl_c();
    tokio::pin!(deadline, interrupt);
    let stopped_by = loop {
        tokio::select! {
            biased;
            _ = &mut interrupt => break StopReason::Interrupted,
            () = &mut deadline => break StopReason::TimedOut,
            event = received.recv() => match event {
                Some(event) => writer.write(&event)?,
                None => break StopReason::Completed,
            },
        }
    };
    // Aborting drops each agent's children, which kills them, before the clones are removed.
    agents.abort_all();
    while agents.join_next().await.is_some() {}
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(cli.is_ok_and(|cli| cli.rh == Path::new("rh") && cli.workdir.is_none()));
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
