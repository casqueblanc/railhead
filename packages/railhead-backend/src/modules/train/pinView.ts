// The agent's view of its own pin on the train: where the queue entry of one claim at one
// generation stands, and the state of the batch holding it. The caller decides whose pin it may
// read; this module reads only the entry it is given and the active batch.

import type { PinBatchState, PinTrainState, PinView } from "@railhead/shared/agent-api";
import type { ClaimId } from "@railhead/shared/events";
import { fail, ok, type PortResult } from "../../contracts/result";
import { activeBatch, queuePosition, readEntry, type BatchRecord, type QueueEntry } from "./store";

/**
 * The train's view of the entry of `claimId` at exactly `generation`, or `null` when the queue holds
 * none. An entry of another generation is never read. Every read is synchronous, so the entry and
 * the batch come from the same state.
 */
export function readPinView(
  sql: SqlStorage,
  claimId: ClaimId,
  generation: number,
): PortResult<PinView | null> {
  const entry = readEntry(sql, claimId, generation);
  if (entry === null) return ok(null);
  const state = trainState(sql, entry);
  if (state === null) return fail("internal", "The train's queue and batch disagree.");
  return ok({
    claimId: entry.pin.claimId,
    generation,
    commit: entry.pin.commit,
    nextCommit: entry.nextCommit,
    state,
  });
}

/** Where `entry` stands, or `null` when the queue and the batch disagree. */
function trainState(sql: SqlStorage, entry: QueueEntry): PinTrainState | null {
  const { pin, reason } = entry;
  const { claimId, generation } = pin;
  switch (entry.state) {
    case "queued": {
      const position = queuePosition(sql, claimId, generation);
      return position === null ? null : { kind: "queued", position };
    }
    case "batched": {
      const batch = activeBatch(sql);
      if (batch === null || !holds(batch, claimId, generation)) return null;
      const stage = batchState(batch);
      if (stage === null) return null;
      return { kind: "batched", batchId: batch.batchId, batch: stage, checkRunId: batch.attemptId };
    }
    case "landed":
      return { kind: "landed" };
    case "dropped":
      return reason === null ? null : { kind: "dropped", reason };
    case "parked":
      return reason === null ? null : { kind: "parked", reason };
    default:
      return unreachable(entry.state);
  }
}

function holds(batch: BatchRecord, claimId: ClaimId, generation: number): boolean {
  return batch.pins.some((pin) => pin.claimId === claimId && pin.generation === generation);
}

/** The agent-facing state of the active batch; `null` for a settled one, which is never active. */
function batchState(batch: BatchRecord): PinBatchState | null {
  switch (batch.state) {
    case "composing":
      return "forming";
    case "checking":
      return batch.checkHeld ? "held" : "checking";
    case "passed":
      return "landing";
    case "landed":
    case "failed":
      return null;
    default:
      return unreachable(batch.state);
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled train state: ${JSON.stringify(value)}`);
}
