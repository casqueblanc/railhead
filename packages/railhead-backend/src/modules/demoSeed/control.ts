// The owner authority over the demo seed. It runs in the `Repo` object named `DEMO_SEED_CONTROL`,
// which never becomes a repository, so its seal key and spent challenges survive a reset of the demo
// repository.
//
// It follows the owner module's protocol: `prepare` stores nothing and seals the exact action, a
// challenge id, a nonce and the expiry into the challenge id it returns; the WebAuthn challenge is a
// digest of the same fields, bound to the demo repository's identifier. `perform` checks the seal
// and the bundle, verifies the assertion against the instance owner's passkey, records the challenge
// as spent in its own transaction and only then hands the action to the demo repository. A proof
// authorizes at most one attempt, whatever the attempt does.

import {
  ACTION_CHALLENGE_TTL_MS,
  MAX_DEMO_BUNDLE_BYTES,
  type ActionChallenge,
  type DemoSeedAction,
  type DemoSeedResult,
  type PasskeyAssertion,
} from "@railhead/shared/board-api";
import { isCommitSha, type CommitSha, type RepoId } from "@railhead/shared/events";
import {
  type ActionBinding,
  actionChallenge,
  boardErrorFor,
  type RelyingParty,
  verifyActionAssertion,
} from "../../auth/passkeyVerifier";
import { fail, ok, type PortResult } from "../../contracts/result";
import type { InstanceOwnerPort } from "../owner/entry";
import { decodeBase64Url, encodeBase64Url, randomBase64Url, randomHex } from "../owner/encoding";
import { atomically, migrate, type RepoStorage } from "../../repo/storage";
import { readBundle, type BundleFailure } from "./bundle";

/** What the control hands the demo repository once a proof is spent. */
export interface SeedTargetCalls {
  /** Seeds main at `head` from `pack`. */
  seed(head: CommitSha, pack: Uint8Array): Promise<PortResult<DemoSeedResult>>;
  /** Resets the demo repository. */
  reset(): Promise<PortResult<DemoSeedResult>>;
}

/** What the control needs. */
export interface SeedControlContext {
  /** The control object's storage. */
  readonly storage: RepoStorage;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly clock: () => number;
  /** The demo repository's identifier, which every challenge is bound to. */
  readonly repoId: RepoId;
  /** The instance owner. */
  readonly instance: InstanceOwnerPort;
  /** The fixed relying party, or `undefined` when the configured host is not a Railhead host. */
  readonly relyingParty: RelyingParty | undefined;
  /** The demo repository. */
  readonly target: SeedTargetCalls;
}

/** The owner's seed and reset of the demo repository. */
export interface SeedControl {
  /** Issues a challenge bound to `action`. */
  prepare(action: DemoSeedAction): Promise<PortResult<ActionChallenge>>;
  /** Performs the action the challenge names, if `assertion` verifies for it; at most once. */
  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
    bundle: Uint8Array | null,
  ): Promise<PortResult<DemoSeedResult>>;
}

/** Domain separator for the seal; distinct from the owner module's, so neither opens the other's. */
const SEAL_DOMAIN = "railhead-demo-seed-challenge-v1";

/** The longest sealed challenge id `prepare` issues. A seed action is under a hundred bytes. */
const MAX_SEALED_LENGTH = 512;

const GRANT_ID = /^dsc_[0-9a-f]{32}$/;
const EXPIRY = /^[1-9][0-9]{0,15}$/;

/** The migration owner name of the control's tables. */
const CONTROL_OWNER = "demo_seed";

/** Released schema steps. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE demo_seed_key (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    key BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE demo_seed_spent (
    challenge_id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) STRICT`,
];

/** Builds the control and migrates its tables. */
export function createSeedControl(context: SeedControlContext): SeedControl {
  migrate(context.storage, CONTROL_OWNER, MIGRATIONS);
  const { storage, clock, repoId, instance, relyingParty: party, target } = context;
  const sql = storage.sql;

  return {
    async prepare(action) {
      const parsed = parseAction(action);
      if (parsed === undefined) return fail("invalid_request", "That is not a demo seed action.");
      if (party === undefined) return misconfigured();
      const enrolled = await instance.credential();
      if (enrolled === null) return fail("unavailable", "No owner passkey is enrolled.");
      const binding: ActionBinding<DemoSeedAction> = {
        repoId,
        challengeId: `dsc_${randomHex(16)}`,
        nonce: randomBase64Url(32),
        expiresAt: clock() + ACTION_CHALLENGE_TTL_MS,
        action: parsed,
      };
      const digest = await actionChallenge(party, binding);
      if (!digest.ok) return misconfigured();
      const fields = [
        binding.challengeId,
        String(binding.expiresAt),
        binding.nonce,
        encodeBase64Url(new TextEncoder().encode(JSON.stringify(parsed))),
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

    async perform(sealedId, assertion, bundle) {
      const opened = parseSealed(sealedId);
      if (opened === undefined) {
        return fail("invalid_request", "That is not a demo seed challenge id.");
      }
      if (party === undefined) return misconfigured();
      const intact = await crypto.subtle.verify(
        "HMAC",
        await sealKey(),
        opened.seal,
        sealed(opened.fields),
      );
      if (!intact) return fail("proof_invalid", "That challenge was not issued here.");
      const { binding } = opened;

      // The bundle is checked before the proof is spent, so a wrong file costs no passkey prompt.
      const input = actionInput(binding.action, bundle);
      if (!input.ok) return input;

      if (binding.expiresAt <= clock() || isSpent(binding.challengeId)) return spent();
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

      const now = clock();
      const consumed = atomically(storage, () => {
        if (binding.expiresAt <= now) return 0;
        sql.exec("DELETE FROM demo_seed_spent WHERE expires_at <= ?", now);
        return sql
          .exec(
            `INSERT INTO demo_seed_spent (challenge_id, expires_at) VALUES (?, ?)
              ON CONFLICT DO NOTHING RETURNING challenge_id`,
            binding.challengeId,
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
      return input.value === null
        ? target.reset()
        : target.seed(input.value.head, input.value.pack);
    },
  };

  async function sealKey(): Promise<CryptoKey> {
    sql.exec(
      "INSERT INTO demo_seed_key (id, key) VALUES (1, ?) ON CONFLICT DO NOTHING",
      crypto.getRandomValues(new Uint8Array(32)),
    );
    const { key } = sql.exec<{ key: ArrayBuffer }>("SELECT key FROM demo_seed_key").one();
    return crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
  }

  function sealed(fields: string): Uint8Array {
    return new TextEncoder().encode(`${SEAL_DOMAIN}\n${repoId}\n${fields}`);
  }

  function isSpent(challengeId: string): boolean {
    return (
      sql.exec("SELECT 1 FROM demo_seed_spent WHERE challenge_id = ?", challengeId).toArray()
        .length > 0
    );
  }

  function parseSealed(
    text: string,
  ):
    | { fields: string; seal: Uint8Array<ArrayBuffer>; binding: ActionBinding<DemoSeedAction> }
    | undefined {
    if (text.length > MAX_SEALED_LENGTH) return undefined;
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
    const actionBytes = decodeBase64Url(action, MAX_SEALED_LENGTH);
    const sealBytes = decodeBase64Url(seal, 32);
    if (actionBytes === undefined || sealBytes === undefined) return undefined;
    let json: unknown;
    try {
      json = JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(actionBytes),
      );
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof TypeError) return undefined;
      throw error;
    }
    const parsed = parseAction(json);
    if (parsed === undefined) return undefined;
    return {
      fields: [challengeId, expiry, nonce, action].join("."),
      seal: sealBytes,
      binding: { repoId, challengeId, nonce, expiresAt: Number(expiry), action: parsed },
    };
  }
}

/** `value` as a demo seed action with a well-formed head, or `undefined`. */
function parseAction(value: unknown): DemoSeedAction | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kind: unknown = Reflect.get(value, "kind");
  if (kind === "demo.reset") return { kind };
  if (kind !== "demo.seed") return undefined;
  const head: unknown = Reflect.get(value, "head");
  return typeof head === "string" && isCommitSha(head) ? { kind, head } : undefined;
}

/** The pack a seed pushes, or `null` for a reset, after checking the bundle fits the action. */
function actionInput(
  action: DemoSeedAction,
  bundle: Uint8Array | null,
): PortResult<{ head: CommitSha; pack: Uint8Array } | null> {
  switch (action.kind) {
    case "demo.reset":
      return bundle === null ? ok(null) : fail("invalid_request", "A reset takes no bundle.");
    case "demo.seed": {
      if (bundle === null) return fail("invalid_request", "A seed needs the main bundle.");
      if (bundle.length > MAX_DEMO_BUNDLE_BYTES) {
        return fail("invalid_request", "The bundle is too large.");
      }
      const read = readBundle(bundle);
      if (!read.ok) return fail("invalid_request", bundleMessage(read.reason));
      if (read.bundle.head !== action.head) {
        return fail("invalid_request", "The bundle's main is not the head the passkey approved.");
      }
      return ok(read.bundle);
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

function bundleMessage(reason: BundleFailure): string {
  switch (reason) {
    case "not_a_bundle":
      return "That is not a v2 Git bundle.";
    case "prerequisites":
      return "The bundle must hold main's full history, with no prerequisites.";
    case "wrong_refs":
      return "The bundle must carry refs/heads/main and nothing else.";
    case "no_pack":
      return "The bundle has no pack.";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}

function spent(): PortResult<never> {
  return fail("proof_expired", "The challenge expired or was already used.");
}

function misconfigured(): PortResult<never> {
  return fail("internal", "This instance has no passkey relying party configured.");
}
