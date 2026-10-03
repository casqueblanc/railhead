//! One simulated agent: `rh work` → edit → commit → push → `rh ready` → wait for the train, for
//! each planned edit.
//!
//! The agent follows what `rh` answers. A retryable refusal is repeated within the retry bound,
//! after the delay the backend asked for. An unacknowledged decision is read and acknowledged
//! before `rh ready` is repeated. A conflict routed to its claim, or the claim reopening, makes
//! it redo the edit on the new main and push again. A ready claim that does not land within the
//! land timeout stops the agent: it still holds the claim, so it cannot take other work.
//!
//! A task lands only when the agent reads its claim as `merged`. A claim that leaves the agent's
//! status without that evidence may have expired, so the agent stops on it instead of counting a
//! landing.
//!
//! A rerun picks up where a stopped run left off. The agent's progress record names the planned
//! task it was on and that task's claim. When `rh work` hands back a claim an earlier run already
//! pinned, the agent adopts it: it waits for the claim's outcome and records it before it plans
//! any new edit.
//!
//! The agent writes only inside the clone `rh work` made under its own working directory, and
//! only to a clone whose fork belongs to the scenario's repository. It never follows a symbolic
//! link the repository planted there (see [`crate::confined`]).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use railhead_protocol::{
    AgentErrorCode, ClaimState, ClaimView, IdKind, InboxDigest, InboxEntry, InboxItem, InboxResult,
    is_commit_sha, is_id,
};
use serde::Deserialize;

use crate::confined;
use crate::events::{AgentState, Emitter, Event, Step, TaskClass, millis};
use crate::plan::{ApplyError, Edit, scaffold};
use crate::process::{self, AgentEnv, Envelope, Runner};
use crate::progress::{Progress, ProgressFile, RunKey};
use crate::scenario::Bounds;

/// The plan an agent writes when it acknowledges an item.
const CONFLICT_PLAN: &str = "Simulated agent: redo the edit on the new main and push it again.";
const REWORK_PLAN: &str = "Simulated agent: redo the edit against the new decision.";
const DECISION_PLAN: &str = "Simulated agent: noted; the scripted edit does not depend on it.";

/// Longest pause between two retries of one step.
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
    /// Landings seen so far, to find same-path pairs Git merged.
    pub landings: Mutex<Landings>,
}

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
    /// When the claim was made or last reopened: its fork has main as of then.
    based_at: Instant,
}

/// What waiting on a ready claim ended with.
enum Waited {
    Landed,
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
    /// It closed without landing, or without evidence that it did.
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
        // The agent wire does not yet say which (#237 adds the closed reason); without positive
        // evidence it is not a landing.
        None => Polled::Closed("closed_unknown"),
    }
}

/// A landing, for pairing same-path edits.
#[derive(Debug, Clone)]
struct Landing {
    claim_id: String,
    path: String,
    at: Instant,
}

/// Landings seen in this run.
#[derive(Debug, Default)]
pub struct Landings(Vec<Landing>);

impl Landings {
    /// Records a landing of `path`, made on a fork of main as of `based_at`, and returns the
    /// latest earlier landing of the same path that main did not have then: Git merged the two.
    fn record(
        &mut self,
        claim_id: &str,
        path: &str,
        based_at: Instant,
        at: Instant,
    ) -> Option<String> {
        let merged = self
            .0
            .iter()
            .filter(|landing| landing.path == path && landing.claim_id != claim_id)
            .filter(|landing| landing.at >= based_at)
            .max_by_key(|landing| landing.at)
            .map(|landing| landing.claim_id.clone());
        self.0.push(Landing {
            claim_id: claim_id.to_owned(),
            path: path.to_owned(),
            at,
        });
        merged
    }
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
                Polled::Landed => next = self.landed_meanwhile(saved, claim_id).await?,
                Polled::Closed(code) => {
                    return Err(self.fail(Step::Claim, code.to_owned()).await);
                }
            }
        }
        let mut first = None;
        if task_index(next) < self.agent.edits.len() {
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
            return match self.wait(&held, None, TaskClass::Adopted, None).await? {
                Waited::Landed => Ok(next),
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

    /// Records the landing of an earlier run's claim that merged while no run watched it, and
    /// returns the planned task to go on with.
    async fn landed_meanwhile(&self, saved: &Progress, claim_id: &str) -> Outcome<u32> {
        let Some(edit) = self.agent.edits.get(task_index(saved.round)).copied() else {
            return Err(self.fail(Step::Claim, "unmapped_claim".to_owned()).await);
        };
        self.emit(Event::Adopted {
            agent: self.name(),
            claim_id: claim_id.to_owned(),
            round: Some(saved.round),
        })
        .await;
        self.emit(Event::Landed {
            agent: self.name(),
            claim_id: claim_id.to_owned(),
            class: if saved.scaffold {
                TaskClass::Scaffold
            } else {
                TaskClass::from(edit.class)
            },
            ready_to_landed_ms: None,
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
            let held = match first.take() {
                Some(held) => held,
                None => self.claim().await?,
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
            based_at: Instant::now(),
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
            let ready_at = if pinned {
                pinned = false;
                None
            } else {
                Some(self.pin(&held, edit, redos > 0, class, &path).await?)
            };
            // Only planned edits pair: every scaffold is the same bytes.
            let pairs = edit.map(|_| path.as_str());
            match self.wait(&held, ready_at, class, pairs).await? {
                Waited::Landed => return Ok(()),
                Waited::Redo => {}
            }
            redos += 1;
            if redos > self.shared.bounds.retries {
                return Err(self.fail(Step::Redo, "too_many_redos".to_owned()).await);
            }
            held = self.redo(&held).await?;
        }
    }

    /// Writes, commits, pushes and pins the edit, and returns when it was pinned.
    async fn pin(
        &self,
        held: &Held,
        edit: Option<Edit>,
        force: bool,
        class: TaskClass,
        path: &str,
    ) -> Outcome<Instant> {
        self.state(AgentState::Editing).await;
        self.write(&held.dir, edit).await?;
        let commit = self.commit(held, edit, force).await?;
        self.emit(Event::Pushed {
            agent: self.name(),
            claim_id: held.claim_id.clone(),
            commit: commit.clone(),
            class,
            path: path.to_owned(),
        })
        .await;
        self.ready(held).await?;
        self.emit(Event::Ready {
            agent: self.name(),
            claim_id: held.claim_id.clone(),
            commit,
        })
        .await;
        Ok(Instant::now())
    }

    /// Writes the edit, or every missing scaffold file, into the clone.
    async fn write(&self, dir: &Path, edit: Option<Edit>) -> Outcome<()> {
        let written = match edit {
            None => scaffold()
                .iter()
                .filter(|(path, _)| !confined::is_file(dir, path))
                .try_for_each(|(path, contents)| {
                    confined::write(dir, path, contents).map_err(|error| error.code())
                }),
            Some(edit) => {
                let path = edit.path(&self.agent.env.name);
                match confined::read(dir, &path) {
                    Err(error) => Err(error.code()),
                    Ok(current) => {
                        match edit.apply(self.agent.slot, &self.agent.env.name, current.as_deref())
                        {
                            Ok(contents) => {
                                confined::write(dir, &path, &contents).map_err(|error| error.code())
                            }
                            Err(ApplyError::NoScaffold) => Err("no_scaffold"),
                            Err(ApplyError::Unrecognised) => Err("unrecognised_file"),
                        }
                    }
                }
            }
        };
        match written {
            Ok(()) => Ok(()),
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

    /// `rh ready`, acknowledging pending decisions first when it asks.
    async fn ready(&self, held: &Held) -> Outcome<()> {
        self.state(AgentState::Readying).await;
        for _ in 0..=self.shared.bounds.retries {
            let pinned = self
                .retrying_until(Step::Ready, AgentErrorCode::UnackedDecision, || {
                    self.shared.runner.rh::<serde_json::Value>(
                        &self.agent.env,
                        &held.dir,
                        &["ready"],
                    )
                })
                .await?;
            if pinned.is_some() {
                return Ok(());
            }
            self.sync(held).await?;
        }
        Err(self.fail(Step::Ready, "unacked_decision".to_owned()).await)
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
    /// to redo its edit.
    async fn acknowledge(&self, held: &Held, items: &[InboxItem]) -> Outcome<bool> {
        let mut redo = false;
        for item in items {
            let ours = item.claim_id == held.claim_id;
            let plan = match &item.entry {
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
                    CONFLICT_PLAN
                }
                InboxEntry::Rework { .. } => {
                    redo |= ours;
                    REWORK_PLAN
                }
                InboxEntry::Decision { .. } => DECISION_PLAN,
            };
            let number = item.item.get().to_string();
            let args = ["ack", number.as_str(), "--plan", plan];
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
        path: Option<&str>,
    ) -> Outcome<Waited> {
        self.state(AgentState::Waiting).await;
        let bounds = &self.shared.bounds;
        let since = ready_at.unwrap_or_else(Instant::now);
        let mut failures = 0;
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
                    failures += 1;
                    if error.retry().is_none() || failures > bounds.retries {
                        return Err(self.fail(Step::Status, error.code()).await);
                    }
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
                    self.landed(held, ready_at, class, path).await;
                    return Ok(Waited::Landed);
                }
                Polled::Redo => return Ok(Waited::Redo),
                Polled::Pending => {}
                Polled::Closed(code) => {
                    return Err(self.fail(Step::Status, code.to_owned()).await);
                }
            }
        }
    }

    async fn landed(
        &self,
        held: &Held,
        ready_at: Option<Instant>,
        class: TaskClass,
        path: Option<&str>,
    ) {
        let now = Instant::now();
        self.emit(Event::Landed {
            agent: self.name(),
            claim_id: held.claim_id.clone(),
            class,
            ready_to_landed_ms: ready_at.map(|at| millis(now.duration_since(at))),
        })
        .await;
        let Some(path) = path else { return };
        let merged = self
            .shared
            .landings
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .record(&held.claim_id, path, held.based_at, now);
        if let Some(first) = merged {
            self.emit(Event::ConflictAutoMerged {
                path: path.to_owned(),
                claims: [first, held.claim_id.clone()],
            })
            .await;
        }
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
                        tokio::time::sleep(backoff(tries, after, self.shared.bounds.poll)).await;
                    }
                    Some(_) | None => return Err(self.fail(step, error.code()).await),
                },
            }
        }
    }

    /// As [`Self::retrying`], but `Ok(None)` when the backend answers `halt`.
    async fn retrying_until<T, F, Fut>(
        &self,
        step: Step,
        halt: AgentErrorCode,
        attempt: F,
    ) -> Outcome<Option<T>>
    where
        F: Fn() -> Fut,
        Fut: Future<Output = Result<T, process::Error>>,
    {
        self.retrying(step, || async {
            match attempt().await {
                Ok(value) => Ok(Some(value)),
                Err(error) if error.agent_code() == Some(halt) => Ok(None),
                Err(error) => Err(error),
            }
        })
        .await
    }
}

/// The pause before retry `tries`: the backend's delay, or the poll interval doubled per try,
/// whichever is longer, at most [`MAX_BACKOFF`].
fn backoff(tries: u32, asked: Duration, poll: Duration) -> Duration {
    let doubled = poll.saturating_mul(2_u32.saturating_pow(tries.saturating_sub(1)));
    asked.max(doubled).min(MAX_BACKOFF)
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
    use super::*;

    #[test]
    fn a_landing_pairs_with_one_its_base_lacked() {
        let start = Instant::now();
        let later = |ms| start + Duration::from_millis(ms);
        let mut landings = Landings::default();
        // A lands at 10; B was based at 5 and lands at 20: its fork lacked A's change.
        assert_eq!(landings.record("clm_aaaaaa", "f", start, later(10)), None);
        assert_eq!(
            landings.record("clm_bbbbbb", "f", later(5), later(20)),
            Some("clm_aaaaaa".to_owned())
        );
        // C was based at 25, after both landed: nothing to merge.
        assert_eq!(
            landings.record("clm_cccccc", "f", later(25), later(30)),
            None
        );
        // Another path never pairs.
        assert_eq!(landings.record("clm_dddddd", "g", start, later(40)), None);
        // A redo landing of the same claim never pairs with itself.
        assert_eq!(landings.record("clm_dddddd", "g", start, later(50)), None);
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
        // Gone from the status: merged or expired, the agent cannot tell.
        assert_eq!(judge(None), Polled::Closed("closed_unknown"));
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
        assert_eq!(backoff(1, Duration::from_secs(600), poll), MAX_BACKOFF);
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
}
