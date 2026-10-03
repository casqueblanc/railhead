// Owner: the human-only actions on one repository, each performed once for one passkey assertion
// bound to it, and the enrollment of the instance owner's passkey.
//
// `prepare` stores nothing. It seals the exact action, a challenge id, a nonce and the expiry into
// the challenge id it returns, under an HMAC key that never leaves the repository's storage; the
// WebAuthn challenge the browser signs is a digest of the same fields. So anyone may ask for a
// challenge, but asking costs the repository no storage and cannot crowd out the owner's.
// `perform` checks the seal, verifies the assertion against the instance owner's passkey and only
// then records the challenge as spent, in its own committed transaction, before it builds the
// `HumanGrant` and hands it to the one port that performs that action kind. Only assertions the
// owner signed are recorded, each until its challenge expires. A spent challenge stays spent
// whatever the action does next: an action that fails or rolls back cannot be retried with the
// same proof, so a proof authorizes at most one attempt, and of concurrent replays at most one
// gets that far.

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
import { decodeBase64Url, encodeBase64Url, randomBase64Url, randomHex } from "./encoding";
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

/** The largest action, in bytes of its JSON, a challenge may be bound to. */
export const MAX_ACTION_BYTES = 64 * 1024;

/** The longest sealed challenge id `prepare` issues, for the largest action. */
export const MAX_SEALED_CHALLENGE_LENGTH = 4 * Math.ceil(MAX_ACTION_BYTES / 3) + 256;

/** Domain separator for the seal; the version names the layout of the sealed fields. */
const SEAL_DOMAIN = "railhead-owner-challenge-v1";

/** The id part of a sealed challenge: what the WebAuthn challenge and the grant name. */
const GRANT_ID = /^pkc_[0-9a-f]{32}$/;
const EXPIRY = /^[1-9][0-9]{0,15}$/;

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
      const encoded = new TextEncoder().encode(JSON.stringify(action));
      if (encoded.length > MAX_ACTION_BYTES) {
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
      const fields = [
        binding.challengeId,
        String(binding.expiresAt),
        binding.nonce,
        encodeBase64Url(encoded),
      ].join(".");
      const seal = await crypto.subtle.sign("HMAC", await sealKey(), sealed(fields));
      return ok({
        challengeId: `${fields}.${encodeBase64Url(new Uint8Array(seal))}`,
        challenge: digest.challenge,
        rpId: party.rpId,
        allowCredentials: [enrolled.credential.credentialId],
        expiresAt: binding.expiresAt,
      });
    },

    async perform(sealedId, assertion) {
      const opened = parseSealed(sealedId);
      if (opened === undefined) {
        return fail("invalid_request", "That is not an action challenge id.");
      }
      if (party === undefined) return misconfigured();
      const intact = await crypto.subtle.verify(
        "HMAC",
        await sealKey(),
        opened.seal,
        sealed(opened.fields),
      );
      if (!intact) return fail("proof_invalid", "That action challenge was not issued here.");
      const { binding } = opened;
      const { challengeId } = binding;
      if (binding.expiresAt <= clock() || isSpent(challengeId)) return spent();
      const enrolled = await instance.credential();
      if (enrolled === null) return fail("proof_invalid", "No owner passkey is enrolled.");
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

      // Spend before acting, in a transaction of its own, so neither a concurrent replay nor an
      // action that fails afterwards can use this proof again.
      const now = clock();
      const consumed = atomically(storage, () => {
        if (binding.expiresAt <= now) return 0;
        sql.exec("DELETE FROM owner_spent_challenge WHERE expires_at <= ?", now);
        // `RETURNING` counts the inserted row alone; `rowsWritten` would count index writes too.
        return sql
          .exec(
            `INSERT INTO owner_spent_challenge (challenge_id, expires_at) VALUES (?, ?)
              ON CONFLICT DO NOTHING RETURNING challenge_id`,
            challengeId,
            binding.expiresAt,
          )
          .toArray().length;
      });
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

  /** This repository's seal key, made on first use. */
  async function sealKey(): Promise<CryptoKey> {
    sql.exec(
      "INSERT INTO owner_seal_key (id, key) VALUES (1, ?) ON CONFLICT DO NOTHING",
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { key } = sql.exec<{ key: ArrayBuffer }>("SELECT key FROM owner_seal_key").one();
    return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  }

  /** What the seal covers: the domain, this repository and the sealed fields. */
  function sealed(fields: string): Uint8Array {
    return new TextEncoder().encode(`${SEAL_DOMAIN}\n${repoId}\n${fields}`);
  }

  function isSpent(challengeId: string): boolean {
    return (
      sql.exec("SELECT 1 FROM owner_spent_challenge WHERE challenge_id = ?", challengeId).toArray()
        .length > 0
    );
  }

  /**
   * Splits a sealed challenge id into its fields, its seal and the binding the fields name, or
   * returns `undefined` when it is not shaped like one. The seal is not checked here.
   */
  function parseSealed(
    text: string,
  ): { fields: string; seal: Uint8Array<ArrayBuffer>; binding: ActionBinding } | undefined {
    if (text.length > MAX_SEALED_CHALLENGE_LENGTH) return undefined;
    const parts = text.split(".");
    if (parts.length !== 5) return undefined;
    const [challengeId, expiry, nonce, action, seal] = parts;
    if (
      challengeId === undefined ||
      !GRANT_ID.test(challengeId) ||
      expiry === undefined ||
      !EXPIRY.test(expiry) ||
      nonce === undefined ||
      decodeBase64Url(nonce, 32) === undefined ||
      action === undefined ||
      seal === undefined
    ) {
      return undefined;
    }
    const actionBytes = decodeBase64Url(action, MAX_ACTION_BYTES);
    const sealBytes = decodeBase64Url(seal, 32);
    if (actionBytes === undefined || sealBytes === undefined) return undefined;
    let parsed: OwnerAction;
    try {
      // Sealed by `prepare` from an action the RPC boundary validated; trusted once the seal checks.
      parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(actionBytes),
      );
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) return undefined;
      throw error;
    }
    return {
      fields: [challengeId, expiry, nonce, action].join("."),
      seal: sealBytes,
      binding: { repoId, challengeId, nonce, expiresAt: Number(expiry), action: parsed },
    };
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
