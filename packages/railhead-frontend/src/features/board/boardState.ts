// Board state: a pure fold over one repository's event log.
//
// The board shows nothing that is not derived from the log, so a replay renders exactly what was
// shown live. `foldEvent` applies one event to a plain-data `BoardState`; the same function serves
// a live stream, a resynchronisation after a gap and a captured replay.
//
// The fold never guesses. A duplicate is ignored by its sequence number; a gap stops application
// until the missing events arrive; an unsupported schema version, an event that fails
// `validateEvent`, an event from another repository or one that contradicts what the log already
// said halts the fold with a typed fault instead of producing a plausible board. Badges that
// depend on several facts, such as "adapted", are computed by selectors over the folded facts and
// are never stored.
//
// Totals are counted from applied events only, so a duplicate, which the fold ignores by its
// sequence number, never adds to one. Recent activity is bucketed by the minute each event was
// recorded and kept only for the window that ends at the newest event's minute, so it is bounded and
// a replay shows the same numbers as the live board did.

import { INVITE_TTL_MS } from "@railhead/shared/board-api";
import {
  isReadableVersion,
  validateEvent,
  type AgentId,
  type CheckResult,
  type CheckRunId,
  type ClaimId,
  type CommitSha,
  type ConflictClass,
  type ConflictRoute,
  type DecisionId,
  type DecisionRef,
  type InboxEntry,
  type IntentId,
  type InviteId,
  type IssueId,
  type MainOutcome,
  type QuestionId,
  type QuestionOption,
  type RailheadEvent,
  type RefusalReason,
  type RepoId,
  type UnreportedOutcome,
  type UserId,
} from "@railhead/shared/events";

/** How many recent pushes a claim keeps for its lane. Older pushes remain in the log. */
export const MAX_LANE_PUSHES = 20;

/** How many minutes of recent activity the board keeps, ending at the newest event's minute. */
export const ACTIVITY_WINDOW_MINUTES = 10;

const MINUTE_MS = 60_000;

/** Where an agent's inbox item stands. Each state is recorded by a separate event. */
export type InboxDelivery = "queued" | "delivered" | "acknowledged";

/** Where an enrolled agent stands. */
export type AgentStatus = "awaiting_confirmation" | "confirmed" | "revoked";

/**
 * Where a claim stands. A ready claim returns to `working` when its agent pushes again, as the
 * losing side of a `redo` conflict or a rework does. A claim whose pin landed is `merged`, and an
 * expired one waits for a successor; neither takes a push. A newer decision reopens a ready or
 * merged claim to `working` (`claim.reopened`).
 */
export type ClaimPhase = "working" | "ready" | "merged" | "expired";

/** An invite, and the agent that joined with it once one has. */
export interface InviteState {
  inviteId: InviteId;
  /** The agent name the invite fixed in advance. Untrusted text. */
  name: string;
  /**
   * When the invite stops being usable, in milliseconds since the Unix epoch: the event's `at` plus
   * `INVITE_TTL_MS`. The backend reads its clock for its own expiry just before it appends the event,
   * so this is never earlier than that expiry. No event records an expiry; this is how the board
   * learns of it.
   */
  expiresAt: number;
  agentId: AgentId | null;
}

/** An agent that joined. */
export interface AgentState {
  agentId: AgentId;
  /** Untrusted text. */
  name: string;
  inviteId: InviteId;
  status: AgentStatus;
}

/** A filed issue. Title and body are untrusted text. */
export interface IssueState {
  issueId: IssueId;
  title: string;
  body: string;
}

/** One push to a claim's fork. */
export interface ClaimPush {
  seq: number;
  ref: string;
  from: CommitSha | null;
  to: CommitSha;
}

/** One claim: the lane on the board. */
export interface ClaimState {
  claimId: ClaimId;
  issueId: IssueId;
  /** The agent currently holding the claim. */
  agentId: AgentId;
  /** The current ownership generation. */
  generation: number;
  base: CommitSha;
  /** The last pushed commit, or `null` before the first push. */
  head: CommitSha | null;
  phase: ClaimPhase;
  /** The commit pinned by the last `ready` and the decisions it relied on, until the next push. */
  ready: { commit: CommitSha; decisions: readonly DecisionRef[] } | null;
  /** The most recent pushes, oldest first, at most `MAX_LANE_PUSHES`. */
  pushes: readonly ClaimPush[];
  /** The latest refusal, which names the generation the refused caller held. */
  refusal: { generation: number; reason: RefusalReason } | null;
  /**
   * The phase a newer decision reopened the claim from, until its next `ready` or takeover, or
   * `null` when it was not reopened since.
   */
  reopened: "ready" | "merged" | null;
  /** Intents that landed this claim on main, oldest first. */
  landings: readonly IntentId[];
  /**
   * The decision versions the backend recorded this claim's landed work as adapted to, in log
   * order. See `isClaimAdapted`.
   */
  adaptations: readonly DecisionRef[];
}

/** A question asked from a claim. Text and option labels are untrusted. */
export interface QuestionState {
  questionId: QuestionId;
  claimId: ClaimId;
  decisionId: DecisionId;
  text: string;
  options: readonly QuestionOption[];
}

/** One recorded version of a decision. */
export interface DecisionVersionState {
  version: number;
  questionId: QuestionId;
  /** The chosen option's key. */
  option: string;
  scope: readonly string[];
  seq: number;
}

/** A decision and every version recorded for it. */
export interface DecisionState {
  decisionId: DecisionId;
  /** Ascending by version, gapless from 1; never empty. */
  versions: readonly DecisionVersionState[];
}

/** One inbox item. `plan` is the agent's acknowledgement text, untrusted. */
export interface InboxItemState {
  agentId: AgentId;
  claimId: ClaimId;
  item: number;
  entry: InboxEntry;
  delivery: InboxDelivery;
  plan: string | null;
  /** Sequence number of the `inbox.queued` event. */
  queuedSeq: number;
}

/** One result within a check run. */
export interface CheckEntryState {
  seq: number;
  check: string;
  result: CheckResult;
  acceptance: { decision: DecisionRef; option: string } | null;
}

/** A check run against one candidate commit. */
export interface CheckRunState {
  checkRunId: CheckRunId;
  candidate: CommitSha;
  /** In log order. Empty for a run that ended without a report. */
  results: readonly CheckEntryState[];
  /** How the run ended without a report, from its `train.unreported` event, or `null`. */
  unreported: { outcome: UnreportedOutcome; seq: number } | null;
}

/**
 * A check attempt held because its candidate edits the trusted check definition or a path it
 * protects. Nothing runs until a person approves the candidate's own definition, named by `digest`.
 */
export interface HeldCheckState {
  checkRunId: CheckRunId;
  /** Sequence number of the `train.held` event. */
  seq: number;
  expectedMain: CommitSha;
  candidate: CommitSha;
  claims: readonly ClaimId[];
  /** The protected paths the candidate edits. */
  paths: readonly string[];
  /** SHA-256 of the candidate's definition, or `null` when it has none to approve. */
  digest: string | null;
  /** The person who approved running it, and when, or `null` while it waits. */
  approval: { userId: UserId; seq: number } | null;
  /** The event after which the train can no longer run this attempt, or `null` while it may. */
  ended: { reason: HeldEndReason; seq: number } | null;
}

/**
 * Why the train can no longer run a held attempt. `superseded`: a later attempt took one of its
 * claims, or a claim moved to a new generation. `dropped`: a claim was reopened or expired, so its
 * pin is gone.
 */
export type HeldEndReason = "superseded" | "dropped";

/** What became of a merge intent. Only `landed` means the candidate is on main. */
export type IntentLanding =
  | { kind: "pending" }
  | { kind: "landed"; outcome: "updated" | "reconciled"; main: CommitSha }
  | { kind: "not_landed"; outcome: "rejected" | "reconciled"; main: CommitSha };

/** A merge intent recorded by the train. */
export interface IntentState {
  intentId: IntentId;
  expectedMain: CommitSha;
  candidate: CommitSha;
  claims: readonly ClaimId[];
  /** The decision versions the merge was authorised against. */
  decisions: readonly DecisionRef[];
  checkRunId: CheckRunId;
  landing: IntentLanding;
}

/** A classified conflict between two claims. */
export interface ConflictState {
  seq: number;
  claims: readonly [ClaimId, ClaimId];
  path: string;
  class: ConflictClass;
  probability: number;
  route: ConflictRoute;
}

/** What happened in one minute of the log, by the minute each event was recorded. */
export interface MinuteActivity {
  /** Whole minutes since the Unix epoch. */
  minute: number;
  /** `claim.opened` events. */
  claimsOpened: number;
  /** `train.check` events: one per check result, whatever the result. */
  checksReported: number;
  /** Claims carried by a merge that moved main to its candidate. */
  changesLanded: number;
}

/** Counts over every applied event, and when the log began and last moved. */
export interface LogTotals {
  /** Events a person recorded: invites, confirmations, revocations, filed issues and decisions. */
  humanActions: number;
  /**
   * The earliest `at` of any applied event, or `null` before the first. A late event can carry an
   * earlier `at` than the event before it in sequence.
   */
  earliestAt: number | null;
  /** The latest `at` of any applied event, or `null` before the first. */
  lastAt: number | null;
}

/** Why the fold stopped. A halted board must say so; it never shows a guessed state. */
export type BoardFault =
  /** The event uses a schema version this board cannot read. */
  | { kind: "unsupported_version"; seq: number; version: number }
  /** The event failed `validateEvent`. */
  | { kind: "invalid_event"; seq: number; message: string }
  /** The event belongs to another repository's log. */
  | { kind: "foreign_repo"; seq: number }
  /** The event contradicts an earlier one or refers to something the log never recorded. */
  | { kind: "inconsistent"; seq: number; message: string };

/** Whether the folded state is complete up to `cursor`. */
export type StreamStatus =
  /** Every event up to `cursor` was applied and none beyond it has been seen. */
  | { kind: "consistent" }
  /**
   * Events `expected` through `through` are missing: nothing beyond the gap is applied until they
   * arrive in order, for example from a replay starting at `cursor + 1`.
   */
  | { kind: "gap"; expected: number; through: number }
  /** The fold stopped for good; later events are ignored. */
  | { kind: "halted"; fault: BoardFault };

/** Everything the board knows about one repository, as plain data. */
export interface BoardState {
  repo: RepoId;
  /** Sequence number of the last applied event; 0 before the first. */
  cursor: number;
  stream: StreamStatus;
  /** Main as last read by the train, or `null` before any `train.main` event. */
  main: CommitSha | null;
  invites: Readonly<Record<InviteId, InviteState>>;
  agents: Readonly<Record<AgentId, AgentState>>;
  issues: Readonly<Record<IssueId, IssueState>>;
  claims: Readonly<Record<ClaimId, ClaimState>>;
  questions: Readonly<Record<QuestionId, QuestionState>>;
  decisions: Readonly<Record<DecisionId, DecisionState>>;
  /** Keyed by `inboxKey`. */
  inbox: Readonly<Record<string, InboxItemState>>;
  checkRuns: Readonly<Record<CheckRunId, CheckRunState>>;
  heldChecks: Readonly<Record<CheckRunId, HeldCheckState>>;
  /** The latest held attempt naming each claim, so the event that ends it finds it directly. */
  heldByClaim: Readonly<Record<ClaimId, CheckRunId>>;
  intents: Readonly<Record<IntentId, IntentState>>;
  /** In log order. */
  conflicts: readonly ConflictState[];
  totals: LogTotals;
  /**
   * Activity in each minute within `ACTIVITY_WINDOW_MINUTES` of the newest event's minute that had
   * any, ascending. Older minutes are dropped.
   */
  recent: readonly MinuteActivity[];
}

/** The board of a repository whose log has no events yet. */
export const emptyBoardState = (repo: RepoId): BoardState => ({
  repo,
  cursor: 0,
  stream: { kind: "consistent" },
  main: null,
  invites: {},
  agents: {},
  issues: {},
  claims: {},
  questions: {},
  decisions: {},
  inbox: {},
  checkRuns: {},
  heldChecks: {},
  heldByClaim: {},
  intents: {},
  conflicts: [],
  totals: { humanActions: 0, earliestAt: null, lastAt: null },
  recent: [],
});

/** The key of an inbox item in `BoardState.inbox`. Item numbers are per agent. */
export const inboxKey = (agentId: AgentId, item: number): string => `${agentId}/${item}`;

/**
 * Applies one event. Returns `state` itself when the event changes nothing: a duplicate, or any
 * event after the fold halted. Never throws for a bad event; see `StreamStatus` and `BoardFault`.
 */
export const foldEvent = (state: BoardState, event: RailheadEvent): BoardState =>
  foldInto(state, event, new FoldDraft());

/**
 * Applies events in order; see `foldEvent`. Each record is copied at most once per call, so the
 * time taken grows linearly with the number of events.
 */
export const foldEvents = (state: BoardState, events: Iterable<RailheadEvent>): BoardState => {
  const draft = new FoldDraft();
  let next = state;
  for (const event of events) next = foldInto(next, event, draft);
  return next;
};

/** The latest recorded version of a decision, or `undefined` for an unknown decision. */
export const currentDecisionVersion = (
  state: BoardState,
  decisionId: DecisionId,
): DecisionVersionState | undefined => own(state.decisions, decisionId)?.versions.at(-1);

/**
 * True only when the backend recorded the claim's landed work as adapted to the decision's current
 * version (`claim.adapted`). The backend records it per claim: the intent landed, the acceptance
 * check it rests on passed the version's chosen option on the landed commit, and this claim depended
 * on that version when it landed. The board does not derive it from the intent, whose decisions are
 * the batch's combined ones.
 *
 * A passing check on a candidate that has not landed, a pass for an older version or another option,
 * and the agent's own acknowledgement all leave the claim not adapted. Superseding the decision
 * removes the badge until the new version's work lands and is recorded adapted.
 */
export const isClaimAdapted = (
  state: BoardState,
  claimId: ClaimId,
  decisionId: DecisionId,
): boolean => {
  const current = currentDecisionVersion(state, decisionId);
  const claim = own(state.claims, claimId);
  if (current === undefined || claim === undefined) return false;
  return claim.adaptations.some(
    (ref) => ref.decisionId === decisionId && ref.version === current.version,
  );
};

/** One agent's progress on the current version of a decision. */
export interface RippleRow {
  agentId: AgentId;
  claimId: ClaimId;
  /** The least advanced delivery among the agent's items for the current version. */
  delivery: InboxDelivery;
  /** See `isClaimAdapted`. Independent of `delivery`: it is never the agent's word. */
  adapted: boolean;
}

/**
 * The decision ripple: one row per agent and claim with an inbox item for the decision's current
 * version, in the order their first such item was queued. Items for superseded versions are not
 * shown, so a supersession resets every row.
 */
export const decisionRipple = (state: BoardState, decisionId: DecisionId): RippleRow[] => {
  const current = currentDecisionVersion(state, decisionId);
  if (current === undefined) return [];
  const rows = new Map<string, RippleRow & { firstSeq: number }>();
  const items = Object.values(state.inbox).toSorted((a, b) => a.queuedSeq - b.queuedSeq);
  for (const item of items) {
    const { entry } = item;
    if (entry.kind === "conflict") continue;
    if (entry.decision.decisionId !== decisionId || entry.decision.version !== current.version) {
      continue;
    }
    const key = `${item.agentId}/${item.claimId}`;
    const row = rows.get(key);
    if (row === undefined) {
      rows.set(key, {
        agentId: item.agentId,
        claimId: item.claimId,
        delivery: item.delivery,
        adapted: isClaimAdapted(state, item.claimId, decisionId),
        firstSeq: item.queuedSeq,
      });
    } else if (DELIVERY_RANK[item.delivery] < DELIVERY_RANK[row.delivery]) {
      row.delivery = item.delivery;
    }
  }
  return [...rows.values()].map(({ firstSeq: _, ...row }) => row);
};

// Internals

/**
 * The records and lists one fold created, which later events of the same fold update in place.
 *
 * Copying a record for every event made a fold quadratic. Instead a record is copied the first time a
 * fold writes to it and mutated afterwards. Nothing the caller passed in is ever registered, and the
 * draft dies with its fold, so every state a caller holds stays unchanged. Only the latest state of
 * a fold is returned; the intermediate states that share these objects are discarded. `applyEvent`
 * makes all its checks before its first write, so a halting event leaves its input state intact.
 */
class FoldDraft {
  readonly #records = new WeakMap<object, Record<string, unknown>>();
  readonly #lists = new WeakMap<object, unknown[]>();

  /** `record` with `key` set to `value`. */
  put<T>(record: Readonly<Record<string, T>>, key: string, value: T): Readonly<Record<string, T>> {
    const owned = this.#records.get(record);
    if (owned !== undefined) {
      owned[key] = value;
      return record;
    }
    const copy = { ...record, [key]: value };
    this.#records.set(copy, copy);
    return copy;
  }

  /** `list` with `item` appended. */
  append<T>(list: readonly T[], item: T): readonly T[] {
    const owned = this.#lists.get(list);
    if (owned !== undefined) {
      owned.push(item);
      return list;
    }
    const copy = [...list, item];
    this.#lists.set(copy, copy);
    return copy;
  }
}

/** `foldEvent`, writing through `draft`. */
const foldInto = (state: BoardState, event: RailheadEvent, draft: FoldDraft): BoardState => {
  if (state.stream.kind === "halted") return state;
  if (!isReadableVersion(event.v)) {
    return halt(state, { kind: "unsupported_version", seq: event.seq, version: event.v });
  }
  try {
    validateEvent(event);
  } catch (error) {
    return halt(state, { kind: "invalid_event", seq: event.seq, message: messageOf(error) });
  }
  if (event.repo !== state.repo) return halt(state, { kind: "foreign_repo", seq: event.seq });
  if (event.seq <= state.cursor) return state;
  if (event.seq > state.cursor + 1) return markGap(state, event.seq);

  let next: BoardState;
  try {
    next = applyEvent(state, event, draft);
  } catch (error) {
    if (!(error instanceof LogInconsistency)) throw error;
    return halt(state, { kind: "inconsistent", seq: event.seq, message: error.message });
  }
  return {
    ...next,
    cursor: event.seq,
    stream: afterApplying(state.stream, event.seq),
    totals: countTotals(state.totals, event),
    recent: countRecent(state.recent, state.totals.lastAt, event, activityOf(next, event)),
  };
};

const countTotals = (totals: LogTotals, event: RailheadEvent): LogTotals => ({
  humanActions: totals.humanActions + (event.actor.kind === "human" ? 1 : 0),
  earliestAt: totals.earliestAt === null ? event.at : Math.min(totals.earliestAt, event.at),
  lastAt: totals.lastAt === null ? event.at : Math.max(totals.lastAt, event.at),
});

type ActivityCounts = Omit<MinuteActivity, "minute">;

/** What an applied event adds to its minute's activity, or `null` when it adds nothing. */
const activityOf = (next: BoardState, event: RailheadEvent): ActivityCounts | null => {
  switch (event.type) {
    case "claim.opened":
      return { claimsOpened: 1, checksReported: 0, changesLanded: 0 };
    case "train.check":
      return { claimsOpened: 0, checksReported: 1, changesLanded: 0 };
    case "train.main": {
      const intent = own(next.intents, event.data.intentId);
      if (intent?.landing.kind !== "landed") return null;
      return { claimsOpened: 0, checksReported: 0, changesLanded: intent.claims.length };
    }
    default:
      return null;
  }
};

/**
 * `recent` after an event at `event.at`, given the latest `at` before it. Minutes that fall out of
 * the window ending at the newest minute are dropped, and an event older than that window adds
 * nothing.
 */
const countRecent = (
  recent: readonly MinuteActivity[],
  lastAt: number | null,
  event: RailheadEvent,
  counts: ActivityCounts | null,
): readonly MinuteActivity[] => {
  const minute = Math.floor(event.at / MINUTE_MS);
  const newest = lastAt === null ? minute : Math.max(Math.floor(lastAt / MINUTE_MS), minute);
  const oldest = newest - ACTIVITY_WINDOW_MINUTES + 1;
  const outdated = recent.length > 0 && (recent[0]?.minute ?? oldest) < oldest;
  if (counts === null || minute < oldest) {
    return outdated ? recent.filter((entry) => entry.minute >= oldest) : recent;
  }
  const kept = recent.filter((entry) => entry.minute >= oldest && entry.minute !== minute);
  const prior = recent.find((entry) => entry.minute === minute);
  const updated: MinuteActivity = {
    minute,
    claimsOpened: (prior?.claimsOpened ?? 0) + counts.claimsOpened,
    checksReported: (prior?.checksReported ?? 0) + counts.checksReported,
    changesLanded: (prior?.changesLanded ?? 0) + counts.changesLanded,
  };
  return [...kept, updated].toSorted((a, b) => a.minute - b.minute);
};

const DELIVERY_RANK: Record<InboxDelivery, number> = { queued: 0, delivered: 1, acknowledged: 2 };

/** Thrown by `applyEvent` when an event contradicts the folded log; becomes an `inconsistent` fault. */
class LogInconsistency extends Error {}

const halt = (state: BoardState, fault: BoardFault): BoardState => ({
  ...state,
  stream: { kind: "halted", fault },
});

const markGap = (state: BoardState, seq: number): BoardState => {
  const through = state.stream.kind === "gap" ? Math.max(state.stream.through, seq) : seq;
  return { ...state, stream: { kind: "gap", expected: state.cursor + 1, through } };
};

const afterApplying = (stream: StreamStatus, seq: number): StreamStatus =>
  stream.kind === "gap" && seq < stream.through
    ? { kind: "gap", expected: seq + 1, through: stream.through }
    : { kind: "consistent" };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "event failed validation";

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const known = <T>(record: Readonly<Record<string, T>>, key: string, what: string): T => {
  const value = own(record, key);
  if (value === undefined) throw new LogInconsistency(`${what} ${key} was never recorded`);
  return value;
};

const fresh = (record: Readonly<Record<string, unknown>>, key: string, what: string): void => {
  if (Object.hasOwn(record, key)) throw new LogInconsistency(`${what} ${key} was already recorded`);
};

const check = (condition: boolean, message: string): void => {
  if (!condition) throw new LogInconsistency(message);
};

const knownDecisionVersion = (state: BoardState, ref: DecisionRef): DecisionVersionState => {
  const decision = known(state.decisions, ref.decisionId, "decision");
  const version = decision.versions.find((entry) => entry.version === ref.version);
  if (version === undefined) {
    throw new LogInconsistency(
      `decision ${ref.decisionId} has no version ${ref.version} on record`,
    );
  }
  return version;
};

const confirmedAgent = (state: BoardState, agentId: AgentId): AgentState => {
  const agent = known(state.agents, agentId, "agent");
  check(agent.status === "confirmed", `agent ${agentId} is not confirmed`);
  return agent;
};

const currentGeneration = (claim: ClaimState, generation: number): void =>
  check(
    generation === claim.generation,
    `claim ${claim.claimId} is at generation ${claim.generation}, not ${generation}`,
  );

const landingOf = (intent: IntentState, outcome: MainOutcome, main: CommitSha): IntentLanding => {
  switch (outcome) {
    case "updated":
      check(main === intent.candidate, `intent ${intent.intentId} updated main to another commit`);
      return { kind: "landed", outcome, main };
    case "reconciled":
      return main === intent.candidate
        ? { kind: "landed", outcome, main }
        : { kind: "not_landed", outcome, main };
    case "rejected":
      return { kind: "not_landed", outcome, main };
    default:
      return unreachable(outcome);
  }
};

/** Applies a validated, in-order event. Throws `LogInconsistency` when it contradicts the log. */
const applyEvent = (state: BoardState, event: RailheadEvent, draft: FoldDraft): BoardState => {
  const { seq } = event;
  switch (event.type) {
    case "agent.invited": {
      const { inviteId, name } = event.data;
      fresh(state.invites, inviteId, "invite");
      return {
        ...state,
        invites: draft.put(state.invites, inviteId, {
          inviteId,
          name,
          expiresAt: event.at + INVITE_TTL_MS,
          agentId: null,
        }),
      };
    }
    case "agent.joined": {
      const { agentId, inviteId, name } = event.data;
      const invite = known(state.invites, inviteId, "invite");
      check(invite.agentId === null, `invite ${inviteId} was already used`);
      check(invite.name === name, `agent ${agentId} joined under another name than its invite`);
      fresh(state.agents, agentId, "agent");
      return {
        ...state,
        invites: draft.put(state.invites, inviteId, { ...invite, agentId }),
        agents: draft.put(state.agents, agentId, {
          agentId,
          name,
          inviteId,
          status: "awaiting_confirmation",
        }),
      };
    }
    case "agent.confirmed": {
      const agent = known(state.agents, event.data.agentId, "agent");
      check(
        agent.status === "awaiting_confirmation",
        `agent ${agent.agentId} is not awaiting confirmation`,
      );
      return {
        ...state,
        agents: draft.put(state.agents, agent.agentId, { ...agent, status: "confirmed" }),
      };
    }
    case "agent.revoked": {
      const agent = known(state.agents, event.data.agentId, "agent");
      check(agent.status !== "revoked", `agent ${agent.agentId} was already revoked`);
      return {
        ...state,
        agents: draft.put(state.agents, agent.agentId, { ...agent, status: "revoked" }),
      };
    }
    case "issue.filed": {
      const { issueId, title, body } = event.data;
      fresh(state.issues, issueId, "issue");
      return { ...state, issues: draft.put(state.issues, issueId, { issueId, title, body }) };
    }
    case "claim.opened": {
      const { claimId, issueId, agentId, generation, base } = event.data;
      fresh(state.claims, claimId, "claim");
      known(state.issues, issueId, "issue");
      confirmedAgent(state, agentId);
      check(generation === 1, `claim ${claimId} opened at generation ${generation}`);
      return {
        ...state,
        claims: draft.put(state.claims, claimId, {
          claimId,
          issueId,
          agentId,
          generation,
          base,
          head: null,
          phase: "working",
          ready: null,
          pushes: [],
          refusal: null,
          reopened: null,
          landings: [],
          adaptations: [],
        }),
      };
    }
    case "claim.pushed": {
      const { claimId, generation, ref, from, to } = event.data;
      const claim = known(state.claims, claimId, "claim");
      currentGeneration(claim, generation);
      check(
        claim.phase !== "expired" && claim.phase !== "merged",
        `claim ${claimId} cannot take a push while ${claim.phase}`,
      );
      const pushes = [...claim.pushes, { seq, ref, from, to }].slice(-MAX_LANE_PUSHES);
      return {
        ...state,
        claims: draft.put(state.claims, claimId, {
          ...claim,
          head: to,
          phase: "working",
          ready: null,
          pushes,
        }),
      };
    }
    case "claim.ready": {
      const { claimId, generation, commit, decisions } = event.data;
      const claim = known(state.claims, claimId, "claim");
      currentGeneration(claim, generation);
      check(claim.phase === "working", `claim ${claimId} cannot become ready while ${claim.phase}`);
      for (const ref of decisions) knownDecisionVersion(state, ref);
      return {
        ...state,
        claims: draft.put(state.claims, claimId, {
          ...claim,
          phase: "ready",
          ready: { commit, decisions },
          reopened: null,
        }),
      };
    }
    case "claim.refused": {
      const { claimId, generation, reason } = event.data;
      const claim = known(state.claims, claimId, "claim");
      check(generation <= claim.generation, `claim ${claimId} refused a future generation`);
      return {
        ...state,
        claims: draft.put(state.claims, claimId, { ...claim, refusal: { generation, reason } }),
      };
    }
    case "claim.reopened": {
      const { claimId, generation, decisions } = event.data;
      const claim = known(state.claims, claimId, "claim");
      currentGeneration(claim, generation);
      const from = claim.phase === "ready" || claim.phase === "merged" ? claim.phase : null;
      if (from === null)
        throw new LogInconsistency(`claim ${claimId} cannot reopen while ${claim.phase}`);
      for (const ref of decisions) knownDecisionVersion(state, ref);
      return {
        ...endHolds(state, draft, [claimId], "dropped", seq),
        claims: draft.put(state.claims, claimId, {
          ...claim,
          phase: "working",
          ready: null,
          reopened: from,
        }),
      };
    }
    case "claim.merged": {
      const { claimId, generation } = event.data;
      const claim = known(state.claims, claimId, "claim");
      currentGeneration(claim, generation);
      check(claim.phase === "ready", `claim ${claimId} merged while ${claim.phase}`);
      return { ...state, claims: draft.put(state.claims, claimId, { ...claim, phase: "merged" }) };
    }
    case "claim.expired": {
      const { claimId, generation } = event.data;
      const claim = known(state.claims, claimId, "claim");
      currentGeneration(claim, generation);
      check(claim.phase !== "expired", `claim ${claimId} already expired`);
      return {
        ...endHolds(state, draft, [claimId], "dropped", seq),
        claims: draft.put(state.claims, claimId, { ...claim, phase: "expired" }),
      };
    }
    case "claim.reassigned": {
      const { claimId, from, to, generation } = event.data;
      const claim = known(state.claims, claimId, "claim");
      check(claim.agentId === from, `claim ${claimId} is not held by ${from}`);
      check(generation > claim.generation, `claim ${claimId} reassigned to an old generation`);
      confirmedAgent(state, to);
      return {
        ...endHolds(state, draft, [claimId], "superseded", seq),
        claims: draft.put(state.claims, claimId, {
          ...claim,
          agentId: to,
          generation,
          phase: "working",
          ready: null,
          reopened: null,
        }),
      };
    }
    case "claim.adapted": {
      const { claimId, intentId, decision } = event.data;
      const claim = known(state.claims, claimId, "claim");
      const intent = known(state.intents, intentId, "intent");
      check(intent.landing.kind === "landed", `intent ${intentId} did not land`);
      check(intent.claims.includes(claimId), `intent ${intentId} did not land claim ${claimId}`);
      knownDecisionVersion(state, decision);
      const repeated = claim.adaptations.some(
        (ref) => ref.decisionId === decision.decisionId && ref.version === decision.version,
      );
      if (repeated) return state;
      return {
        ...state,
        claims: draft.put(state.claims, claimId, {
          ...claim,
          adaptations: draft.append(claim.adaptations, decision),
        }),
      };
    }
    case "question.asked": {
      const { questionId, claimId, decisionId, text, options } = event.data;
      fresh(state.questions, questionId, "question");
      known(state.claims, claimId, "claim");
      return {
        ...state,
        questions: draft.put(state.questions, questionId, {
          questionId,
          claimId,
          decisionId,
          text,
          options,
        }),
      };
    }
    case "decision.recorded": {
      const { decisionId, version, questionId, option, scope } = event.data;
      const question = known(state.questions, questionId, "question");
      check(
        question.decisionId === decisionId,
        `question ${questionId} does not ask for decision ${decisionId}`,
      );
      check(
        question.options.some((candidate) => candidate.key === option),
        `question ${questionId} offers no option ${option}`,
      );
      const previous = own(state.decisions, decisionId)?.versions ?? [];
      check(
        version === previous.length + 1,
        `decision ${decisionId} recorded version ${version} after ${previous.length}`,
      );
      return {
        ...state,
        decisions: draft.put(state.decisions, decisionId, {
          decisionId,
          versions: draft.append(previous, { version, questionId, option, scope, seq }),
        }),
      };
    }
    case "inbox.queued": {
      const { agentId, claimId, item, entry } = event.data;
      const key = inboxKey(agentId, item);
      fresh(state.inbox, key, "inbox item");
      known(state.agents, agentId, "agent");
      known(state.claims, claimId, "claim");
      switch (entry.kind) {
        case "decision":
        case "rework":
          knownDecisionVersion(state, entry.decision);
          break;
        case "conflict":
          known(state.claims, entry.otherClaimId, "claim");
          break;
        default:
          return unreachable(entry);
      }
      return {
        ...state,
        inbox: draft.put(state.inbox, key, {
          agentId,
          claimId,
          item,
          entry,
          delivery: "queued",
          plan: null,
          queuedSeq: seq,
        }),
      };
    }
    case "inbox.delivered": {
      const { agentId, claimId, item } = event.data;
      const key = inboxKey(agentId, item);
      const entry = known(state.inbox, key, "inbox item");
      check(entry.claimId === claimId, `inbox item ${key} belongs to another claim`);
      // A redelivery after a reconnect never moves an acknowledged item back.
      if (entry.delivery !== "queued") return state;
      return { ...state, inbox: draft.put(state.inbox, key, { ...entry, delivery: "delivered" }) };
    }
    case "inbox.acked": {
      const { agentId, claimId, item, plan } = event.data;
      const key = inboxKey(agentId, item);
      const entry = known(state.inbox, key, "inbox item");
      check(entry.claimId === claimId, `inbox item ${key} belongs to another claim`);
      return {
        ...state,
        inbox: draft.put(state.inbox, key, { ...entry, delivery: "acknowledged", plan }),
      };
    }
    case "train.check": {
      const { checkRunId, candidate, check: name, result, acceptance } = event.data;
      if (acceptance !== null) {
        const version = knownDecisionVersion(state, acceptance.decision);
        const question = known(state.questions, version.questionId, "question");
        check(
          question.options.some((candidateOption) => candidateOption.key === acceptance.option),
          `acceptance check names option ${acceptance.option}, which its decision does not offer`,
        );
      }
      const run = own(state.checkRuns, checkRunId) ?? {
        checkRunId,
        candidate,
        results: [],
        unreported: null,
      };
      check(run.candidate === candidate, `check run ${checkRunId} changed its candidate`);
      check(run.unreported === null, `check run ${checkRunId} reported after it ended`);
      return {
        ...state,
        checkRuns: draft.put(state.checkRuns, checkRunId, {
          ...run,
          results: draft.append(run.results, { seq, check: name, result, acceptance }),
        }),
      };
    }
    case "train.conflict": {
      const { claims, path, class: conflictClass, probability, route } = event.data;
      for (const claimId of claims) known(state.claims, claimId, "claim");
      return {
        ...state,
        conflicts: draft.append(state.conflicts, {
          seq,
          claims,
          path,
          class: conflictClass,
          probability,
          route,
        }),
      };
    }
    case "train.intent": {
      const { intentId, expectedMain, candidate, claims, decisions, checkRunId } = event.data;
      fresh(state.intents, intentId, "intent");
      for (const claimId of claims) known(state.claims, claimId, "claim");
      for (const ref of decisions) knownDecisionVersion(state, ref);
      const run = known(state.checkRuns, checkRunId, "check run");
      check(run.candidate === candidate, `intent ${intentId} cites a check of another candidate`);
      return {
        ...endHolds(state, draft, claims, "superseded", seq, checkRunId),
        intents: draft.put(state.intents, intentId, {
          intentId,
          expectedMain,
          candidate,
          claims,
          decisions,
          checkRunId,
          landing: { kind: "pending" },
        }),
      };
    }
    case "train.main": {
      const { intentId, outcome, main } = event.data;
      const intent = known(state.intents, intentId, "intent");
      check(intent.landing.kind === "pending", `intent ${intentId} already has an outcome`);
      const landing = landingOf(intent, outcome, main);
      // Every check precedes the first write; see `FoldDraft`.
      for (const claimId of intent.claims) known(state.claims, claimId, "claim");
      let { claims } = state;
      if (landing.kind === "landed") {
        for (const claimId of intent.claims) {
          const claim = known(claims, claimId, "claim");
          // The phase changes only on `claim.merged`: a pin readied again while this landing was
          // published is sent back to the train, and its claim stays ready.
          claims = draft.put(claims, claimId, {
            ...claim,
            landings: draft.append(claim.landings, intentId),
          });
        }
      }
      return {
        ...state,
        main,
        claims,
        intents: draft.put(state.intents, intentId, { ...intent, landing }),
      };
    }
    case "train.held": {
      const { checkRunId, expectedMain, candidate, claims, paths, digest } = event.data;
      check(
        own(state.heldChecks, checkRunId) === undefined,
        `check run ${checkRunId} was held twice`,
      );
      for (const claimId of claims) known(state.claims, claimId, "claim");
      const ended = endHolds(state, draft, claims, "superseded", seq, checkRunId);
      let { heldByClaim } = ended;
      for (const claimId of claims) heldByClaim = draft.put(heldByClaim, claimId, checkRunId);
      return {
        ...ended,
        heldByClaim,
        heldChecks: draft.put(ended.heldChecks, checkRunId, {
          checkRunId,
          seq,
          expectedMain,
          candidate,
          claims,
          paths,
          digest,
          approval: null,
          ended: null,
        }),
      };
    }
    case "check.approved": {
      const { checkRunId, candidate, digest } = event.data;
      const held = known(state.heldChecks, checkRunId, "held check");
      check(held.candidate === candidate, `approval of ${checkRunId} names another candidate`);
      check(held.digest === digest, `approval of ${checkRunId} names another definition`);
      check(held.approval === null, `check run ${checkRunId} was approved twice`);
      return {
        ...state,
        heldChecks: draft.put(state.heldChecks, checkRunId, {
          ...held,
          approval: { userId: event.actor.id, seq },
        }),
      };
    }
    case "train.unreported": {
      const { checkRunId, candidate, outcome } = event.data;
      // The train refuses a report once the attempt has ended, and ends an attempt only once.
      check(
        own(state.checkRuns, checkRunId) === undefined,
        `check run ${checkRunId} already reported or ended`,
      );
      return {
        ...state,
        checkRuns: draft.put(state.checkRuns, checkRunId, {
          checkRunId,
          candidate,
          results: [],
          unreported: { outcome, seq },
        }),
      };
    }
    default:
      return unreachable(event);
  }
};

/**
 * Ends the latest held attempt of each of `claimIds` at `seq`, unless it is `except` (the attempt
 * the event itself continues) or already ended. Its claims' pins left it, so the train never runs it.
 */
const endHolds = (
  state: BoardState,
  draft: FoldDraft,
  claimIds: readonly ClaimId[],
  reason: HeldEndReason,
  seq: number,
  except: CheckRunId | null = null,
): BoardState => {
  let { heldChecks } = state;
  for (const claimId of claimIds) {
    const checkRunId = own(state.heldByClaim, claimId);
    if (checkRunId === undefined || checkRunId === except) continue;
    const held = known(heldChecks, checkRunId, "held check");
    if (held.ended !== null) continue;
    heldChecks = draft.put(heldChecks, checkRunId, { ...held, ended: { reason, seq } });
  }
  return heldChecks === state.heldChecks ? state : { ...state, heldChecks };
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled board event variant: ${JSON.stringify(value)}`);
};
