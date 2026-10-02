// Train: the queue of ready pins and check bookkeeping. Until its task installs the module, every call refuses with `unavailable` and has no effect.

import type { TrainPort } from "../../contracts/train";
import { unavailableTrain } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the train module of one repository. */
export const train: ModuleFactory<TrainPort> = () => unavailableTrain;
