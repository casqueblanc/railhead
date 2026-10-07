// Queues a pin the way `ready` does, for train tests that start from a pin rather than a claim.

import type { CheckRunId, CommitSha } from "@railhead/shared/events";
import type { ClaimPin } from "../src/contracts/claims";
import type { PortResult } from "../src/contracts/result";
import type { Train } from "../src/modules/train/scheduler";
import type { EventLog } from "../src/repo/eventLog";

/** The last ready episode `enqueue` used; each call takes the next, as each `ready` does. */
let episodes = 0;

/** A train with `enqueue`, which only tests have. */
export interface QueueingTrain extends Train {
  /**
   * Queues `pin` through `queue` in a transaction of its own, as `ready` does, then drives the train
   * as the Repo's alarm would once that transaction commits. The pin is a new ready episode, numbered
   * `episode` when given. A refused pin is not driven. A drive that throws is logged and not
   * rethrown, as the alarm does.
   */
  enqueue(pin: ClaimPin, episode?: number): Promise<PortResult<{ queued: boolean }>>;
  /** Calls `release` in a transaction of its own, as the checks module does for an approval. */
  releaseHeld(attemptId: CheckRunId): boolean;
}

/** Adds `enqueue` to `train`, queuing through `log`, the Repo's event log. */
export function queueing(train: Train, log: EventLog): QueueingTrain {
  return {
    ...train,
    async enqueue(pin, episode) {
      episodes += 1;
      const result = log.transaction((tx) => train.queue(tx, pin, episode ?? episodes)).value;
      if (!result.ok) return result;
      try {
        await train.drive();
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        console.error(JSON.stringify({ event: "train.drive_failed", error: name }));
      }
      return result;
    },
    releaseHeld(attemptId) {
      return log.transaction((tx) => train.release(tx, attemptId)).value;
    },
  };
}

/** A distinct candidate for each main and pin list, as a real merge would produce. */
export function candidateOf(main: CommitSha, pins: ClaimPin[]): CommitSha {
  const key = `${main}:${pins.map((p) => `${p.claimId}@${p.generation}:${p.commit}`).join(",")}`;
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(8, "0").repeat(5);
}
