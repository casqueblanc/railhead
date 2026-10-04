//! What the terminal view shows, folded from the event stream, and what its keys do.
//!
//! The view keeps a bounded window of the run: the latest event of each agent and its
//! [`RECENT_EVENTS`] most recent ones, the [`KEPT`] most recent conflicts and landings, and the
//! pushes and landings of the last minute for the rates. Totals come from the same [`Tally`] the
//! summary line is counted with.

use std::collections::VecDeque;
use std::time::Duration;

use crate::events::{AgentState, Event, Step as FailedStep, StopReason, Tally, TaskClass};

/// Recent events kept per agent for its detail view.
pub const RECENT_EVENTS: usize = 32;

/// Conflicts and landings kept for their panels.
pub const KEPT: usize = 64;

/// The window the live rates are measured over.
const RATE_WINDOW: Duration = Duration::from_secs(60);

/// The shortest window a rate is measured over, so the first seconds do not extrapolate a few
/// events into a large rate.
const MIN_RATE_WINDOW: Duration = Duration::from_secs(10);

/// Most pushes or landings kept for one rate window, so a burst cannot grow it without bound.
const MAX_RATE_SAMPLES: usize = 4096;

/// Where an agent's current task stands, as its lane shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// No event yet.
    Idle,
    /// `rh work`.
    Claim,
    /// Writing and committing.
    Edit,
    /// `git push`.
    Push,
    /// `rh ready`.
    Ready,
    /// Pinned, waiting for the train.
    Train,
    /// The last task landed.
    Landed,
    /// The last task closed without evidence of a landing.
    Unverified,
    /// Redoing the edit on the new main.
    Redo,
    /// Every planned task finished.
    Done,
    /// The agent gave up.
    Stopped,
}

impl Stage {
    /// The label a lane shows.
    #[must_use]
    pub const fn label(self) -> &'static str {
        match self {
            Self::Idle => "-",
            Self::Claim => "claim",
            Self::Edit => "edit",
            Self::Push => "push",
            Self::Ready => "ready",
            Self::Train => "in train",
            Self::Landed => "landed",
            Self::Unverified => "unverified",
            Self::Redo => "redo",
            Self::Done => "done",
            Self::Stopped => "stopped",
        }
    }

    const fn of(state: AgentState) -> Self {
        match state {
            AgentState::Claiming => Self::Claim,
            AgentState::Editing => Self::Edit,
            AgentState::Pushing => Self::Push,
            AgentState::Readying => Self::Ready,
            AgentState::Waiting => Self::Train,
            AgentState::Redoing => Self::Redo,
            AgentState::Done => Self::Done,
            AgentState::Stopped => Self::Stopped,
        }
    }
}

/// One event, as a line of text, at its time since the run started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// When it arrived.
    pub at: Duration,
    /// What it says.
    pub text: String,
}

/// A ready claim waiting for the train.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pin {
    /// The claim.
    pub claim_id: String,
    /// When it was pinned, or adopted from an earlier run.
    pub since: Duration,
}

/// One agent's row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lane {
    /// The agent.
    pub name: String,
    /// Where its task stands.
    pub stage: Stage,
    /// Its claim's ownership generation.
    pub generation: Option<u64>,
    /// Its claim.
    pub claim_id: Option<String>,
    /// Its pin while the train holds it.
    pub pin: Option<Pin>,
    /// Its tasks that landed.
    pub landings: u64,
    /// Its most recent events, oldest first.
    pub recent: VecDeque<Entry>,
}

impl Lane {
    fn new(name: String) -> Self {
        Self {
            name,
            stage: Stage::Idle,
            generation: None,
            claim_id: None,
            pin: None,
            landings: 0,
            recent: VecDeque::with_capacity(RECENT_EVENTS),
        }
    }

    /// Its latest event.
    #[must_use]
    pub fn last(&self) -> Option<&Entry> {
        self.recent.back()
    }
}

/// What became of a conflict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Overlap {
    /// Git merged two edits of the same path, made on bases that lacked each other.
    AutoMerged {
        /// The claim that landed first, then the other.
        claims: [String; 2],
    },
    /// The backend routed a true conflict to an agent.
    Routed {
        /// The agent.
        agent: String,
        /// Its claim.
        claim_id: String,
        /// The claim it overlaps.
        other_claim_id: String,
        /// Whether the agent has started to redo its edit.
        redone: bool,
    },
}

/// One conflict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Conflict {
    /// When it was seen.
    pub at: Duration,
    /// The path both changed.
    pub path: String,
    /// What became of it.
    pub overlap: Overlap,
}

/// One landing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Landing {
    /// When it was seen.
    pub at: Duration,
    /// The agent.
    pub agent: String,
    /// The claim.
    pub claim_id: String,
    /// What it delivered.
    pub class: TaskClass,
    /// From `rh ready` to the landing, when this run saw the `rh ready`.
    pub ready_to_landed_ms: Option<u64>,
}

/// The run's parameters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunInfo {
    /// The plan's seed.
    pub seed: u64,
    /// How many agents run.
    pub agents: u32,
    /// Tasks per agent.
    pub rounds: u32,
    /// The repository.
    pub repository: String,
}

/// Where the run is, as the operator drives it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Agents are working.
    Running,
    /// No agent claims new work.
    Paused,
    /// The operator asked the run to stop; it is stopping its agents.
    Stopping,
    /// The run ended.
    Ended(StopReason),
}

/// What a key asks of the run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// Nothing outside the view.
    None,
    /// Hold new work back, or let it go on.
    Pause(bool),
    /// Stop the run.
    Stop,
    /// Close the view: the run has ended.
    Exit,
}

/// A key the view handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Key {
    /// `q`, or Ctrl-C.
    Quit,
    /// `p`.
    Pause,
    /// `↑`.
    Up,
    /// `↓`.
    Down,
    /// `enter`.
    Enter,
    /// `esc`.
    Escape,
}

/// The view's state.
#[derive(Debug)]
pub struct View {
    /// The run's parameters, once it started.
    pub run: Option<RunInfo>,
    /// Totals.
    pub tally: Tally,
    /// One per agent, by name.
    pub lanes: Vec<Lane>,
    /// The latest conflicts, oldest first.
    pub conflicts: VecDeque<Conflict>,
    /// The latest landings, oldest first.
    pub landed: VecDeque<Landing>,
    /// Where the run is.
    pub phase: Phase,
    /// The selected lane.
    pub selected: usize,
    /// Whether the selected agent's recent events are shown.
    pub detail: bool,
    /// The time of the latest event or tick.
    pub now: Duration,
    pushes: VecDeque<Duration>,
    landings: VecDeque<Duration>,
}

impl Default for View {
    fn default() -> Self {
        Self::new()
    }
}

/// A rate per minute, in tenths, of `count` events over the time since the run started, at most
/// [`RATE_WINDOW`] and at least [`MIN_RATE_WINDOW`].
fn per_minute_tenths(count: usize, elapsed: Duration) -> u64 {
    let window = elapsed.clamp(MIN_RATE_WINDOW, RATE_WINDOW);
    let window_ms = u64::try_from(window.as_millis()).unwrap_or(u64::MAX);
    u64::try_from(count)
        .unwrap_or(u64::MAX)
        .saturating_mul(600_000)
        / window_ms
}

/// Drops samples older than the rate window before `now`.
fn prune(samples: &mut VecDeque<Duration>, now: Duration) {
    let start = now.saturating_sub(RATE_WINDOW);
    while samples.front().is_some_and(|at| *at < start) {
        samples.pop_front();
    }
}

fn record(samples: &mut VecDeque<Duration>, at: Duration) {
    if samples.len() == MAX_RATE_SAMPLES {
        samples.pop_front();
    }
    samples.push_back(at);
    prune(samples, at);
}

fn keep<T>(queue: &mut VecDeque<T>, item: T) {
    if queue.len() == KEPT {
        queue.pop_front();
    }
    queue.push_back(item);
}

/// `text` with every control character replaced, so nothing an event carries can drive the
/// terminal.
#[must_use]
pub fn printable(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { '\u{fffd}' } else { c })
        .collect()
}

/// The first 7 characters of a commit id.
fn short(commit: &str) -> &str {
    commit.get(..7).unwrap_or(commit)
}

/// A duration in milliseconds as seconds with one decimal.
#[must_use]
pub fn seconds(ms: u64) -> String {
    format!("{}.{}s", ms / 1000, ms % 1000 / 100)
}

/// The short name of a task class.
#[must_use]
pub const fn class_label(class: TaskClass) -> &'static str {
    match class {
        TaskClass::Scaffold => "scaffold",
        TaskClass::Disjoint => "disjoint",
        TaskClass::SameFileHunks => "hunks",
        TaskClass::Overlapping => "overlap",
        TaskClass::Adopted => "adopted",
    }
}

const fn step_label(step: FailedStep) -> &'static str {
    match step {
        FailedStep::Preflight => "preflight",
        FailedStep::Claim => "claim",
        FailedStep::Edit => "edit",
        FailedStep::Push => "push",
        FailedStep::Ready => "ready",
        FailedStep::Status => "status",
        FailedStep::Inbox => "inbox",
        FailedStep::Redo => "redo",
        FailedStep::Verify => "verify",
        FailedStep::Progress => "progress",
    }
}

/// The agent an event is about, and how its lane describes it; `None` for run-wide events and
/// state changes, which the lane's stage shows.
fn describe(event: &Event) -> Option<(&str, String)> {
    let (agent, text) = match event {
        Event::Claimed {
            agent,
            claim_id,
            generation,
            resumed,
            ..
        } => {
            let resumed = if *resumed { ", resumed" } else { "" };
            (
                agent,
                format!("claimed {claim_id} gen {generation}{resumed}"),
            )
        }
        Event::Pushed {
            agent,
            commit,
            class,
            path,
            ..
        } => (
            agent,
            format!("pushed {} {} {path}", short(commit), class_label(*class)),
        ),
        Event::Ready { agent, commit, .. } => (agent, format!("ready {}", short(commit))),
        Event::Adopted {
            agent, claim_id, ..
        } => (agent, format!("adopted {claim_id}")),
        Event::Landed {
            agent,
            claim_id,
            ready_to_landed_ms,
            ..
        } => (
            agent,
            match ready_to_landed_ms {
                Some(ms) => format!("landed {claim_id} in {}", seconds(*ms)),
                None => format!("landed {claim_id}"),
            },
        ),
        Event::Unverified {
            agent, claim_id, ..
        } => (agent, format!("closed {claim_id}, outcome unknown")),
        Event::ConflictRouted {
            agent,
            other_claim_id,
            path,
            item,
            ..
        } => (
            agent,
            format!("conflict on {path} with {other_claim_id}, item {item}"),
        ),
        Event::Redo {
            agent, generation, ..
        } => (agent, format!("redo at gen {generation}")),
        Event::Acknowledged { agent, item } => (agent, format!("acknowledged item {item}")),
        Event::Stalled {
            agent, waited_ms, ..
        } => (agent, format!("stalled after {}", seconds(*waited_ms))),
        Event::Failed { agent, step, code } => {
            (agent, format!("failed at {}: {code}", step_label(*step)))
        }
        Event::RunStarted { .. }
        | Event::AgentState { .. }
        | Event::ConflictAutoMerged { .. }
        | Event::Summary(_) => return None,
    };
    Some((agent, printable(&text)))
}

impl View {
    /// A view of a run that has not started.
    #[must_use]
    pub fn new() -> Self {
        Self {
            run: None,
            tally: Tally::default(),
            lanes: Vec::new(),
            conflicts: VecDeque::with_capacity(KEPT),
            landed: VecDeque::with_capacity(KEPT),
            phase: Phase::Running,
            selected: 0,
            detail: false,
            now: Duration::ZERO,
            pushes: VecDeque::new(),
            landings: VecDeque::new(),
        }
    }

    /// Moves the clock to `now`, so the rates and waits age without events.
    pub fn tick(&mut self, now: Duration) {
        self.now = self.now.max(now);
        prune(&mut self.pushes, self.now);
        prune(&mut self.landings, self.now);
    }

    /// Pushes per minute, in tenths, over the last minute.
    #[must_use]
    pub fn pushes_per_minute(&self) -> u64 {
        per_minute_tenths(self.pushes.len(), self.now)
    }

    /// Landings per minute, in tenths, over the last minute.
    #[must_use]
    pub fn landings_per_minute(&self) -> u64 {
        per_minute_tenths(self.landings.len(), self.now)
    }

    fn lane(&mut self, agent: &str) -> Option<&mut Lane> {
        let name = printable(agent);
        let index = match self.lanes.binary_search_by(|lane| lane.name.cmp(&name)) {
            Ok(index) => index,
            Err(index) => {
                self.lanes.insert(index, Lane::new(name));
                if index <= self.selected && self.lanes.len() > 1 {
                    self.selected = self.selected.saturating_add(1);
                }
                index
            }
        };
        self.lanes.get_mut(index)
    }

    /// Folds one event, which arrived at `at`, into the view.
    pub fn apply(&mut self, event: &Event, at: Duration) {
        self.tick(at);
        self.tally.count(event);
        let now = self.now;
        if let Some((agent, text)) = describe(event)
            && let Some(lane) = self.lane(agent)
        {
            if lane.recent.len() == RECENT_EVENTS {
                lane.recent.pop_front();
            }
            lane.recent.push_back(Entry { at: now, text });
        }
        match event {
            Event::RunStarted {
                seed,
                agents,
                rounds,
                repository,
            } => {
                self.run = Some(RunInfo {
                    seed: *seed,
                    agents: *agents,
                    rounds: *rounds,
                    repository: printable(repository),
                });
                // Every lane from the start, so the selection does not move as agents report.
                for index in 0..*agents {
                    self.lane(&crate::agent_name(index));
                }
            }
            Event::AgentState { agent, state } => {
                if let Some(lane) = self.lane(agent) {
                    lane.stage = Stage::of(*state);
                    if matches!(state, AgentState::Done | AgentState::Stopped) {
                        lane.pin = None;
                    }
                }
            }
            Event::Claimed {
                agent,
                claim_id,
                generation,
                ..
            } => self.claimed(agent, claim_id, *generation),
            Event::Pushed { .. } => record(&mut self.pushes, now),
            Event::Ready {
                agent, claim_id, ..
            }
            | Event::Adopted {
                agent, claim_id, ..
            } => self.pinned(agent, claim_id),
            Event::Landed {
                agent,
                claim_id,
                class,
                ready_to_landed_ms,
            } => self.landed(agent, claim_id, *class, *ready_to_landed_ms),
            Event::Unverified { agent, .. } => {
                if let Some(lane) = self.lane(agent) {
                    lane.stage = Stage::Unverified;
                    lane.pin = None;
                }
            }
            Event::ConflictAutoMerged { path, claims } => {
                let claims = claims.clone().map(|claim| printable(&claim));
                self.conflict(path, Overlap::AutoMerged { claims });
            }
            Event::ConflictRouted {
                agent,
                claim_id,
                other_claim_id,
                path,
                ..
            } => {
                if let Some(lane) = self.lane(agent) {
                    lane.pin = None;
                }
                let overlap = Overlap::Routed {
                    agent: printable(agent),
                    claim_id: printable(claim_id),
                    other_claim_id: printable(other_claim_id),
                    redone: false,
                };
                self.conflict(path, overlap);
            }
            Event::Redo {
                agent,
                claim_id,
                generation,
            } => self.redo(agent, claim_id, *generation),
            Event::Stalled { agent, .. } | Event::Failed { agent, .. } => {
                if let Some(lane) = self.lane(agent) {
                    lane.pin = None;
                }
            }
            Event::Summary(summary) => self.phase = Phase::Ended(summary.stopped_by),
            Event::Acknowledged { .. } => {}
        }
    }

    fn conflict(&mut self, path: &str, overlap: Overlap) {
        let conflict = Conflict {
            at: self.now,
            path: printable(path),
            overlap,
        };
        keep(&mut self.conflicts, conflict);
    }

    fn claimed(&mut self, agent: &str, claim_id: &str, generation: u64) {
        if let Some(lane) = self.lane(agent) {
            lane.claim_id = Some(printable(claim_id));
            lane.generation = Some(generation);
            lane.pin = None;
        }
    }

    fn pinned(&mut self, agent: &str, claim_id: &str) {
        let since = self.now;
        if let Some(lane) = self.lane(agent) {
            lane.claim_id = Some(printable(claim_id));
            lane.pin = Some(Pin {
                claim_id: printable(claim_id),
                since,
            });
        }
    }

    fn landed(
        &mut self,
        agent: &str,
        claim_id: &str,
        class: TaskClass,
        ready_to_landed_ms: Option<u64>,
    ) {
        record(&mut self.landings, self.now);
        if let Some(lane) = self.lane(agent) {
            lane.stage = Stage::Landed;
            lane.pin = None;
            lane.landings = lane.landings.saturating_add(1);
        }
        keep(
            &mut self.landed,
            Landing {
                at: self.now,
                agent: printable(agent),
                claim_id: printable(claim_id),
                class,
                ready_to_landed_ms,
            },
        );
    }

    /// The agent redoes its claim: the conflicts routed to that claim are marked redone.
    fn redo(&mut self, agent: &str, claim_id: &str, generation: u64) {
        if let Some(lane) = self.lane(agent) {
            lane.stage = Stage::Redo;
            lane.generation = Some(generation);
            lane.pin = None;
        }
        let (agent, claim_id) = (printable(agent), printable(claim_id));
        for conflict in &mut self.conflicts {
            if let Overlap::Routed {
                agent: routed,
                claim_id: claim,
                redone,
                ..
            } = &mut conflict.overlap
                && *routed == agent
                && *claim == claim_id
            {
                *redone = true;
            }
        }
    }

    /// The lanes whose pin the train holds, longest waiting first.
    #[must_use]
    pub fn waiting(&self) -> Vec<(&Lane, &Pin)> {
        let mut waiting: Vec<_> = self
            .lanes
            .iter()
            .filter_map(|lane| lane.pin.as_ref().map(|pin| (lane, pin)))
            .collect();
        waiting.sort_by_key(|(lane, pin)| (pin.since, lane.name.as_str()));
        waiting
    }

    /// Handles a key, and says what it asks of the run.
    pub fn key(&mut self, key: Key) -> Action {
        match key {
            Key::Quit => match self.phase {
                Phase::Running | Phase::Paused => {
                    self.phase = Phase::Stopping;
                    Action::Stop
                }
                Phase::Stopping => Action::None,
                Phase::Ended(_) => Action::Exit,
            },
            Key::Pause => match self.phase {
                Phase::Running => {
                    self.phase = Phase::Paused;
                    Action::Pause(true)
                }
                Phase::Paused => {
                    self.phase = Phase::Running;
                    Action::Pause(false)
                }
                Phase::Stopping | Phase::Ended(_) => Action::None,
            },
            Key::Up => {
                self.selected = self.selected.saturating_sub(1);
                Action::None
            }
            Key::Down => {
                if self.selected.saturating_add(1) < self.lanes.len() {
                    self.selected = self.selected.saturating_add(1);
                }
                Action::None
            }
            Key::Enter => {
                self.detail = !self.detail && !self.lanes.is_empty();
                Action::None
            }
            Key::Escape => {
                self.detail = false;
                Action::None
            }
        }
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use crate::events::{StopReason, Summary};

    /// The events of a run of 4 agents against the fake backend of `tests/swarm.rs`, recorded
    /// from its standard output, each at its `elapsedMs`.
    pub fn recorded() -> anyhow::Result<Vec<(Event, Duration)>> {
        include_str!("../../tests/fixtures/run.jsonl")
            .lines()
            .map(|line| {
                // The stamps beside the event are fields the event does not know, so it skips them.
                let stamp: serde_json::Value = serde_json::from_str(line)?;
                let elapsed = stamp
                    .get("elapsedMs")
                    .and_then(serde_json::Value::as_u64)
                    .ok_or_else(|| anyhow::anyhow!("a line without elapsedMs"))?;
                let event: Event = serde_json::from_str(line)?;
                Ok((event, Duration::from_millis(elapsed)))
            })
            .collect()
    }

    fn state(agent: &str, state: AgentState) -> Event {
        Event::AgentState {
            agent: agent.to_owned(),
            state,
        }
    }

    fn at(ms: u64) -> Duration {
        Duration::from_millis(ms)
    }

    #[test]
    fn a_recorded_run_folds_into_its_totals_lanes_and_panels() -> anyhow::Result<()> {
        let mut view = View::new();
        for (event, elapsed) in recorded()? {
            view.apply(&event, elapsed);
        }
        let summary = match view.phase {
            Phase::Ended(StopReason::Completed) => {
                view.tally.summary(StopReason::Completed, view.now)
            }
            other => anyhow::bail!("the run did not end: {other:?}"),
        };
        let run = view.run.as_ref().map(|run| run.agents);
        assert_eq!(run, Some(4));
        assert_eq!(view.lanes.len(), 4);
        assert!(view.lanes.iter().all(|lane| lane.stage == Stage::Done));
        assert_eq!(view.waiting().len(), 0);
        assert_eq!(
            u64::try_from(view.landed.len())?,
            summary.landings.min(u64::try_from(KEPT)?)
        );
        let auto = view
            .conflicts
            .iter()
            .filter(|c| matches!(c.overlap, Overlap::AutoMerged { .. }))
            .count();
        let routed = view
            .conflicts
            .iter()
            .filter(|c| matches!(c.overlap, Overlap::Routed { redone: true, .. }))
            .count();
        assert_eq!(u64::try_from(auto)?, summary.auto_merged_overlaps);
        assert_eq!(u64::try_from(routed)?, summary.routed_conflicts);
        assert!(summary.routed_conflicts > 0 && summary.auto_merged_overlaps > 0);
        Ok(())
    }

    #[test]
    fn a_lane_follows_its_agent_through_a_task() {
        let mut view = View::new();
        view.apply(&state("swarm-01", AgentState::Claiming), at(0));
        view.apply(
            &Event::Claimed {
                agent: "swarm-01".to_owned(),
                claim_id: "clm_swarm0001".to_owned(),
                issue_id: "iss_swarm0001".to_owned(),
                generation: 1,
                resumed: false,
            },
            at(10),
        );
        view.apply(
            &Event::Ready {
                agent: "swarm-01".to_owned(),
                claim_id: "clm_swarm0001".to_owned(),
                commit: "0123456789abcdef0123456789abcdef01234567".to_owned(),
            },
            at(20),
        );
        view.apply(&state("swarm-01", AgentState::Waiting), at(20));
        let waiting: Vec<_> = view
            .waiting()
            .iter()
            .map(|(lane, pin)| (lane.name.clone(), pin.since))
            .collect();
        assert_eq!(waiting, [("swarm-01".to_owned(), at(20))]);
        view.apply(
            &Event::Landed {
                agent: "swarm-01".to_owned(),
                claim_id: "clm_swarm0001".to_owned(),
                class: TaskClass::Disjoint,
                ready_to_landed_ms: Some(1234),
            },
            at(1254),
        );
        let lane = view.lanes.first();
        assert_eq!(lane.map(|lane| lane.stage), Some(Stage::Landed));
        assert_eq!(lane.and_then(|lane| lane.generation), Some(1));
        assert_eq!(
            lane.and_then(Lane::last).map(|entry| entry.text.as_str()),
            Some("landed clm_swarm0001 in 1.2s")
        );
        assert_eq!(view.waiting().len(), 0);
        // One landing in the first 10 seconds.
        assert_eq!(view.landings_per_minute(), 60);
    }

    #[test]
    fn control_characters_never_reach_the_screen() {
        let mut view = View::new();
        view.apply(
            &Event::Failed {
                agent: "swarm-00\u{1b}[2J".to_owned(),
                step: FailedStep::Push,
                code: "bad\u{1b}]0;title\u{7}".to_owned(),
            },
            at(0),
        );
        let lane = view.lanes.first();
        assert_eq!(
            lane.map(|lane| lane.name.as_str()),
            Some("swarm-00\u{fffd}[2J")
        );
        assert_eq!(
            lane.and_then(Lane::last).map(|entry| entry.text.as_str()),
            Some("failed at push: bad\u{fffd}]0;title\u{fffd}")
        );
    }

    #[test]
    fn kept_history_is_bounded() {
        let mut view = View::new();
        for n in 0..200_u64 {
            view.apply(
                &Event::Acknowledged {
                    agent: "swarm-00".to_owned(),
                    item: n,
                },
                at(n),
            );
            view.apply(
                &Event::ConflictAutoMerged {
                    path: "swarm/shared.txt".to_owned(),
                    claims: [format!("clm_a{n:05}"), format!("clm_b{n:05}")],
                },
                at(n),
            );
        }
        let recent = view.lanes.first().map(|lane| lane.recent.len());
        assert_eq!(recent, Some(RECENT_EVENTS));
        assert_eq!(view.conflicts.len(), KEPT);
        let newest = view.conflicts.back().map(|c| c.overlap.clone());
        assert_eq!(
            newest,
            Some(Overlap::AutoMerged {
                claims: ["clm_a00199".to_owned(), "clm_b00199".to_owned()]
            })
        );
        assert_eq!(view.tally.auto_merged, 200);
    }

    #[test]
    fn rates_cover_the_last_minute_only() {
        let pushed = |n: u64| Event::Pushed {
            agent: "swarm-00".to_owned(),
            claim_id: "clm_swarm0001".to_owned(),
            commit: format!("{n:040}"),
            class: TaskClass::Disjoint,
            path: "a.txt".to_owned(),
        };
        let mut view = View::new();
        assert_eq!(view.pushes_per_minute(), 0);
        // One push 1 second in counts over 10 seconds, not 1: 6 a minute, not 60.
        view.apply(&pushed(0), at(1_000));
        assert_eq!(view.pushes_per_minute(), 60);
        // 3 pushes in the first 30 seconds: 6 a minute.
        view.apply(&pushed(1), at(10_000));
        view.apply(&pushed(2), at(20_000));
        view.tick(at(30_000));
        assert_eq!(view.pushes_per_minute(), 60);
        // A minute after the last, none of them count.
        view.tick(at(81_000));
        assert_eq!(view.pushes_per_minute(), 0);
        // The clock never runs backwards.
        view.tick(at(5));
        assert_eq!(view.now, at(81_000));
    }

    #[test]
    fn a_routed_conflict_is_marked_redone_by_its_own_claim_only() {
        let mut view = View::new();
        let routed = |agent: &str, claim: &str| Event::ConflictRouted {
            agent: agent.to_owned(),
            claim_id: claim.to_owned(),
            other_claim_id: "clm_swarm0000".to_owned(),
            path: "swarm/contested.txt".to_owned(),
            item: 1,
        };
        view.apply(&routed("swarm-01", "clm_swarm0001"), at(0));
        view.apply(&routed("swarm-02", "clm_swarm0002"), at(0));
        view.apply(
            &Event::Redo {
                agent: "swarm-02".to_owned(),
                claim_id: "clm_swarm0002".to_owned(),
                generation: 2,
            },
            at(5),
        );
        let redone: Vec<bool> = view
            .conflicts
            .iter()
            .map(|c| matches!(c.overlap, Overlap::Routed { redone: true, .. }))
            .collect();
        assert_eq!(redone, [false, true]);
        let lane = view.lanes.iter().find(|lane| lane.name == "swarm-02");
        assert_eq!(
            lane.map(|l| (l.stage, l.generation)),
            Some((Stage::Redo, Some(2)))
        );
    }

    #[test]
    fn quit_stops_a_running_run_and_closes_an_ended_one() {
        let mut view = View::new();
        assert_eq!(view.key(Key::Pause), Action::Pause(true));
        assert_eq!(view.phase, Phase::Paused);
        assert_eq!(view.key(Key::Quit), Action::Stop);
        assert_eq!(view.phase, Phase::Stopping);
        // Stopping already: neither a second quit nor a pause does anything more.
        assert_eq!(view.key(Key::Quit), Action::None);
        assert_eq!(view.key(Key::Pause), Action::None);
        let summary: Summary = Tally::default().summary(StopReason::Interrupted, Duration::ZERO);
        view.apply(&Event::Summary(summary), at(1));
        assert_eq!(view.phase, Phase::Ended(StopReason::Interrupted));
        assert_eq!(view.key(Key::Pause), Action::None);
        assert_eq!(view.key(Key::Quit), Action::Exit);
    }

    #[test]
    fn pause_toggles_while_the_run_runs() {
        let mut view = View::new();
        assert_eq!(view.key(Key::Pause), Action::Pause(true));
        assert_eq!(view.key(Key::Pause), Action::Pause(false));
        assert_eq!(view.phase, Phase::Running);
    }

    #[test]
    fn selection_stays_on_a_lane_and_detail_needs_one() {
        let mut view = View::new();
        // No lanes: nothing to select or show.
        assert_eq!(view.key(Key::Down), Action::None);
        view.key(Key::Up);
        view.key(Key::Enter);
        assert_eq!((view.selected, view.detail), (0, false));
        for agent in ["swarm-01", "swarm-02"] {
            view.apply(&state(agent, AgentState::Claiming), at(0));
        }
        view.key(Key::Down);
        view.key(Key::Down);
        assert_eq!(view.selected, 1);
        // A lane that sorts before the selection keeps the same agent selected.
        view.apply(&state("swarm-00", AgentState::Claiming), at(0));
        let selected = view.lanes.get(view.selected).map(|lane| lane.name.as_str());
        assert_eq!(selected, Some("swarm-02"));
        view.key(Key::Enter);
        assert!(view.detail);
        view.key(Key::Escape);
        assert!(!view.detail);
    }
}
