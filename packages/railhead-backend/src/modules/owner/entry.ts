// Owner: the human-only actions on one repository, each performed once for one passkey assertion
// bound to it, and the enrollment of the instance owner's passkey.
//
// `prepare` stores a challenge naming the exact action; the WebAuthn challenge the browser signs is
// a digest of that action, the repository, the challenge id, a nonce and the expiry. `perform`
// verifies the assertion against the instance owner's passkey and then consumes the challenge in
// its own committed transaction before it builds the `HumanGrant` and hands it to the one port that
// performs that action kind. A consumed challenge stays consumed whatever the action does next: an
// action that fails or rolls back cannot be retried with the same proof, so a proof authorizes at
// most one attempt, and of concurrent replays at most one gets that far.

import {
  ACTION_CHALLENGE_TTL_MS,
  type ActionChallenge,
  type EnrollmentChallenge,
  type OwnerAction,
  type OwnerActionResult,
  type PasskeyAssertion,
  type PasskeyRegistration,
} from "@railhead/shared/board-api";
import type { UserId } from "@railhead/shared/events";
import {
  type ActionBinding,
  actionChallenge,
  boardErrorFor,
  type RelyingParty,
  relyingParty,
  verifyActionAssertion,
} from "../../auth/passkeyVerifier";
import type { HumanGrant } from "../../contracts/principals";
import { fail, ok, type PortResult } from "../../contracts/result";
import type { ModuleFactory, RepoContext, RepoPorts } from "../../repo/composeRepo";
import { atomically, migrate } from "../../repo/storage";
import { randomBase64Url, randomHex } from "./encoding";
import type { OwnerCredential } from "./instance";
import { OWNER_OBJECT_NAME } from "./OwnerObject";

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

/** The most unconsumed, unexpired action challenges one repository holds. */
export const MAX_OPEN_ACTION_CHALLENGES = 32;

/** The largest action, in bytes of its JSON, a challenge may be bound to. */
export const MAX_ACTION_BYTES = 64 * 1024;

const CHALLENGE_ID = /^pkc_[0-9a-f]{32}$/;

/** The migration owner name of the owner module's table in each repository. */
const OWNER_REPO = "owner";

/** Released schema steps. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE owner_action_challenge (
    challenge_id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER
  ) STRICT`,
];

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
  const { storage, clock, repoId } = context;
  const { instance, relyingParty: party } = dependencies;
  const sql = storage.sql;

  return {
    async prepare(action) {
      const encoded = JSON.stringify(action);
      if (new TextEncoder().encode(encoded).length > MAX_ACTION_BYTES) {
        return fail("invalid_request", "The action is too large.");
      }
      if (party === undefined) return misconfigured();
      const enrolled = await instance.credential();
      if (enrolled === null) return fail("unavailable", "No owner passkey is enrolled.");
      const binding: ActionBinding = {
        repoId,
        challengeId: `pkc_${randomHex(16)}`,
        nonce: randomBase64Url(32),
        expiresAt: clock() + ACTION_CHALLENGE_TTL_MS,
        action,
      };
      const digest = await actionChallenge(party, binding);
      if (!digest.ok) return misconfigured();
      const now = clock();
      return atomically(storage, () => {
        sql.exec("DELETE FROM owner_action_challenge WHERE expires_at <= ?", now);
        const open = sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM owner_action_challenge WHERE consumed_at IS NULL",
          )
          .one().n;
        if (open >= MAX_OPEN_ACTION_CHALLENGES) {
          return fail("quota_exceeded", "Too many owner actions are waiting for a passkey.");
        }
        sql.exec(
          "INSERT INTO owner_action_challenge (challenge_id, action, nonce, expires_at) VALUES (?, ?, ?, ?)",
          binding.challengeId,
          encoded,
          binding.nonce,
          binding.expiresAt,
        );
        return ok({
          challengeId: binding.challengeId,
          challenge: digest.challenge,
          rpId: party.rpId,
          allowCredentials: [enrolled.credential.credentialId],
          expiresAt: binding.expiresAt,
        });
      });
    },

    async perform(challengeId, assertion) {
      if (!CHALLENGE_ID.test(challengeId)) {
        return fail("invalid_request", "That is not an action challenge id.");
      }
      if (party === undefined) return misconfigured();
      const stored = readChallenge(challengeId);
      if (stored === null) return spent();
      const enrolled = await instance.credential();
      if (enrolled === null) return fail("proof_invalid", "No owner passkey is enrolled.");
      const binding: ActionBinding = { repoId, challengeId, ...stored };
      const verdict = await verifyActionAssertion({
        relyingParty: party,
        binding,
        credential: enrolled.credential,
        assertion,
        now: clock(),
      });
      if (!verdict.ok) {
        const code = boardErrorFor(verdict.reason);
        return code === "proof_expired"
          ? spent()
          : fail(code, "The passkey assertion did not verify for this action.");
      }

      // Consume before acting, in a transaction of its own, so neither a concurrent replay nor an
      // action that fails afterwards can use this proof again.
      const now = clock();
      const consumed = atomically(
        storage,
        () =>
          sql.exec(
            `UPDATE owner_action_challenge SET consumed_at = ?
              WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?`,
            now,
            challengeId,
            now,
          ).rowsWritten,
      );
      if (consumed !== 1) return spent();
      const counted = await instance.recordSignCount(
        enrolled.credential.credentialId,
        verdict.signCount,
      );
      if (!counted) {
        return fail("proof_invalid", "The passkey's signature counter did not advance.");
      }
      return act(ports(), {
        kind: "human",
        userId: enrolled.userId,
        repoId,
        grantId: challengeId,
        action: binding.action,
      });
    },
  };

  function readChallenge(
    challengeId: string,
  ): Pick<ActionBinding, "nonce" | "expiresAt" | "action"> | null {
    const row = sql
      .exec<{ action: string; nonce: string; expires_at: number }>(
        `SELECT action, nonce, expires_at FROM owner_action_challenge
          WHERE challenge_id = ? AND consumed_at IS NULL AND expires_at > ?`,
        challengeId,
        clock(),
      )
      .toArray()[0];
    if (row === undefined) return null;
    // Written by `prepare` from an action the RPC boundary validated; read back as stored.
    const action: OwnerAction = JSON.parse(row.action);
    return { nonce: row.nonce, expiresAt: row.expires_at, action };
  }
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

function spent(): PortResult<never> {
  return fail("proof_expired", "The action challenge expired or was already used.");
}

function misconfigured(): PortResult<never> {
  return fail("internal", "This instance has no passkey relying party configured.");
}
