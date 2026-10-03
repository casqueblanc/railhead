// The implementation of each port while its module is not installed. Every asynchronous method
// refuses with `unavailable`, and each synchronous fence reader returns `null`; neither does
// anything else. Each port holds no state and receives no storage, so it cannot record an effect.
// In particular the ready gate is never `clear` and no check ever passes by default; a missing
// security module blocks the action it guards.
//
// The fence readers cannot return a `PortFailure`, so their `null` is what each contract defines
// as unknown: no attempt, no current generation and no decision list, never an empty one. A
// caller treats `null` as a refusal.

import type { ArtifactsPort } from "./artifacts";
import type { ClaimsPort } from "./claims";
import type { DecisionsPort } from "./decisions";
import type { IdentityPort, SessionsPort } from "./identity";
import type { InboxPort } from "./inbox";
import { unavailable, type PortFailure, type PortName } from "./result";
import type {
  AuthorizationPort,
  CheckPort,
  MainRefPort,
  MainWriterPort,
  MergePort,
  TrainPort,
} from "./train";

/** Identity while its module is missing. */
export const unavailableIdentity: IdentityPort = {
  join: refuse("identity"),
  createInvite: refuse("identity"),
  confirm: refuse("identity"),
  revoke: refuse("identity"),
  pendingJoins: refuse("identity"),
  view: refuse("identity"),
  credential: refuse("identity"),
};

/** Sessions while its module is missing: no caller authenticates. */
export const unavailableSessions: SessionsPort = {
  issueChallenge: refuse("sessions"),
  redeem: refuse("sessions"),
  authenticate: refuse("sessions"),
};

/** Claims while its module is missing: no Git request is authorized, and nothing is owed. */
export const unavailableClaims: ClaimsPort = {
  activeClaim: refuse("claims"),
  work: refuse("claims"),
  claim: refuse("claims"),
  ready: refuse("claims"),
  pin: refuse("claims"),
  currentGeneration: () => null,
  workingGeneration: () => null,
  workingEpisode: () => null,
  readyPin: () => null,
  reopen: () => {
    throw new UnavailableError("claims");
  },
  authorizeGit: refuse("claims"),
  fileIssue: refuse("claims"),
  resume: async () => {},
};

/** Inbox while its module is missing: the ready gate is never clear. */
export const unavailableInbox: InboxPort = {
  pending: refuse("inbox"),
  digest: refuse("inbox"),
  ack: refuse("inbox"),
  queue: () => {
    throw new UnavailableError("inbox");
  },
  readyGate: refuse("inbox"),
  readyGateNow: () => null,
};

/**
 * Decisions while its module is missing: no requirement list, so nothing is authorized, and no
 * dependency is moved or relied on, so its caller's transaction rolls back.
 */
export const unavailableDecisions: DecisionsPort = {
  ask: refuse("decisions"),
  question: refuse("decisions"),
  record: refuse("decisions"),
  requirements: refuse("decisions"),
  currentVersions: () => null,
  currentDecision: () => null,
  transfer: () => {
    throw new UnavailableError("decisions");
  },
  relied: () => {
    throw new UnavailableError("decisions");
  },
  obligations: () => null,
};

/** Artifacts while its module is missing. */
export const unavailableArtifacts: ArtifactsPort = {
  forkForClaim: refuse("artifacts"),
  commitExists: refuse("artifacts"),
  token: refuse("artifacts"),
  revokeTokens: refuse("artifacts"),
};

/** Merging while its module is missing. */
export const unavailableMerge: MergePort = {
  compose: refuse("merge"),
  discard: refuse("merge"),
};

/** Checks while their module is missing: nothing runs, so nothing passes. */
export const unavailableChecks: CheckPort = {
  definitions: refuse("checks"),
  start: refuse("checks"),
  report: refuse("checks"),
  approve: refuse("checks"),
  detail: refuse("checks"),
};

/**
 * The train while its module is missing: no pin is queued, so no ready is recorded, no report is
 * recorded, no attempt is known and nothing is owed, so `resume` does nothing.
 */
export const unavailableTrain: TrainPort = {
  queue: () => {
    throw new UnavailableError("train");
  },
  recordCheck: refuse("train"),
  attemptOutcome: () => null,
  holdsLiveEntry: () => null,
  pinView: refuse("train"),
  armWake: async () => false,
  release: () => false,
  holds: () => false,
  resume: async () => {},
  startup: async () => true,
};

/** Authorization while its module is missing: no intent is authorized. */
export const unavailableAuthorization: AuthorizationPort = {
  authorize: refuse("authorization"),
  intent: refuse("authorization"),
  record: () => null,
  unsettled: () => {
    throw new UnavailableError("authorization");
  },
  recordWrite: () => {
    throw new UnavailableError("authorization");
  },
};

/** Main's ref while the main writer is missing: main is neither read nor moved. */
export const unavailableMainRef: MainRefPort = {
  read: refuse("mainWriter"),
  update: refuse("mainWriter"),
};

/** The main writer while its module is missing. */
export const unavailableMainWriter: MainWriterPort = {
  head: refuse("mainWriter"),
  publish: refuse("mainWriter"),
};

/**
 * Thrown by a synchronous method of a missing module, inside its caller's transaction, so the
 * caller's whole change rolls back.
 */
export class UnavailableError extends Error {
  /** The missing module. */
  readonly port: PortName;

  constructor(port: PortName) {
    super(`The ${port} module is not available.`);
    this.name = "UnavailableError";
    this.port = port;
  }
}

/** A method that ignores its arguments and refuses. */
function refuse(port: PortName): () => Promise<PortFailure> {
  return async () => unavailable(port);
}
