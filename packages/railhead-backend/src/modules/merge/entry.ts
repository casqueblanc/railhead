// Merge: composing pins into a candidate in the sandbox. Until its task installs the module, every call refuses with `unavailable` and has no effect.

import type { MergePort } from "../../contracts/train";
import { unavailableMerge } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the merge module of one repository. */
export const merge: ModuleFactory<MergePort> = () => unavailableMerge;
