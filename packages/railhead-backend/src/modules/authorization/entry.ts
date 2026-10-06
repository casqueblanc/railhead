// Authorization: durable merge intents. The implementation is `createAuthorization` in
// `train/authorize.ts`. This file builds the fence readers both authorization and the main writer
// use; each calls `ports()` when it is read, never while the Repo is composed.

import type { AuthorizationPort } from "../../contracts/train";
import type { ModuleFactory, RepoPorts } from "../../repo/composeRepo";
import { createAuthorization, type AuthorizationReaders } from "../../train/authorize";

/** The in-transaction fence readers, each resolving `ports()` at the time of the read. */
export function authorizationReaders(ports: () => RepoPorts): AuthorizationReaders {
  return {
    attemptOutcome: (attemptId) => ports().train.attemptOutcome(attemptId),
    currentGeneration: (claimId) => ports().claims.currentGeneration(claimId),
    currentVersions: (claimId) => ports().decisions.currentVersions(claimId),
    readyPin: (claimId) => ports().claims.readyPin(claimId),
    readyGateNow: (claimId, generation) => ports().inbox.readyGateNow(claimId, generation),
  };
}

/** Builds the authorization module of one repository. */
export const authorization: ModuleFactory<AuthorizationPort> = (context, ports) =>
  createAuthorization(context, authorizationReaders(ports));
