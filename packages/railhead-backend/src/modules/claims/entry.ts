// Claims: issues, claims, pins and the Git gateway's authority. `createClaims` in `module.ts` files
// issues, allocates claims and reports their current generation; ready, pins and Git authority
// still refuse with `unavailable`. Main is read through the main writer, so while that module is
// missing every allocation fails closed, with no fork.

import type { ClaimsPort } from "../../contracts/claims";
import type { ModuleFactory } from "../../repo/composeRepo";
import { createClaims } from "./module";

/** Builds the claims module of one repository. */
export const claims: ModuleFactory<ClaimsPort> = (context, ports) => createClaims(context, ports);
