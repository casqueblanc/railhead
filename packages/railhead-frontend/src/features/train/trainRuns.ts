// Train outcomes: what became of each merge intent, derived from the folded board. Only a landed
// outcome means the candidate is on main; a passing check alone never does.

import type {
  CheckResult,
  CheckRunId,
  ClaimId,
  CommitSha,
  DecisionRef,
  IntentId,
} from "@railhead/shared/events";
import type { BoardState, IntentState } from "../board/boardState";

/** Every way a merge intent can stand. */
export type TrainOutcome =
  /** The train has not recorded an attempt to move main yet. */
  | { kind: "pending" }
  /** Main moved from the expected commit to the candidate. */
  | { kind: "landed" }
  /** The push result was uncertain; main was read back and is the candidate. */
  | { kind: "landed_after_read_back" }
  /** Main was no longer at the expected commit, so nothing changed. */
  | { kind: "main_moved"; main: CommitSha }
  /** The push result was uncertain; main was read back and is another commit. */
  | { kind: "not_landed_after_read_back"; main: CommitSha };

/** One claim the intent carried. `issueTitle` is untrusted text. */
export interface TrainClaim {
  claimId: ClaimId;
  issueTitle: string;
}

/** The results of the check run the intent cites, counted by result. */
export interface CheckSummary {
  checkRunId: CheckRunId;
  /** The commit the checks ran on: the intent's candidate. */
  candidate: CommitSha;
  counts: Readonly<Record<CheckResult, number>>;
}

/** One merge intent with its outcome. */
export interface TrainRun {
  intentId: IntentId;
  expectedMain: CommitSha;
  candidate: CommitSha;
  claims: readonly TrainClaim[];
  decisions: readonly DecisionRef[];
  checks: CheckSummary;
  outcome: TrainOutcome;
}

/** Merge intents, newest first. */
export const trainRuns = (state: BoardState): TrainRun[] =>
  // Intents are recorded in log order and never removed, so insertion order is log order.
  Object.values(state.intents)
    .map((intent) => runOf(state, intent))
    .toReversed();

/** The intent's outcome. Exhaustive over the fold's landing and main outcomes. */
export const outcomeOf = (intent: IntentState): TrainOutcome => {
  const { landing } = intent;
  switch (landing.kind) {
    case "pending":
      return { kind: "pending" };
    case "landed":
      return landing.outcome === "updated"
        ? { kind: "landed" }
        : { kind: "landed_after_read_back" };
    case "not_landed":
      return landing.outcome === "rejected"
        ? { kind: "main_moved", main: landing.main }
        : { kind: "not_landed_after_read_back", main: landing.main };
    default:
      return unreachable(landing);
  }
};

const runOf = (state: BoardState, intent: IntentState): TrainRun => {
  const counts: Record<CheckResult, number> = { pass: 0, fail: 0, error: 0 };
  // The fold refuses an intent whose check run was never recorded.
  for (const entry of own(state.checkRuns, intent.checkRunId)?.results ?? []) {
    counts[entry.result] += 1;
  }
  return {
    intentId: intent.intentId,
    expectedMain: intent.expectedMain,
    candidate: intent.candidate,
    claims: intent.claims.map((claimId) => {
      const claim = own(state.claims, claimId);
      const issue = claim === undefined ? undefined : own(state.issues, claim.issueId);
      return { claimId, issueTitle: issue?.title ?? claimId };
    }),
    decisions: intent.decisions,
    checks: { checkRunId: intent.checkRunId, candidate: intent.candidate, counts },
    outcome: outcomeOf(intent),
  };
};

const own = <T>(record: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const unreachable = (value: never): never => {
  throw new Error(`unhandled train outcome: ${JSON.stringify(value)}`);
};
