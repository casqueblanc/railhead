//! The agent wire: the HTTP JSON protocol between the `rh` CLI and the backend, version 1, as
//! `@railhead/shared/agent-api` defines it.
//!
//! Requests serialize to the bodies the backend accepts, and each request type's `validate`
//! applies the rules of `validateAgentRequest` before it is sent. Responses decode through
//! [`AgentResponse`], which refuses a missing field, an omitted `null`, an unknown tag or error
//! code, and an integer above [`crate::MAX_SAFE_INTEGER`]. Unknown fields are ignored and dropped.
//! Every text field in a response is untrusted: render it as inert text.

use std::fmt;

use serde::de::{DeserializeOwned, Error as _};
use serde::ser::SerializeStruct;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::error::Result;
use crate::events::{InboxEntry, QuestionOption};
use crate::integer::{SafeInteger, nullable};
use crate::payloads::require_options;
use crate::rules::{
    IdKind, MAX_PLAN_LENGTH, MAX_QUESTION_LENGTH, is_armored_signature, is_challenge_id,
    is_commit_sha, is_ed25519_public_key, is_invite_secret, is_request_id, require, require_id,
    require_positive, require_text,
};

/// The agent protocol version, the `v1` in every route path.
pub const AGENT_PROTOCOL_VERSION: u64 = 1;
/// Path prefix of every agent route: `/agent/v1/{org}/{repo}/...`.
pub const AGENT_PATH_PREFIX: &str = "/agent/v1";
/// The only request content type the agent routes accept for a body.
pub const AGENT_REQUEST_CONTENT_TYPE: &str = "application/json";
/// Largest request body the backend reads, in bytes.
pub const MAX_AGENT_REQUEST_BYTES: usize = 16 * 1024;
/// Largest response body the CLI accepts, in bytes.
pub const MAX_AGENT_RESPONSE_BYTES: usize = 1024 * 1024;
/// How long the CLI waits for one response, in milliseconds.
pub const AGENT_REQUEST_TIMEOUT_MS: u64 = 30_000;
/// Longest a question long-poll holds a request open, in milliseconds.
pub const MAX_LONG_POLL_MS: u64 = 25_000;
/// Largest inbox page a sync returns.
pub const MAX_INBOX_PAGE: u64 = 64;
/// Inbox page size when the request does not name one.
pub const DEFAULT_INBOX_PAGE: u64 = 16;
/// Most inbox items piggybacked on one command result.
pub const MAX_PIGGYBACK_ITEMS: usize = 8;
/// Largest session token the CLI stores or sends, in characters.
pub const MAX_SESSION_TOKEN_LENGTH: usize = 4096;

// =======================================================================================
// Routes

/// An HTTP method an agent route uses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    /// `GET`, a read with no body.
    Get,
    /// `POST`, with a JSON body or none.
    Post,
}

impl Method {
    /// The method's name, as HTTP writes it.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

/// One agent route, version 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AgentRoute {
    /// Register a key with an invite.
    Join,
    /// Ask for a login challenge.
    Challenge,
    /// Redeem a signed challenge for a session token.
    Session,
    /// The calling agent and its claim.
    Status,
    /// Claim the next ready issue.
    Work,
    /// Claim a named issue.
    Claim,
    /// Pin a commit for the train.
    Ready,
    /// Unacknowledged inbox items.
    Inbox,
    /// Acknowledge one inbox item.
    Ack,
    /// Ask the owner a question.
    Ask,
    /// Read or long-poll a question.
    Question,
}

impl AgentRoute {
    /// Every route, in the order of the route table.
    pub const ALL: [Self; 11] = [
        Self::Join,
        Self::Challenge,
        Self::Session,
        Self::Status,
        Self::Work,
        Self::Claim,
        Self::Ready,
        Self::Inbox,
        Self::Ack,
        Self::Ask,
        Self::Question,
    ];

    /// The route's name in the route table, such as `ready`.
    #[must_use]
    pub const fn name(self) -> &'static str {
        match self {
            Self::Join => "join",
            Self::Challenge => "challenge",
            Self::Session => "session",
            Self::Status => "status",
            Self::Work => "work",
            Self::Claim => "claim",
            Self::Ready => "ready",
            Self::Inbox => "inbox",
            Self::Ack => "ack",
            Self::Ask => "ask",
            Self::Question => "question",
        }
    }

    /// The route's HTTP method.
    #[must_use]
    pub const fn method(self) -> Method {
        match self {
            Self::Status | Self::Inbox | Self::Question => Method::Get,
            Self::Join
            | Self::Challenge
            | Self::Session
            | Self::Work
            | Self::Claim
            | Self::Ready
            | Self::Ack
            | Self::Ask => Method::Post,
        }
    }

    /// The path after `/agent/v1/{org}/{repo}`, with `{name}` placeholders.
    #[must_use]
    pub const fn path(self) -> &'static str {
        match self {
            Self::Join => "/join",
            Self::Challenge => "/session/challenge",
            Self::Session => "/session",
            Self::Status => "/status",
            Self::Work => "/work",
            Self::Claim => "/claims",
            Self::Ready => "/claims/{claimId}/ready",
            Self::Inbox => "/inbox",
            Self::Ack => "/inbox/{item}/ack",
            Self::Ask => "/claims/{claimId}/questions",
            Self::Question => "/questions/{questionId}",
        }
    }

    /// True when the route needs `Authorization: Bearer <session token>`.
    #[must_use]
    pub const fn needs_session(self) -> bool {
        match self {
            Self::Join | Self::Challenge | Self::Session => false,
            Self::Status
            | Self::Work
            | Self::Claim
            | Self::Ready
            | Self::Inbox
            | Self::Ack
            | Self::Ask
            | Self::Question => true,
        }
    }

    /// True when the route takes a JSON body. `work` is a `POST` without one.
    #[must_use]
    pub const fn has_body(self) -> bool {
        match self {
            Self::Join
            | Self::Challenge
            | Self::Session
            | Self::Claim
            | Self::Ready
            | Self::Ack
            | Self::Ask => true,
            Self::Status | Self::Work | Self::Inbox | Self::Question => false,
        }
    }
}

impl fmt::Display for AgentRoute {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

// =======================================================================================
// Errors

/// A command the CLI can suggest, named without the `rh` prefix.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NextCommand {
    /// `rh join`.
    Join,
    /// `rh work`.
    Work,
    /// `rh claim`.
    Claim,
    /// `rh sync`.
    Sync,
    /// `rh ack`.
    Ack,
    /// `rh ask`.
    Ask,
    /// `rh ready`.
    Ready,
    /// `rh status`.
    Status,
}

/// Every error code the agent routes return. An unknown code is a decode error.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentErrorCode {
    /// The request is malformed.
    InvalidRequest,
    /// The body is not `application/json`.
    UnsupportedMediaType,
    /// The body is larger than the backend reads.
    PayloadTooLarge,
    /// The named object does not exist or is not the caller's.
    NotFound,
    /// Too many requests.
    RateLimited,
    /// The join failed; nothing more is said.
    JoinRefused,
    /// The challenge is unknown, expired, redeemed or wrongly signed.
    ChallengeInvalid,
    /// The session token is missing, expired or invalid.
    Unauthenticated,
    /// The owner has not confirmed the agent yet.
    IdentityPending,
    /// The owner revoked the agent.
    IdentityRevoked,
    /// The agent used up a quota.
    QuotaExceeded,
    /// No issue is ready.
    NoWork,
    /// The agent already holds an active claim.
    ClaimExists,
    /// The issue is claimed or closed.
    IssueUnavailable,
    /// The claim is closed.
    ClaimClosed,
    /// The claim moved to a newer generation.
    StaleGeneration,
    /// The claim is already ready at another commit.
    AfterReady,
    /// A decision affecting the claim is not acknowledged.
    UnackedDecision,
    /// The fork has no such commit.
    CommitNotFound,
    /// An idempotency key was reused with a different request.
    IdempotencyMismatch,
    /// The backend is busy; retry.
    Busy,
    /// A backend module is not installed.
    Unavailable,
    /// The backend failed.
    Internal,
}

/// The fixed HTTP status and retry advice of one error code, as `AGENT_ERRORS` defines them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentErrorSpec {
    /// The HTTP status sent with the code.
    pub status: u16,
    /// Whether repeating the same request may succeed.
    pub retryable: bool,
    /// The command the CLI suggests next.
    pub next: Option<NextCommand>,
}

impl AgentErrorCode {
    /// The code's fixed status and retry advice.
    #[must_use]
    pub const fn spec(self) -> AgentErrorSpec {
        const fn spec(status: u16, retryable: bool, next: Option<NextCommand>) -> AgentErrorSpec {
            AgentErrorSpec {
                status,
                retryable,
                next,
            }
        }
        match self {
            Self::InvalidRequest => spec(400, false, None),
            Self::UnsupportedMediaType => spec(415, false, None),
            Self::PayloadTooLarge => spec(413, false, None),
            Self::NotFound => spec(404, false, Some(NextCommand::Status)),
            Self::RateLimited => spec(429, true, None),
            Self::ChallengeInvalid | Self::Unauthenticated => spec(401, false, None),
            Self::IdentityPending => spec(403, true, Some(NextCommand::Join)),
            Self::JoinRefused | Self::IdentityRevoked => spec(403, false, None),
            Self::QuotaExceeded => spec(429, false, Some(NextCommand::Status)),
            Self::NoWork => spec(409, true, Some(NextCommand::Work)),
            Self::ClaimExists | Self::StaleGeneration | Self::AfterReady => {
                spec(409, false, Some(NextCommand::Status))
            }
            Self::IssueUnavailable | Self::ClaimClosed => spec(409, false, Some(NextCommand::Work)),
            Self::UnackedDecision => spec(409, false, Some(NextCommand::Sync)),
            Self::CommitNotFound => spec(422, false, None),
            Self::IdempotencyMismatch => spec(409, false, None),
            Self::Busy => spec(503, true, None),
            Self::Unavailable => spec(503, false, None),
            Self::Internal => spec(500, true, None),
        }
    }
}

/// The body of every error response.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentError {
    /// What went wrong.
    pub code: AgentErrorCode,
    /// One sentence for the agent, written by the backend.
    pub message: String,
    /// Whether repeating the same request may succeed.
    pub retryable: bool,
    /// How long to wait before a retry, in milliseconds, or `None` for no advice.
    #[serde(deserialize_with = "nullable")]
    pub retry_after_ms: Option<SafeInteger>,
    /// The command to run next.
    #[serde(deserialize_with = "nullable")]
    pub next: Option<NextCommand>,
}

// =======================================================================================
// Envelopes

/// Unacknowledged inbox items carried on a command result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxDigest {
    /// The oldest unacknowledged items, at most [`MAX_PIGGYBACK_ITEMS`], in item order.
    pub items: Vec<InboxItem>,
    /// How many unacknowledged items exist in total.
    pub pending: SafeInteger,
}

/// A successful response.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSuccess<T> {
    /// The route's result.
    pub data: T,
    /// Pending inbox items, or `None` on `join`, `challenge` and `session`.
    #[serde(deserialize_with = "nullable")]
    pub inbox: Option<InboxDigest>,
    /// The command to run next.
    #[serde(deserialize_with = "nullable")]
    pub next: Option<NextCommand>,
}

/// Every agent response body: `{"ok": true, "data", "inbox", "next"}` or
/// `{"ok": false, "error"}`.
///
/// ```
/// use railhead_protocol::{AgentErrorCode, AgentResponse, ChallengeResult};
///
/// let json = r#"{"ok":false,"error":{"code":"rate_limited","message":"Slow down.",
///     "retryable":true,"retryAfterMs":1000,"next":null}}"#;
/// let response: AgentResponse<ChallengeResult> = serde_json::from_str(json)?;
/// let AgentResponse::Failure(error) = response else { return Ok(()) };
/// assert_eq!(error.code, AgentErrorCode::RateLimited);
/// # Ok::<(), serde_json::Error>(())
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AgentResponse<T> {
    /// `ok: true`.
    Success(AgentSuccess<T>),
    /// `ok: false`.
    Failure(AgentError),
}

/// The fields of a failure besides `ok`.
#[derive(Deserialize)]
struct FailureBody {
    error: AgentError,
}

/// Decodes one agent response body as `AgentResponse<T>`.
///
/// Prefer this to `serde_json::from_str`: the returned error keeps only the position, never text
/// from the untrusted body.
///
/// # Errors
///
/// [`crate::Error::Json`] when the body is not a response of this shape.
pub fn decode_response<T: DeserializeOwned>(json: &str) -> Result<AgentResponse<T>> {
    Ok(serde_json::from_str(json)?)
}

impl<'de, T: DeserializeOwned> Deserialize<'de> for AgentResponse<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        // The `ok` flag picks the shape, so the body is read once into a value and decoded from it.
        let value = serde_json::Value::deserialize(deserializer)?;
        match value.get("ok") {
            Some(serde_json::Value::Bool(true)) => AgentSuccess::deserialize(value)
                .map(Self::Success)
                .map_err(D::Error::custom),
            Some(serde_json::Value::Bool(false)) => FailureBody::deserialize(value)
                .map(|body| Self::Failure(body.error))
                .map_err(D::Error::custom),
            Some(_) => Err(D::Error::custom("`ok` is not a boolean")),
            None => Err(D::Error::missing_field("ok")),
        }
    }
}

impl<T: Serialize> Serialize for AgentResponse<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            Self::Success(success) => {
                let mut body = serializer.serialize_struct("AgentSuccess", 4)?;
                body.serialize_field("ok", &true)?;
                body.serialize_field("data", &success.data)?;
                body.serialize_field("inbox", &success.inbox)?;
                body.serialize_field("next", &success.next)?;
                body.end()
            }
            Self::Failure(error) => {
                let mut body = serializer.serialize_struct("AgentFailure", 2)?;
                body.serialize_field("ok", &false)?;
                body.serialize_field("error", error)?;
                body.end()
            }
        }
    }
}

// =======================================================================================
// Shared views

/// Where an agent's enrollment stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EnrollmentState {
    /// Joined; waiting for the owner to confirm.
    Pending,
    /// Confirmed: the agent can log in.
    Confirmed,
}

/// An agent as it sees itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentView {
    /// The `agt_` agent.
    pub agent_id: String,
    /// Its display name.
    pub name: String,
    /// The `usr_` person who owns it.
    pub owner_id: String,
    /// Where its enrollment stands.
    pub state: EnrollmentState,
}

/// Where a claim stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaimState {
    /// The agent is working; pushes to the fork are accepted.
    Working,
    /// A commit is pinned and the fork is read only.
    Ready,
    /// The pinned commit landed on main.
    Merged,
    /// The lease ended and the claim waits for a replacement agent.
    Expired,
}

/// A claim's durable task: the issue's title and body. Untrusted text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    /// The issue's title.
    pub title: String,
    /// The issue's body.
    pub body: String,
}

/// A claim as its agent sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimView {
    /// The `clm_` claim.
    pub claim_id: String,
    /// The `iss_` issue it works on.
    pub issue_id: String,
    /// The ownership generation the agent must send back on claim calls.
    pub generation: SafeInteger,
    /// The main commit the fork was created from.
    pub base: String,
    /// Where the claim stands.
    pub state: ClaimState,
    /// The pinned commit once ready.
    #[serde(deserialize_with = "nullable")]
    pub ready_commit: Option<String>,
    /// Absolute URL of the claim's fork remote.
    pub origin_url: String,
    /// Absolute URL of the main repository remote, fetch only.
    pub upstream_url: String,
    /// The issue's title and body.
    pub task: Task,
}

/// A decision version as an agent's inbox shows it. Every text field is untrusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionView {
    /// The `dec_` decision.
    pub decision_id: String,
    /// This version, counting from 1.
    pub version: SafeInteger,
    /// The version this one replaces, or `None` for the first.
    #[serde(deserialize_with = "nullable")]
    pub supersedes: Option<SafeInteger>,
    /// The `qst_` question it answers.
    pub question_id: String,
    /// The question's text.
    pub question: String,
    /// The chosen option.
    pub option: QuestionOption,
    /// The option the replaced version chose, or `None` for the first.
    #[serde(deserialize_with = "nullable")]
    pub previous: Option<QuestionOption>,
    /// The repository paths it applies to.
    pub scope: Vec<String>,
    /// The `usr_` person who decided.
    pub decided_by: String,
    /// When it was recorded.
    pub decided_at: SafeInteger,
}

/// One inbox item.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxItem {
    /// The item number, unique per agent. `rh ack` names it.
    pub item: SafeInteger,
    /// The `clm_` claim it concerns.
    pub claim_id: String,
    /// When it was queued.
    pub queued_at: SafeInteger,
    /// What it asks of the agent.
    pub entry: InboxEntry,
    /// The decision version for `decision` and `rework` entries, otherwise `None`.
    #[serde(deserialize_with = "nullable")]
    pub decision: Option<DecisionView>,
}

// =======================================================================================
// Requests and results, route by route

/// `join`: register a key with an invite, or resume that registration. Its `invite_secret` is a
/// secret: `Debug` redacts it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinRequest {
    /// The `inv_` invite.
    pub invite_id: String,
    /// The invite's secret, from the invite URL's fragment.
    pub invite_secret: String,
    /// `ssh-ed25519 <base64 blob>`, with no comment.
    pub public_key: String,
    /// An armored SSHSIG over the join message.
    pub signature: String,
}

impl fmt::Debug for JoinRequest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JoinRequest")
            .field("invite_id", &self.invite_id)
            .field("invite_secret", &"<redacted>")
            .field("public_key", &self.public_key)
            .field("signature", &self.signature)
            .finish()
    }
}

impl JoinRequest {
    /// Checks the rules `validateAgentRequest` applies to a join.
    ///
    /// # Errors
    ///
    /// The first rule the request breaks.
    pub fn validate(&self) -> Result<()> {
        require_id(IdKind::Invite, &self.invite_id, "inviteId")?;
        require(
            is_invite_secret(&self.invite_secret),
            "inviteSecret",
            "an invite secret",
        )?;
        require(
            is_ed25519_public_key(&self.public_key),
            "publicKey",
            "an OpenSSH ssh-ed25519 public key",
        )?;
        require_signature(&self.signature)
    }
}

/// `join` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JoinResult {
    /// The agent the invite created.
    pub agent: AgentView,
    /// The six-digit code the owner matches on the board.
    pub code: String,
    /// When to ask again while pending, in milliseconds.
    pub poll_after_ms: SafeInteger,
}

/// `challenge`: ask for a login challenge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeRequest {
    /// The `agt_` agent that will sign it.
    pub agent_id: String,
}

impl ChallengeRequest {
    /// Checks the rules `validateAgentRequest` applies to a challenge request.
    ///
    /// # Errors
    ///
    /// [`crate::Error::InvalidId`] when `agentId` is not an agent identifier.
    pub fn validate(&self) -> Result<()> {
        require_id(IdKind::Agent, &self.agent_id, "agentId")
    }
}

/// `challenge` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeResult {
    /// The `chl_` challenge, single use.
    pub challenge_id: String,
    /// When it stops being redeemable.
    pub expires_at: SafeInteger,
    /// The login message as the server built it; the CLI compares it with its own.
    pub message: String,
}

/// `session`: redeem a signed challenge for a session token.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRequest {
    /// The `agt_` agent that signed.
    pub agent_id: String,
    /// The `chl_` challenge it signed.
    pub challenge_id: String,
    /// An armored SSHSIG over the challenge message.
    pub signature: String,
}

impl SessionRequest {
    /// Checks the rules `validateAgentRequest` applies to a session request.
    ///
    /// # Errors
    ///
    /// The first rule the request breaks.
    pub fn validate(&self) -> Result<()> {
        require_id(IdKind::Agent, &self.agent_id, "agentId")?;
        require(
            is_challenge_id(&self.challenge_id),
            "challengeId",
            "a challenge identifier",
        )?;
        require_signature(&self.signature)
    }
}

/// `session` result. Its `token` is a secret: never log or print it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionResult {
    /// The bearer token for every session route.
    pub token: String,
    /// When it expires.
    pub expires_at: SafeInteger,
    /// The agent it authenticates.
    pub agent: AgentView,
    /// The `rep_` repository it is bound to.
    pub repo_id: String,
}

impl fmt::Debug for SessionResult {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SessionResult")
            .field("token", &"<redacted>")
            .field("expires_at", &self.expires_at)
            .field("agent", &self.agent)
            .field("repo_id", &self.repo_id)
            .finish()
    }
}

/// `status` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusResult {
    /// The calling agent.
    pub agent: AgentView,
    /// Its active claim.
    #[serde(deserialize_with = "nullable")]
    pub claim: Option<ClaimView>,
}

/// `claim`: claim a named issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRequest {
    /// The `iss_` issue.
    pub issue_id: String,
}

impl ClaimRequest {
    /// Checks the rules `validateAgentRequest` applies to a claim request.
    ///
    /// # Errors
    ///
    /// [`crate::Error::InvalidId`] when `issueId` is not an issue identifier.
    pub fn validate(&self) -> Result<()> {
        require_id(IdKind::Issue, &self.issue_id, "issueId")
    }
}

/// `work` and `claim` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaimResult {
    /// The claim.
    pub claim: ClaimView,
    /// `true` when the agent already held this claim.
    pub resumed: bool,
}

/// `ready`: pin a commit for the train. The claim is in the path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyRequest {
    /// The ownership generation the agent last saw.
    pub generation: SafeInteger,
    /// The commit to pin.
    pub commit: String,
}

impl ReadyRequest {
    /// Checks the rules `validateAgentRequest` applies to a ready request.
    ///
    /// # Errors
    ///
    /// The first rule the request breaks.
    pub fn validate(&self) -> Result<()> {
        require_positive(self.generation, "generation")?;
        require(is_commit_sha(&self.commit), "commit", "a commit id")
    }
}

/// `ready` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyResult {
    /// The claim, now `ready` with its pinned commit.
    pub claim: ClaimView,
    /// `true` when this exact pin was already recorded.
    pub repeated: bool,
}

/// `inbox` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxResult {
    /// Unacknowledged items, oldest first.
    pub items: Vec<InboxItem>,
    /// How many unacknowledged items exist in total.
    pub pending: SafeInteger,
}

/// `ack`: acknowledge one item with a plan. The item is in the path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AckRequest {
    /// What the agent will change, or why the item does not apply.
    pub plan: String,
}

impl AckRequest {
    /// Checks the rules `validateAgentRequest` applies to an acknowledgement.
    ///
    /// # Errors
    ///
    /// [`crate::Error::Invalid`] when the plan is blank or longer than 4000 characters.
    pub fn validate(&self) -> Result<()> {
        require_text(
            &self.plan,
            MAX_PLAN_LENGTH,
            "plan",
            "a plan of 1 to 4000 characters",
        )
    }
}

/// `ack` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AckResult {
    /// The item.
    pub item: SafeInteger,
    /// The plan recorded with the first acknowledgement.
    pub plan: String,
    /// When it was first acknowledged.
    pub acked_at: SafeInteger,
    /// `true` when the item was already acknowledged.
    pub repeated: bool,
}

/// `ask`: ask the owner a question about the claim. The claim is in the path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AskRequest {
    /// The ownership generation the agent last saw.
    pub generation: SafeInteger,
    /// The `req_` idempotency key.
    pub request_id: String,
    /// The question.
    pub text: String,
    /// The answers offered.
    pub options: Vec<QuestionOption>,
}

impl AskRequest {
    /// Checks the rules `validateAgentRequest` applies to a question.
    ///
    /// # Errors
    ///
    /// The first rule the request breaks.
    pub fn validate(&self) -> Result<()> {
        require_positive(self.generation, "generation")?;
        require(
            is_request_id(&self.request_id),
            "requestId",
            "an idempotency key",
        )?;
        require_text(
            &self.text,
            MAX_QUESTION_LENGTH,
            "text",
            "a question of 1 to 2000 characters",
        )?;
        require_options(&self.options)
    }
}

/// Where a question stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionState {
    /// Not answered yet. A long poll that times out returns this.
    Open,
    /// Answered; the decision is attached.
    Answered,
}

/// `ask` and `question` result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionResult {
    /// The `qst_` question.
    pub question_id: String,
    /// The `dec_` decision its answer will record.
    pub decision_id: String,
    /// Where it stands.
    pub state: QuestionState,
    /// The current decision version once answered.
    #[serde(deserialize_with = "nullable")]
    pub decision: Option<DecisionView>,
}

fn require_signature(signature: &str) -> Result<()> {
    require(
        is_armored_signature(signature),
        "signature",
        "an armored SSH signature",
    )
}
