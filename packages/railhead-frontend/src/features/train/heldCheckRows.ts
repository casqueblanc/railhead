import type { CheckResult } from "@railhead/shared/events";
import type { BoardState, HeldCheckState, HeldEndReason } from "../board/boardState";
import { trainClaim, type TrainClaim } from "./trainRuns";

/** Where a held check stands, from the log alone. */
export type HeldCheckStatus =
  /** Waiting for the owner to approve the candidate's definition. */
  | { kind: "waiting" }
  /** The candidate has no valid definition, so there is nothing to approve. */
  | { kind: "unapprovable" }
  /** Approved; the train has not recorded a result for it yet. */
  | { kind: "approved" }
  /** Approved, and the run recorded `result`. */
  | { kind: "ran"; result: CheckResult }
  /** The train can no longer run it, so it can no longer be approved; see `HeldEndReason`. */
  | { kind: "ended"; reason: HeldEndReason };

/** One held check as the board shows it. Issue titles are untrusted text. */
export interface HeldCheckRow {
  held: HeldCheckState;
  claims: TrainClaim[];
  status: HeldCheckStatus;
}

/** Most held checks the board lists; the rest are counted, not rendered. */
export const MAX_SHOWN_HELD_CHECKS = 20;

/** Every held check, those waiting for the owner first, then newest first. */
export const heldCheckRows = (state: BoardState): HeldCheckRow[] =>
  Object.values(state.heldChecks)
    .map((held) => ({
      held,
      claims: held.claims.map((claimId) => trainClaim(state, claimId)),
      status: statusOf(state, held),
    }))
    .toSorted(
      (a, b) =>
        Number(b.status.kind === "waiting") - Number(a.status.kind === "waiting") ||
        b.held.seq - a.held.seq,
    );

const statusOf = (state: BoardState, held: HeldCheckState): HeldCheckStatus => {
  const runs = Object.hasOwn(state.checkRuns, held.checkRunId)
    ? state.checkRuns[held.checkRunId]
    : undefined;
  const result = runs?.results.at(-1)?.result;
  // A recorded result outlasts what happens to the claims afterwards.
  if (held.approval !== null && result !== undefined) return { kind: "ran", result };
  if (held.ended !== null) return { kind: "ended", reason: held.ended.reason };
  if (held.digest === null) return { kind: "unapprovable" };
  return held.approval === null ? { kind: "waiting" } : { kind: "approved" };
};
