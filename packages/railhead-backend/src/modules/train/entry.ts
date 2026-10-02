// Train: the queue of ready pins, one batch at a time, and check bookkeeping. Main's commit and the
// trusted check definitions come from ports #107 adds; until then they refuse with `unavailable`,
// so pins queue but no batch starts.

import type { TrainPort } from "../../contracts/train";
import { unavailable } from "../../contracts/result";
import type { ModuleFactory } from "../../repo/composeRepo";
import { createTrain, type TrainDeps } from "./scheduler";

// #107 replaces these with `ports().mainWriter.head()` and `ports().checks.definitions(main)`.
const pendingContract: TrainDeps = {
  mainHead: async () => unavailable("mainWriter"),
  checkDefinitions: async () => unavailable("checks"),
};

/** Builds the train module of one repository. */
export const train: ModuleFactory<TrainPort> = (context, ports) => {
  const { enqueue, recordCheck } = createTrain(context, ports, pendingContract);
  return { enqueue, recordCheck };
};
