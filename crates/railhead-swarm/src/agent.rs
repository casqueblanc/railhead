//! One simulated agent: `rh work` → edit → commit → push → `rh ready` → wait for the train, for
//! each planned edit.
//!
//! The agent follows what `rh` answers. A retryable refusal is repeated within the retry bound,
//! after the delay the backend asked for. A conflict routed to its claim, or the claim reopening,
//! makes it acknowledge the conflict, redo the edit on the new main and push again. An owner's
//! decision or a rework request stops it unacknowledged: its edits are scripted, so it cannot
//! follow a decision, and acknowledging one would claim it had. An `rh ready` whose answer was lost
//! may have pinned the commit, so the agent reads its claim before repeating it. A ready claim that does not land within the
//! land timeout stops the agent: it still holds the claim, so it cannot take other work. While
//! it waits, it reads its pin with `rh pin` after each poll that finds the claim still ready, and
//! reports where the train holds it whenever that changes. The pin only describes the wait: a
//! landing still needs the claim read as `merged`, and a failed `rh pin` stops nothing.
//!
//! A task lands only when the agent reads its claim as `merged`. A ready claim that leaves the
//! agent's status without that evidence may have merged or expired: today's agent wire does not say
//! which (casqueblanc/railhead#237 adds the closed reason). The agent reports such a task as
//! unverified, never as a landing, and goes on with its plan, which is what an agent whose claim
//! merged would do. A claim it reads as `expired` stops it.
//!
//! Two edits of the same path count as merged by Git only on evidence Git gives: each was
//! written on a base that lacked the other's line, and main, read back after the second landed,
//! holds both.
//!
//! A rerun picks up where a stopped run left off. The agent's progress record names the planned
//! task it was on and that task's claim. When `rh work` hands back a claim an earlier run already
//! pinned, the agent adopts it: it waits for the claim's outcome and records it before it plans
//! any new edit. A claim handed back still working may already hold the edit, pushed by a run that
//! stopped before `rh ready`; the agent keeps a disjoint file that holds exactly its planned line.
//!
//! The agent writes only inside the clone `rh work` made under its own working directory, and
//! only to a clone whose fork belongs to the scenario's repository. It never follows a symbolic
//! link the repository planted there (see [`crate::confined`]).
//!
//! While the run is paused, an agent claims no new task. A task it already holds goes on to its
//! landing, a redo included.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use railhead_protocol::{
    AgentErrorCode, ClaimState, ClaimView, IdKind, InboxDigest, InboxEntry, InboxItem, InboxResult,
    PinResult, PinView, is_commit_sha, is_id,
};
use serde::Deserialize;
use tokio::sync::watch;

use crate::confined;
use crate::events::{AgentState, Emitter, Event, Step, TaskClass, TrainState, millis};
use crate::plan::{ApplyError, Edit, scaffold};
use crate::process::{self, AgentEnv, Envelope, Runner};
use crate::progress::{Progress, ProgressFile, RunKey};
use crate::scenario::Bounds;

/// The plan an agent writes when it acknowledges a conflict, the only item it can act on.
const CONFLICT_PLAN: &str = "Simulated agent: redo the edit on the new main and push it again.";

/// Longest pause the driver chooses between two retries of one step. A longer delay the backend
/// asks for is kept.
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// What every agent shares.
#[derive(Debug)]
pub struct Shared {
    /// Starts `rh` and Git.
    pub runner: Runner,
    /// The event stream.
    pub events: Emitter,
    /// The run's bounds.
    pub bounds: Bounds,
    /// The URL prefix of every fork of the scenario's repository.
    pub fork_prefix: String,
    /// When the run times out: no retry waits past it.
    pub deadline: Instant,
    /// Landings seen so far, to find same-path pairs Git merged.
    pub landings: Mutex<Landings>,
    /// `true` while the run is paused: no agent claims a new task.
    pub paused: watch::Receiver<bool>,
}

/// Resolves once `paused` reads `false`. A pause nobody can lift any more holds for good: the run's
/// own stop ends it.
async fn unpaused(paused: &watch::Receiver<bool>) {
    let mut paused = paused.clone();
    if paused.wait_for(|paused| !paused).await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Where a ready claim's outcome is unverified: the issue that adds the closed reason to the
/// agent wire.
pub const UNVERIFIED_NEEDS: &str = "casqueblanc/railhead#237";

/// One simulated agent.
#[derive(Debug)]
pub struct Agent {
    /// Its slot in the shared file, from 0.
    pub slot: u32,
    /// Its name, home and Git author.
    pub env: AgentEnv,
    /// The directory its clones go in, inside the run's temporary directory.
    pub workdir: PathBuf,
    /// Its planned edits.
    pub edits: Vec<Edit>,
    /// The run its plan came from, which its progress records name.
    pub key: RunKey,
    /// Where its progress is kept between runs.
    pub progress: ProgressFile,
    /// The progress an earlier run of the same scenario recorded, read before any agent started.
    pub saved: Option<Progress>,
}

/// The agent stopped; an event already says why.
#[derive(Debug)]
pub struct Stopped;

type Outcome<T> = Result<T, Stopped>;

/// The `rh work` result.
#[derive(Debug, Deserialize)]
struct Claimed {
    claim: ClaimView,
    resumed: bool,
    clone: CloneInfo,
}

#[derive(Debug, Deserialize)]
struct CloneInfo {
    dir: PathBuf,
}

/// The `rh status` result.
#[derive(Debug, Deserialize)]
struct Status {
    claim: Option<ClaimView>,
}

/// A claim the agent holds, with its clone.
#[derive(Debug, Clone)]
struct Held {
    claim_id: String,
    generation: u64,
    state: ClaimState,
    dir: PathBuf,
    /// Whether `rh work` handed back a claim the agent already held.
    resumed: bool,
}

/// What waiting on a ready claim ended with.
enum Waited {
    Landed,
    /// It left the status without a closed reason; see [`UNVERIFIED_NEEDS`].
    Unverified,
    Redo,
}

/// What one `rh status` poll says about a ready claim.
#[derive(Debug, PartialEq, Eq)]
enum Polled {
    /// It merged.
    Landed,
    /// It reopened for a redo.
    Redo,
    /// It is still ready.
    Pending,
    /// It left the status, which does not say whether it merged or expired.
    Unverified,
    /// It closed without landing.
    Closed(&'static str),
}

/// Judges the held claim's state as `rh status` reported it, `None` when the status shows no
/// claim of that id.
fn judge(state: Option<ClaimState>) -> Polled {
    match state {
        Some(ClaimState::Merged) => Polled::Landed,
        Some(ClaimState::Working) => Polled::Redo,
        Some(ClaimState::Ready) => Polled::Pending,
        Some(ClaimState::Expired) => Polled::Closed("claim_expired"),
        // The status shows only an active claim, so one that left it may have merged or expired.
        // The agent wire does not yet say which (casqueblanc/railhead#237 adds the closed reason);
        // without positive evidence it is not a landing, and not a failure either.
        None => Polled::Unverified,
    }
}

/// What a waiting agent last read of its pin.
#[derive(Debug, Default)]
struct PinWatch {
    /// The state last reported, `None` before the first read.
    last: Option<TrainState>,
    /// No read before this: the backend asked for a delay.
    not_before: Option<Instant>,
    /// A refusal that repeating cannot fix ended the reads for this wait.
    stopped: bool,
}

impl PinWatch {
    /// Whether to read the pin at `now`.
    fn due(&self, now: Instant) -> bool {
        !self.stopped && self.not_before.is_none_or(|at| now >= at)
    }

    /// Takes in what one `rh pin` read at `now`, and returns the state to report when it changed.
    fn read(
        &mut self,
        result: Result<Option<&PinView>, &process::Error>,
        claim_id: &str,
        now: Instant,
    ) -> Option<TrainState> {
        let state = match result {
            Ok(pin) => {
                self.not_before = None;
                TrainState::of(pin, claim_id)
            }
            Err(error) => {
                match error.retry() {
                    Some(after) => self.not_before = now.checked_add(after),
                    None => self.stopped = true,
                }
                TrainState::Unreadable { code: error.code() }
            }
        };
        if self.last.as_ref() == Some(&state) {
            return None;
        }
        self.last = Some(state.clone());
        Some(state)
    }
}

/// Most swarm lines a landing keeps from its base. The scaffold has room for 65; a base with
/// more was changed by something other than the swarm, and its landing never pairs.
const MAX_BASE_LINES: usize = 256;

/// A landed edit of a shared path, for pairing same-path edits. It keeps hashes of the swarm
/// lines pairing compares, never the file's text, so a run's landings stay bounded whatever the
/// size of the shared file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Landing {
    /// The claim that landed it.
    claim_id: String,
    /// The path it changed.
    path: String,
    /// The hash of the line it wrote, which only this edit writes.
    line: u64,
    /// The hashes of the swarm lines the path held when the edit was written on it, sorted;
    /// `None` when it held more than [`MAX_BASE_LINES`].
    base: Option<Box<[u64]>>,
}

impl Landing {
    /// The landing of `claim_id`, which wrote `line` into `path` when it held `base`.
    fn new(claim_id: &str, path: &str, line: &str, base: &str) -> Self {
        let mut lines: Vec<u64> = swarm_lines(base).take(MAX_BASE_LINES + 1).collect();
        lines.sort_unstable();
        Self {
            claim_id: claim_id.to_owned(),
            path: path.to_owned(),
            line: line_hash(line),
            base: (lines.len() <= MAX_BASE_LINES).then(|| lines.into_boxed_slice()),
        }
    }

    /// Whether the base is known to lack `line`.
    fn lacks(&self, line: u64) -> bool {
        self.base
            .as_ref()
            .is_some_and(|base| base.binary_search(&line).is_err())
    }
}

/// Landings seen in this run.
#[derive(Debug, Default)]
pub struct Landings(Vec<Landing>);

impl Landings {
    /// Records `landing` and returns the latest recorded landing of the same path that Git merged
    /// with it: neither edit's base held the other's line, and `main`, the path's contents on main
    /// read back after both landed, holds both lines. Without that evidence it returns `None`, an
    /// edit that built on the other included.
    fn record(&mut self, landing: Landing, main: &str) -> Option<String> {
        let on_main: std::collections::HashSet<u64> = swarm_lines(main).collect();
        let merged = on_main
            .contains(&landing.line)
            .then(|| {
                self.0.iter().rev().find(|earlier| {
                    earlier.path == landing.path
                        && earlier.claim_id != landing.claim_id
                        && on_main.contains(&earlier.line)
                        && landing.lacks(earlier.line)
                        && earlier.lacks(landing.line)
                })
            })
            .flatten()
            .map(|earlier| earlier.claim_id.clone());
        self.0.push(landing);
        merged
    }

    /// How many line hashes the landings keep, to show they stay bounded.
    #[cfg(test)]
    fn retained(&self) -> usize {
        self.0
            .iter()
            .map(|landing| 1 + landing.base.as_ref().map_or(0, |base| base.len()))
            .sum()
    }
}

/// The hashes of the swarm lines `text` holds: each of its lines that is one an edit writes
/// (`<agent> round <round> <16 hex digits>`, see [`Edit::line`]), or ends with one after a
/// space, as a slot or the contested line does.
fn swarm_lines(text: &str) -> impl Iterator<Item = u64> + '_ {
    text.lines().filter_map(|existing| {
        let mut words = existing.rsplitn(5, ' ');
        let (token, round, label, agent) =
            (words.next()?, words.next()?, words.next()?, words.next()?);
        let swarm = agent.strip_prefix("swarm-").is_some_and(is_digits)
            && label == "round"
            && is_digits(round)
            && token.len() == 16
            && token.bytes().all(|byte| byte.is_ascii_hexdigit());
        // The four words, joined by the single spaces they were split on.
        let length = agent.len() + label.len() + round.len() + token.len() + 3;
        swarm
            .then(|| existing.len().checked_sub(length))
            .flatten()
            .and_then(|start| existing.get(start..))
            .map(line_hash)
    })
}

fn is_digits(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
}

/// A swarm line's hash. A collision can only make a base seem to hold a line, which counts a
/// pair as not merged.
fn line_hash(line: &str) -> u64 {
    use std::hash::{Hash as _, Hasher as _};
    let mut hasher = std::hash::DefaultHasher::new();
    line.hash(&mut hasher);
    hasher.finish()
}

impl Agent {
    /// Runs every planned edit, then reports the agent done; or stops at the first task it cannot
    /// finish.
    pub async fn run(self, shared: Arc<Shared>) {
        let run = Run {
            agent: &self,
            shared: &shared,
        };
        let state = match run.all().await {
            Ok(()) => AgentState::Done,
            Err(Stopped) => AgentState::Stopped,
        };
        run.state(state).await;
    }
}

struct Run<'a> {
    agent: &'a Agent,
    shared: &'a Shared,
}

impl Run<'_> {
    fn name(&self) -> String {
        self.agent.env.name.clone()
    }

    async fn emit(&self, event: Event) {
        self.shared.events.emit(event).await;
    }

    async fn state(&self, state: AgentState) {
        self.emit(Event::AgentState {
            agent: self.name(),
            state,
        })
        .await;
    }

    async fn fail(&self, step: Step, code: String) -> Stopped {
        self.emit(Event::Failed {
            agent: self.name(),
            step,
            code,
        })
        .await;
        Stopped
    }

    async fn all(&self) -> Outcome<()> {
        // A first `rh status` proves the identity and its session before any claim.
        let workdir = &self.agent.workdir;
        let status: Envelope<Status> = self
            .retrying(Step::Preflight, || {
                self.shared.runner.rh(&self.agent.env, workdir, &["status"])
            })
            .await?;
        let saved = self.agent.saved.clone();
        let mut next = saved.as_ref().map_or(0, |saved| saved.round);
        // The claim an earlier run left may have closed while no run watched it.
        if let Some(saved) = &saved
            && let Some(claim_id) = &saved.claim_id
        {
            let state = status
                .data
                .claim
                .filter(|claim| &claim.claim_id == claim_id)
                .map(|claim| claim.state);
            match judge(state) {
                // Still held: `rh work` hands it back.
                Polled::Pending | Polled::Redo => {}
                Polled::Landed => next = self.closed_meanwhile(saved, claim_id, true).await?,
                Polled::Unverified => next = self.closed_meanwhile(saved, claim_id, false).await?,
                Polled::Closed(code) => {
                    return Err(self.fail(Step::Claim, code.to_owned()).await);
                }
            }
        }
        let mut first = None;
        if task_index(next) < self.agent.edits.len() {
            unpaused(&self.shared.paused).await;
            let held = self.claim().await?;
            if held.state == ClaimState::Ready {
                next = self.adopt(held, saved.as_ref(), next).await?;
            } else {
                first = Some(held);
            }
        }
        for (index, edit) in self.agent.edits.iter().enumerate().skip(task_index(next)) {
            let round = u32::try_from(index).unwrap_or(u32::MAX);
            self.task(round, *edit, first.take()).await?;
        }
        if self.agent.progress.clear().is_err() {
            return Err(self.fail(Step::Progress, "progress".to_owned()).await);
        }
        Ok(())
    }

    /// Waits for the outcome of a claim an earlier run pinned, and returns the planned task to go
    /// on with; `next` when no record names the claim.
    async fn adopt(&self, held: Held, saved: Option<&Progress>, next: u32) -> Outcome<u32> {
        let saved = saved.filter(|saved| saved.claim_id.as_deref() == Some(&held.claim_id));
        self.emit(Event::Adopted {
            agent: self.name(),
            claim_id: held.claim_id.clone(),
            round: saved.map(|saved| saved.round),
        })
        .await;
        let Some(saved) = saved else {
            // No record says which planned task it carries, so it cannot be redone.
            return match self.wait(&held, None, TaskClass::Adopted).await? {
                Waited::Landed | Waited::Unverified => Ok(next),
                Waited::Redo => Err(self.fail(Step::Claim, "unmapped_claim".to_owned()).await),
            };
        };
        let Some(edit) = self.agent.edits.get(task_index(saved.round)).copied() else {
            return Err(self.fail(Step::Claim, "unmapped_claim".to_owned()).await);
        };
        if saved.scaffold {
            self.deliver(held, None, true).await?;
            return Ok(saved.round);
        }
        self.deliver(held, Some(edit), true).await?;
        let next = saved.round.saturating_add(1);
        self.save(next, false, None).await?;
        Ok(next)
    }

    /// Records the outcome of an earlier run's claim that closed while no run watched it, a landing
    /// when it was read as `merged`, and returns the planned task to go on with.
    async fn closed_meanwhile(
        &self,
        saved: &Progress,
        claim_id: &str,
        merged: bool,
    ) -> Outcome<u32> {
        let Some(edit) = self.agent.edits.get(task_index(saved.round)).copied() else {
            return Err(self.fail(Step::Claim, "unmapped_claim".to_owned()).await);
        };
        self.emit(Event::Adopted {
            agent: self.name(),
            claim_id: claim_id.to_owned(),
            round: Some(saved.round),
        })
        .await;
        let class = if saved.scaffold {
            TaskClass::Scaffold
        } else {
            TaskClass::from(edit.class)
        };
        self.emit(if merged {
            Event::Landed {
                agent: self.name(),
                claim_id: claim_id.to_owned(),
                class,
                ready_to_landed_ms: None,
            }
        } else {
            self.unverified(claim_id, class)
        })
        .await;
        if saved.scaffold {
            self.save(saved.round, false, None).await?;
            return Ok(saved.round);
        }
        let next = saved.round.saturating_add(1);
        self.save(next, false, None).await?;
        Ok(next)
    }

    /// Lands planned task `round`, landing the scaffold first when the clone lacks it. `first` is
    /// a claim `rh work` already returned for it.
    async fn task(&self, round: u32, edit: Edit, mut first: Option<Held>) -> Outcome<()> {
        // Each pass claims once; a pass that lands the scaffold goes round again, which happens
        // at most once per task.
        for _ in 0..2 {
            let held = if let Some(held) = first.take() {
                held
            } else {
                unpaused(&self.shared.paused).await;
                self.claim().await?
            };
            if held.state != ClaimState::Working {
                // Only the first claim of a run may be an earlier run's pin.
                return Err(self.fail(Step::Claim, "claim_not_working".to_owned()).await);
            }
            let scaffold = edit.needs_scaffold() && !has_scaffold(&held.dir);
            self.save(round, scaffold, Some(&held.claim_id)).await?;
            if scaffold {
                self.deliver(held, None, false).await?;
                continue;
            }
            self.deliver(held, Some(edit), false).await?;
            return self.save(round.saturating_add(1), false, None).await;
        }
        Err(self.fail(Step::Claim, "unexpected_claim".to_owned()).await)
    }

    /// Records that the agent is on planned task `round`, holding `claim_id`.
    async fn save(&self, round: u32, scaffold: bool, claim_id: Option<&str>) -> Outcome<()> {
        let progress = Progress {
            seed: self.agent.key.seed,
            scenario: self.agent.key.scenario.clone(),
            round,
            scaffold,
            claim_id: claim_id.map(str::to_owned),
        };
        match self.agent.progress.save(&progress) {
            Ok(()) => Ok(()),
            Err(_) => Err(self.fail(Step::Progress, "progress".to_owned()).await),
        }
    }

    /// `rh work`, repeated while it is retryable, with the clone checked to be this run's.
    async fn claim(&self) -> Outcome<Held> {
        self.state(AgentState::Claiming).await;
        let workdir = &self.agent.workdir;
        let claimed: Envelope<Claimed> = self
            .retrying(Step::Claim, || {
                self.shared.runner.rh(&self.agent.env, workdir, &["work"])
            })
            .await?;
        let Claimed {
            claim,
            resumed,
            clone,
        } = claimed.data;
        let fork = format!("{}{}.git", self.shared.fork_prefix, claim.claim_id);
        let inside = clone
            .dir
            .canonicalize()
            .ok()
            .zip(workdir.canonicalize().ok())
            .is_some_and(|(dir, workdir)| dir != workdir && dir.starts_with(&workdir));
        if !is_id(IdKind::Claim, &claim.claim_id)
            || !is_id(IdKind::Issue, &claim.issue_id)
            || claim.origin_url != fork
            || !inside
        {
            return Err(self.fail(Step::Claim, "foreign_claim".to_owned()).await);
        }
        self.emit(Event::Claimed {
            agent: self.name(),
            claim_id: claim.claim_id.clone(),
            issue_id: claim.issue_id.clone(),
            generation: claim.generation.get(),
            resumed,
        })
        .await;
        Ok(Held {
            claim_id: claim.claim_id,
            generation: claim.generation.get(),
            state: claim.state,
            dir: clone.dir,
            resumed,
        })
    }

    /// Writes, pushes and pins the edit, or the scaffold for `None`, then waits for it to land,
    /// redoing it on the new main as often as the retry bound allows. A claim already `pinned` by
    /// an earlier run is waited on first.
    async fn deliver(&self, mut held: Held, edit: Option<Edit>, mut pinned: bool) -> Outcome<()> {
        let class = edit.map_or(TaskClass::Scaffold, |edit| TaskClass::from(edit.class));
        let path = edit.map_or_else(
            || crate::plan::SHARED_PATH.to_owned(),
            |edit| edit.path(&self.agent.env.name),
        );
        let mut redos = 0;
        loop {
            let (ready_at, base) = if pinned {
                pinned = false;
                (None, None)
            } else {
                let (ready_at, base) = self.pin(&held, edit, redos > 0, class, &path).await?;
                (Some(ready_at), base)
            };
            match self.wait(&held, ready_at, class).await? {
                Waited::Landed => {
                    // Only shared edits pair: every scaffold is the same bytes, and an adopted
                    // pin's base is unknown.
                    if let (Some(edit), Some(base)) = (edit, base) {
                        self.pair(&held, edit, &path, base).await?;
                    }
                    return Ok(());
                }
                Waited::Unverified => return Ok(()),
                Waited::Redo => {}
            }
            redos += 1;
            if redos > self.shared.bounds.retries {
                return Err(self.fail(Step::Redo, "too_many_redos".to_owned()).await);
            }
            held = self.redo(&held).await?;
        }
    }

    /// Writes, commits, pushes and pins the edit, and returns when it was pinned and the base the
    /// edit rewrote, for a shared edit.
    async fn pin(
        &self,
        held: &Held,
        edit: Option<Edit>,
        force: bool,
        class: TaskClass,
        path: &str,
    ) -> Outcome<(Instant, Option<String>)> {
        self.state(AgentState::Editing).await;
        let base = self.write(held, edit).await?;
        let commit = self.commit(held, edit, force).await?;
        self.emit(Event::Pushed {
            agent: self.name(),
            claim_id: held.claim_id.clone(),
            commit: commit.clone(),
            class,
            path: path.to_owned(),
        })
        .await;
        self.ready(held, &commit).await?;
        self.emit(Event::Ready {
            agent: self.name(),
            claim_id: held.claim_id.clone(),
            commit,
        })
        .await;
        Ok((Instant::now(), base))
    }

    /// Writes the edit, or every missing scaffold file, into the clone, and returns the contents
    /// a shared edit rewrote. A disjoint edit creates its file and refuses one already there,
    /// unless the claim was handed back and the file holds exactly the planned line: an earlier
    /// run pushed it and stopped before `rh ready`.
    async fn write(&self, held: &Held, edit: Option<Edit>) -> Outcome<Option<String>> {
        let (name, dir) = (&self.agent.env.name, held.dir.as_path());
        let written = match edit {
            None => scaffold()
                .iter()
                .filter(|(path, _)| !confined::is_file(dir, path))
                .try_for_each(|(path, contents)| {
                    confined::write(dir, path, contents).map_err(|error| error.code())
                })
                .map(|()| None),
            Some(edit) if !edit.needs_scaffold() => {
                let path = edit.path(name);
                edit.apply(self.agent.slot, name, None)
                    .map_err(apply_code)
                    .and_then(|contents| {
                        if held.resumed
                            && confined::read(dir, &path)
                                .map_err(|error| error.code())?
                                .is_some_and(|current| current == contents)
                        {
                            return Ok(());
                        }
                        confined::create(dir, &path, &contents).map_err(|error| error.code())
                    })
                    .map(|()| None)
            }
            Some(edit) => {
                let path = edit.path(name);
                confined::read(dir, &path)
                    .map_err(|error| error.code())
                    .and_then(|current| {
                        let contents = edit
                            .apply(self.agent.slot, name, current.as_deref())
                            .map_err(apply_code)?;
                        confined::write(dir, &path, &contents).map_err(|error| error.code())?;
                        Ok(current)
                    })
            }
        };
        match written {
            Ok(base) => Ok(base),
            Err(code) => Err(self.fail(Step::Edit, code.to_owned()).await),
        }
    }

    /// Commits everything and pushes it to the fork; a redo replaces what the fork held.
    async fn commit(&self, held: &Held, edit: Option<Edit>, force: bool) -> Outcome<String> {
        let message = edit.map_or_else(
            || format!("swarm: {} adds the scaffold", self.agent.env.name),
            |edit| {
                format!(
                    "swarm: {} round {} ({})",
                    self.agent.env.name, edit.round, edit.class
                )
            },
        );
        let git = |action, args: &'static [&'static str]| {
            self.shared
                .runner
                .git(&self.agent.env, &held.dir, action, args)
        };
        let committed = async {
            git("add", &["add", "--all"]).await?;
            self.shared
                .runner
                .git(
                    &self.agent.env,
                    &held.dir,
                    "commit",
                    &["commit", "--quiet", "--allow-empty", "-m", &message],
                )
                .await?;
            git("rev-parse", &["rev-parse", "HEAD"]).await
        }
        .await;
        let commit = match committed {
            Ok(commit) if is_commit_sha(&commit) => commit,
            Ok(_) => return Err(self.fail(Step::Edit, "no_commit".to_owned()).await),
            Err(error) => return Err(self.fail(Step::Edit, error.code()).await),
        };
        self.state(AgentState::Pushing).await;
        let args: &'static [&'static str] = if force {
            &["push", "--quiet", "--force", "origin", "HEAD:main"]
        } else {
            &["push", "--quiet", "origin", "HEAD:main"]
        };
        self.retrying(Step::Push, || git("push", args)).await?;
        Ok(commit)
    }

    /// `rh ready` for `commit`, reading the inbox first when it names an unacknowledged item.
    /// A retryable failure may have pinned the commit with its answer lost, so the claim is read
    /// back before `rh ready` is repeated, and repeated only while it is still working at the
    /// generation the agent pushed for.
    async fn ready(&self, held: &Held, commit: &str) -> Outcome<()> {
        self.state(AgentState::Readying).await;
        let bounds = &self.shared.bounds;
        let (mut syncs, mut tries) = (0, 0);
        loop {
            let Err(error) = self
                .shared
                .runner
                .rh::<serde_json::Value>(&self.agent.env, &held.dir, &["ready"])
                .await
            else {
                return Ok(());
            };
            if error.agent_code() == Some(AgentErrorCode::UnackedDecision) {
                syncs += 1;
                if syncs > bounds.retries {
                    return Err(self.fail(Step::Ready, error.code()).await);
                }
                self.sync(held).await?;
                continue;
            }
            let Some(after) = error.retry().filter(|_| tries < bounds.retries) else {
                return Err(self.fail(Step::Ready, error.code()).await);
            };
            tries += 1;
            self.pause(Step::Ready, tries, after).await?;
            if self.reconcile(held, commit).await? == Reconciled::Settled {
                return Ok(());
            }
        }
    }

    /// Reads the claim back after an uncertain `rh ready` for `commit`.
    async fn reconcile(&self, held: &Held, commit: &str) -> Outcome<Reconciled> {
        let status: Envelope<Status> = self
            .retrying(Step::Status, || {
                self.shared
                    .runner
                    .rh(&self.agent.env, &held.dir, &["status"])
            })
            .await?;
        let claim = status
            .data
            .claim
            .filter(|claim| claim.claim_id == held.claim_id);
        match reconciled(claim.as_ref(), held.generation, commit) {
            Ok(reconciled) => Ok(reconciled),
            Err(code) => Err(self.fail(Step::Ready, code.to_owned()).await),
        }
    }

    /// Reads the inbox with `rh sync` and acknowledges every item on it.
    async fn sync(&self, held: &Held) -> Outcome<bool> {
        let page: Envelope<InboxResult> = self
            .retrying(Step::Inbox, || {
                self.shared.runner.rh(&self.agent.env, &held.dir, &["sync"])
            })
            .await?;
        self.acknowledge(held, &page.data.items).await
    }

    /// Acknowledges `items`, reporting each routed conflict. Returns whether one asks this claim
    /// to redo its edit. A decision or rework item stops the agent before it acknowledges
    /// anything: it cannot change its scripted edit to follow one, so it leaves the item for the
    /// operator.
    async fn acknowledge(&self, held: &Held, items: &[InboxItem]) -> Outcome<bool> {
        if let Some(code) = items.iter().find_map(|item| needs_operator(&item.entry)) {
            return Err(self.fail(Step::Inbox, code.to_owned()).await);
        }
        let mut redo = false;
        for item in items {
            let ours = item.claim_id == held.claim_id;
            match &item.entry {
                InboxEntry::Conflict {
                    other_claim_id,
                    path,
                } => {
                    if ours && is_id(IdKind::Claim, other_claim_id) && is_repo_path(path) {
                        self.emit(Event::ConflictRouted {
                            agent: self.name(),
                            claim_id: held.claim_id.clone(),
                            other_claim_id: other_claim_id.clone(),
                            path: path.clone(),
                            item: item.item.get(),
                        })
                        .await;
                    }
                    redo |= ours;
                }
                // Refused above.
                InboxEntry::Decision { .. } | InboxEntry::Rework { .. } => {
                    return Err(self.fail(Step::Inbox, "needs_operator".to_owned()).await);
                }
            }
            let number = item.item.get().to_string();
            let args = ["ack", number.as_str(), "--plan", CONFLICT_PLAN];
            self.retrying(Step::Inbox, || {
                self.shared
                    .runner
                    .rh::<serde_json::Value>(&self.agent.env, &held.dir, &args)
            })
            .await?;
            self.emit(Event::Acknowledged {
                agent: self.name(),
                item: item.item.get(),
            })
            .await;
        }
        Ok(redo)
    }

    /// Polls `rh status` until the ready claim lands, is sent back for a redo, closes, or the land
    /// timeout passes. `ready_at` is when this run pinned it, `None` for an adopted claim.
    async fn wait(
        &self,
        held: &Held,
        ready_at: Option<Instant>,
        class: TaskClass,
    ) -> Outcome<Waited> {
        self.state(AgentState::Waiting).await;
        let bounds = &self.shared.bounds;
        let since = ready_at.unwrap_or_else(Instant::now);
        let mut failures = 0;
        let mut pin = PinWatch::default();
        loop {
            tokio::time::sleep(bounds.poll).await;
            if since.elapsed() > bounds.land_timeout {
                self.emit(Event::Stalled {
                    agent: self.name(),
                    claim_id: held.claim_id.clone(),
                    waited_ms: millis(since.elapsed()),
                })
                .await;
                return Err(Stopped);
            }
            let status: Envelope<Status> = match self
                .shared
                .runner
                .rh(&self.agent.env, &held.dir, &["status"])
                .await
            {
                Ok(status) => status,
                Err(error) => {
                    let Some(after) = error.retry().filter(|_| failures < bounds.retries) else {
                        return Err(self.fail(Step::Status, error.code()).await);
                    };
                    failures += 1;
                    self.pause(Step::Status, failures, after).await?;
                    continue;
                }
            };
            failures = 0;
            if let Some(InboxDigest { items, .. }) = &status.inbox
                && !items.is_empty()
            {
                self.acknowledge(held, items).await?;
            }
            let state = status
                .data
                .claim
                .filter(|claim| claim.claim_id == held.claim_id)
                .map(|claim| claim.state);
            match judge(state) {
                Polled::Landed => {
                    self.emit(Event::Landed {
                        agent: self.name(),
                        claim_id: held.claim_id.clone(),
                        class,
                        ready_to_landed_ms: ready_at.map(|at| millis(at.elapsed())),
                    })
                    .await;
                    return Ok(Waited::Landed);
                }
                Polled::Unverified => {
                    self.emit(self.unverified(&held.claim_id, class)).await;
                    return Ok(Waited::Unverified);
                }
                Polled::Redo => return Ok(Waited::Redo),
                Polled::Pending => self.read_pin(held, &mut pin).await,
                Polled::Closed(code) => {
                    return Err(self.fail(Step::Status, code.to_owned()).await);
                }
            }
        }
    }

    /// Reads the held claim's pin with `rh pin`, once, and reports where the train holds it when
    /// that changed since the last read.
    async fn read_pin(&self, held: &Held, watch: &mut PinWatch) {
        if !watch.due(Instant::now()) {
            return;
        }
        let read: Result<Envelope<PinResult>, _> = self
            .shared
            .runner
            .rh(&self.agent.env, &held.dir, &["pin"])
            .await;
        let result = read.as_ref().map(|envelope| envelope.data.pin.as_ref());
        if let Some(train) = watch.read(result, &held.claim_id, Instant::now()) {
            self.emit(Event::PinState {
                agent: self.name(),
                claim_id: held.claim_id.clone(),
                train,
            })
            .await;
        }
    }

    fn unverified(&self, claim_id: &str, class: TaskClass) -> Event {
        Event::Unverified {
            agent: self.name(),
            claim_id: claim_id.to_owned(),
            class,
            needs: UNVERIFIED_NEEDS,
        }
    }

    /// Reads `path` back from main after the shared `edit` written on `base` landed, and reports
    /// the earlier landing Git merged it with, if main shows one (see [`Landings::record`]).
    async fn pair(&self, held: &Held, edit: Edit, path: &str, base: String) -> Outcome<()> {
        let (runner, env, dir) = (&self.shared.runner, &self.agent.env, &held.dir);
        let fetch = ["fetch", "--quiet", "upstream"];
        self.retrying(Step::Verify, || runner.git_text(env, dir, "fetch", &fetch))
            .await?;
        let object = format!("upstream/main:{path}");
        let show = ["show", object.as_str()];
        let main = self
            .retrying(Step::Verify, || runner.git_text(env, dir, "show", &show))
            .await?;
        let landing = Landing::new(
            &held.claim_id,
            path,
            &edit.line(&self.agent.env.name),
            &base,
        );
        let merged = self
            .shared
            .landings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .record(landing, &main);
        if let Some(first) = merged {
            self.emit(Event::ConflictAutoMerged {
                path: path.to_owned(),
                claims: [first, held.claim_id.clone()],
            })
            .await;
        }
        Ok(())
    }

    /// Takes the reopened claim back with `rh work` and resets the clone to the new main.
    async fn redo(&self, held: &Held) -> Outcome<Held> {
        self.state(AgentState::Redoing).await;
        let again = self.claim().await?;
        if again.claim_id != held.claim_id || again.dir != held.dir {
            return Err(self.fail(Step::Redo, "claim_changed".to_owned()).await);
        }
        self.emit(Event::Redo {
            agent: self.name(),
            claim_id: again.claim_id.clone(),
            generation: again.generation,
        })
        .await;
        let git = |action, args: &'static [&'static str]| {
            self.shared
                .runner
                .git(&self.agent.env, &again.dir, action, args)
        };
        self.retrying(Step::Redo, || {
            git("fetch", &["fetch", "--quiet", "upstream"])
        })
        .await?;
        if let Err(error) = git("reset", &["reset", "--quiet", "--hard", "upstream/main"]).await {
            return Err(self.fail(Step::Redo, error.code()).await);
        }
        Ok(again)
    }

    /// Waits before retry `tries` of `step`, which the backend asked to delay by `asked`. A wait
    /// that would end after the run's deadline stops the agent instead: the retry could not run.
    async fn pause(&self, step: Step, tries: u32, asked: Duration) -> Outcome<()> {
        let delay = backoff(tries, asked, self.shared.bounds.poll);
        if !ends_by(Instant::now(), delay, self.shared.deadline) {
            return Err(self.fail(step, "retry_after_deadline".to_owned()).await);
        }
        tokio::time::sleep(delay).await;
        Ok(())
    }

    /// Runs `step` until it succeeds, repeating a retryable failure within the retry bound.
    async fn retrying<T, F, Fut>(&self, step: Step, attempt: F) -> Outcome<T>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<T, process::Error>>,
    {
        let mut tries = 0;
        loop {
            match attempt().await {
                Ok(value) => return Ok(value),
                Err(error) => match error.retry() {
                    Some(after) if tries < self.shared.bounds.retries => {
                        tries += 1;
                        self.pause(step, tries, after).await?;
                    }
                    Some(_) | None => return Err(self.fail(step, error.code()).await),
                },
            }
        }
    }
}

/// The pause before retry `tries`: the poll interval doubled per try, at most [`MAX_BACKOFF`],
/// or the backend's delay when that is longer.
fn backoff(tries: u32, asked: Duration, poll: Duration) -> Duration {
    let doubled = poll.saturating_mul(2_u32.saturating_pow(tries.saturating_sub(1)));
    asked.max(doubled.min(MAX_BACKOFF))
}

/// Whether a pause of `delay` from `now` ends by `deadline`.
fn ends_by(now: Instant, delay: Duration, deadline: Instant) -> bool {
    now.checked_add(delay).is_some_and(|end| end <= deadline)
}

/// What reading a claim back after an uncertain `rh ready` showed.
#[derive(Debug, PartialEq, Eq)]
enum Reconciled {
    /// Still working at the generation the commit was pushed for: `rh ready` may be repeated.
    Unpinned,
    /// The pin was recorded, or the claim moved on since; waiting on it judges the outcome.
    Settled,
}

/// Judges the held claim at `generation`, as `rh status` showed it after an uncertain `rh ready`
/// for `commit`, or the code the agent stops with.
fn reconciled(
    claim: Option<&ClaimView>,
    generation: u64,
    commit: &str,
) -> Result<Reconciled, &'static str> {
    let Some(claim) = claim else {
        // It left the status: merged or expired, which waiting reports as unverified.
        return Ok(Reconciled::Settled);
    };
    match claim.state {
        ClaimState::Working if claim.generation.get() == generation => Ok(Reconciled::Unpinned),
        ClaimState::Ready if claim.ready_commit.as_deref() != Some(commit) => Err("foreign_pin"),
        // Pinned, landed, sent back for a redo or expired: waiting on it says which.
        ClaimState::Working | ClaimState::Ready | ClaimState::Merged | ClaimState::Expired => {
            Ok(Reconciled::Settled)
        }
    }
}

/// The code an agent stops with on an inbox item it cannot follow, `None` for a conflict.
const fn needs_operator(entry: &InboxEntry) -> Option<&'static str> {
    match entry {
        InboxEntry::Decision { .. } => Some("decision_needs_operator"),
        InboxEntry::Rework { .. } => Some("rework_needs_operator"),
        InboxEntry::Conflict { .. } => None,
    }
}

/// The code a stopped agent reports when an edit cannot be applied.
fn apply_code(error: ApplyError) -> &'static str {
    match error {
        ApplyError::NoScaffold => "no_scaffold",
        ApplyError::Unrecognised => "unrecognised_file",
        ApplyError::Exists => "path_exists",
    }
}

/// A planned task's index into the agent's edits.
fn task_index(round: u32) -> usize {
    usize::try_from(round).unwrap_or(usize::MAX)
}

/// Whether the clone has both scaffold files.
fn has_scaffold(dir: &Path) -> bool {
    scaffold()
        .iter()
        .all(|(path, _)| confined::is_file(dir, path))
}

/// A relative path of plain segments, as the protocol's path rule requires.
fn is_repo_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= railhead_protocol::MAX_PATH_LENGTH
        && path
            .split('/')
            .all(|segment| !segment.is_empty() && segment != "." && segment != "..")
        && !path.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use super::*;

    const A: &str = "swarm-00 round 0 000000000000000a";
    const B: &str = "swarm-01 round 0 000000000000000b";
    const BASE: &str = "slot 00: open\nslot 01: open\n";

    fn landing(claim_id: &str, path: &str, line: &str, base: &str) -> Landing {
        Landing::new(claim_id, path, line, base)
    }

    fn holds(text: &str, line: &str) -> bool {
        swarm_lines(text).any(|held| held == line_hash(line))
    }

    #[test]
    fn concurrent_edits_main_holds_together_count_as_merged() {
        let mut landings = Landings::default();
        let after_a = format!("slot 00: {A}\nslot 01: open\n");
        let both = format!("slot 00: {A}\nslot 01: {B}\n");
        assert_eq!(
            landings.record(landing("clm_aaaaaa", "f", A, BASE), &after_a),
            None
        );
        // B was written on a base without A's line, and main holds both: Git merged them.
        assert_eq!(
            landings.record(landing("clm_bbbbbb", "f", B, BASE), &both),
            Some("clm_aaaaaa".to_owned())
        );
    }

    #[test]
    fn an_edit_that_built_on_the_other_never_counts_whatever_the_order_seen() {
        let after_a = format!("slot 00: {A}\nslot 01: open\n");
        let both = format!("slot 00: {A}\nslot 01: {B}\n");
        // A landed; B forked after it, so B's base already held A's line. B's agent saw its
        // landing first and A's agent saw its own late: neither order makes it a merge.
        let mut landings = Landings::default();
        assert_eq!(
            landings.record(landing("clm_bbbbbb", "f", B, &after_a), &both),
            None
        );
        assert_eq!(
            landings.record(landing("clm_aaaaaa", "f", A, BASE), &both),
            None
        );
        let mut landings = Landings::default();
        assert_eq!(
            landings.record(landing("clm_aaaaaa", "f", A, BASE), &both),
            None
        );
        assert_eq!(
            landings.record(landing("clm_bbbbbb", "f", B, &after_a), &both),
            None
        );
    }

    #[test]
    fn a_merge_main_does_not_show_never_counts() {
        let mut landings = Landings::default();
        let after_a = format!("slot 00: {A}\nslot 01: open\n");
        assert_eq!(
            landings.record(landing("clm_aaaaaa", "f", A, BASE), &after_a),
            None
        );
        // A's line was rewritten before B read main back: no evidence both landed together.
        let rewritten = format!("slot 00: swarm-00 round 1 00000000000000aa\nslot 01: {B}\n");
        assert_eq!(
            landings.record(landing("clm_bbbbbb", "f", B, BASE), &rewritten),
            None
        );
        // Main without the landing's own line: nothing to pair.
        assert_eq!(
            landings.record(
                landing("clm_cccccc", "f", "swarm-02 round 0 c", BASE),
                &after_a
            ),
            None
        );
        // Another path, or the same claim landing again, never pairs.
        let both = format!("slot 00: {A}\nslot 01: {B}\n");
        assert_eq!(
            landings.record(landing("clm_dddddd", "g", B, BASE), &both),
            None
        );
        assert_eq!(
            landings.record(landing("clm_aaaaaa", "f", A, BASE), &after_a),
            None
        );
    }

    #[test]
    fn a_line_is_held_only_whole() {
        assert!(holds(&format!("slot 00: {A}\n"), A));
        assert!(holds(&format!("{A}\n"), A));
        assert!(!holds("slot 00: open\n", A));
        // A longer round or another agent's name is another line.
        assert!(!holds(
            "swarm-00 round 10 000000000000000a\n",
            "round 0 000000000000000a"
        ));
        assert!(!holds("xswarm-00 round 0 000000000000000a\n", A));
        assert!(!holds("swarm-00  round 0 000000000000000a\n", A));
        assert!(!holds("swarm-00 round 0 000000000000000a \n", A));
        assert!(!holds("", A));
        // Only lines an edit writes are kept: a short token or another word is not one.
        assert_eq!(
            swarm_lines("swarm-00 round 0 abc\nslot 00: open\n--\n").count(),
            0
        );
    }

    /// A shared file near the read limit: every slot holds a swarm line, padded with long lines.
    fn large_base() -> String {
        let mut base = String::with_capacity(1024 * 1024);
        for slot in 0..64 {
            // Writing to a `String` cannot fail.
            let _ = writeln!(base, "slot {slot:02}: swarm-{slot:02} round 9 {slot:016x}");
        }
        let filler = format!("{}\n", "-".repeat(1023));
        while base.len() < 1000 * 1024 {
            base.push_str(&filler);
        }
        base
    }

    #[test]
    fn landings_keep_line_hashes_not_the_shared_file() {
        let base = large_base();
        let mut landings = Landings::default();
        for index in 0..100_u64 {
            let line = format!("swarm-00 round {index} {index:016x}");
            let main = format!("{base}contested: {line}\n");
            let claim = format!("clm_{index:06}");
            assert_eq!(
                landings.record(landing(&claim, "f", &line, &base), &main),
                None
            );
        }
        // Each landing keeps its line and the base's 64 slot lines: about 50 KiB in all, where
        // the bases were 100 MiB.
        assert_eq!(landings.retained(), 100 * 65);

        // Pairing still works on a large base: neither line on it, both on main.
        let mut landings = Landings::default();
        let both = format!("{base}contested: {A}\nslot 64: {B}\n");
        landings.record(landing("clm_aaaaaa", "f", A, &base), &both);
        assert_eq!(
            landings.record(landing("clm_bbbbbb", "f", B, &base), &both),
            Some("clm_aaaaaa".to_owned())
        );
    }

    #[test]
    fn a_base_with_more_swarm_lines_than_the_scaffold_never_pairs() {
        let mut crowded = String::new();
        for index in 0..=MAX_BASE_LINES {
            let _ = writeln!(crowded, "swarm-63 round {index} {index:016x}");
        }
        let both = format!("slot 00: {A}\nslot 01: {B}\n");
        let mut landings = Landings::default();
        landings.record(landing("clm_aaaaaa", "f", A, BASE), &both);
        // B's base is unknown, so it may have held A's line: not counted as merged.
        assert_eq!(
            landings.record(landing("clm_bbbbbb", "f", B, &crowded), &both),
            None
        );
        // It keeps only its own line.
        assert_eq!(landings.retained(), 2);
        // One line fewer is kept whole.
        crowded.truncate(crowded.trim_end().rfind('\n').map_or(0, |end| end + 1));
        assert_eq!(swarm_lines(&crowded).count(), MAX_BASE_LINES);
        let kept = landing("clm_cccccc", "f", A, &crowded);
        assert_eq!(
            kept.base.as_ref().map(|base| base.len()),
            Some(MAX_BASE_LINES)
        );
    }

    #[test]
    fn only_a_merged_claim_counts_as_landed() {
        assert_eq!(judge(Some(ClaimState::Merged)), Polled::Landed);
        assert_eq!(judge(Some(ClaimState::Ready)), Polled::Pending);
        assert_eq!(judge(Some(ClaimState::Working)), Polled::Redo);
        assert_eq!(
            judge(Some(ClaimState::Expired)),
            Polled::Closed("claim_expired")
        );
        // Gone from the status: merged or expired, the agent cannot tell (#237).
        assert_eq!(judge(None), Polled::Unverified);
    }

    fn claim(state: &str, generation: u64, ready: Option<&str>) -> anyhow::Result<ClaimView> {
        Ok(serde_json::from_value(serde_json::json!({
            "claimId": "clm_abcdef", "issueId": "iss_abcdef", "generation": generation,
            "base": "0".repeat(40), "state": state, "readyCommit": ready,
            "originUrl": "https://railhead.test/git/o/r/claims/clm_abcdef.git",
            "upstreamUrl": "https://railhead.test/git/o/r.git",
            "task": {"title": "t", "body": "b"}
        }))?)
    }

    #[test]
    fn an_uncertain_ready_is_repeated_only_while_unpinned() -> anyhow::Result<()> {
        let ours = "a".repeat(40);
        let theirs = "b".repeat(40);
        let check = |state, generation, ready: Option<&str>| {
            claim(state, generation, ready).map(|claim| reconciled(Some(&claim), 2, &ours))
        };
        // Still working at the pushed generation: the pin did not happen.
        assert_eq!(check("working", 2, None)?, Ok(Reconciled::Unpinned));
        // The lost answer had pinned it, or the train moved it on since.
        assert_eq!(check("ready", 2, Some(&ours))?, Ok(Reconciled::Settled));
        assert_eq!(check("merged", 2, Some(&ours))?, Ok(Reconciled::Settled));
        assert_eq!(check("working", 3, None)?, Ok(Reconciled::Settled));
        assert_eq!(check("expired", 2, None)?, Ok(Reconciled::Settled));
        assert_eq!(reconciled(None, 2, &ours), Ok(Reconciled::Settled));
        // Pinned at a commit the agent did not push.
        assert_eq!(check("ready", 2, Some(&theirs))?, Err("foreign_pin"));
        assert_eq!(check("ready", 2, None)?, Err("foreign_pin"));
        Ok(())
    }

    #[test]
    fn only_a_conflict_is_followed_without_the_operator() -> anyhow::Result<()> {
        let entry = |value| serde_json::from_value::<InboxEntry>(value);
        let decision = serde_json::json!({"decisionId": "dec_abcdef", "version": 2});
        assert_eq!(
            needs_operator(&entry(
                serde_json::json!({"kind": "decision", "decision": decision})
            )?),
            Some("decision_needs_operator")
        );
        assert_eq!(
            needs_operator(&entry(
                serde_json::json!({"kind": "rework", "decision": decision})
            )?),
            Some("rework_needs_operator")
        );
        assert_eq!(
            needs_operator(&entry(serde_json::json!({"kind": "conflict",
                "otherClaimId": "clm_bcdefg", "path": "swarm/contested.txt"}))?),
            None
        );
        Ok(())
    }

    fn pin_view(state: &serde_json::Value) -> anyhow::Result<PinView> {
        Ok(serde_json::from_value(serde_json::json!({
            "claimId": "clm_abcdef", "generation": 1, "commit": "a".repeat(40),
            "nextCommit": null, "state": state
        }))?)
    }

    fn refused(code: AgentErrorCode, retryable: bool, after: Option<u64>) -> process::Error {
        process::Error::Rejected(process::Rejection {
            code: process::Code::Agent(code),
            retryable,
            retry_after_ms: after,
            next: None,
        })
    }

    #[test]
    fn a_pin_is_reported_only_when_it_changes() -> anyhow::Result<()> {
        let now = Instant::now();
        let mut watch = PinWatch::default();
        let queued = pin_view(&serde_json::json!({"kind": "queued", "position": 2}))?;
        let first = watch.read(Ok(Some(&queued)), "clm_abcdef", now);
        assert_eq!(first, Some(TrainState::Queued { position: 2 }));
        assert_eq!(watch.read(Ok(Some(&queued)), "clm_abcdef", now), None);
        let checking = pin_view(&serde_json::json!({"kind": "batched", "batchId": 7,
            "batch": "checking", "checkRunId": "chk_run0001"}))?;
        assert_eq!(
            watch.read(Ok(Some(&checking)), "clm_abcdef", now),
            Some(TrainState::Batched {
                batch_id: 7,
                batch: railhead_protocol::PinBatchState::Checking,
                check_run_id: Some("chk_run0001".to_owned()),
            })
        );
        // No pin, or another claim's, is the train holding none for this one.
        assert_eq!(
            watch.read(Ok(None), "clm_abcdef", now),
            Some(TrainState::Absent)
        );
        assert_eq!(watch.read(Ok(Some(&queued)), "clm_bcdefg", now), None);
        assert!(watch.due(now));
        Ok(())
    }

    #[test]
    fn a_refused_pin_read_waits_as_asked_or_stops_for_the_wait() -> anyhow::Result<()> {
        let now = Instant::now();
        let mut watch = PinWatch::default();
        let limited = refused(AgentErrorCode::RateLimited, true, Some(5_000));
        assert_eq!(
            watch.read(Err(&limited), "clm_abcdef", now),
            Some(TrainState::Unreadable {
                code: "rate_limited".to_owned()
            })
        );
        assert!(!watch.due(now + Duration::from_millis(4_999)));
        assert!(watch.due(now + Duration::from_secs(5)));
        // The same failure again is no change; a read that works clears the delay.
        assert_eq!(watch.read(Err(&limited), "clm_abcdef", now), None);
        let landed = pin_view(&serde_json::json!({"kind": "landed"}))?;
        assert_eq!(
            watch.read(Ok(Some(&landed)), "clm_abcdef", now),
            Some(TrainState::Landed)
        );
        assert!(watch.due(now));
        // A refusal repeating cannot fix ends the reads for this wait.
        let missing = refused(AgentErrorCode::Unavailable, false, None);
        assert_eq!(
            watch.read(Err(&missing), "clm_abcdef", now),
            Some(TrainState::Unreadable {
                code: "unavailable".to_owned()
            })
        );
        assert!(!watch.due(now + Duration::from_secs(3600)));
        Ok(())
    }

    #[test]
    fn a_check_run_that_breaks_the_identifier_rule_is_not_reported() -> anyhow::Result<()> {
        let forged = pin_view(&serde_json::json!({"kind": "batched", "batchId": 7,
            "batch": "held", "checkRunId": "chk_x\u{1b}[2J"}))?;
        assert_eq!(
            TrainState::of(Some(&forged), "clm_abcdef"),
            TrainState::Batched {
                batch_id: 7,
                batch: railhead_protocol::PinBatchState::Held,
                check_run_id: None,
            }
        );
        let parked = pin_view(&serde_json::json!({"kind": "parked", "reason": "conflict"}))?;
        assert_eq!(
            serde_json::to_value(TrainState::of(Some(&parked), "clm_abcdef"))?,
            serde_json::json!({"kind": "parked", "reason": "conflict"})
        );
        Ok(())
    }

    #[test]
    fn backoff_grows_and_is_capped() {
        let poll = Duration::from_millis(100);
        assert_eq!(backoff(1, Duration::ZERO, poll), poll);
        assert_eq!(backoff(3, Duration::ZERO, poll), Duration::from_millis(400));
        assert_eq!(
            backoff(1, Duration::from_secs(2), poll),
            Duration::from_secs(2)
        );
        assert_eq!(backoff(40, Duration::ZERO, poll), MAX_BACKOFF);
        // The backend's delay is kept above the driver's cap.
        assert_eq!(
            backoff(1, Duration::from_secs(600), poll),
            Duration::from_secs(600)
        );
        assert_eq!(
            backoff(40, Duration::from_secs(45), poll),
            Duration::from_secs(45)
        );
    }

    #[test]
    fn a_retry_waits_only_when_it_can_run_before_the_deadline() {
        let now = Instant::now();
        let deadline = now + Duration::from_secs(120);
        assert!(ends_by(now, Duration::from_secs(30), deadline));
        assert!(ends_by(now, Duration::from_secs(120), deadline));
        assert!(!ends_by(now, Duration::from_secs(121), deadline));
        assert!(!ends_by(now, Duration::from_secs(600), deadline));
        assert!(!ends_by(now, Duration::MAX, deadline));
    }

    #[test]
    fn only_plain_relative_paths_are_reported() {
        assert!(is_repo_path("swarm/contested.txt"));
        for path in ["", "/etc/passwd", "a//b", "../x", "a/./b", "a\u{1b}[2J"] {
            assert!(!is_repo_path(path), "{path:?}");
        }
    }

    #[test]
    fn the_scaffold_is_written_only_where_missing() -> anyhow::Result<()> {
        let dir = tempfile::tempdir()?;
        assert!(!has_scaffold(dir.path()));
        let [(shared, shared_text), (contested, contested_text)] = scaffold();
        confined::write(dir.path(), contested, "kept\n")?;
        assert!(!has_scaffold(dir.path()));
        confined::write(dir.path(), shared, &shared_text)?;
        assert!(has_scaffold(dir.path()));
        assert_ne!(
            std::fs::read_to_string(dir.path().join(contested))?,
            contested_text
        );
        Ok(())
    }

    #[tokio::test]
    async fn a_paused_run_holds_new_claims_until_it_resumes() -> anyhow::Result<()> {
        let short = Duration::from_millis(50);
        let (pause, paused) = watch::channel(false);
        tokio::time::timeout(short, unpaused(&paused)).await?;
        pause.send(true)?;
        assert!(
            tokio::time::timeout(short, unpaused(&paused))
                .await
                .is_err()
        );
        let waiting = tokio::spawn({
            let paused = paused.clone();
            async move { unpaused(&paused).await }
        });
        tokio::time::sleep(short).await;
        assert!(!waiting.is_finished());
        pause.send(false)?;
        tokio::time::timeout(Duration::from_secs(5), waiting).await??;
        Ok(())
    }

    #[tokio::test]
    async fn a_pause_nobody_can_lift_holds_but_a_closed_resume_does_not() -> anyhow::Result<()> {
        let short = Duration::from_millis(50);
        let (pause, paused) = watch::channel(true);
        drop(pause);
        assert!(
            tokio::time::timeout(short, unpaused(&paused))
                .await
                .is_err()
        );
        let (pause, paused) = watch::channel(false);
        drop(pause);
        tokio::time::timeout(short, unpaused(&paused)).await?;
        Ok(())
    }
}
