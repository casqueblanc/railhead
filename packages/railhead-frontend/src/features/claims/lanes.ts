// Claim lanes: one row per claim, derived from the folded board. Nothing here is stored; a lane
// says only what the log recorded, including why the claim is waiting.

import type {
  AgentId,
  ClaimId,
  CommitSha,
  DecisionRef,
  IssueId,
  QuestionId,
  RefusalReason,
} from "@railhead/shared/events";
import {
  inboxKey,
  type AgentStatus,
  type BoardState,
  type ClaimPush,
  type ClaimState,
} from "../board/boardState";

/** Where a lane stands, most urgent first in `LANE_ORDER`. */
export type LaneStatus =
  /** The claim's last action at its current generation was refused. */
  | { kind: "refused"; reason: RefusalReason }
  /** The claim asked a question that has no decision yet. */
  | { kind: "waiting_on_decision"; questions: readonly QuestionId[] }
  | { kind: "working" }
  /** The claim pinned `commit` for the train. */
  | { kind: "ready"; commit: CommitSha; decisions: readonly DecisionRef[] }
  | { kind: "landed" }
  | { kind: "expired" };

/**
 * Something queued for the claim's agent that it has not acknowledged. `key` is the item's
 * `inboxKey`.
 */
export type LaneInboxItem = { key: string } & (
  | { kind: "decision"; decision: DecisionRef }
  | { kind: "rework"; decision: DecisionRef }
  /** `otherIssueTitle` is untrusted text, or `null` when the other claim's issue is unknown. */
  | { kind: "conflict"; otherClaimId: ClaimId; otherIssueTitle: string | null; path: string }
);

/** One lane. `issueTitle` and `agentName` are untrusted text. */
export interface ClaimLane {
  claimId: ClaimId;
  issueId: IssueId;
  issueTitle: string;
  agentId: AgentId;
  agentName: string;
  /** `null` only if the log never recorded the agent, which the fold does not allow. */
  agentStatus: AgentStatus | null;
  generation: number;
  base: CommitSha;
  head: CommitSha | null;
  status: LaneStatus;
  /** A refusal recorded against an older generation; informational, it no longer blocks. */
  staleRefusal: { generation: number; reason: RefusalReason } | null;
  /** Unacknowledged inbox items, oldest first. */
  inbox: readonly LaneInboxItem[];
  /** Recent pushes, newest first. */
  pushes: readonly ClaimPush[];
  landings: number;
}

/** Lanes, most urgent status first and in log order within a status. */
export const claimLanes = (state: BoardState): ClaimLane[] =>
  Object.values(state.claims)
    .map((claim) => laneOf(state, claim))
    .map((lane, index) => ({ lane, index }))
    .toSorted(
      (a, b) =>
        LANE_ORDER[a.lane.status.kind] - LANE_ORDER[b.lane.status.kind] || a.index - b.index,
    )
    .map(({ lane }) => lane);

/** The order lanes are listed in: blocked first, then active, then finished. */
export const LANE_ORDER: Readonly<Record<LaneStatus["kind"], number>> = {
  refused: 0,
  waiting_on_decision: 1,
  working: 2,
  ready: 3,
  landed: 4,
  expired: 5,
};

const laneOf = (state: BoardState, claim: ClaimState): ClaimLane => {
  const issue = own(state.issues, claim.issueId);
  const agent = own(state.agents, claim.agentId);
  const current = claim.refusal !== null && claim.refusal.generation === claim.generation;
  return {
    claimId: claim.claimId,
    issueId: claim.issueId,
    // The fold refuses a claim whose issue or agent was never recorded, so these are present.
    issueTitle: issue?.title ?? claim.issueId,
    agentId: claim.agentId,
    agentName: agent?.name ?? claim.agentId,
    agentStatus: agent?.status ?? null,
    generation: claim.generation,
    base: claim.base,
    head: claim.head,
    status: statusOf(state, claim),
    staleRefusal: claim.refusal !== null && !current ? claim.refusal : null,
    inbox: inboxOf(state, claim.claimId),
    pushes: claim.pushes.toReversed(),
    landings: claim.landings.length,
  };
};

const statusOf = (state: BoardState, claim: ClaimState): LaneStatus => {
  switch (claim.phase) {
    case "expired":
      return { kind: "expired" };
    case "landed":
      return { kind: "landed" };
    case "ready":
      // A ready claim always carries its pinned commit; see `ClaimState.ready`.
      return claim.ready === null
        ? { kind: "working" }
        : { kind: "ready", commit: claim.ready.commit, decisions: claim.ready.decisions };
    case "working": {
      if (claim.refusal !== null && claim.refusal.generation === claim.generation) {
        return { kind: "refused", reason: claim.refusal.reason };
      }
      const open = Object.values(state.questions)
        .filter((q) => q.claimId === claim.claimId && !Object.hasOwn(state.decisions, q.decisionId))
        .map((q) => q.questionId);
      return open.length > 0
        ? { kind: "waiting_on_decision", questions: open }
        : { kind: "working" };
    }
    default:
      return unreachable(claim.phase);
  }
};

const inboxOf = (state: BoardState, claimId: ClaimId): LaneInboxItem[] =>
  Object.values(state.inbox)
    .filter((item) => item.claimId === claimId && item.delivery !== "acknowledged")
    .toSorted((a, b) => a.queuedSeq - b.queuedSeq)
    .map(({ agentId, item, entry }): LaneInboxItem => {
      const key = inboxKey(agentId, item);
      switch (entry.kind) {
        case "decision":
        case "rework":
          return { key, ...entry };
        case "conflict": {
          const other = own(state.claims, entry.otherClaimId);
          const issue = other === undefined ? undefined : own(state.issues, other.issueId);
          return {
            key,
            kind: "conflict",
            otherClaimId: entry.otherClaimId,
            otherIssueTitle: issue?.title ?? null,
            path: entry.path,
          };
        }
        default:
          return unreachable(entry);
      }
    });

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const unreachable = (value: never): never => {
  throw new Error(`unhandled claim lane variant: ${JSON.stringify(value)}`);
};
