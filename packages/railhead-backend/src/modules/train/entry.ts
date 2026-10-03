// Train: the queue of ready pins, one batch at a time, and check bookkeeping. Main's commit comes
// from the main writer and the trusted check definitions from the checks module; while either is
// missing it refuses with `unavailable`, so pins queue but no batch starts.

import type { TrainPort } from "../../contracts/train";
import type { ModuleFactory } from "../../repo/composeRepo";
import { createTrain } from "./scheduler";

/** Builds the train module of one repository. */
export const train: ModuleFactory<TrainPort> = (context, ports) => {
  const { queue, recordCheck, attemptOutcome, hasEntry, resume } = createTrain(context, ports);
  return { queue, recordCheck, attemptOutcome, hasEntry, resume };
};
