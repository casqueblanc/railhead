// The single-use passkey challenge every owner action goes through, shared by the owner module and
// the demo seed control.
//
// `prepare` stores nothing. It seals the exact action, a challenge id, a nonce and the expiry into
// the challenge id it returns, under an HMAC key that never leaves its object's storage; the
// WebAuthn challenge the browser signs is a digest of the same fields. So anyone may ask for a
// challenge, but asking costs no storage and cannot crowd out the owner's.
//
// `open` checks the seal and returns the binding it names. `spend` verifies the assertion against
// the instance owner's passkey and only then records the challenge as spent, in its own committed
// transaction, before it advances the passkey's signature counter. A caller checks what it must
// between the two, and acts only after `spend` succeeds. A spent challenge stays spent whatever the
// action does next: an action that fails or rolls back cannot be retried with the same proof, so a
// proof authorizes at most one attempt, and of concurrent replays at most one gets that far.

import {
  ACTION_CHALLENGE_TTL_MS,
  type ActionChallenge,
  type PasskeyAssertion,
} from "@railhead/shared/board-api";
import type { RepoId, UserId } from "@railhead/shared/events";
import {
  type ActionBinding,
  actionChallenge,
  type ApprovableAction,
  boardErrorFor,
  type RelyingParty,
  verifyActionAssertion,
} from "../../auth/passkeyVerifier";
import { fail, ok, type PortResult } from "../../contracts/result";
import { atomically, type RepoStorage } from "../../repo/storage";
import { decodeBase64Url, encodeBase64Url, randomBase64Url, randomHex } from "./encoding";
import type { InstanceOwnerPort } from "./entry";

/** How one kind of sealed challenge is told apart from every other. */
export interface SealedChallengeKind<A extends ApprovableAction> {
  /** Domain separator for the seal; the version names the layout of the sealed fields. */
  readonly domain: string;
  /** The challenge id's prefix, three lowercase letters. */
  readonly idPrefix: string;
  /** The table holding the seal key, with columns `id` and `key`. */
  readonly keyTable: string;
  /** The table holding spent challenges, with columns `challenge_id` and `expires_at`. */
  readonly spentTable: string;
  /** The largest action, in bytes of its JSON, a challenge may be bound to. */
  readonly maxActionBytes: number;
  /** The action in `json`, sealed by `prepare`, or `undefined` when it is not one. May throw `SyntaxError`. */
  readonly decodeAction: (json: string) => A | undefined;
}

/** What the challenges need from their object. */
export interface SealedChallengeContext {
  /** The object's storage, holding the kind's two tables. */
  readonly storage: RepoStorage;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly clock: () => number;
  /** The repository every challenge is bound to. */
  readonly repoId: RepoId;
  /** The instance owner. */
  readonly instance: InstanceOwnerPort;
  /** The fixed relying party, or `undefined` when the configured host is not a Railhead host. */
  readonly relyingParty: RelyingParty | undefined;
}

/** One kind of sealed, single-use action challenge. */
export interface SealedChallenges<A extends ApprovableAction> {
  /** Issues a challenge bound to `action`. */
  prepare(action: A): Promise<PortResult<ActionChallenge>>;
  /** The binding a challenge id names, once its seal checks. Spends nothing. */
  open(sealedId: string): Promise<PortResult<ActionBinding<A>>>;
  /** Verifies `assertion` for `binding` and spends it; the owner who signed, on success. */
  spend(binding: ActionBinding<A>, assertion: PasskeyAssertion): Promise<PortResult<UserId>>;
}

/** The longest sealed challenge id for an action of at most `maxActionBytes`. */
export function maxSealedLength(maxActionBytes: number): number {
  return 4 * Math.ceil(maxActionBytes / 3) + 256;
}

const EXPIRY = /^[1-9][0-9]{0,15}$/;

/** The challenges of `kind`, kept in `context.storage`, whose tables must already exist. */
export function sealedChallenges<A extends ApprovableAction>(
  kind: SealedChallengeKind<A>,
  context: SealedChallengeContext,
): SealedChallenges<A> {
  const { storage, clock, repoId, instance, relyingParty: party } = context;
  const { domain, keyTable, spentTable, maxActionBytes } = kind;
  const sql = storage.sql;

  return {
    async prepare(action) {
      const encoded = new TextEncoder().encode(JSON.stringify(action));
      if (encoded.length > maxActionBytes) {
        return fail("invalid_request", "The action is too large.");
      }
      if (party === undefined) return misconfigured();
      const enrolled = await instance.credential();
      if (enrolled === null) return fail("unavailable", "No owner passkey is enrolled.");
      const binding: ActionBinding<A> = {
        repoId,
        challengeId: `${kind.idPrefix}_${randomHex(16)}`,
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

    async open(sealedId) {
      const opened = parseSealed(kind, sealedId);
      if (opened === undefined) return notAChallenge();
      if (party === undefined) return misconfigured();
      const intact = await crypto.subtle.verify(
        "HMAC",
        await sealKey(),
        opened.seal,
        sealed(opened.fields),
      );
      if (!intact) return fail("proof_invalid", "That action challenge was not issued here.");
      const { challengeId, nonce, expiresAt, action } = opened;
      return ok({ repoId, challengeId, nonce, expiresAt, action });
    },

    async spend(binding, assertion) {
      if (party === undefined) return misconfigured();
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
        sql.exec(`DELETE FROM ${spentTable} WHERE expires_at <= ?`, now);
        // `RETURNING` counts the inserted row alone; `rowsWritten` would count index writes too.
        return sql
          .exec(
            `INSERT INTO ${spentTable} (challenge_id, expires_at) VALUES (?, ?)
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
      return ok(enrolled.userId);
    },
  };

  /** The seal key, made on first use. */
  async function sealKey(): Promise<CryptoKey> {
    sql.exec(
      `INSERT INTO ${keyTable} (id, key) VALUES (1, ?) ON CONFLICT DO NOTHING`,
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { key } = sql.exec<{ key: ArrayBuffer }>(`SELECT key FROM ${keyTable}`).one();
    return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  }

  /** What the seal covers: the domain, the repository and the sealed fields. */
  function sealed(fields: string): Uint8Array {
    return new TextEncoder().encode(`${domain}\n${repoId}\n${fields}`);
  }

  function isSpent(challengeId: string): boolean {
    return (
      sql.exec(`SELECT 1 FROM ${spentTable} WHERE challenge_id = ?`, challengeId).toArray().length >
      0
    );
  }
}

/** Whether `text` is shaped like a challenge id of `kind`. Checks no seal and reads no storage. */
export function isSealedChallengeId<A extends ApprovableAction>(
  kind: SealedChallengeKind<A>,
  text: string,
): boolean {
  return parseSealed(kind, text) !== undefined;
}

/** A sealed challenge id split into its fields, its seal and the parts of the binding they name. */
interface ParsedSealed<A extends ApprovableAction> {
  readonly fields: string;
  readonly seal: Uint8Array<ArrayBuffer>;
  readonly challengeId: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly action: A;
}

/**
 * Splits a sealed challenge id of `kind`, or returns `undefined` when it is not shaped like one.
 * The seal is not checked here.
 */
function parseSealed<A extends ApprovableAction>(
  kind: SealedChallengeKind<A>,
  text: string,
): ParsedSealed<A> | undefined {
  const { maxActionBytes } = kind;
  if (text.length > maxSealedLength(maxActionBytes)) return undefined;
  const parts = text.split(".");
  if (parts.length !== 5) return undefined;
  const [challengeId, expiry, nonce, action, seal] = parts;
  if (
    challengeId === undefined ||
    !new RegExp(`^${kind.idPrefix}_[0-9a-f]{32}$`).test(challengeId) ||
    expiry === undefined ||
    !EXPIRY.test(expiry) ||
    nonce === undefined ||
    decodeBase64Url(nonce, 32) === undefined ||
    action === undefined ||
    seal === undefined
  ) {
    return undefined;
  }
  const actionBytes = decodeBase64Url(action, maxActionBytes);
  const sealBytes = decodeBase64Url(seal, 32);
  if (actionBytes === undefined || sealBytes === undefined) return undefined;
  let parsed: A | undefined;
  try {
    parsed = kind.decodeAction(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(actionBytes),
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return undefined;
    throw error;
  }
  if (parsed === undefined) return undefined;
  return {
    fields: [challengeId, expiry, nonce, action].join("."),
    seal: sealBytes,
    challengeId,
    nonce,
    expiresAt: Number(expiry),
    action: parsed,
  };
}

/** The refusal of a challenge id that is not shaped like one. */
export function notAChallenge(): PortResult<never> {
  return fail("invalid_request", "That is not an action challenge id.");
}

function spent(): PortResult<never> {
  return fail("proof_expired", "The action challenge expired or was already used.");
}

function misconfigured(): PortResult<never> {
  return fail("internal", "This instance has no passkey relying party configured.");
}
