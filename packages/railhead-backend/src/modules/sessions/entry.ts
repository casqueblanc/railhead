// Sessions: login challenges and the session tokens they redeem for.
//
// A challenge is stateless. Its id carries its expiry, a nonce and a MAC over both, the agent and
// the repository, so issuing one stores nothing and an unauthenticated caller cannot grow any
// state. Redeeming one checks the MAC and expiry, reads the agent's registered key and standing
// from the identity module, verifies the SSHSIG over `loginMessage(...)`, and only then consumes the
// challenge id in one transaction: of concurrent redemptions of one challenge, exactly one gets a
// session. A consumed id is kept until the challenge would have expired anyway, so the table holds
// at most `MAX_AGENTS * MAX_LOGINS_PER_WINDOW` rows. After a lost response the challenge is spent
// and the CLI asks for a new one, as the agent wire specifies.
//
// A token names the agent, its owner and this repository and lasts `SESSION_TTL_MS`. It is signed
// with a key this repository generates once and never reveals. `authenticate` checks, at every
// call, that the agent still exists with the same owner and is confirmed, so revocation takes
// effect at the agent's next call. Neither tokens nor signatures are ever logged.

import {
  CHALLENGE_TTL_MS,
  loginMessage,
  SESSION_TTL_MS,
  type ChallengeRequest,
  type ChallengeResult,
  type SessionRequest,
  type SessionResult,
} from "@railhead/shared/agent-api";
import type { AgentId } from "@railhead/shared/events";
import { relyingParty } from "../../auth/passkeyVerifier";
import {
  importSessionKey,
  SESSION_KEY_BYTES,
  signSessionToken,
  verifySessionToken,
} from "../../auth/sessionToken";
import { verifySshSig } from "../../auth/sshsig";
import type { AgentCredential, SessionsPort } from "../../contracts/identity";
import type { AgentPrincipal, SessionClaims } from "../../contracts/principals";
import { fail, ok, type PortResult } from "../../contracts/result";
import type { ModuleFactory, RepoContext, RepoPorts } from "../../repo/composeRepo";
import { atomically, migrate } from "../../repo/storage";
import { equalBytes, randomHex } from "../owner/encoding";

/** Most challenges one agent may redeem per `CHALLENGE_TTL_MS`. Past it logins are `rate_limited`. */
export const MAX_LOGINS_PER_WINDOW = 30;

const SESSIONS_OWNER = "sessions";

/** Domain separator of the challenge MAC. */
const CHALLENGE_DOMAIN = "railhead-challenge-v1";

/** `chl_`, the expiry as 12 hex digits, a 16-digit nonce and a 32-digit truncated MAC. */
const CHALLENGE_ID = /^chl_([0-9a-f]{12})([0-9a-f]{16})([0-9a-f]{32})$/;

/** Released schema steps. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE sessions_key (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    challenge_secret BLOB NOT NULL,
    token_secret BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE sessions_challenge (
    challenge_id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT`,
  "CREATE INDEX sessions_challenge_agent ON sessions_challenge (agent_id, expires_at)",
];

/** Where the sessions module finds the origin agents sign for. */
export interface SessionsDependencies {
  /** The instance's origin, `https://<host>`, or `undefined` when the host is not configured. */
  readonly origin: string | undefined;
}

/** Builds the sessions module of one repository. */
export const sessions: ModuleFactory<SessionsPort> = (context, ports) =>
  createSessions(context, ports, {
    origin: relyingParty(context.env.RELYING_PARTY_HOST)?.origin,
  });

interface SessionKeys {
  readonly challenge: CryptoKey;
  readonly token: CryptoKey;
}

/** Builds the sessions module of one repository with explicit dependencies. */
export function createSessions(
  context: RepoContext,
  ports: () => RepoPorts,
  dependencies: SessionsDependencies,
): SessionsPort {
  migrate(context.storage, SESSIONS_OWNER, MIGRATIONS);
  const { storage, clock, repoId } = context;
  const sql = storage.sql;
  sql.exec(
    "INSERT OR IGNORE INTO sessions_key (id, challenge_secret, token_secret) VALUES (1, ?, ?)",
    crypto.getRandomValues(new Uint8Array(SESSION_KEY_BYTES)),
    crypto.getRandomValues(new Uint8Array(SESSION_KEY_BYTES)),
  );
  let keys: Promise<SessionKeys> | undefined;

  function sessionKeys(): Promise<SessionKeys> {
    keys ??= loadKeys().catch((error: unknown) => {
      keys = undefined;
      throw error;
    });
    return keys;
  }

  async function loadKeys(): Promise<SessionKeys> {
    const row = sql
      .exec<{ challenge_secret: ArrayBuffer; token_secret: ArrayBuffer }>(
        "SELECT challenge_secret, token_secret FROM sessions_key WHERE id = 1",
      )
      .one();
    const [challenge, token] = await Promise.all([
      importSessionKey(new Uint8Array(row.challenge_secret)),
      importSessionKey(new Uint8Array(row.token_secret)),
    ]);
    return { challenge, token };
  }

  /** The truncated MAC binding a challenge to this repository, `agentId` and its expiry. */
  async function challengeMac(
    agentId: AgentId,
    expires: string,
    nonce: string,
  ): Promise<Uint8Array> {
    const { challenge } = await sessionKeys();
    const input = [CHALLENGE_DOMAIN, repoId, agentId, expires, nonce].join("\n");
    const mac = await crypto.subtle.sign("HMAC", challenge, new TextEncoder().encode(input));
    return new Uint8Array(mac, 0, 16);
  }

  /** The login message for this repository, or `undefined` when the instance has no origin. */
  function message(agentId: AgentId, challengeId: string, expiresAt: number): string | undefined {
    const names = sql
      .exec<{ org: string; name: string }>("SELECT org, name FROM repo WHERE id = 1")
      .toArray()[0];
    const { origin } = dependencies;
    if (origin === undefined || names === undefined) return undefined;
    return loginMessage({
      origin,
      org: names.org,
      repo: names.name,
      agentId,
      challengeId,
      expiresAt,
    });
  }

  /** The expiry of a challenge id this repository issued to `agentId` and still open, else `null`. */
  async function openChallenge(agentId: AgentId, challengeId: string): Promise<number | null> {
    const [, expires, nonce, macHex] = CHALLENGE_ID.exec(challengeId) ?? [];
    if (expires === undefined || nonce === undefined || macHex === undefined) return null;
    const expected = await challengeMac(agentId, expires, nonce);
    if (!equalBytes(expected, hexBytes(macHex))) return null;
    const expiresAt = Number.parseInt(expires, 16);
    return clock() < expiresAt ? expiresAt : null;
  }

  /** The agent's credential if it may hold a session now, or the refusal. */
  async function standing(agentId: AgentId): Promise<PortResult<AgentCredential | null>> {
    const read = await ports().identity.credential(agentId);
    if (!read.ok || read.value === null) return read;
    const credential = read.value;
    switch (credential.standing) {
      case "confirmed":
        return read;
      case "pending":
        return fail("identity_pending", "The owner has not confirmed this agent yet.");
      case "revoked":
        return fail("identity_revoked", "This agent was revoked.");
      default:
        return unreachable(credential.standing);
    }
  }

  return {
    async issueChallenge(request: ChallengeRequest): Promise<PortResult<ChallengeResult>> {
      const expiresAt = clock() + CHALLENGE_TTL_MS;
      const expires = expiresAt.toString(16).padStart(12, "0");
      if (expires.length !== 12) return fail("internal", "The clock is out of range.");
      const nonce = randomHex(8);
      const challengeId = `chl_${expires}${nonce}${hex(await challengeMac(request.agentId, expires, nonce))}`;
      const text = message(request.agentId, challengeId, expiresAt);
      if (text === undefined) return misconfigured();
      return ok({ challengeId, expiresAt, message: text });
    },

    async redeem(request: SessionRequest): Promise<PortResult<SessionResult>> {
      const { agentId, challengeId } = request;
      const expiresAt = await openChallenge(agentId, challengeId);
      if (expiresAt === null) return challengeInvalid();
      const text = message(agentId, challengeId, expiresAt);
      if (text === undefined) return misconfigured();

      // An unknown agent and a wrong signature look the same; standing is told only to the key holder.
      const known = await ports().identity.credential(agentId);
      if (!known.ok) return known;
      if (known.value === null) return challengeInvalid();
      const verified = await verifySshSig(
        known.value.publicKey,
        request.signature,
        new TextEncoder().encode(text),
      );
      if (!verified.ok) return challengeInvalid();

      const now = clock();
      const claims: SessionClaims = {
        v: 1,
        sub: agentId,
        owner: known.value.ownerId,
        repo: repoId,
        iat: now,
        exp: now + SESSION_TTL_MS,
        jti: randomHex(16),
      };
      const principal: AgentPrincipal = { kind: "agent", agentId, ownerId: claims.owner, repoId };
      const token = await signSessionToken((await sessionKeys()).token, claims);
      const view = await ports().identity.view(principal);
      if (!view.ok) return view;

      // Read again after the awaits above: the agent must still hold this key, and be confirmed,
      // when the challenge is consumed. Nothing below awaits, so the two cannot drift apart.
      const current = await standing(agentId);
      if (!current.ok) return current;
      if (
        current.value === null ||
        current.value.publicKey !== known.value.publicKey ||
        current.value.ownerId !== claims.owner
      ) {
        return challengeInvalid();
      }
      const consumed = atomically(storage, () => {
        sql.exec("DELETE FROM sessions_challenge WHERE expires_at <= ?", clock());
        const spent = sql
          .exec("SELECT 1 FROM sessions_challenge WHERE challenge_id = ?", challengeId)
          .toArray();
        if (spent.length > 0) return "spent";
        const used = sql
          .exec<{ n: number }>(
            "SELECT COUNT(*) AS n FROM sessions_challenge WHERE agent_id = ?",
            agentId,
          )
          .one().n;
        if (used >= MAX_LOGINS_PER_WINDOW) return "limited";
        sql.exec(
          "INSERT INTO sessions_challenge (challenge_id, agent_id, expires_at) VALUES (?, ?, ?)",
          challengeId,
          agentId,
          expiresAt,
        );
        return "consumed";
      });
      switch (consumed) {
        case "consumed":
          return ok({ token, expiresAt: claims.exp, agent: view.value, repoId });
        case "spent":
          return challengeInvalid();
        case "limited":
          return fail("rate_limited", "Too many logins for this agent. Wait a minute.");
        default:
          return unreachable(consumed);
      }
    },

    async authenticate(token: string): Promise<PortResult<AgentPrincipal>> {
      const verified = await verifySessionToken((await sessionKeys()).token, token, clock());
      if (!verified.ok || verified.claims.repo !== repoId) return unauthenticated();
      const { sub, owner } = verified.claims;
      const current = await standing(sub);
      if (!current.ok) return current;
      if (current.value === null || current.value.ownerId !== owner) return unauthenticated();
      return ok({ kind: "agent", agentId: sub, ownerId: owner, repoId });
    },
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexBytes(text: string): Uint8Array {
  return Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function challengeInvalid(): PortResult<never> {
  return fail("challenge_invalid", "The challenge expired or was used. Request a new one.");
}

function unauthenticated(): PortResult<never> {
  return fail("unauthenticated", "The session token is not valid. Log in again.");
}

function misconfigured(): PortResult<never> {
  return fail("internal", "This instance has no origin configured.");
}

function unreachable(value: never): never {
  throw new Error(`unexpected value ${JSON.stringify(value)}`);
}
