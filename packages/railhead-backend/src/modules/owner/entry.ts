// Owner: the human-only actions on one repository, each performed once for one passkey assertion
// bound to it, and the enrollment of the instance owner's passkey.
//
// Each action goes through a sealed, single-use challenge (`sealedChallenge.ts`): `perform` opens
// the seal and spends the proof, and only then builds the `HumanGrant` and hands it to the one port
// that performs that action kind. A proof authorizes at most one attempt, whatever the action does.

import type {
  ActionChallenge,
  EnrollmentChallenge,
  OwnerAction,
  OwnerActionResult,
  PasskeyAssertion,
  PasskeyRegistration,
} from "@railhead/shared/board-api";
import type { UserId } from "@railhead/shared/events";
import { type RelyingParty, relyingParty } from "../../auth/passkeyVerifier";
import type { HumanGrant } from "../../contracts/principals";
import { ok, type PortResult } from "../../contracts/result";
import type { ModuleFactory, RepoContext, RepoPorts } from "../../repo/composeRepo";
import { migrate } from "../../repo/storage";
import type { OwnerCredential } from "./instance";
import { OWNER_OBJECT_NAME } from "./OwnerObject";
import { maxSealedLength, sealedChallenges, type SealedChallengeKind } from "./sealedChallenge";

/** The owner's actions on one repository. */
export interface OwnerPort {
  /** Issues a challenge bound to `action`. */
  prepare(action: OwnerAction): Promise<PortResult<ActionChallenge>>;
  /** Performs the action the challenge names, if `assertion` verifies for it; at most once. */
  perform(challengeId: string, assertion: PasskeyAssertion): Promise<PortResult<OwnerActionResult>>;
}

/** Enrollment of the instance owner's passkey. It belongs to the instance, not to a repository. */
export interface OwnerEnrollmentPort {
  /** Starts enrollment with the one-time bootstrap token. */
  prepare(bootstrapToken: string): Promise<PortResult<EnrollmentChallenge>>;
  /** Completes enrollment and closes it. */
  complete(
    challengeId: string,
    registration: PasskeyRegistration,
  ): Promise<PortResult<{ ownerId: UserId }>>;
}

/** What a repository's owner module reads from the instance owner. */
export interface InstanceOwnerPort {
  /** The enrolled owner, or `null` before enrollment. */
  credential(): Promise<OwnerCredential | null>;
  /** Advances the passkey's signature counter; `false` when it would not advance. */
  recordSignCount(credentialId: string, signCount: number): Promise<boolean>;
}

/** The largest action, in bytes of its JSON, a challenge may be bound to. */
export const MAX_ACTION_BYTES = 64 * 1024;

/** The longest sealed challenge id `prepare` issues, for the largest action. */
export const MAX_SEALED_CHALLENGE_LENGTH = maxSealedLength(MAX_ACTION_BYTES);

/** The migration owner name of the owner module's table in each repository. */
const OWNER_REPO = "owner";

/** Released schema steps. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE owner_seal_key (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    key BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE owner_spent_challenge (
    challenge_id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) STRICT`,
];

/** The owner's challenges; the id part is what the WebAuthn challenge and the grant name. */
const OWNER_CHALLENGE: SealedChallengeKind<OwnerAction> = {
  domain: "railhead-owner-challenge-v1",
  idPrefix: "pkc",
  keyTable: "owner_seal_key",
  spentTable: "owner_spent_challenge",
  maxActionBytes: MAX_ACTION_BYTES,
  decodeAction: (json) => {
    // Sealed by `prepare` from an action the RPC boundary validated; trusted once the seal checks.
    const action: OwnerAction = JSON.parse(json);
    return action;
  },
};

/** Builds the owner module of one repository against the instance's `Owner` object. */
export const owner: ModuleFactory<OwnerPort> = (context, ports) =>
  createOwner(context, ports, {
    instance: instanceOwner(context.env),
    relyingParty: relyingParty(context.env.RELYING_PARTY_HOST),
  });

/**
 * The instance's `Owner` object as a port. Each call takes a fresh stub: a stub that saw an
 * exception may stay broken, and this port outlives any one request.
 */
function instanceOwner(env: Env): InstanceOwnerPort {
  const stub = () => env.OWNER.getByName(OWNER_OBJECT_NAME);
  return {
    credential: () => stub().credential(),
    recordSignCount: (credentialId, signCount) => stub().recordSignCount(credentialId, signCount),
  };
}

/** Where an owner module finds the instance owner and its relying party. */
export interface OwnerDependencies {
  /** The instance owner. */
  readonly instance: InstanceOwnerPort;
  /** The fixed relying party, or `undefined` when the configured host is not a Railhead host. */
  readonly relyingParty: RelyingParty | undefined;
}

/** Builds the owner module of one repository with explicit dependencies. */
export function createOwner(
  context: RepoContext,
  ports: () => RepoPorts,
  dependencies: OwnerDependencies,
): OwnerPort {
  migrate(context.storage, OWNER_REPO, MIGRATIONS);
  const { repoId } = context;
  const challenges = sealedChallenges(OWNER_CHALLENGE, {
    storage: context.storage,
    clock: context.clock,
    repoId,
    instance: dependencies.instance,
    relyingParty: dependencies.relyingParty,
  });

  return {
    prepare: (action) => challenges.prepare(action),

    async perform(sealedId, assertion) {
      const opened = await challenges.open(sealedId);
      if (!opened.ok) return opened;
      const binding = opened.value;
      const signed = await challenges.spend(binding, assertion);
      if (!signed.ok) return signed;
      return act(ports(), {
        kind: "human",
        userId: signed.value,
        repoId,
        grantId: binding.challengeId,
        action: binding.action,
      });
    },
  };
}

/** Hands `grant` to the one port that performs its action kind. */
async function act(ports: RepoPorts, grant: HumanGrant): Promise<PortResult<OwnerActionResult>> {
  const { action } = grant;
  switch (action.kind) {
    case "invite.create": {
      const result = await ports.identity.createInvite({ ...grant, action });
      return result.ok ? ok({ kind: action.kind, ...result.value }) : result;
    }
    case "agent.confirm": {
      const result = await ports.identity.confirm({ ...grant, action });
      return result.ok ? ok({ kind: action.kind, ...result.value }) : result;
    }
    case "agent.revoke": {
      const result = await ports.identity.revoke({ ...grant, action });
      return result.ok ? ok({ kind: action.kind, ...result.value }) : result;
    }
    case "issue.file": {
      const result = await ports.claims.fileIssue({ ...grant, action });
      return result.ok ? ok({ kind: action.kind, ...result.value }) : result;
    }
    case "decision.record": {
      const result = await ports.decisions.record({ ...grant, action });
      return result.ok ? ok({ kind: action.kind, ...result.value }) : result;
    }
    case "check.approve": {
      const result = await ports.checks.approve({ ...grant, action });
      return result.ok ? ok({ kind: action.kind, ...result.value }) : result;
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/** Builds the instance owner's enrollment, through the instance's `Owner` object. */
export function ownerEnrollment(env: Env): OwnerEnrollmentPort {
  // A fresh stub per call, as in `instanceOwner`.
  const stub = () => env.OWNER.getByName(OWNER_OBJECT_NAME);
  return {
    prepare: (bootstrapToken) => stub().prepareEnrollment(bootstrapToken),
    complete: (challengeId, registration) => stub().completeEnrollment(challengeId, registration),
  };
}
