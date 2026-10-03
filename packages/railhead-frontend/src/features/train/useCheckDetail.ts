import { useEffect, useState } from "react";
import type {
  BoardErrorCode,
  BoardResult,
  CheckDetail,
  CheckDetailState,
} from "@railhead/shared/board-api";
import type { CheckRunId, CommitSha } from "@railhead/shared/events";
import type { CheckDetailPort, CheckDetailUnavailableReason } from "../board/boardPorts";

/**
 * A run's detail once it reported. A listed run always has: the backend records the report before
 * it appends the run's first result to the log.
 */
export type ReportedCheckDetail = CheckDetail & {
  state: Extract<CheckDetailState, { kind: "reported" }>;
};

/** What the board knows of one run's recorded detail. */
export type CheckDetailLoad =
  | { kind: "closed" }
  | { kind: "loading" }
  | { kind: "loaded"; detail: ReportedCheckDetail }
  /**
   * The backend refused, or its answer does not match the listed run: another run or commit, or
   * no report.
   */
  | { kind: "failed"; code: BoardErrorCode | "mismatch" }
  /** The board cannot ask right now. */
  | { kind: "unavailable"; reason: CheckDetailUnavailableReason };

/** The run the board asks about. `results` counts its results in the log so far. */
export interface CheckRunKey {
  checkRunId: CheckRunId;
  candidate: CommitSha;
  results: number;
}

/**
 * Reads the run's detail while `open`. A new result for the run in the log reads it again, so an
 * open detail never keeps showing an older answer. A loaded answer stays shown
 * when the session is lost; `onRetry` asks again after a failure.
 */
export const useCheckDetail = (
  port: CheckDetailPort,
  run: CheckRunKey,
  open: boolean,
): { load: CheckDetailLoad; onRetry: () => void } => {
  const [attempt, setAttempt] = useState(0);
  const [settled, setSettled] = useState<{ key: string; load: CheckDetailLoad } | null>(null);
  const { checkRunId, candidate } = run;
  const key = `${checkRunId}/${candidate}/${run.results}/${attempt}`;
  const onReadCheck = port.kind === "available" ? port.onReadCheck : null;
  const answered = settled?.key === key;

  useEffect(() => {
    if (!open || onReadCheck === null || answered) return;
    let current = true;
    // The live port never rejects; any other port that does is shown as a failed read.
    void onReadCheck(checkRunId).then(
      (result) => {
        if (current) setSettled({ key, load: loadOf(result, checkRunId, candidate) });
      },
      () => {
        if (current) setSettled({ key, load: { kind: "failed", code: "internal" } });
      },
    );
    return () => {
      current = false;
    };
  }, [open, onReadCheck, answered, checkRunId, candidate, key]);

  const onRetry = () => setAttempt((count) => count + 1);
  if (!open) return { load: { kind: "closed" }, onRetry };
  if (settled !== null && settled.key === key) return { load: settled.load, onRetry };
  if (port.kind === "unavailable") {
    return { load: { kind: "unavailable", reason: port.reason }, onRetry };
  }
  return { load: { kind: "loading" }, onRetry };
};

const loadOf = (
  result: BoardResult<CheckDetail>,
  checkRunId: CheckRunId,
  candidate: CommitSha,
): CheckDetailLoad => {
  if (!result.ok) return { kind: "failed", code: result.code };
  const detail = result.value;
  const { state } = detail;
  if (
    detail.checkRunId !== checkRunId ||
    detail.candidate !== candidate ||
    state.kind !== "reported"
  ) {
    return { kind: "failed", code: "mismatch" };
  }
  return { kind: "loaded", detail: { ...detail, state } };
};
