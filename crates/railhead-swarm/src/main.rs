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
//! already hold that agent, joined to the scenario's repository. Clones go in a temporary
//! directory that is removed when the run ends, on Ctrl-C included; every child process is killed
//! first.
//!
//! ```text
//! railhead-swarm --scenario crates/railhead-swarm/scenarios/local.json \
//!     --homes ~/.railhead-swarm --rh target/debug/rh > run.jsonl
//! ```

mod agent;
mod events;
mod plan;
mod process;
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
use crate::scenario::{MAX_SCENARIO_BYTES, Scenario};

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
        Ok(StopReason::Completed) => ExitCode::SUCCESS,
        Ok(StopReason::TimedOut) => ExitCode::FAILURE,
        Ok(StopReason::Interrupted) => ExitCode::from(130),
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

async fn run(cli: &Cli) -> anyhow::Result<StopReason> {
    let scenario = read_scenario(&cli.scenario)?;
    let homes = (0..scenario.agents)
        .map(|index| {
            let home = cli.homes.join(agent_name(index));
            if home.is_dir() {
                Ok(home)
            } else {
                anyhow::bail!("{} is not an agent home directory", home.display())
            }
        })
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
            env: AgentEnv { name, home },
            workdir,
            edits: plan.agent(usize::try_from(slot)?).to_vec(),
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
    writer.finish(stopped_by)?;
    clones
        .close()
        .context("removing the run's temporary directory")?;
    Ok(stopped_by)
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
}
