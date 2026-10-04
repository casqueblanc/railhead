// The issues section's rows, derived from the folded log. An issue the owner just filed shows here
// only once its `issue.filed` event is folded, and its status follows the latest claim on it: when
// a claim expires, a replacement agent takes the same issue record.

import type { IssueId } from "@railhead/shared/events";
import type { BoardState, ClaimState } from "../board/boardState";

/** How many issues the section lists, newest first. */
export const MAX_LISTED_ISSUES = 20;

/** Where an issue stands, from the latest claim on it. */
export type IssueStatus =
  /** No claim, or the latest one expired: the next agent to ask for work can take it. */
  | { kind: "open" }
  /** An agent holds a working or ready claim. `agent` is its untrusted name. */
  | { kind: "claimed"; agent: string }
  | { kind: "landed" };

/** One listed issue. Title and body are untrusted text. */
export interface IssueRow {
  issueId: IssueId;
  title: string;
  body: string;
  status: IssueStatus;
}

/** The newest issues first, at most `MAX_LISTED_ISSUES`, and how many older ones are not listed. */
export interface IssueList {
  rows: readonly IssueRow[];
  hidden: number;
}

/**
 * Lists the board's issues. The fold adds each issue and claim to its record in log order, so the
 * last one listed is the newest.
 */
export const issueList = (board: BoardState): IssueList => {
  const issues = Object.values(board.issues);
  const claims = Object.values(board.claims);
  const rows = issues
    .toReversed()
    .slice(0, MAX_LISTED_ISSUES)
    .map(({ issueId, title, body }): IssueRow => {
      const latest = claims.findLast((claim) => claim.issueId === issueId);
      return {
        issueId,
        title,
        body,
        status: latest === undefined ? OPEN : statusOf(board, latest),
      };
    });
  return { rows, hidden: issues.length - rows.length };
};

const OPEN: IssueStatus = { kind: "open" };

const statusOf = (board: BoardState, claim: ClaimState): IssueStatus => {
  switch (claim.phase) {
    case "working":
    case "ready":
      return { kind: "claimed", agent: board.agents[claim.agentId]?.name ?? claim.agentId };
    case "merged":
      return { kind: "landed" };
    case "expired":
      return OPEN;
    default:
      return unreachable(claim.phase);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled claim phase: ${JSON.stringify(value)}`);
};
