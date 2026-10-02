// Claims: issues, claims, pins and the Git gateway's authority. `createClaims` in `module.ts` files
// issues and allocates claims; ready, pins and Git authority still refuse with `unavailable`. No
// port reads main yet, so allocation fails closed, with no fork, until `MainWriterPort.head` (#107)
// is wired in as the main reader.

import type { ClaimsPort } from "../../contracts/claims";
import type { ModuleFactory } from "../../repo/composeRepo";
import { CLAIMS_LIMITS, createClaims, noMainHead } from "./module";

/** Builds the claims module of one repository. */
export const claims: ModuleFactory<ClaimsPort> = (context, ports) =>
  createClaims(context, ports, { mainHead: noMainHead, limits: CLAIMS_LIMITS });
