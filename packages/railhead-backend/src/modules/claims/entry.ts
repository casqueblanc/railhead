// Claims: issues, claims, pins and the Git gateway's authority, implemented by `createClaims` in
// `module.ts`. Main is read through the main writer and commits are checked through Artifacts, so
// while either module is missing allocation and `ready` fail closed, with no fork and no pin.

import type { ClaimsPort } from "../../contracts/claims";
import type { ModuleFactory } from "../../repo/composeRepo";
import { createClaims } from "./module";

/** Builds the claims module of one repository. */
export const claims: ModuleFactory<ClaimsPort> = (context, ports) => createClaims(context, ports);
