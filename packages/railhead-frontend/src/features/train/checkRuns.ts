// Check runs: every run the train recorded, newest first, with each result as the log gave it. A
// failing run often never reaches a merge, so runs are listed on their own, not only under the
// intent that cites them.

import type {
  CheckResult,
  CheckRunId,
  CommitSha,
  DecisionRef,
  IntentId,
} from "@railhead/shared/events";
import type { BoardState } from "../board/boardState";

/** How many check runs the train section lists. Older runs remain in the log and the totals. */
export const MAX_LISTED_CHECK_RUNS = 20;

/** One check result in a run. `check` is the definition's name, repository content. */
export interface CheckRunResult {
  check: string;
  result: CheckResult;
  /** For an acceptance check, the decision version and option it proves. */
  acceptance: { decision: DecisionRef; option: string } | null;
}

/** One check run with its results. */
export interface CheckRunView {
  checkRunId: CheckRunId;
  /** The exact commit checked. */
  candidate: CommitSha;
  /** In log order. */
  results: readonly CheckRunResult[];
  /** The worst result: `fail` over `error` over `pass`. */
  overall: CheckResult;
  /** The merge intents citing this run, oldest first. */
  intents: readonly IntentId[];
}

/** The newest `MAX_LISTED_CHECK_RUNS` runs, newest first, and how many older ones were left out. */
export const checkRuns = (state: BoardState): { runs: CheckRunView[]; omitted: number } => {
  const intents = new Map<CheckRunId, IntentId[]>();
  for (const intent of Object.values(state.intents)) {
    const citing = intents.get(intent.checkRunId) ?? [];
    citing.push(intent.intentId);
    intents.set(intent.checkRunId, citing);
  }
  const all = Object.values(state.checkRuns)
    .map((run) => ({ run, last: run.results.at(-1)?.seq ?? 0 }))
    .toSorted((a, b) => b.last - a.last);
  return {
    runs: all.slice(0, MAX_LISTED_CHECK_RUNS).map(({ run }) => ({
      checkRunId: run.checkRunId,
      candidate: run.candidate,
      results: run.results.map(({ check, result, acceptance }) => ({ check, result, acceptance })),
      overall: overallResult(run.results.map((entry) => entry.result)),
      intents: intents.get(run.checkRunId) ?? [],
    })),
    omitted: Math.max(0, all.length - MAX_LISTED_CHECK_RUNS),
  };
};

const overallResult = (results: readonly CheckResult[]): CheckResult => {
  if (results.includes("fail")) return "fail";
  if (results.includes("error")) return "error";
  return "pass";
};
