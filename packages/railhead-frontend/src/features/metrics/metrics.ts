// Measured totals: raw counts over the folded log. Every number here is counted from recorded
// events, so a replay shows what the live board showed and a duplicate never adds to a count. No
// ratio is derived: a rate would need a definition the board does not have yet, and a target is
// never shown as if it were measured.

import type { CheckResult } from "@railhead/shared/events";
import { ACTIVITY_WINDOW_MINUTES, type BoardState } from "../board/boardState";

/** Activity in the recent window of the log. */
export interface RecentActivity {
  /**
   * How many minutes the window covers: `ACTIVITY_WINDOW_MINUTES`, or fewer when the log itself
   * spans less time.
   */
  minutes: number;
  claimsOpened: number;
  checksRun: number;
  changesLanded: number;
}

/** The board's measured totals. */
export interface BoardMetrics {
  /** Questions agents asked. */
  questionsAsked: number;
  /** Events a person recorded: invites, confirmations, revocations, filed issues and decisions. */
  humanActions: number;
  /** Check results recorded, by result. A failure and a check that could not run both count. */
  checks: Readonly<Record<CheckResult, number>>;
  /** Claims carried by merges that moved main to their candidate. */
  changesLanded: number;
  /** Claims being worked on or waiting to merge. */
  activeClaims: number;
  /** Activity in the window ending at the newest event, or `null` before the first event. */
  recent: RecentActivity | null;
}

/** Counts the board's measured totals. */
export const boardMetrics = (state: BoardState): BoardMetrics => {
  const checks: Record<CheckResult, number> = { pass: 0, fail: 0, error: 0 };
  for (const run of Object.values(state.checkRuns)) {
    for (const entry of run.results) checks[entry.result] += 1;
  }
  const claims = Object.values(state.claims);
  return {
    questionsAsked: Object.keys(state.questions).length,
    humanActions: state.totals.humanActions,
    checks,
    changesLanded: claims.reduce((sum, claim) => sum + claim.landings.length, 0),
    activeClaims: claims.filter((claim) => claim.phase === "working" || claim.phase === "ready")
      .length,
    recent: recentActivity(state),
  };
};

const MINUTE_MS = 60_000;

const recentActivity = (state: BoardState): RecentActivity | null => {
  const { earliestAt, lastAt } = state.totals;
  if (earliestAt === null || lastAt === null) return null;
  const spanned = Math.floor(lastAt / MINUTE_MS) - Math.floor(earliestAt / MINUTE_MS) + 1;
  const activity: RecentActivity = {
    minutes: Math.min(ACTIVITY_WINDOW_MINUTES, spanned),
    claimsOpened: 0,
    checksRun: 0,
    changesLanded: 0,
  };
  for (const minute of state.recent) {
    activity.claimsOpened += minute.claimsOpened;
    activity.checksRun += minute.checksRun;
    activity.changesLanded += minute.changesLanded;
  }
  return activity;
};
