// Checks: trusted check runs on exact candidates. While missing, nothing runs, so nothing passes. Until its task installs the module, every call refuses with `unavailable` and has no effect.

import type { CheckPort } from "../../contracts/train";
import { unavailableChecks } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the checks module of one repository. */
export const checks: ModuleFactory<CheckPort> = () => unavailableChecks;
