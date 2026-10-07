//! The repository event log, as `@railhead/shared/events` defines it.
//!
//! [`decode_event`] reads one event and refuses it unless `validateEvent` in TypeScript would
//! accept it. Text fields carry untrusted agent or person input: render them as inert text.

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::integer::SafeInteger;
pub use crate::payloads::*;
use crate::rules::{IdKind, require_id, require_positive};

/// The newest event schema version this crate reads. It reads every version from 1 to this; any
/// other version is refused, never guessed at.
pub const EVENT_SCHEMA_VERSION: u64 = 3;

/// True when this crate reads events of schema version `v`.
#[must_use]
pub const fn is_readable_version(v: u64) -> bool {
    v >= 1 && v <= EVENT_SCHEMA_VERSION
}

/// Who recorded an event, as authenticated by the backend.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Actor {
    /// A person, by `usr_` identifier.
    Human {
        /// The `usr_` identifier.
        id: String,
    },
    /// An agent, by `agt_` identifier.
    Agent {
        /// The `agt_` identifier.
        id: String,
    },
    /// A system component, by `sys_` identifier.
    System {
        /// The `sys_` identifier.
        id: String,
    },
}

/// A decision at one version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRef {
    /// The `dec_` decision.
    pub decision_id: String,
    /// Its version, counting from 1.
    pub version: SafeInteger,
}

/// One answer a question offers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    /// Stable key within the question, such as `reject`.
    pub key: String,
    /// The label shown to the person deciding. Untrusted text.
    pub label: String,
}

/// Why a claim's action was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefusalReason {
    /// The caller's ownership generation is older than the claim's current one.
    StaleGeneration,
    /// The claim was already marked ready, so its commit is pinned.
    AfterReady,
    /// A decision affecting the claim has not been acknowledged.
    UnackedDecision,
}

/// Why a ready or merged claim went back to working: the system decided its pinned work must be
/// redone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReopenReason {
    /// The pin lost a conflict on the train and must be redone on the new base.
    LostConflict,
    /// A decision version recorded after ready superseded the versions the pin was recorded under.
    DecisionSuperseded,
    /// The train's check failed on the pin.
    CheckFailed,
}

impl ReopenReason {
    /// The reason of a schema version 1 `claim.reopened` that has none: it was recorded before
    /// reasons existed, when a superseded decision was the only cause.
    pub const BEFORE_REASONS: Self = Self::DecisionSuperseded;

    pub(crate) const fn before_reasons() -> Self {
        Self::BEFORE_REASONS
    }
}

/// What an inbox entry asks of the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InboxEntry {
    /// A decision in the claim's scope was recorded or superseded.
    Decision {
        /// The decision version.
        decision: DecisionRef,
    },
    /// Work that relied on an older decision version must be redone.
    Rework {
        /// The decision version to redo the work against.
        decision: DecisionRef,
    },
    /// The claim's change overlaps another and must be redone on the new base.
    Conflict {
        /// The `clm_` claim it overlaps.
        other_claim_id: String,
        /// The repository path both changed.
        path: String,
    },
}

/// The outcome of one check run. `Error` means the check could not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CheckResult {
    /// The check passed.
    Pass,
    /// The check failed.
    Fail,
    /// The check could not run.
    Error,
}

/// Why a check attempt ended without a report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnreportedOutcome {
    /// The attempt's deadline passed before the runner reported, so the train failed its batch.
    TimedOut,
}

/// Why the train stopped keeping a held attempt for an approval.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HeldExpiryReason {
    /// It waited longer than the train keeps a held attempt.
    TimedOut,
    /// Newer held attempts in the repository filled the train's bound, and it was the oldest.
    OverLimit,
}

/// The classification of a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictClass {
    /// Both changes can stand.
    Compatible,
    /// The changes contradict each other.
    Contradictory,
}

/// Where the train sent a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictRoute {
    /// The losing claim's agent redoes its change on the new base.
    Redo,
    /// The pair is parked and a person is asked.
    Question,
}

/// The result of one attempt to move main.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MainOutcome {
    /// Main moved from the expected commit to the candidate.
    Updated,
    /// Main was no longer at the expected commit, so nothing changed.
    Rejected,
    /// The push result was uncertain; main was read back and the intent marked accordingly.
    Reconciled,
}

/// The decision option an acceptance check proves.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Acceptance {
    /// The decision version.
    pub decision: DecisionRef,
    /// The option key the check proves.
    pub option: String,
}

/// Every fact the log records, tagged by `type` with its payload under `data`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum EventPayload {
    /// A person invited an agent.
    #[serde(rename = "agent.invited")]
    AgentInvited(AgentInvited),
    /// An agent joined with an invite and registered its key.
    #[serde(rename = "agent.joined")]
    AgentJoined(AgentJoined),
    /// The owner confirmed an agent.
    #[serde(rename = "agent.confirmed")]
    AgentConfirmed(AgentRef),
    /// The owner revoked an agent.
    #[serde(rename = "agent.revoked")]
    AgentRevoked(AgentRef),
    /// An issue was filed.
    #[serde(rename = "issue.filed")]
    IssueFiled(IssueFiled),
    /// A claim was opened on an issue.
    #[serde(rename = "claim.opened")]
    ClaimOpened(ClaimOpened),
    /// A push to a claim's fork moved a ref.
    #[serde(rename = "claim.pushed")]
    ClaimPushed(ClaimPushed),
    /// A claim pinned a commit for the train.
    #[serde(rename = "claim.ready")]
    ClaimReady(ClaimReady),
    /// A claim's action was refused.
    #[serde(rename = "claim.refused")]
    ClaimRefused(ClaimRefused),
    /// The system decided a ready or merged claim's pinned work must be redone, so it is working
    /// again.
    #[serde(rename = "claim.reopened")]
    ClaimReopened(ClaimReopened),
    /// The train landed a claim's pin and the claim closed.
    #[serde(rename = "claim.merged")]
    ClaimMerged(ClaimMerged),
    /// A claim's lease ended.
    #[serde(rename = "claim.expired")]
    ClaimExpired(ClaimExpired),
    /// A claim's holder gave it up.
    #[serde(rename = "claim.released")]
    ClaimReleased(ClaimReleased),
    /// A claim moved to another agent.
    #[serde(rename = "claim.reassigned")]
    ClaimReassigned(ClaimReassigned),
    /// A claim's landed work passed the acceptance check of a decision version it depended on.
    #[serde(rename = "claim.adapted")]
    ClaimAdapted(ClaimAdapted),
    /// A question was put to the owner, by an agent or by a system module.
    #[serde(rename = "question.asked")]
    QuestionAsked(QuestionAsked),
    /// A person recorded a decision version.
    #[serde(rename = "decision.recorded")]
    DecisionRecorded(DecisionRecorded),
    /// An item was queued in an agent's inbox.
    #[serde(rename = "inbox.queued")]
    InboxQueued(InboxQueued),
    /// An inbox item reached its agent.
    #[serde(rename = "inbox.delivered")]
    InboxDelivered(InboxDelivered),
    /// An agent acknowledged an inbox item with a plan.
    #[serde(rename = "inbox.acked")]
    InboxAcked(InboxAcked),
    /// The train ran a check on a candidate.
    #[serde(rename = "train.check")]
    TrainCheck(TrainCheck),
    /// The train found two claims changing the same path.
    #[serde(rename = "train.conflict")]
    TrainConflict(TrainConflict),
    /// The train recorded its intent to move main.
    #[serde(rename = "train.intent")]
    TrainIntent(TrainIntent),
    /// The result of an attempt to move main.
    #[serde(rename = "train.main")]
    TrainMain(TrainMain),
    /// A candidate edits protected check paths; its attempt waits for a person.
    #[serde(rename = "train.held")]
    TrainHeld(TrainHeld),
    /// A person approved running a held candidate's own definition.
    #[serde(rename = "check.approved")]
    CheckApproved(CheckApproved),
    /// A check attempt ended without a report.
    #[serde(rename = "train.unreported")]
    TrainUnreported(TrainUnreported),
    /// The train stopped keeping a held attempt nobody approved.
    #[serde(rename = "train.held_expired")]
    TrainHeldExpired(TrainHeldExpired),
}

/// Who may record an event type: `HUMAN_ONLY_EVENTS`, `AGENT_ONLY_EVENTS`, `SYSTEM_ONLY_EVENTS`.
enum Recorder {
    Person,
    Agent,
    System,
    Anyone,
}

impl EventPayload {
    /// The event's wire type, such as `claim.opened`.
    #[must_use]
    pub const fn type_name(&self) -> &'static str {
        match self {
            Self::AgentInvited(_) => "agent.invited",
            Self::AgentJoined(_) => "agent.joined",
            Self::AgentConfirmed(_) => "agent.confirmed",
            Self::AgentRevoked(_) => "agent.revoked",
            Self::IssueFiled(_) => "issue.filed",
            Self::ClaimOpened(_) => "claim.opened",
            Self::ClaimPushed(_) => "claim.pushed",
            Self::ClaimReady(_) => "claim.ready",
            Self::ClaimRefused(_) => "claim.refused",
            Self::ClaimReopened(_) => "claim.reopened",
            Self::ClaimMerged(_) => "claim.merged",
            Self::ClaimExpired(_) => "claim.expired",
            Self::ClaimReleased(_) => "claim.released",
            Self::ClaimReassigned(_) => "claim.reassigned",
            Self::ClaimAdapted(_) => "claim.adapted",
            Self::QuestionAsked(_) => "question.asked",
            Self::DecisionRecorded(_) => "decision.recorded",
            Self::InboxQueued(_) => "inbox.queued",
            Self::InboxDelivered(_) => "inbox.delivered",
            Self::InboxAcked(_) => "inbox.acked",
            Self::TrainCheck(_) => "train.check",
            Self::TrainConflict(_) => "train.conflict",
            Self::TrainIntent(_) => "train.intent",
            Self::TrainMain(_) => "train.main",
            Self::TrainHeld(_) => "train.held",
            Self::CheckApproved(_) => "check.approved",
            Self::TrainUnreported(_) => "train.unreported",
            Self::TrainHeldExpired(_) => "train.held_expired",
        }
    }

    /// The schema version an event of this type is written at: the version that introduced the
    /// type, so an older reader refuses a newer type by its version rather than by its shape.
    #[must_use]
    pub const fn schema_version(&self) -> u64 {
        match self {
            Self::AgentInvited(_)
            | Self::AgentJoined(_)
            | Self::AgentConfirmed(_)
            | Self::AgentRevoked(_)
            | Self::IssueFiled(_)
            | Self::ClaimOpened(_)
            | Self::ClaimPushed(_)
            | Self::ClaimReady(_)
            | Self::ClaimRefused(_)
            | Self::ClaimReopened(_)
            | Self::ClaimExpired(_)
            | Self::ClaimReassigned(_)
            | Self::ClaimAdapted(_)
            | Self::QuestionAsked(_)
            | Self::DecisionRecorded(_)
            | Self::InboxQueued(_)
            | Self::InboxDelivered(_)
            | Self::InboxAcked(_)
            | Self::TrainCheck(_)
            | Self::TrainConflict(_)
            | Self::TrainIntent(_)
            | Self::TrainMain(_) => 1,
            Self::TrainHeld(_)
            | Self::CheckApproved(_)
            | Self::TrainUnreported(_)
            | Self::ClaimMerged(_)
            | Self::ClaimReleased(_) => 2,
            Self::TrainHeldExpired(_) => 3,
        }
    }

    const fn recorder(&self) -> Recorder {
        match self {
            Self::AgentInvited(_)
            | Self::AgentConfirmed(_)
            | Self::AgentRevoked(_)
            | Self::DecisionRecorded(_)
            | Self::CheckApproved(_) => Recorder::Person,
            Self::InboxAcked(_) | Self::ClaimReleased(_) => Recorder::Agent,
            Self::AgentJoined(_)
            | Self::ClaimRefused(_)
            | Self::ClaimReopened(_)
            | Self::ClaimMerged(_)
            | Self::ClaimExpired(_)
            | Self::ClaimReassigned(_)
            | Self::ClaimAdapted(_)
            | Self::InboxQueued(_)
            | Self::InboxDelivered(_)
            | Self::TrainCheck(_)
            | Self::TrainConflict(_)
            | Self::TrainIntent(_)
            | Self::TrainMain(_)
            | Self::TrainHeld(_)
            | Self::TrainUnreported(_)
            | Self::TrainHeldExpired(_) => Recorder::System,
            Self::IssueFiled(_)
            | Self::ClaimOpened(_)
            | Self::ClaimPushed(_)
            | Self::ClaimReady(_)
            | Self::QuestionAsked(_) => Recorder::Anyone,
        }
    }

    /// The agent an agent actor must be when it records this event: it can open a claim only for
    /// itself and acknowledge only its own inbox items. A person may still open a claim for one.
    fn subject_agent(&self) -> Option<&str> {
        match self {
            Self::ClaimOpened(ClaimOpened { agent_id, .. })
            | Self::InboxAcked(InboxAcked { agent_id, .. }) => Some(agent_id),
            Self::AgentInvited(_)
            | Self::AgentJoined(_)
            | Self::AgentConfirmed(_)
            | Self::AgentRevoked(_)
            | Self::IssueFiled(_)
            | Self::ClaimPushed(_)
            | Self::ClaimReady(_)
            | Self::ClaimRefused(_)
            | Self::ClaimReopened(_)
            | Self::ClaimMerged(_)
            | Self::ClaimExpired(_)
            | Self::ClaimReleased(_)
            | Self::ClaimReassigned(_)
            | Self::ClaimAdapted(_)
            | Self::QuestionAsked(_)
            | Self::DecisionRecorded(_)
            | Self::InboxQueued(_)
            | Self::InboxDelivered(_)
            | Self::TrainCheck(_)
            | Self::TrainConflict(_)
            | Self::TrainIntent(_)
            | Self::TrainMain(_)
            | Self::TrainHeld(_)
            | Self::CheckApproved(_)
            | Self::TrainUnreported(_)
            | Self::TrainHeldExpired(_) => None,
        }
    }

    fn validate(&self) -> Result<()> {
        match self {
            Self::AgentInvited(data) => data.validate(),
            Self::AgentJoined(data) => data.validate(),
            Self::AgentConfirmed(data) | Self::AgentRevoked(data) => data.validate(),
            Self::IssueFiled(data) => data.validate(),
            Self::ClaimOpened(data) => data.validate(),
            Self::ClaimPushed(data) => data.validate(),
            Self::ClaimReady(data) => data.validate(),
            Self::ClaimRefused(data) => data.validate(),
            Self::ClaimReopened(data) => data.validate(),
            Self::ClaimMerged(data) => data.validate(),
            Self::ClaimExpired(data) => data.validate(),
            Self::ClaimReleased(data) => data.validate(),
            Self::ClaimReassigned(data) => data.validate(),
            Self::ClaimAdapted(data) => data.validate(),
            Self::QuestionAsked(data) => data.validate(),
            Self::DecisionRecorded(data) => data.validate(),
            Self::InboxQueued(data) => data.validate(),
            Self::InboxDelivered(data) => data.validate(),
            Self::InboxAcked(data) => data.validate(),
            Self::TrainCheck(data) => data.validate(),
            Self::TrainConflict(data) => data.validate(),
            Self::TrainIntent(data) => data.validate(),
            Self::TrainMain(data) => data.validate(),
            Self::TrainHeld(data) => data.validate(),
            Self::CheckApproved(data) => data.validate(),
            Self::TrainUnreported(data) => data.validate(),
            Self::TrainHeldExpired(data) => data.validate(),
        }
    }
}

/// One entry in a repository's log.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Event {
    /// The schema version, the payload's [`EventPayload::schema_version`] after decoding.
    pub v: u64,
    /// Position in the repository's log, counting from 1.
    pub seq: SafeInteger,
    /// When it was recorded, in milliseconds since the Unix epoch.
    pub at: SafeInteger,
    /// The `rep_` repository whose log this is.
    pub repo: String,
    /// Who caused it.
    pub actor: Actor,
    /// The type and its payload.
    #[serde(flatten)]
    pub payload: EventPayload,
}

/// Only the version, read before the rest so a newer event is refused for its version and not
/// for a shape this crate does not know.
#[derive(Deserialize)]
struct VersionProbe {
    v: u64,
}

/// Decodes one event from JSON and checks it by the rules of `validateEvent`.
///
/// Unknown fields are ignored and dropped. A missing field, a `null` where none is allowed, an
/// unknown `type`, `kind` or enum value, and an integer above [`crate::MAX_SAFE_INTEGER`] are
/// shape errors.
///
/// # Errors
///
/// [`Error::UnsupportedVersion`] for a `v` outside 1 to [`EVENT_SCHEMA_VERSION`], checked first;
/// [`Error::Json`] for a shape error; [`Error::Invalid`] on `v` when it is not the version the
/// event's type is written at; and the other variants for the first rule the event breaks.
///
/// ```
/// let json = r#"{"v":1,"seq":1,"at":1700000000000,"repo":"rep_abc123",
///     "actor":{"kind":"human","id":"usr_abc123"},"type":"agent.revoked",
///     "data":{"agentId":"agt_abc123"}}"#;
/// let event = railhead_protocol::decode_event(json)?;
/// assert_eq!(event.payload.type_name(), "agent.revoked");
/// # Ok::<(), railhead_protocol::Error>(())
/// ```
pub fn decode_event(json: &str) -> Result<Event> {
    let VersionProbe { v } = serde_json::from_str(json)?;
    if !is_readable_version(v) {
        return Err(Error::UnsupportedVersion(v));
    }
    let event: Event = serde_json::from_str(json)?;
    event.validate()?;
    Ok(event)
}

impl Event {
    /// Checks the rules `validateEvent` checks: version, integer ranges, identifier and commit
    /// formats, size caps, and which actor may record which fact.
    ///
    /// # Errors
    ///
    /// The first rule the event breaks; see [`decode_event`].
    pub fn validate(&self) -> Result<()> {
        if !is_readable_version(self.v) {
            return Err(Error::UnsupportedVersion(self.v));
        }
        if self.v != self.payload.schema_version() {
            return Err(Error::Invalid {
                field: "v",
                expected: "the schema version its type is written at",
            });
        }
        require_positive(self.seq, "seq")?;
        require_positive(self.at, "at")?;
        require_id(IdKind::Repo, &self.repo, "repo")?;
        self.validate_actor()?;
        self.payload.validate()
    }

    fn validate_actor(&self) -> Result<()> {
        let event_type = self.payload.type_name();
        match &self.actor {
            Actor::Human { id } => require_id(IdKind::User, id, "actor.id")?,
            Actor::Agent { id } => require_id(IdKind::Agent, id, "actor.id")?,
            Actor::System { id } => require_id(IdKind::System, id, "actor.id")?,
        }
        let required = match (self.payload.recorder(), &self.actor) {
            (Recorder::Anyone, _)
            | (Recorder::Person, Actor::Human { .. })
            | (Recorder::Agent, Actor::Agent { .. })
            | (Recorder::System, Actor::System { .. }) => None,
            (Recorder::Person, Actor::Agent { .. } | Actor::System { .. }) => Some("a person"),
            (Recorder::Agent, Actor::Human { .. } | Actor::System { .. }) => {
                Some("the agent itself")
            }
            (Recorder::System, Actor::Human { .. } | Actor::Agent { .. }) => Some("the system"),
        };
        if let Some(required) = required {
            return Err(Error::WrongActor {
                event_type,
                required,
            });
        }
        match (&self.actor, self.payload.subject_agent()) {
            (Actor::Agent { id }, Some(subject)) if id != subject => {
                Err(Error::ActorNotSubject { event_type })
            }
            (Actor::Agent { .. } | Actor::Human { .. } | Actor::System { .. }, _) => Ok(()),
        }
    }
}
