// Claims: issues, claims, pins and the Git gateway's authority. While missing, no Git request is authorized. Until its task installs the module, every asynchronous call refuses with `unavailable`, the synchronous fence reader `currentGeneration` returns `null` (unknown, so callers refuse), and no call has an effect.

import type { ClaimsPort } from "../../contracts/claims";
import { unavailableClaims } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the claims module of one repository. */
export const claims: ModuleFactory<ClaimsPort> = () => unavailableClaims;
