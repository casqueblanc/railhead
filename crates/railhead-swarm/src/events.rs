//! The event stream: one JSON object per line on stdout, each stamped with the wall clock, the
//! time since the run started and `"simulated": true`. The last line is the summary.
//!
//! Events carry only what the driver composed or checked: agent names it chose, identifiers that
//! passed the protocol's identifier rules, commit ids, paths from the plan and error codes. Task
//! text and backend messages are untrusted and never written.
//!
//! The agent wire shows an agent its own claim and inbox, not the train, so batches and parked
//! pairs are not events here. "Landed" needs positive evidence: the agent read its claim as
//! `merged`. A ready claim that leaves the agent's status without that evidence may have merged or
//! expired, and today's agent wire does not say which, so it is "unverified" until
//! casqueblanc/railhead#237 adds the closed reason: never a landing, and not a failure. "Auto-merged"
//! needs Git's evidence: two edits of the same path landed, each written on a base that lacked the
//! other's line, and main read back afterwards holds both.

use std::io::{self, Write};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::mpsc;

use crate::plan::EditClass;

/// Most events queued for the writer before an agent waits for it.
pub const EVENT_QUEUE: usize = 1024;

/// What the summary is.
pub const SUMMARY_LABEL: &str = "measured on a simulated run";

/// What a task delivers: the scaffold or a planned edit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub enum TaskClass {
    /// The shared files the two shared edit classes rewrite.
    Scaffold,
    /// [`EditClass::Disjoint`].
    Disjoint,
    /// [`EditClass::SameFileHunks`].
    SameFileHunks,
    /// [`EditClass::Overlapping`].
    Overlapping,
    /// A ready claim an earlier run pinned, for which no progress record names the planned task.
    Adopted,
}

impl From<EditClass> for TaskClass {
    fn from(class: EditClass) -> Self {
        match class {
            EditClass::Disjoint => Self::Disjoint,
            EditClass::SameFileHunks => Self::SameFileHunks,
            EditClass::Overlapping => Self::Overlapping,
        }
    }
}

/// Where an agent is in its loop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub enum AgentState {
    /// Asking for work with `rh work`.
    Claiming,
    /// Writing and committing the edit.
    Editing,
    /// Pushing to the claim's fork.
    Pushing,
    /// Pinning the commit with `rh ready`.
    Readying,
    /// Waiting for the train.
    Waiting,
    /// Redoing the edit on the new main.
    Redoing,
    /// Every planned task landed or closed unverified.
    Done,
    /// The agent gave up; a `failed` or `stalled` event says why.
    Stopped,
}

/// The step that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub enum Step {
    /// Checking the agent's identity before the run.
    Preflight,
    /// `rh work`.
    Claim,
    /// Writing and committing.
    Edit,
    /// `git push`.
    Push,
    /// `rh ready`.
    Ready,
    /// `rh status` while waiting.
    Status,
    /// `rh sync` or `rh ack`.
    Inbox,
    /// Fetching main for a redo.
    Redo,
    /// Reading main back after a landing.
    Verify,
    /// Saving the agent's progress record.
    Progress,
}

/// One event.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Event {
    /// The run began.
    RunStarted {
        /// The plan's seed.
        seed: u64,
        /// How many agents run.
        agents: u32,
        /// Tasks per agent.
        rounds: u32,
        /// The repository.
        repository: String,
    },
    /// An agent moved to another step.
    AgentState {
        /// The agent.
        agent: String,
        /// Its new state.
        state: AgentState,
    },
    /// `rh work` returned a claim.
    Claimed {
        /// The agent.
        agent: String,
        /// The claim.
        claim_id: String,
        /// The issue it works on.
        issue_id: String,
        /// Its ownership generation.
        generation: u64,
        /// Whether the agent already held it.
        resumed: bool,
    },
    /// A commit reached the claim's fork.
    Pushed {
        /// The agent.
        agent: String,
        /// The claim.
        claim_id: String,
        /// The pushed commit.
        commit: String,
        /// What it delivers.
        class: TaskClass,
        /// The path it changes; the scaffold names the shared file.
        path: String,
    },
    /// `rh ready` pinned a commit.
    Ready {
        /// The agent.
        agent: String,
        /// The claim.
        claim_id: String,
        /// The pinned commit.
        commit: String,
    },
    /// `rh work` returned a claim an earlier run had already pinned; the agent waits for its
    /// outcome before planning new edits.
    Adopted {
        /// The agent.
        agent: String,
        /// The claim.
        claim_id: String,
        /// The planned round it carries, from the agent's progress record, or `None` when no
        /// record names it.
        round: Option<u32>,
    },
    /// A pinned commit landed: the agent read its claim as `merged`.
    Landed {
        /// The agent.
        agent: String,
        /// The claim.
        claim_id: String,
        /// What it delivered.
        class: TaskClass,
        /// From the last `rh ready` to the poll that saw it land; `None` for an adopted claim,
        /// whose `rh ready` this run did not see.
        ready_to_landed_ms: Option<u64>,
    },
    /// A pinned claim left the agent's status without a closed reason, so whether it merged or
    /// expired is unknown. Not a landing, and not a failure.
    Unverified {
        /// The agent.
        agent: String,
        /// The claim.
        claim_id: String,
        /// What it delivers.
        class: TaskClass,
        /// The issue that adds the closed reason to the agent wire.
        #[cfg_attr(test, serde(deserialize_with = "known"))]
        needs: &'static str,
    },
    /// Two claims changed the same path from bases that lacked each other's edit, and main holds
    /// both: Git merged them.
    ConflictAutoMerged {
        /// The path.
        path: String,
        /// The claim recorded as landed first, then the other.
        claims: [String; 2],
    },
    /// The backend routed a conflict to the agent.
    ConflictRouted {
        /// The agent.
        agent: String,
        /// Its claim.
        claim_id: String,
        /// The claim it overlaps.
        other_claim_id: String,
        /// The path both changed.
        path: String,
        /// The inbox item.
        item: u64,
    },
    /// The agent redoes its edit on the new main.
    Redo {
        /// The agent.
        agent: String,
        /// The claim.
        claim_id: String,
        /// The generation it redoes under.
        generation: u64,
    },
    /// The agent acknowledged an inbox item.
    Acknowledged {
        /// The agent.
        agent: String,
        /// The item.
        item: u64,
    },
    /// A ready claim did not land within the land timeout; the agent stops.
    Stalled {
        /// The agent.
        agent: String,
        /// The claim.
        claim_id: String,
        /// How long it waited.
        waited_ms: u64,
    },
    /// A step failed for good.
    Failed {
        /// The agent.
        agent: String,
        /// The step.
        step: Step,
        /// The error code `rh` reported, or the driver's own.
        code: String,
    },
    /// The last line: totals for the run.
    Summary(Summary),
}

/// Why the run ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    /// Every agent finished or stopped.
    Completed,
    /// The run timeout passed.
    TimedOut,
    /// Ctrl-C.
    Interrupted,
}

/// Ready→landed latency over the run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub struct Latency {
    /// How many landings were measured.
    pub samples: usize,
    /// The median, nearest rank, or `None` with no samples.
    pub p50_ms: Option<u64>,
    /// The 95th percentile, nearest rank, or `None` with no samples.
    pub p95_ms: Option<u64>,
}

/// The run's totals.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(serde::Deserialize))]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    /// Always [`SUMMARY_LABEL`].
    #[cfg_attr(test, serde(deserialize_with = "known"))]
    pub label: &'static str,
    /// Why the run ended.
    pub stopped_by: StopReason,
    /// How long it ran.
    pub duration_ms: u64,
    /// Commits pushed.
    pub pushes: u64,
    /// Commits pinned.
    pub readies: u64,
    /// Commits landed.
    pub landings: u64,
    /// Pinned claims that closed without a closed reason, which may have landed or expired; see
    /// [`Event::Unverified`].
    pub unverified: u64,
    /// Same-path pairs Git merged.
    pub auto_merged_overlaps: u64,
    /// Conflicts the backend routed to an agent.
    pub routed_conflicts: u64,
    /// Edits redone.
    pub redos: u64,
    /// Ready claims that never landed.
    pub stalls: u64,
    /// Steps that failed for good.
    pub failures: u64,
    /// Agents that finished every planned task, landed or unverified.
    pub agents_done: u64,
    /// Ready→landed latency.
    pub ready_to_landed: Latency,
}

impl Summary {
    /// Whether the run did all it was asked: it completed, all `agents` finished every planned
    /// task, and nothing failed or stalled. An unverified task is not a failure: the agent wire
    /// cannot tell it apart from a landing yet.
    #[must_use]
    pub fn succeeded(&self, agents: u32) -> bool {
        self.stopped_by == StopReason::Completed
            && self.agents_done == u64::from(agents)
            && self.failures == 0
            && self.stalls == 0
    }
}

/// One of the fixed strings the stream carries, read back from a recorded run.
#[cfg(test)]
fn known<'de, D: serde::Deserializer<'de>>(from: D) -> Result<&'static str, D::Error> {
    use serde::Deserialize as _;
    let text = String::deserialize(from)?;
    [SUMMARY_LABEL, crate::agent::UNVERIFIED_NEEDS]
        .into_iter()
        .find(|known| *known == text)
        .ok_or_else(|| serde::de::Error::custom("not a string the stream carries"))
}

/// The `p`th percentile of sorted `samples` by nearest rank.
fn percentile(sorted: &[u64], p: usize) -> Option<u64> {
    let rank = p.saturating_mul(sorted.len()).div_ceil(100).max(1);
    sorted.get(rank - 1).copied()
}

/// Counts events as they are written. The fields are the [`Summary`] totals of the same name.
#[derive(Debug, Default)]
pub struct Tally {
    /// Commits pushed.
    pub pushes: u64,
    /// Commits pinned.
    pub readies: u64,
    /// Commits landed.
    pub landings: u64,
    /// Pinned claims that closed without a closed reason.
    pub unverified: u64,
    /// Same-path pairs Git merged.
    pub auto_merged: u64,
    /// Conflicts the backend routed to an agent.
    pub routed: u64,
    /// Edits redone.
    pub redos: u64,
    /// Ready claims that never landed.
    pub stalls: u64,
    /// Steps that failed for good.
    pub failures: u64,
    /// Agents that finished every planned task.
    pub agents_done: u64,
    latencies: Vec<u64>,
}

impl Tally {
    /// Counts `event` into the totals.
    pub fn count(&mut self, event: &Event) {
        let counter = match event {
            Event::Pushed { .. } => &mut self.pushes,
            Event::Ready { .. } => &mut self.readies,
            Event::Landed {
                ready_to_landed_ms, ..
            } => {
                self.latencies.extend(*ready_to_landed_ms);
                &mut self.landings
            }
            Event::Unverified { .. } => &mut self.unverified,
            Event::ConflictAutoMerged { .. } => &mut self.auto_merged,
            Event::ConflictRouted { .. } => &mut self.routed,
            Event::Redo { .. } => &mut self.redos,
            Event::Stalled { .. } => &mut self.stalls,
            Event::Failed { .. } => &mut self.failures,
            Event::AgentState {
                state: AgentState::Done,
                ..
            } => &mut self.agents_done,
            Event::RunStarted { .. }
            | Event::AgentState { .. }
            | Event::Claimed { .. }
            | Event::Adopted { .. }
            | Event::Acknowledged { .. }
            | Event::Summary(_) => return,
        };
        *counter = counter.saturating_add(1);
    }

    /// Ready→landed latency over the landings counted so far.
    #[must_use]
    pub fn latency(&self) -> Latency {
        let mut sorted = self.latencies.clone();
        sorted.sort_unstable();
        Latency {
            samples: sorted.len(),
            p50_ms: percentile(&sorted, 50),
            p95_ms: percentile(&sorted, 95),
        }
    }

    /// The summary of what was counted.
    #[must_use]
    pub fn summary(&self, stopped_by: StopReason, duration: Duration) -> Summary {
        Summary {
            label: SUMMARY_LABEL,
            stopped_by,
            duration_ms: millis(duration),
            pushes: self.pushes,
            readies: self.readies,
            landings: self.landings,
            unverified: self.unverified,
            auto_merged_overlaps: self.auto_merged,
            routed_conflicts: self.routed,
            redos: self.redos,
            stalls: self.stalls,
            failures: self.failures,
            agents_done: self.agents_done,
            ready_to_landed: self.latency(),
        }
    }
}

/// A duration in whole milliseconds, saturating.
#[must_use]
pub fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// One line of the stream.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Line<'a> {
    ts: u64,
    elapsed_ms: u64,
    simulated: bool,
    #[serde(flatten)]
    event: &'a Event,
}

/// Writes events as JSON lines and counts them.
pub struct Writer<W: Write> {
    out: W,
    started: Instant,
    tally: Tally,
}

impl<W: Write> Writer<W> {
    /// A writer for a run that started at `started`.
    pub fn new(out: W, started: Instant) -> Self {
        Self {
            out,
            started,
            tally: Tally::default(),
        }
    }

    /// Writes one event and flushes it, so a reader sees it at once.
    ///
    /// # Errors
    ///
    /// When writing fails.
    pub fn write(&mut self, event: &Event) -> io::Result<()> {
        self.tally.count(event);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, millis);
        let line = Line {
            ts,
            elapsed_ms: millis(self.started.elapsed()),
            simulated: true,
            event,
        };
        serde_json::to_writer(&mut self.out, &line)?;
        self.out.write_all(b"\n")?;
        self.out.flush()
    }

    /// Writes the summary as the last line.
    ///
    /// # Errors
    ///
    /// When writing fails.
    pub fn finish(mut self, stopped_by: StopReason) -> io::Result<Summary> {
        let tally = std::mem::take(&mut self.tally);
        let summary = tally.summary(stopped_by, self.started.elapsed());
        self.write(&Event::Summary(summary.clone()))?;
        Ok(summary)
    }
}

/// The agents' side of the stream.
#[derive(Debug, Clone)]
pub struct Emitter(mpsc::Sender<Event>);

impl Emitter {
    /// An emitter and the receiver the writer drains.
    #[must_use]
    pub fn channel() -> (Self, mpsc::Receiver<Event>) {
        let (tx, rx) = mpsc::channel(EVENT_QUEUE);
        (Self(tx), rx)
    }

    /// Queues an event, waiting while the queue is full.
    pub async fn emit(&self, event: Event) {
        // The writer stops only when stdout fails, and it returns that error to the run; there is
        // nowhere else to report an event that cannot be written.
        let _ = self.0.send(event).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn landed(ms: Option<u64>) -> Event {
        Event::Landed {
            agent: "swarm-00".to_owned(),
            claim_id: "clm_abcdef".to_owned(),
            class: TaskClass::Disjoint,
            ready_to_landed_ms: ms,
        }
    }

    fn state(state: AgentState) -> Event {
        Event::AgentState {
            agent: "swarm-00".to_owned(),
            state,
        }
    }

    #[test]
    fn percentiles_use_the_nearest_rank() {
        let samples: Vec<u64> = (1..=20).collect();
        assert_eq!(percentile(&samples, 50), Some(10));
        assert_eq!(percentile(&samples, 95), Some(19));
        assert_eq!(percentile(&[7], 50), Some(7));
        assert_eq!(percentile(&[7], 95), Some(7));
        assert_eq!(percentile(&[], 50), None);
    }

    #[test]
    fn every_line_is_stamped_and_marked_simulated() -> anyhow::Result<()> {
        let mut out = Vec::new();
        let mut writer = Writer::new(&mut out, Instant::now());
        writer.write(&Event::AgentState {
            agent: "swarm-00".to_owned(),
            state: AgentState::Claiming,
        })?;
        writer.write(&landed(Some(40)))?;
        writer.write(&landed(Some(10)))?;
        let summary = writer.finish(StopReason::Completed)?;
        assert_eq!(summary.landings, 2);
        assert_eq!(
            summary.ready_to_landed,
            Latency {
                samples: 2,
                p50_ms: Some(10),
                p95_ms: Some(40)
            }
        );
        let lines: Vec<serde_json::Value> = std::str::from_utf8(&out)?
            .lines()
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()?;
        assert_eq!(lines.len(), 4);
        for line in &lines {
            assert_eq!(line["simulated"], true);
            assert!(line["ts"].as_u64().is_some_and(|ts| ts > 0));
            assert!(line["elapsedMs"].is_u64());
        }
        let at = |line: usize, pointer: &str| {
            lines
                .get(line)
                .and_then(|line| line.pointer(pointer))
                .cloned()
        };
        assert_eq!(at(0, "/type"), Some("agentState".into()));
        assert_eq!(at(0, "/state"), Some("claiming".into()));
        assert_eq!(at(1, "/readyToLandedMs"), Some(40.into()));
        assert_eq!(at(3, "/type"), Some("summary".into()));
        assert_eq!(at(3, "/label"), Some(SUMMARY_LABEL.into()));
        assert_eq!(at(3, "/stoppedBy"), Some("completed".into()));
        assert_eq!(at(3, "/readyToLanded/p95Ms"), Some(40.into()));
        Ok(())
    }

    #[test]
    fn an_empty_run_has_no_latency() {
        let summary = Tally::default().summary(StopReason::Interrupted, Duration::from_millis(5));
        assert_eq!(summary.landings, 0);
        assert_eq!(summary.duration_ms, 5);
        assert_eq!(
            summary.ready_to_landed,
            Latency {
                samples: 0,
                p50_ms: None,
                p95_ms: None
            }
        );
    }

    struct Closed;

    impl Write for Closed {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::ErrorKind::BrokenPipe.into())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_closed_stdout_is_an_error() {
        let mut writer = Writer::new(Closed, Instant::now());
        assert!(writer.write(&landed(Some(1))).is_err());
    }

    #[test]
    fn an_adopted_landing_counts_without_a_latency_sample() {
        let mut tally = Tally::default();
        tally.count(&landed(None));
        tally.count(&landed(Some(30)));
        let summary = tally.summary(StopReason::Completed, Duration::ZERO);
        assert_eq!(summary.landings, 2);
        assert_eq!(summary.ready_to_landed.samples, 1);
        assert_eq!(summary.ready_to_landed.p50_ms, Some(30));
    }

    #[test]
    fn a_run_succeeds_only_when_every_agent_is_done_and_nothing_failed() {
        let summary_of = |events: &[Event], stopped_by| {
            let mut tally = Tally::default();
            for event in events {
                tally.count(event);
            }
            tally.summary(stopped_by, Duration::ZERO)
        };
        let done = [state(AgentState::Done), state(AgentState::Done)];
        assert!(summary_of(&done, StopReason::Completed).succeeded(2));
        // One agent short: it stopped, or never reported.
        assert!(!summary_of(&done, StopReason::Completed).succeeded(3));
        let stopped = [state(AgentState::Done), state(AgentState::Stopped)];
        assert!(!summary_of(&stopped, StopReason::Completed).succeeded(2));
        let stalled = [
            state(AgentState::Done),
            Event::Stalled {
                agent: "swarm-00".to_owned(),
                claim_id: "clm_abcdef".to_owned(),
                waited_ms: 1,
            },
        ];
        assert!(!summary_of(&stalled, StopReason::Completed).succeeded(1));
        assert!(!summary_of(&done, StopReason::TimedOut).succeeded(2));
        // Unverified tasks alone do not fail a run, and are counted apart from landings.
        let unverified = Event::Unverified {
            agent: "swarm-00".to_owned(),
            claim_id: "clm_abcdef".to_owned(),
            class: TaskClass::Disjoint,
            needs: "casqueblanc/railhead#237",
        };
        let summary = summary_of(
            &[unverified, state(AgentState::Done)],
            StopReason::Completed,
        );
        assert!(summary.succeeded(1));
        assert_eq!((summary.unverified, summary.landings), (1, 0));
        assert!(!summary_of(&done, StopReason::Interrupted).succeeded(2));
    }
}
