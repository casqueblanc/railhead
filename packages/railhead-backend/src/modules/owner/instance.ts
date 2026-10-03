// The instance owner: the one passkey every repository's owner actions are verified against, and
// the bootstrap that enrolls it. Enrollment opens only with the operator's one-time bootstrap
// token, and only while no passkey is enrolled; the first completed registration closes it for
// good. State lives in the `Owner` Durable Object's SQLite storage and is read on every call.

import {
  ACTION_CHALLENGE_TTL_MS,
  type EnrollmentChallenge,
  type PasskeyRegistration,
} from "@railhead/shared/board-api";
import type { UserId } from "@railhead/shared/events";
import type { RelyingParty, StoredCredential } from "../../auth/passkeyVerifier";
import { fail, ok, type PortResult } from "../../contracts/result";
import { atomically, migrate, type RepoStorage } from "../../repo/storage";
import { equalBytes, randomBase64Url, randomHex, sha256 } from "./encoding";
import { verifyRegistration } from "./registration";

/** The fewest characters a configured bootstrap token may have; a shorter one keeps enrollment shut. */
export const MIN_BOOTSTRAP_TOKEN_LENGTH = 32;

/** The most characters of a presented bootstrap token that are read. */
const MAX_BOOTSTRAP_TOKEN_LENGTH = 512;

/** The most enrollment ceremonies that may be open at once. */
export const MAX_OPEN_ENROLLMENTS = 4;

const ENROLLMENT_ID = /^enr_[0-9a-f]{32}$/;

/** The migration owner name of the instance owner's tables. */
const OWNER_INSTANCE = "owner_instance";

/** Released schema steps. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE owner_credential (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    user_id TEXT NOT NULL,
    credential_id TEXT NOT NULL,
    public_key BLOB NOT NULL,
    user_handle TEXT NOT NULL,
    sign_count INTEGER NOT NULL,
    enrolled_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE owner_enrollment (
    challenge_id TEXT PRIMARY KEY,
    challenge TEXT NOT NULL,
    user_handle TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT`,
];

/** The enrolled owner and the credential their actions are verified against. */
export interface OwnerCredential {
  /** The owner. */
  readonly userId: UserId;
  /** Their passkey. */
  readonly credential: StoredCredential;
}

/** What the instance owner reads from its deployment. */
export interface InstanceConfig {
  /** The operator's bootstrap token, or `undefined` when none is configured. */
  readonly bootstrapToken: string | undefined;
  /** The fixed relying party, or `undefined` when the configured host is not a Railhead host. */
  readonly relyingParty: RelyingParty | undefined;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly clock: () => number;
}

/** The instance owner over one storage. */
export class InstanceOwner {
  readonly #storage: RepoStorage;
  readonly #config: InstanceConfig;

  constructor(storage: RepoStorage, config: InstanceConfig) {
    migrate(storage, OWNER_INSTANCE, MIGRATIONS);
    this.#storage = storage;
    this.#config = config;
  }

  /**
   * Opens an enrollment ceremony when `bootstrapToken` matches the configured one and no passkey
   * is enrolled. A wrong token, a missing or short configured token and an enrolled owner all fail
   * with `bootstrap_closed` and store nothing.
   */
  async prepareEnrollment(bootstrapToken: string): Promise<PortResult<EnrollmentChallenge>> {
    if (!(await this.#tokenMatches(bootstrapToken)) || this.credential() !== null) {
      return closed();
    }
    const party = this.#config.relyingParty;
    if (party === undefined) return misconfigured();
    const now = this.#config.clock();
    const challenge: EnrollmentChallenge = {
      challengeId: `enr_${randomHex(16)}`,
      challenge: randomBase64Url(32),
      rpId: party.rpId,
      userHandle: randomBase64Url(16),
      expiresAt: now + ACTION_CHALLENGE_TTL_MS,
    };
    const sql = this.#storage.sql;
    return atomically(this.#storage, () => {
      if (this.credential() !== null) return closed();
      sql.exec("DELETE FROM owner_enrollment WHERE expires_at <= ?", now);
      const open = sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM owner_enrollment").one().n;
      if (open >= MAX_OPEN_ENROLLMENTS) {
        return fail("quota_exceeded", "Too many enrollments are open; wait for one to expire.");
      }
      sql.exec(
        "INSERT INTO owner_enrollment (challenge_id, challenge, user_handle, expires_at) VALUES (?, ?, ?, ?)",
        challenge.challengeId,
        challenge.challenge,
        challenge.userHandle,
        challenge.expiresAt,
      );
      return ok(challenge);
    });
  }

  /**
   * Enrolls the registration's passkey as the owner's, once, and closes enrollment. The ceremony is
   * consumed in the same transaction that stores the credential, so of two concurrent completions
   * at most one enrolls.
   */
  async completeEnrollment(
    challengeId: string,
    registration: PasskeyRegistration,
  ): Promise<PortResult<{ ownerId: UserId }>> {
    if (this.credential() !== null) return closed();
    const party = this.#config.relyingParty;
    if (party === undefined) return misconfigured();
    if (!ENROLLMENT_ID.test(challengeId)) {
      return fail("invalid_request", "That is not an enrollment challenge id.");
    }
    const row = this.#openEnrollment(challengeId);
    if (row === null) return expired();
    const verdict = await verifyRegistration({
      relyingParty: party,
      challenge: row.challenge,
      registration,
    });
    if (!verdict.ok) {
      return fail("proof_invalid", "The passkey registration did not verify for this enrollment.");
    }
    const userId: UserId = `usr_${randomHex(16)}`;
    const now = this.#config.clock();
    const sql = this.#storage.sql;
    return atomically(this.#storage, () => {
      // Checked again: another completion may have enrolled while this one was verifying.
      if (this.credential() !== null) return closed();
      const consumed = sql.exec(
        "DELETE FROM owner_enrollment WHERE challenge_id = ? AND expires_at > ?",
        challengeId,
        now,
      ).rowsWritten;
      if (consumed !== 1) return expired();
      sql.exec(
        `INSERT INTO owner_credential
           (id, user_id, credential_id, public_key, user_handle, sign_count, enrolled_at)
         VALUES (1, ?, ?, ?, ?, ?, ?)`,
        userId,
        verdict.credential.credentialId,
        verdict.credential.publicKey,
        row.userHandle,
        verdict.credential.signCount,
        now,
      );
      // Enrollment is closed now; no open ceremony may linger.
      sql.exec("DELETE FROM owner_enrollment");
      return ok({ ownerId: userId });
    });
  }

  /** The enrolled owner, or `null` before enrollment. */
  credential(): OwnerCredential | null {
    const row = this.#storage.sql
      .exec<{
        user_id: string;
        credential_id: string;
        public_key: ArrayBuffer;
        user_handle: string;
        sign_count: number;
      }>(
        "SELECT user_id, credential_id, public_key, user_handle, sign_count FROM owner_credential WHERE id = 1",
      )
      .toArray()[0];
    if (row === undefined) return null;
    return {
      userId: row.user_id,
      credential: {
        credentialId: row.credential_id,
        publicKey: new Uint8Array(row.public_key),
        userHandle: row.user_handle,
        signCount: row.sign_count,
      },
    };
  }

  /**
   * Records `signCount` as the credential's counter if it advances the stored one, or if the
   * authenticator does not count (both 0). Returns `false`, changing nothing, when it does not:
   * another assertion with a later counter was accepted first, or the authenticator was cloned.
   */
  recordSignCount(credentialId: string, signCount: number): boolean {
    if (!Number.isSafeInteger(signCount) || signCount < 0) return false;
    const written = this.#storage.sql.exec(
      `UPDATE owner_credential SET sign_count = ?
        WHERE id = 1 AND credential_id = ? AND (sign_count < ? OR (sign_count = 0 AND ? = 0))`,
      signCount,
      credentialId,
      signCount,
      signCount,
    ).rowsWritten;
    return written === 1;
  }

  #openEnrollment(challengeId: string): { challenge: string; userHandle: string } | null {
    const row = this.#storage.sql
      .exec<{ challenge: string; user_handle: string }>(
        "SELECT challenge, user_handle FROM owner_enrollment WHERE challenge_id = ? AND expires_at > ?",
        challengeId,
        this.#config.clock(),
      )
      .toArray()[0];
    return row === undefined ? null : { challenge: row.challenge, userHandle: row.user_handle };
  }

  async #tokenMatches(presented: string): Promise<boolean> {
    const configured = this.#config.bootstrapToken;
    if (
      configured === undefined ||
      configured.length < MIN_BOOTSTRAP_TOKEN_LENGTH ||
      presented.length > MAX_BOOTSTRAP_TOKEN_LENGTH
    ) {
      return false;
    }
    // Digests of equal length, compared in constant time, so timing says nothing of the token.
    const encoder = new TextEncoder();
    const [a, b] = await Promise.all([
      sha256(encoder.encode(presented)),
      sha256(encoder.encode(configured)),
    ]);
    return equalBytes(a, b);
  }
}

function closed(): PortResult<never> {
  return fail("bootstrap_closed", "Owner enrollment is closed.");
}

function expired(): PortResult<never> {
  return fail("proof_expired", "The enrollment challenge expired or was already used.");
}

function misconfigured(): PortResult<never> {
  return fail("internal", "This instance has no passkey relying party configured.");
}
