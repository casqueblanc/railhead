//! The payload of each event type and the rules `validateEvent` applies to it.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::events::{
    Acceptance, CheckResult, ConflictClass, ConflictRoute, DecisionRef, InboxEntry, MainOutcome,
    QuestionOption, RefusalReason,
};
use crate::integer::{SafeInteger, nullable};
use crate::rules::{
    IdKind, MAX_CHECK_NAME_LENGTH, MAX_ISSUE_BODY_LENGTH, MAX_OPTION_LABEL_LENGTH, MAX_OPTIONS,
    MAX_PLAN_LENGTH, MAX_QUESTION_LENGTH, MAX_TITLE_LENGTH, MIN_OPTIONS, require,
    require_agent_name, require_commit, require_id, require_key_fingerprint, require_length,
    require_list, require_option_key, require_path, require_positive, require_ref, require_text,
    require_unique,
};

/// `agent.invited`: a person invited an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInvited {
    /// The `inv_` invite.
    pub invite_id: String,
    /// The agent's display name.
    pub name: String,
}

impl AgentInvited {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Invite, &self.invite_id, "inviteId")?;
        require_agent_name(&self.name)
    }
}

/// `agent.joined`: an agent joined with an invite and registered its key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentJoined {
    /// The `agt_` agent the invite created.
    pub agent_id: String,
    /// The `inv_` invite.
    pub invite_id: String,
    /// The agent's display name.
    pub name: String,
    /// The OpenSSH SHA256 fingerprint of its key.
    pub key_fingerprint: String,
}

impl AgentJoined {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Agent, &self.agent_id, "agentId")?;
        require_id(IdKind::Invite, &self.invite_id, "inviteId")?;
        require_agent_name(&self.name)?;
        require_key_fingerprint(&self.key_fingerprint)
    }
}

/// `agent.confirmed` and `agent.revoked`: the owner confirmed or revoked an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    /// The `agt_` agent.
    pub agent_id: String,
}

impl AgentRef {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Agent, &self.agent_id, "agentId")
    }
}

/// `issue.filed`: an issue was filed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueFiled {
    /// The `iss_` issue.
    pub issue_id: String,
    /// Its title. Untrusted text.
    pub title: String,
    /// Its body, possibly empty. Untrusted text.
    pub body: String,
}

impl IssueFiled {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Issue, &self.issue_id, "issueId")?;
        require_text(
            &self.title,
            MAX_TITLE_LENGTH,
            "title",
            "a title of 1 to 256 characters",
        )?;
        require_length(
            &self.body,
            MAX_ISSUE_BODY_LENGTH,
            "body",
            "at most 16384 characters",
        )
    }
}

/// `claim.opened`: a claim was opened on an issue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimOpened {
    /// The `clm_` claim.
    pub claim_id: String,
    /// The `iss_` issue.
    pub issue_id: String,
    /// The `agt_` agent that holds it.
    pub agent_id: String,
    /// The ownership generation.
    pub generation: SafeInteger,
    /// The main commit the fork was created from.
    pub base: String,
}

impl ClaimOpened {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Claim, &self.claim_id, "claimId")?;
        require_id(IdKind::Issue, &self.issue_id, "issueId")?;
        require_id(IdKind::Agent, &self.agent_id, "agentId")?;
        require_positive(self.generation, "generation")?;
        require_commit(&self.base, "base")
    }
}

/// `claim.pushed`: a push to a claim's fork moved a ref.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimPushed {
    /// The `clm_` claim.
    pub claim_id: String,
    /// The ownership generation.
    pub generation: SafeInteger,
    /// The ref that moved.
    #[serde(rename = "ref")]
    pub git_ref: String,
    /// Its previous commit, or `None` when the push created it.
    #[serde(deserialize_with = "nullable")]
    pub from: Option<String>,
    /// Its new commit.
    pub to: String,
}

impl ClaimPushed {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Claim, &self.claim_id, "claimId")?;
        require_positive(self.generation, "generation")?;
        require_ref(&self.git_ref)?;
        if let Some(from) = &self.from {
            require_commit(from, "from")?;
        }
        require_commit(&self.to, "to")
    }
}

/// `claim.ready`: a claim pinned a commit for the train.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimReady {
    /// The `clm_` claim.
    pub claim_id: String,
    /// The ownership generation.
    pub generation: SafeInteger,
    /// The pinned commit.
    pub commit: String,
    /// The decision versions the work relied on.
    pub decisions: Vec<DecisionRef>,
}

impl ClaimReady {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Claim, &self.claim_id, "claimId")?;
        require_positive(self.generation, "generation")?;
        require_commit(&self.commit, "commit")?;
        require_decision_refs(&self.decisions)
    }
}

/// `claim.refused`: a claim's action was refused.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimRefused {
    /// The `clm_` claim.
    pub claim_id: String,
    /// The generation the refused action named.
    pub generation: SafeInteger,
    /// Why it was refused.
    pub reason: RefusalReason,
}

impl ClaimRefused {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Claim, &self.claim_id, "claimId")?;
        require_positive(self.generation, "generation")
    }
}

/// `claim.expired`: a claim's lease ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimExpired {
    /// The `clm_` claim.
    pub claim_id: String,
    /// The generation that expired.
    pub generation: SafeInteger,
}

impl ClaimExpired {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Claim, &self.claim_id, "claimId")?;
        require_positive(self.generation, "generation")
    }
}

/// `claim.reassigned`: a claim moved to another agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimReassigned {
    /// The `clm_` claim.
    pub claim_id: String,
    /// The `agt_` agent that held it.
    pub from: String,
    /// The `agt_` agent that holds it now.
    pub to: String,
    /// The new generation, at least 2.
    pub generation: SafeInteger,
}

impl ClaimReassigned {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Claim, &self.claim_id, "claimId")?;
        require_id(IdKind::Agent, &self.from, "from")?;
        require_id(IdKind::Agent, &self.to, "to")?;
        require(
            self.generation.get() >= 2,
            "generation",
            "at least 2 for a reassigned claim",
        )?;
        require(self.from != self.to, "to", "an agent other than the holder")
    }
}

/// `question.asked`: an agent asked the owner a question.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionAsked {
    /// The `qst_` question.
    pub question_id: String,
    /// The `clm_` claim it is about.
    pub claim_id: String,
    /// The `dec_` decision its answer records.
    pub decision_id: String,
    /// The question. Untrusted text.
    pub text: String,
    /// The answers offered.
    pub options: Vec<QuestionOption>,
}

impl QuestionAsked {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Question, &self.question_id, "questionId")?;
        require_id(IdKind::Claim, &self.claim_id, "claimId")?;
        require_id(IdKind::Decision, &self.decision_id, "decisionId")?;
        require_text(
            &self.text,
            MAX_QUESTION_LENGTH,
            "text",
            "a question of 1 to 2000 characters",
        )?;
        require_options(&self.options)
    }
}

/// `decision.recorded`: a person recorded a decision version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionRecorded {
    /// The `dec_` decision.
    pub decision_id: String,
    /// This version, counting from 1.
    pub version: SafeInteger,
    /// The `qst_` question it answers.
    pub question_id: String,
    /// The chosen option key.
    pub option: String,
    /// The version it replaces, or `None` for the first.
    #[serde(deserialize_with = "nullable")]
    pub supersedes: Option<SafeInteger>,
    /// The repository paths it applies to.
    pub scope: Vec<String>,
}

impl DecisionRecorded {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Decision, &self.decision_id, "decisionId")?;
        require_positive(self.version, "version")?;
        require_id(IdKind::Question, &self.question_id, "questionId")?;
        require_option_key(&self.option, "option")?;
        // The first version supersedes nothing; every later one supersedes the one before it.
        let previous = self.version.get().checked_sub(1).filter(|v| *v >= 1);
        require(
            self.supersedes.map(SafeInteger::get) == previous,
            "supersedes",
            "the previous version, or null for the first",
        )?;
        require_list(&self.scope, "scope")?;
        require(
            !self.scope.is_empty(),
            "scope",
            "a list of at least one path",
        )?;
        self.scope
            .iter()
            .try_for_each(|path| require_path(path, "scope"))
    }
}

/// `inbox.queued`: an item was queued in an agent's inbox.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxQueued {
    /// The `agt_` agent.
    pub agent_id: String,
    /// The `clm_` claim.
    pub claim_id: String,
    /// The item number.
    pub item: SafeInteger,
    /// What it asks of the agent.
    pub entry: InboxEntry,
}

impl InboxQueued {
    pub(crate) fn validate(&self) -> Result<()> {
        require_inbox_target(&self.agent_id, &self.claim_id, self.item)?;
        match &self.entry {
            InboxEntry::Decision { decision } | InboxEntry::Rework { decision } => {
                require_decision_ref(decision)
            }
            InboxEntry::Conflict {
                other_claim_id,
                path,
            } => {
                require_id(IdKind::Claim, other_claim_id, "entry.otherClaimId")?;
                require_path(path, "entry.path")
            }
        }
    }
}

/// `inbox.delivered`: an inbox item reached its agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxDelivered {
    /// The `agt_` agent.
    pub agent_id: String,
    /// The `clm_` claim.
    pub claim_id: String,
    /// The item number.
    pub item: SafeInteger,
}

impl InboxDelivered {
    pub(crate) fn validate(&self) -> Result<()> {
        require_inbox_target(&self.agent_id, &self.claim_id, self.item)
    }
}

/// `inbox.acked`: an agent acknowledged an inbox item with a plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxAcked {
    /// The `agt_` agent.
    pub agent_id: String,
    /// The `clm_` claim.
    pub claim_id: String,
    /// The item number.
    pub item: SafeInteger,
    /// What the agent will change. Untrusted text.
    pub plan: String,
}

impl InboxAcked {
    pub(crate) fn validate(&self) -> Result<()> {
        require_inbox_target(&self.agent_id, &self.claim_id, self.item)?;
        require_text(
            &self.plan,
            MAX_PLAN_LENGTH,
            "plan",
            "a plan of 1 to 4000 characters",
        )
    }
}

/// `train.check`: the train ran a check on a candidate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainCheck {
    /// The `chk_` run.
    pub check_run_id: String,
    /// The candidate commit.
    pub candidate: String,
    /// The check's name.
    pub check: String,
    /// Its outcome.
    pub result: CheckResult,
    /// The decision option an acceptance check proves, or `None` for any other check.
    #[serde(deserialize_with = "nullable")]
    pub acceptance: Option<Acceptance>,
}

impl TrainCheck {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::CheckRun, &self.check_run_id, "checkRunId")?;
        require_commit(&self.candidate, "candidate")?;
        require_text(
            &self.check,
            MAX_CHECK_NAME_LENGTH,
            "check",
            "a check name of 1 to 128 characters",
        )?;
        if let Some(acceptance) = &self.acceptance {
            require_decision_ref(&acceptance.decision)?;
            require_option_key(&acceptance.option, "acceptance.option")?;
        }
        Ok(())
    }
}

/// `train.conflict`: the train found two claims changing the same path.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainConflict {
    /// The two `clm_` claims.
    pub claims: [String; 2],
    /// The path both changed.
    pub path: String,
    /// The classification.
    pub class: ConflictClass,
    /// The classifier's confidence, from 0 to 1.
    pub probability: f64,
    /// Where the train sent it.
    pub route: ConflictRoute,
}

impl TrainConflict {
    pub(crate) fn validate(&self) -> Result<()> {
        let [first, second] = &self.claims;
        require_id(IdKind::Claim, first, "claims")?;
        require_id(IdKind::Claim, second, "claims")?;
        require(first != second, "claims", "two different claims")?;
        require_path(&self.path, "path")?;
        require(
            (0.0..=1.0).contains(&self.probability),
            "probability",
            "between 0 and 1",
        )
    }
}

/// `train.intent`: the train recorded its intent to move main.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainIntent {
    /// The `int_` intent.
    pub intent_id: String,
    /// The main commit the move expects.
    pub expected_main: String,
    /// The commit main moves to.
    pub candidate: String,
    /// The `clm_` claims it lands.
    pub claims: Vec<String>,
    /// The decision versions it relies on.
    pub decisions: Vec<DecisionRef>,
    /// The `chk_` run that cleared it.
    pub check_run_id: String,
}

impl TrainIntent {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Intent, &self.intent_id, "intentId")?;
        require_commit(&self.expected_main, "expectedMain")?;
        require_commit(&self.candidate, "candidate")?;
        require_list(&self.claims, "claims")?;
        require(
            !self.claims.is_empty(),
            "claims",
            "a list of at least one claim",
        )?;
        require_unique(self.claims.iter().map(String::as_str), "claims")?;
        self.claims
            .iter()
            .try_for_each(|id| require_id(IdKind::Claim, id, "claims"))?;
        require_decision_refs(&self.decisions)?;
        require_id(IdKind::CheckRun, &self.check_run_id, "checkRunId")
    }
}

/// `train.main`: the result of an attempt to move main.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrainMain {
    /// The `int_` intent.
    pub intent_id: String,
    /// What happened.
    pub outcome: MainOutcome,
    /// Main's commit afterwards.
    pub main: String,
}

impl TrainMain {
    pub(crate) fn validate(&self) -> Result<()> {
        require_id(IdKind::Intent, &self.intent_id, "intentId")?;
        require_commit(&self.main, "main")
    }
}

fn require_inbox_target(agent_id: &str, claim_id: &str, item: SafeInteger) -> Result<()> {
    require_id(IdKind::Agent, agent_id, "agentId")?;
    require_id(IdKind::Claim, claim_id, "claimId")?;
    require_positive(item, "item")
}

fn require_decision_refs(refs: &[DecisionRef]) -> Result<()> {
    require_list(refs, "decisions")?;
    require_unique(refs.iter().map(|r| r.decision_id.as_str()), "decisions")?;
    refs.iter().try_for_each(require_decision_ref)
}

fn require_decision_ref(decision: &DecisionRef) -> Result<()> {
    require_id(IdKind::Decision, &decision.decision_id, "decisionId")?;
    require_positive(decision.version, "version")
}

/// Between [`MIN_OPTIONS`] and [`MAX_OPTIONS`] options with unique, valid keys and labels.
pub(crate) fn require_options(options: &[QuestionOption]) -> Result<()> {
    require(
        (MIN_OPTIONS..=MAX_OPTIONS).contains(&options.len()),
        "options",
        "a list of 2 to 8 options",
    )?;
    require_unique(options.iter().map(|o| o.key.as_str()), "options")?;
    options.iter().try_for_each(|option| {
        require_option_key(&option.key, "options.key")?;
        require_text(
            &option.label,
            MAX_OPTION_LABEL_LENGTH,
            "options.label",
            "a label of 1 to 200 characters",
        )
    })
}
