// Authorization: durable merge intents. The implementation is `createAuthorization` in
// `train/authorize.ts`. Its readers are the in-transaction ones `mainWriter/entry.ts` builds from
// the ports; each calls `ports()` when authorization reads it, never while the Repo is composed.

import type { AuthorizationPort } from "../../contracts/train";
import type { ModuleFactory } from "../../repo/composeRepo";
import { createAuthorization } from "../../train/authorize";

/** Builds the authorization module of one repository. */
export const authorization: ModuleFactory<AuthorizationPort> = (context, ports) =>
  createAuthorization(context, {
    attemptOutcome: (attemptId) => ports().train.attemptOutcome(attemptId),
    currentGeneration: (claimId) => ports().claims.currentGeneration(claimId),
    currentVersions: (claimId) => ports().decisions.currentVersions(claimId),
    readyPin: (claimId) => ports().claims.readyPin(claimId),
    readyGateNow: (claimId, generation) => ports().inbox.readyGateNow(claimId, generation),
  });
