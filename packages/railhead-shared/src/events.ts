// The repository event log: the wire types of every fact Railhead records about one repository.
//
// Each repository has one append-only log, written only by its `Repo` Durable Object. The board,
// the agents' inboxes and the demo replay all read this one log. Every view on the board must be a
// fold over it: lane state, the decision ripple and the "adapted" state are derived from events,
// never stored beside them, so a replay renders exactly what was shown live. Events record facts
// that happened, never requests: a refused push is an event, an attempted push is not.
//
// This module is the single owner of the event invariants: the wire types, the limits and the
// validation all live here. The types are plain JSON so the same log travels over Cap'n Web to the
// board, over HTTP to the Rust CLI, and into a captured replay file.
//
// Trust boundary: the shape of an event is established before `validateEvent` runs, by the
// compiler for the backend (the only producer) and by capnweb-validate's generated validator at
// the RPC edge for anything received. So `validateEvent` does not re-check that a value is an
// object or a string. It checks what a TypeScript type cannot state: identifier and commit
// formats, size caps, integer and range rules, and which kind of actor may record which fact. The
// backend must validate every event before appending it, so the log never holds one that fails
// here.
//
// Identifiers are plain strings with a per-kind prefix (`clm_` for a claim, `dec_` for a decision,
// and so on) rather than branded types, because capnweb-validate validates only plain wire types.
// The prefix check in `validateEvent` stops one kind of identifier standing in for another.
//
// Text from an agent or a person, such as issue titles, questions, option labels and
// acknowledgement plans, is untrusted. Events carry it as bounded data, and every reader must
// render it as inert text. No event ever carries a token, key or other secret.
//
// Evolution: capnweb-validate refuses a union member it does not know, so adding an event type is
// a breaking change for older readers. `v` names the schema version an event needs: each type is
// written at the version that introduced it (`eventVersion`), so a log keeps the events an older
// reader can still read at the version it knows. A reader that meets a newer version must stop and
// say so rather than guess; the board reloads into newer code when it does.

// =======================================================================================
// Identifiers

/** A repository identifier, `rep_` followed by 6 to 64 letters or digits. */
export type RepoId = string;
/** An agent identifier, `agt_` followed by 6 to 64 letters or digits. */
export type AgentId = string;
/** A person's identifier, `usr_` followed by 6 to 64 letters or digits. */
export type UserId = string;
/** A system component's identifier, such as `sys_train`. */
export type SystemId = string;
/** An invite identifier, `inv_` followed by 6 to 64 letters or digits. */
export type InviteId = string;
/** An issue identifier, `iss_` followed by 6 to 64 letters or digits. */
export type IssueId = string;
/** A claim identifier, `clm_` followed by 6 to 64 letters or digits. */
export type ClaimId = string;
/** A question identifier, `qst_` followed by 6 to 64 letters or digits. */
export type QuestionId = string;
/** A decision identifier, `dec_` followed by 6 to 64 letters or digits. Versions share one id. */
export type DecisionId = string;
/** A check run identifier, `chk_` followed by 6 to 64 letters or digits. */
export type CheckRunId = string;
/** A merge intent identifier, `int_` followed by 6 to 64 letters or digits. */
export type IntentId = string;
/** A Git commit id: 40 lowercase hexadecimal characters, as Artifacts uses SHA-1. */
export type CommitSha = string;

/** The prefix each identifier kind must carry. */
export const ID_PREFIXES = {
  repo: "rep_",
  agent: "agt_",
  user: "usr_",
  system: "sys_",
  invite: "inv_",
  issue: "iss_",
  claim: "clm_",
  question: "qst_",
  decision: "dec_",
  checkRun: "chk_",
  intent: "int_",
} as const;

/** One kind of identifier, named by its key in `ID_PREFIXES`. */
export type IdKind = keyof typeof ID_PREFIXES;

// =======================================================================================
// Limits

/** The newest schema version this module reads and writes. It reads every version from 1 to this. */
export const EVENT_SCHEMA_VERSION = 2;

/**
 * The schema version each event type is written at: the version that introduced it. An older
 * reader then refuses a newer type by its version rather than mistaking it for corruption.
 */
const EVENT_VERSIONS: Readonly<Record<EventType, number>> = {
  "agent.invited": 1,
  "agent.joined": 1,
  "agent.confirmed": 1,
  "agent.revoked": 1,
  "issue.filed": 1,
  "claim.opened": 1,
  "claim.pushed": 1,
  "claim.ready": 1,
  "claim.refused": 1,
  "claim.reopened": 1,
  "claim.expired": 1,
  "claim.reassigned": 1,
  "claim.adapted": 1,
  "question.asked": 1,
  "decision.recorded": 1,
  "inbox.queued": 1,
  "inbox.delivered": 1,
  "inbox.acked": 1,
  "train.check": 1,
  "train.conflict": 1,
  "train.intent": 1,
  "train.main": 1,
  "train.held": 2,
  "check.approved": 2,
  "train.unreported": 2,
};

/** The schema version an event of `type` is written at. */
export function eventVersion(type: EventType): number {
  return EVENT_VERSIONS[type];
}

/** True when this module reads events of schema version `v`. */
export function isReadableVersion(v: number): boolean {
  return Number.isInteger(v) && v >= 1 && v <= EVENT_SCHEMA_VERSION;
}

/** Maximum length of an issue title, in UTF-16 code units. */
export const MAX_TITLE_LENGTH = 256;
/** Maximum length of an issue body. */
export const MAX_ISSUE_BODY_LENGTH = 16 * 1024;
/** Maximum length of a question's text. */
export const MAX_QUESTION_LENGTH = 2000;
/** Maximum length of one option label in a question. */
export const MAX_OPTION_LABEL_LENGTH = 200;
/** Minimum number of options a question offers. */
export const MIN_OPTIONS = 2;
/** Maximum number of options a question offers. */
export const MAX_OPTIONS = 8;
/** Maximum length of an acknowledgement plan. */
export const MAX_PLAN_LENGTH = 4000;
/** Maximum length of an agent's display name. */
export const MAX_AGENT_NAME_LENGTH = 32;
/** Maximum length of a repository path or Git ref. */
export const MAX_PATH_LENGTH = 1024;
/** Maximum number of entries in any list an event carries: scopes, decisions, claims. */
export const MAX_LIST_LENGTH = 64;
/** Maximum length of a check's name. */
export const MAX_CHECK_NAME_LENGTH = 128;

// =======================================================================================
// Shared parts

/** Who recorded an event. Only the backend sets this, from the authenticated caller. */
export type Actor =
  | { kind: "human"; id: UserId }
  | { kind: "agent"; id: AgentId }
  | { kind: "system"; id: SystemId };

/** A decision at one version: what a piece of work relied on, or what a check proves. */
export interface DecisionRef {
  /** The decision. */
  decisionId: DecisionId;
  /** Its version, counting from 1. */
  version: number;
}

/** One answer a question offers. */
export interface QuestionOption {
  /** Stable key for the option within its question, such as `reject` or `chunk`. */
  key: string;
  /** The label shown to the person deciding. Untrusted text. */
  label: string;
}

/** Why a claim's action was refused. */
export type RefusalReason =
  /** The caller's ownership generation is older than the claim's current one. */
  | "stale_generation"
  /** The claim was already marked ready, so its commit is pinned. */
  | "after_ready"
  /** A decision affecting the claim has not been acknowledged. */
  | "unacked_decision";

/** Why a ready claim went back to working: the system decided its pinned work must be redone. */
export type ReopenReason =
  /** The pin lost a conflict on the train and must be redone on the new base. */
  | "lost_conflict"
  /** A decision version recorded after ready superseded the versions the pin was recorded under. */
  | "decision_superseded"
  /** The train's check failed on the pin. */
  | "check_failed";

/**
 * The reason a reader assigns to a schema version 1 `claim.reopened` that has no `reason`: such an
 * event was recorded before reasons existed, when a superseded decision was the only cause. Writers
 * always record a reason.
 */
export const REOPEN_REASON_BEFORE_REASONS: ReopenReason = "decision_superseded";

/** What an inbox entry asks of the agent. */
export type InboxEntry =
  /** A decision in the claim's scope was recorded or superseded. */
  | { kind: "decision"; decision: DecisionRef }
  /** Work that relied on an older decision version must be redone. */
  | { kind: "rework"; decision: DecisionRef }
  /** The claim's change overlaps another and must be redone on the new base. */
  | { kind: "conflict"; otherClaimId: ClaimId; path: string };

/** The outcome of one check run. `error` means the check could not run, not that the change failed. */
export type CheckResult = "pass" | "fail" | "error";

/**
 * Why a check attempt ended without a report. `timed_out`: its deadline passed before the runner
 * reported, so the train failed its batch.
 */
export type UnreportedOutcome = "timed_out";

/** Clef's classification of a conflict. */
export type ConflictClass = "compatible" | "contradictory";

/** Where the train sent a conflict. */
export type ConflictRoute =
  /** The losing claim's agent redoes its change on the new base. */
  | "redo"
  /** The pair is parked and a person is asked. */
  | "question";

/** The result of one attempt to move main. */
export type MainOutcome =
  /** Main moved from the expected commit to the candidate. */
  | "updated"
  /** Main was no longer at the expected commit, so nothing changed. */
  | "rejected"
  /** The push result was uncertain; main was read back and the intent marked accordingly. */
  | "reconciled";

// =======================================================================================
// Events

/** Every fact the log records, discriminated by `type`. The payload is under `data`. */
export type EventPayload =
  // Agents
  | { type: "agent.invited"; data: { inviteId: InviteId; name: string } }
  | {
      type: "agent.joined";
      data: { agentId: AgentId; inviteId: InviteId; name: string; keyFingerprint: string };
    }
  | { type: "agent.confirmed"; data: { agentId: AgentId } }
  | { type: "agent.revoked"; data: { agentId: AgentId } }
  // Work
  | { type: "issue.filed"; data: { issueId: IssueId; title: string; body: string } }
  | {
      type: "claim.opened";
      data: {
        claimId: ClaimId;
        issueId: IssueId;
        agentId: AgentId;
        generation: number;
        base: CommitSha;
      };
    }
  | {
      type: "claim.pushed";
      data: {
        claimId: ClaimId;
        generation: number;
        ref: string;
        from: CommitSha | null;
        to: CommitSha;
      };
    }
  | {
      type: "claim.ready";
      data: { claimId: ClaimId; generation: number; commit: CommitSha; decisions: DecisionRef[] };
    }
  | {
      type: "claim.refused";
      data: { claimId: ClaimId; generation: number; reason: RefusalReason };
    }
  | {
      // The system decided the pinned work must be redone, for `reason`, so the claim is working
      // again and its holder must rework it and mark it ready at `decisions`, the current versions.
      type: "claim.reopened";
      data: {
        claimId: ClaimId;
        generation: number;
        reason: ReopenReason;
        decisions: DecisionRef[];
      };
    }
  | { type: "claim.expired"; data: { claimId: ClaimId; generation: number } }
  | {
      type: "claim.reassigned";
      data: { claimId: ClaimId; from: AgentId; to: AgentId; generation: number };
    }
  | {
      // The claim's work landed by `intentId` passed the acceptance check of `decision` on the
      // landed commit, and the claim depended on that version when it landed. It stays adapted only
      // while `decision` is the decision's current version.
      type: "claim.adapted";
      data: { claimId: ClaimId; intentId: IntentId; decision: DecisionRef };
    }
  // Decisions
  | {
      type: "question.asked";
      data: {
        questionId: QuestionId;
        claimId: ClaimId;
        decisionId: DecisionId;
        text: string;
        options: QuestionOption[];
      };
    }
  | {
      type: "decision.recorded";
      data: {
        decisionId: DecisionId;
        version: number;
        questionId: QuestionId;
        option: string;
        supersedes: number | null;
        scope: string[];
      };
    }
  // Inbox
  | {
      type: "inbox.queued";
      data: { agentId: AgentId; claimId: ClaimId; item: number; entry: InboxEntry };
    }
  | { type: "inbox.delivered"; data: { agentId: AgentId; claimId: ClaimId; item: number } }
  | {
      type: "inbox.acked";
      data: { agentId: AgentId; claimId: ClaimId; item: number; plan: string };
    }
  // Train
  | {
      type: "train.check";
      data: {
        checkRunId: CheckRunId;
        candidate: CommitSha;
        check: string;
        result: CheckResult;
        acceptance: { decision: DecisionRef; option: string } | null;
      };
    }
  | {
      type: "train.conflict";
      data: {
        claims: [ClaimId, ClaimId];
        path: string;
        class: ConflictClass;
        probability: number;
        route: ConflictRoute;
      };
    }
  | {
      type: "train.intent";
      data: {
        intentId: IntentId;
        expectedMain: CommitSha;
        candidate: CommitSha;
        claims: ClaimId[];
        decisions: DecisionRef[];
        checkRunId: CheckRunId;
      };
    }
  | {
      type: "train.main";
      data: { intentId: IntentId; outcome: MainOutcome; main: CommitSha };
    }
  | {
      /**
       * A candidate edits the trusted check definition or a path it protects, so its check attempt
       * is held for a person and nothing runs until one approves it.
       */
      type: "train.held";
      data: {
        /** The held attempt. */
        checkRunId: CheckRunId;
        /** The main commit the candidate was composed on, whose definition the attempt names. */
        expectedMain: CommitSha;
        /** The candidate commit. */
        candidate: CommitSha;
        /** The claims composed into the candidate. */
        claims: ClaimId[];
        /** The protected paths the candidate edits, the definition's own path first when edited. */
        paths: string[];
        /**
         * SHA-256 of the candidate's own definition file: what an approval runs and names. `null`
         * when the candidate has no valid definition, so there is nothing to approve.
         */
        digest: string | null;
      };
    }
  | {
      /**
       * A person approved running the candidate's own definition, with exactly this digest, for
       * this one held attempt.
       */
      type: "check.approved";
      data: { checkRunId: CheckRunId; candidate: CommitSha; digest: string };
    }
  | {
      /**
       * A check attempt ended without a report, so it has no `train.check` result. A held attempt
       * is recorded by `train.held` instead.
       */
      type: "train.unreported";
      data: { checkRunId: CheckRunId; candidate: CommitSha; outcome: UnreportedOutcome };
    };

/** The name of one event type. */
export type EventType = EventPayload["type"];

/** One entry in a repository's log. */
export type RailheadEvent = {
  /** The schema version, `eventVersion(type)` for events this module writes. */
  v: number;
  /** Position in the repository's log: 1 for the first event, then gapless and increasing. */
  seq: number;
  /** When the `Repo` object recorded it, in milliseconds since the Unix epoch. */
  at: number;
  /** The repository whose log this is. */
  repo: RepoId;
  /** Who caused it, as authenticated by the backend. */
  actor: Actor;
} & EventPayload;

/** The event types a person must record, never an agent or the system. */
export const HUMAN_ONLY_EVENTS: readonly EventType[] = [
  "agent.invited",
  "agent.confirmed",
  "agent.revoked",
  "decision.recorded",
  "check.approved",
];

/**
 * The event types only the agent named in the event may record. An acknowledgement is what the
 * `ready` gate relies on, so nobody can acknowledge on an agent's behalf (#17).
 */
export const AGENT_ONLY_EVENTS: readonly EventType[] = ["inbox.acked"];

/** The event types only the system records: facts no caller can assert about itself. */
export const SYSTEM_ONLY_EVENTS: readonly EventType[] = [
  "agent.joined",
  "claim.refused",
  "claim.reopened",
  "claim.expired",
  "claim.reassigned",
  "claim.adapted",
  "inbox.queued",
  "inbox.delivered",
  "train.check",
  "train.conflict",
  "train.intent",
  "train.main",
  "train.held",
  "train.unreported",
];

// =======================================================================================
// Validation

const ID_BODY = /^[A-Za-z0-9]{6,64}$/;
const SYSTEM_ID_BODY = /^[a-z][a-z0-9_]{1,63}$/;
const COMMIT_SHA = /^[0-9a-f]{40}$/;
const AGENT_NAME = /^[a-z][a-z0-9-]*$/;
const OPTION_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const KEY_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** True when `value` is an identifier of the given kind. */
export function isId(kind: IdKind, value: string): boolean {
  const prefix = ID_PREFIXES[kind];
  if (!value.startsWith(prefix)) return false;
  const body = value.slice(prefix.length);
  return kind === "system" ? SYSTEM_ID_BODY.test(body) : ID_BODY.test(body);
}

/** True when `value` is a 40-character lowercase hexadecimal commit id. */
export function isCommitSha(value: string): boolean {
  return COMMIT_SHA.test(value);
}

/**
 * Checks the invariants of one event that its TypeScript type cannot state, and throws an `Error`
 * naming the first one broken. The event's shape must already be established; see the trust
 * boundary note at the top of this module.
 */
export function validateEvent(event: RailheadEvent): void {
  if (!isReadableVersion(event.v)) {
    throw new Error(`event schema version is not supported: ${event.v}`);
  }
  if (event.v !== eventVersion(event.type)) {
    throw new Error(`${event.type} is written at schema version ${eventVersion(event.type)}`);
  }
  requirePositiveInteger(event.seq, "seq");
  requirePositiveInteger(event.at, "at");
  requireId("repo", event.repo, "repo");
  validateActor(event);
  validatePayload(event);
}

function validateActor(event: RailheadEvent): void {
  const { actor, type } = event;
  switch (actor.kind) {
    case "human":
      requireId("user", actor.id, "actor.id");
      break;
    case "agent":
      requireId("agent", actor.id, "actor.id");
      break;
    case "system":
      requireId("system", actor.id, "actor.id");
      break;
    default:
      return unreachable(actor);
  }
  if (HUMAN_ONLY_EVENTS.includes(type) && actor.kind !== "human") {
    throw new Error(`${type} must be recorded by a person, not by ${actor.kind} ${actor.id}`);
  }
  if (SYSTEM_ONLY_EVENTS.includes(type) && actor.kind !== "system") {
    throw new Error(`${type} must be recorded by the system, not by ${actor.kind} ${actor.id}`);
  }
  if (AGENT_ONLY_EVENTS.includes(type) && actor.kind !== "agent") {
    throw new Error(
      `${type} must be recorded by the agent itself, not by ${actor.kind} ${actor.id}`,
    );
  }
  requireActorIsSubject(event);
}

/**
 * An agent acting for itself must name itself: it can open a claim only for itself, and can
 * acknowledge only its own inbox items. A person may still open a claim for an agent.
 */
function requireActorIsSubject(event: RailheadEvent): void {
  if (event.actor.kind !== "agent") return;
  if (event.type === "claim.opened" && event.data.agentId !== event.actor.id) {
    throw new Error("an agent can open a claim only for itself");
  }
  if (event.type === "inbox.acked" && event.data.agentId !== event.actor.id) {
    throw new Error("an agent can acknowledge only its own inbox items");
  }
}

function validatePayload(event: EventPayload): void {
  switch (event.type) {
    case "agent.invited":
      requireId("invite", event.data.inviteId, "inviteId");
      requireAgentName(event.data.name);
      return;
    case "agent.joined":
      requireId("agent", event.data.agentId, "agentId");
      requireId("invite", event.data.inviteId, "inviteId");
      requireAgentName(event.data.name);
      if (!KEY_FINGERPRINT.test(event.data.keyFingerprint)) {
        throw new Error("keyFingerprint is not an OpenSSH SHA256 fingerprint");
      }
      return;
    case "agent.confirmed":
    case "agent.revoked":
      requireId("agent", event.data.agentId, "agentId");
      return;
    case "issue.filed":
      requireId("issue", event.data.issueId, "issueId");
      requireText(event.data.title, MAX_TITLE_LENGTH, "title");
      requireLength(event.data.body, MAX_ISSUE_BODY_LENGTH, "body");
      return;
    case "claim.opened":
      requireId("claim", event.data.claimId, "claimId");
      requireId("issue", event.data.issueId, "issueId");
      requireId("agent", event.data.agentId, "agentId");
      requirePositiveInteger(event.data.generation, "generation");
      requireCommit(event.data.base, "base");
      return;
    case "claim.pushed":
      requireId("claim", event.data.claimId, "claimId");
      requirePositiveInteger(event.data.generation, "generation");
      requireRef(event.data.ref);
      if (event.data.from !== null) requireCommit(event.data.from, "from");
      requireCommit(event.data.to, "to");
      return;
    case "claim.ready":
      requireId("claim", event.data.claimId, "claimId");
      requirePositiveInteger(event.data.generation, "generation");
      requireCommit(event.data.commit, "commit");
      requireDecisionRefs(event.data.decisions, "decisions");
      return;
    case "claim.refused":
      requireId("claim", event.data.claimId, "claimId");
      requirePositiveInteger(event.data.generation, "generation");
      return;
    case "claim.reopened":
      requireId("claim", event.data.claimId, "claimId");
      requirePositiveInteger(event.data.generation, "generation");
      requireDecisionRefs(event.data.decisions, "decisions");
      return;
    case "claim.expired":
      requireId("claim", event.data.claimId, "claimId");
      requirePositiveInteger(event.data.generation, "generation");
      return;
    case "claim.reassigned":
      requireId("claim", event.data.claimId, "claimId");
      requireId("agent", event.data.from, "from");
      requireId("agent", event.data.to, "to");
      requirePositiveInteger(event.data.generation, "generation");
      if (event.data.generation < 2) {
        throw new Error("generation of a reassigned claim must be at least 2");
      }
      if (event.data.from === event.data.to) {
        throw new Error("a claim cannot be reassigned to the agent that holds it");
      }
      return;
    case "claim.adapted":
      requireId("claim", event.data.claimId, "claimId");
      requireId("intent", event.data.intentId, "intentId");
      requireDecisionRef(event.data.decision, "decision");
      return;
    case "question.asked":
      requireId("question", event.data.questionId, "questionId");
      requireId("claim", event.data.claimId, "claimId");
      requireId("decision", event.data.decisionId, "decisionId");
      requireText(event.data.text, MAX_QUESTION_LENGTH, "text");
      requireOptions(event.data.options);
      return;
    case "decision.recorded":
      requireId("decision", event.data.decisionId, "decisionId");
      requirePositiveInteger(event.data.version, "version");
      requireId("question", event.data.questionId, "questionId");
      requireOptionKey(event.data.option, "option");
      requireSupersedes(event.data.version, event.data.supersedes);
      requireList(event.data.scope, "scope");
      if (event.data.scope.length === 0) throw new Error("scope must name at least one path");
      event.data.scope.forEach((path, index) => requirePath(path, `scope[${index}]`));
      return;
    case "inbox.queued":
      requireInboxTarget(event.data);
      requireInboxEntry(event.data.entry);
      return;
    case "inbox.delivered":
      requireInboxTarget(event.data);
      return;
    case "inbox.acked":
      requireInboxTarget(event.data);
      requireText(event.data.plan, MAX_PLAN_LENGTH, "plan");
      return;
    case "train.check":
      requireId("checkRun", event.data.checkRunId, "checkRunId");
      requireCommit(event.data.candidate, "candidate");
      requireText(event.data.check, MAX_CHECK_NAME_LENGTH, "check");
      if (event.data.acceptance !== null) {
        requireDecisionRef(event.data.acceptance.decision, "acceptance.decision");
        requireOptionKey(event.data.acceptance.option, "acceptance.option");
      }
      return;
    case "train.conflict": {
      const [first, second] = event.data.claims;
      requireId("claim", first, "claims[0]");
      requireId("claim", second, "claims[1]");
      if (first === second) throw new Error("a conflict needs two different claims");
      requirePath(event.data.path, "path");
      const { probability } = event.data;
      if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
        throw new Error("probability must be between 0 and 1");
      }
      return;
    }
    case "train.intent":
      requireId("intent", event.data.intentId, "intentId");
      requireCommit(event.data.expectedMain, "expectedMain");
      requireCommit(event.data.candidate, "candidate");
      requireList(event.data.claims, "claims");
      if (event.data.claims.length === 0) throw new Error("claims must name at least one claim");
      requireUnique(event.data.claims, "claims");
      event.data.claims.forEach((id, index) => requireId("claim", id, `claims[${index}]`));
      requireDecisionRefs(event.data.decisions, "decisions");
      requireId("checkRun", event.data.checkRunId, "checkRunId");
      return;
    case "train.main":
      requireId("intent", event.data.intentId, "intentId");
      requireCommit(event.data.main, "main");
      return;
    case "train.held":
      requireId("checkRun", event.data.checkRunId, "checkRunId");
      requireCommit(event.data.expectedMain, "expectedMain");
      requireCommit(event.data.candidate, "candidate");
      requireList(event.data.claims, "claims");
      if (event.data.claims.length === 0) throw new Error("claims must name at least one claim");
      requireUnique(event.data.claims, "claims");
      event.data.claims.forEach((id, index) => requireId("claim", id, `claims[${index}]`));
      requireList(event.data.paths, "paths");
      if (event.data.paths.length === 0) throw new Error("paths must name at least one path");
      requireUnique(event.data.paths, "paths");
      event.data.paths.forEach((path, index) => requirePath(path, `paths[${index}]`));
      if (event.data.digest !== null) requireDigest(event.data.digest, "digest");
      return;
    case "check.approved":
      requireId("checkRun", event.data.checkRunId, "checkRunId");
      requireCommit(event.data.candidate, "candidate");
      requireDigest(event.data.digest, "digest");
      return;
    case "train.unreported":
      requireId("checkRun", event.data.checkRunId, "checkRunId");
      requireCommit(event.data.candidate, "candidate");
      if (event.data.outcome !== "timed_out")
        throw new Error("outcome is not an unreported outcome");
      return;
    default:
      return unreachable(event);
  }
}

function requireInboxTarget(data: { agentId: AgentId; claimId: ClaimId; item: number }): void {
  requireId("agent", data.agentId, "agentId");
  requireId("claim", data.claimId, "claimId");
  requirePositiveInteger(data.item, "item");
}

function requireInboxEntry(entry: InboxEntry): void {
  switch (entry.kind) {
    case "decision":
    case "rework":
      requireDecisionRef(entry.decision, "entry.decision");
      return;
    case "conflict":
      requireId("claim", entry.otherClaimId, "entry.otherClaimId");
      requirePath(entry.path, "entry.path");
      return;
    default:
      return unreachable(entry);
  }
}

function requireOptions(options: QuestionOption[]): void {
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new Error(`options must have between ${MIN_OPTIONS} and ${MAX_OPTIONS} entries`);
  }
  requireUnique(
    options.map((option) => option.key),
    "options",
  );
  options.forEach((option, index) => {
    requireOptionKey(option.key, `options[${index}].key`);
    requireText(option.label, MAX_OPTION_LABEL_LENGTH, `options[${index}].label`);
  });
}

function requireSupersedes(version: number, supersedes: number | null): void {
  if (version === 1) {
    if (supersedes !== null) throw new Error("the first version of a decision supersedes nothing");
    return;
  }
  if (supersedes !== version - 1) {
    throw new Error(`version ${version} must supersede version ${version - 1}`);
  }
}

function requireDecisionRefs(refs: DecisionRef[], field: string): void {
  requireList(refs, field);
  requireUnique(
    refs.map((ref) => ref.decisionId),
    field,
  );
  refs.forEach((ref, index) => requireDecisionRef(ref, `${field}[${index}]`));
}

function requireDecisionRef(ref: DecisionRef, field: string): void {
  requireId("decision", ref.decisionId, `${field}.decisionId`);
  requirePositiveInteger(ref.version, `${field}.version`);
}

function requireId(kind: IdKind, value: string, field: string): void {
  if (!isId(kind, value)) throw new Error(`${field} is not a ${kind} identifier`);
}

function requireCommit(value: string, field: string): void {
  if (!isCommitSha(value)) throw new Error(`${field} is not a commit id`);
}

function requireDigest(value: string, field: string): void {
  if (!DIGEST.test(value)) throw new Error(`${field} is not a SHA-256 digest`);
}

function requireAgentName(name: string): void {
  if (name.length > MAX_AGENT_NAME_LENGTH || !AGENT_NAME.test(name)) {
    throw new Error("name is not a valid agent name");
  }
}

function requireOptionKey(value: string, field: string): void {
  if (!OPTION_KEY.test(value)) throw new Error(`${field} is not a valid option key`);
}

function requireRef(ref: string): void {
  if (!ref.startsWith("refs/") || ref.length > MAX_PATH_LENGTH) {
    throw new Error("ref is not a Git ref");
  }
}

function requirePath(path: string, field: string): void {
  if (path === "" || path.length > MAX_PATH_LENGTH || path.startsWith("/")) {
    throw new Error(`${field} is not a repository path`);
  }
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${field} is not a repository path`);
  }
}

function requireText(value: string, max: number, field: string): void {
  if (value.trim() === "") throw new Error(`${field} is empty`);
  requireLength(value, max, field);
}

function requireLength(value: string, max: number, field: string): void {
  if (value.length > max) throw new Error(`${field} is longer than ${max} characters`);
}

function requireList(list: readonly unknown[], field: string): void {
  if (list.length > MAX_LIST_LENGTH) {
    throw new Error(`${field} has more than ${MAX_LIST_LENGTH} entries`);
  }
}

function requireUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} has a duplicate entry`);
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled event variant: ${JSON.stringify(value)}`);
}
