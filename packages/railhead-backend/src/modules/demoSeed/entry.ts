// Demo seed: the owner's seed and reset of `demo/upload-app`, the repository the board opens by
// default. It is not part of the Repo composition. Two `Repo` objects play fixed roles, chosen by
// name: `DEMO_SEED_CONTROL` holds the passkey authority, and `demo/upload-app` itself runs the seed
// and reset once a proof is spent. No other object accepts either call, so the seed cannot touch
// another repository.
//
// The Artifacts namespace comes from the Worker's `ARTIFACTS` binding when it is declared; without
// it, seed and reset fail with `unavailable` and change nothing.

import {
  DEMO_ORG,
  DEMO_REPO,
  type ActionChallenge,
  type DemoSeedAction,
  type DemoSeedResult,
  type DemoSeedState,
  type PasskeyAssertion,
} from "@railhead/shared/board-api";
import type { RepoId } from "@railhead/shared/events";
import { relyingParty } from "../../auth/passkeyVerifier";
import type { PortResult } from "../../contracts/result";
import type { RepoStorage } from "../../repo/storage";
import type { InstanceOwnerPort } from "../owner/entry";
import { OWNER_OBJECT_NAME } from "../owner/OwnerObject";
import { checkPerformInput, createSeedControl, type SeedControl } from "./control";
import { artifactsBinding, createSeedTarget, type SeedTarget } from "./target";

/**
 * The `Repo` object that holds the demo seed's passkey authority. The colon is outside the
 * repository segment grammar, so no `org/name` route reaches this object and `initialize` refuses
 * every repository name on it: it never becomes a repository.
 */
export const DEMO_SEED_CONTROL = "railhead:demo-seed";

/** The `Repo` object name of the demo repository. */
export const DEMO_OBJECT_NAME = `${DEMO_ORG}/${DEMO_REPO}`;

/** The demo seed as the RPC gateway reaches it. */
export interface DemoSeedPort {
  /** The demo repository, or `null` when it does not exist. */
  read(): Promise<PortResult<DemoSeedState | null>>;
  /** Issues a challenge bound to `action`. */
  prepare(action: DemoSeedAction): Promise<PortResult<ActionChallenge>>;
  /** Performs the action the challenge names; at most once. */
  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
    bundle: Uint8Array | null,
  ): Promise<PortResult<DemoSeedResult>>;
}

/**
 * The demo seed through the two fixed `Repo` objects. A fresh stub per call. `perform` is
 * unauthenticated until the control opens the seal, so its stateless checks run here first.
 */
export function demoSeedPort(env: Env): DemoSeedPort {
  const control = () => env.REPO.getByName(DEMO_SEED_CONTROL);
  const demo = () => env.REPO.getByName(DEMO_OBJECT_NAME);
  return {
    read: () => demo().demoSeedState(),
    prepare: (action) => control().prepareDemoSeed(action),
    perform: async (challengeId, assertion, bundle) => {
      const input = checkPerformInput(challengeId, bundle);
      if (!input.ok) return input;
      return control().performDemoSeed(challengeId, assertion, bundle);
    },
  };
}

/** The demo repository's identifier: the one its `Repo` records when it is initialized. */
export function demoRepoId(env: Env): RepoId {
  return `rep_${env.REPO.idFromName(DEMO_OBJECT_NAME).toString()}`;
}

/** Builds the control inside the `Repo` named `DEMO_SEED_CONTROL`. */
export function demoSeedControl(storage: RepoStorage, env: Env): SeedControl {
  const demo = () => env.REPO.getByName(DEMO_OBJECT_NAME);
  return createSeedControl({
    storage,
    clock: Date.now,
    repoId: demoRepoId(env),
    instance: instanceOwner(env),
    relyingParty: relyingParty(env.RELYING_PARTY_HOST),
    target: {
      seed: (head, pack) => demo().seedDemo(head, pack),
      reset: () => demo().resetDemo(),
    },
  });
}

/** What the demo repository's `Repo` lends its seed target. */
export interface DemoSeedHost {
  /** The Repo's identifier. */
  readonly repoId: RepoId;
  /** The Repo's storage. */
  readonly storage: RepoStorage;
  /** Whether the Repo has been initialized. */
  initialized(): boolean;
  /** Initializes the Repo as `demo/upload-app`. */
  initialize(): PortResult<unknown>;
  /** Deletes all of the Repo's storage and forgets its modules. */
  wipe(): Promise<void>;
}

/** Builds the seed target inside the `Repo` named `DEMO_OBJECT_NAME`. */
export function demoSeedTarget(host: DemoSeedHost, env: Env): SeedTarget {
  return createSeedTarget({
    repoId: host.repoId,
    storage: host.storage,
    artifacts: artifactsBinding(env),
    fetch: (input, init) => fetch(input, init),
    clock: Date.now,
    initialized: () => host.initialized(),
    initialize: () => host.initialize(),
    wipe: () => host.wipe(),
  });
}

/** The instance's `Owner` object as a port, a fresh stub per call. */
function instanceOwner(env: Env): InstanceOwnerPort {
  const stub = () => env.OWNER.getByName(OWNER_OBJECT_NAME);
  return {
    credential: () => stub().credential(),
    recordSignCount: (credentialId, signCount) => stub().recordSignCount(credentialId, signCount),
  };
}
