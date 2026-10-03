// Queues a pin the way `ready` does, for train tests that start from a pin rather than a claim.

import type { ClaimPin } from "../src/contracts/claims";
import type { PortResult } from "../src/contracts/result";
import type { Train } from "../src/modules/train/scheduler";
import type { EventLog } from "../src/repo/eventLog";

/** A train with `enqueue`, which only tests have. */
export interface QueueingTrain extends Train {
  /**
   * Queues `pin` through `queue` in a transaction of its own, as `ready` does, then drives the train
   * as the Repo's alarm would once that transaction commits. A refused pin is not driven. A drive
   * that throws is logged and not rethrown, as the alarm does.
   */
  enqueue(pin: ClaimPin): Promise<PortResult<{ queued: boolean }>>;
}

/** Adds `enqueue` to `train`, queuing through `log`, the Repo's event log. */
export function queueing(train: Train, log: EventLog): QueueingTrain {
  return {
    ...train,
    async enqueue(pin) {
      const result = log.transaction((tx) => train.queue(tx, pin)).value;
      if (!result.ok) return result;
      try {
        await train.drive();
      } catch (error) {
        const name = error instanceof Error ? error.name : "unknown";
        console.error(JSON.stringify({ event: "train.drive_failed", error: name }));
      }
      return result;
    },
  };
}
