// Identity: single-use invites, joins waiting for the owner, and confirmation and revocation.
//
// An invite is created only with a consumed owner proof (`invite.create`). Its secret travels in
// the invite URL's fragment and only its SHA-256 is stored. A join presents the invite, its secret
// and a new key with a signature proving possession of that key. The first valid join consumes the
// invite and records one pending agent bound to that key, in the same transaction that appends
// `agent.joined`. A repeat with the same key resumes that enrollment; any other key is refused, so
// a consumed invite never enrolls a second identity. Every refusal of a join is the same
// `join_refused` and writes nothing. Confirmation and revocation each need their own owner proof.
//
// Pre-enrolling agents before a demo uses exactly this path: the owner creates an invite and
// confirms the join, each with a passkey assertion. There is no other way to add an agent.

import {
  joinMessage,
  type AgentView,
  type JoinRequest,
  type JoinResult,
} from "@railhead/shared/agent-api";
import { INVITE_TTL_MS, type PendingJoin } from "@railhead/shared/board-api";
import type { Actor, AgentId } from "@railhead/shared/events";
import { relyingParty } from "../../auth/passkeyVerifier";
import {
  confirmationCode,
  parsePublicKey,
  verifySshSig,
  type Ed25519PublicKey,
} from "../../auth/sshsig";
import type { AgentCredential, AgentStanding, IdentityPort } from "../../contracts/identity";
import type { GrantFor } from "../../contracts/principals";
import { fail, ok, type PortResult } from "../../contracts/result";
import { EventLogError } from "../../repo/eventLog";
import type { ModuleFactory, RepoContext } from "../../repo/composeRepo";
import { migrate } from "../../repo/storage";
import { equalBytes, randomBase64Url, randomHex, sha256 } from "../owner/encoding";

/** Most invites that are neither used nor expired at once in one repository. */
export const MAX_OPEN_INVITES = 16;

/** Most agents, pending or confirmed, plus open invites, one repository holds. */
export const MAX_AGENTS = 64;

/**
 * Most refused signature checks one invite answers per `JOIN_WINDOW_MS`. Past it every join that
 * presents that invite's secret is `rate_limited` until the window ends. Only a caller holding the
 * secret reaches a signature check, so the budget is per invite: requests naming an unknown invite
 * or a wrong secret are refused before any signature check and spend no invite's budget.
 */
const MAX_JOIN_REFUSALS_PER_WINDOW = 30;

/** The window of the join rate limit, in milliseconds. */
export const JOIN_WINDOW_MS = 60_000;

/** How long a pending agent waits before asking again, in milliseconds. */
export const JOIN_POLL_MS = 2_000;

/** The system component that records joins. */
const IDENTITY_ACTOR: Actor = { kind: "system", id: "sys_identity" };

const IDENTITY_OWNER = "identity";

/** Released schema steps. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE identity_invite (
    invite_id TEXT PRIMARY KEY,
    secret_hash BLOB NOT NULL,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    agent_id TEXT UNIQUE
  ) STRICT`,
  `CREATE TABLE identity_agent (
    agent_id TEXT PRIMARY KEY,
    invite_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    public_key TEXT NOT NULL UNIQUE,
    key_fingerprint TEXT NOT NULL,
    code TEXT NOT NULL,
    standing TEXT NOT NULL CHECK (standing IN ('pending', 'confirmed', 'revoked')),
    joined_at INTEGER NOT NULL
  ) STRICT`,
];

/** Where the identity module finds the origin agents sign for and how it rate limits joins. */
export interface IdentityDependencies {
  /** The instance's origin, `https://<host>`, or `undefined` when the host is not configured. */
  readonly origin: string | undefined;
  /** Refused signature checks allowed per invite and window. */
  readonly refusalsPerWindow: number;
}

/** Builds the identity module of one repository. */
export const identity: ModuleFactory<IdentityPort> = (context) =>
  createIdentity(context, {
    origin: relyingParty(context.env.RELYING_PARTY_HOST)?.origin,
    refusalsPerWindow: MAX_JOIN_REFUSALS_PER_WINDOW,
  });

// A type alias, not an interface, so it satisfies the SQL row constraint.
type AgentRow = {
  agent_id: string;
  invite_id: string;
  name: string;
  owner_id: string;
  public_key: string;
  key_fingerprint: string;
  code: string;
  standing: AgentStanding;
  joined_at: number;
};

/** Builds the identity module of one repository with explicit dependencies. */
export function createIdentity(
  context: RepoContext,
  dependencies: IdentityDependencies,
): IdentityPort {
  migrate(context.storage, IDENTITY_OWNER, MIGRATIONS);
  const { storage, log, clock, repoId } = context;
  const sql = storage.sql;
  // Refused signature checks per invite. Only refusals count, so agents polling their own pending
  // join are never limited. An entry exists only for an invite whose secret was presented, and
  // `join` drops entries whose window ended, so the map holds at most the invites used within one
  // window. Held in memory, so a refused attempt leaves nothing in storage; it resets when the Repo
  // restarts, which bounds a burst rather than a long-run rate.
  const refusals = new Map<string, { start: number; count: number }>();

  async function attemptJoin(request: JoinRequest): Promise<PortResult<JoinResult>> {
    const key = parsePublicKey(request.publicKey);
    if (key === undefined) return refused();
    // Stored without a comment, so the same key always compares equal.
    const publicKey = `ssh-ed25519 ${base64(key.blob)}`;
    const invite = sql
      .exec<{ secret_hash: ArrayBuffer; expires_at: number; agent_id: string | null }>(
        "SELECT secret_hash, expires_at, agent_id FROM identity_invite WHERE invite_id = ?",
        request.inviteId,
      )
      .toArray()[0];
    if (invite === undefined) return refused();
    const presented = await sha256(new TextEncoder().encode(request.inviteSecret));
    if (!equalBytes(presented, new Uint8Array(invite.secret_hash))) return refused();
    // A consumed invite resumes only its own key, so any other key is refused unchecked.
    if (invite.agent_id !== null && readAgent(invite.agent_id)?.public_key !== publicKey) {
      return refused();
    }

    const { origin } = dependencies;
    const names = repoNames();
    if (origin === undefined || names === null) return misconfigured();

    const now = clock();
    for (const [inviteId, window] of refusals) {
      if (now - window.start >= JOIN_WINDOW_MS) refusals.delete(inviteId);
    }
    const window = refusals.get(request.inviteId) ?? { start: now, count: 0 };
    refusals.set(request.inviteId, window);
    if (window.count >= dependencies.refusalsPerWindow) {
      return fail("rate_limited", "Too many refused joins; wait a minute and try again.");
    }
    // Reserve a slot before awaiting the signature check, so concurrent attempts cannot all pass;
    // give it back unless the attempt was refused.
    window.count += 1;
    const result = await enroll(request, key, publicKey, invite.agent_id, origin, names);
    if (result.ok || result.code !== "join_refused") window.count -= 1;
    return result;
  }

  /** Checks the request's signature, then records or resumes the enrollment of its key. */
  async function enroll(
    request: JoinRequest,
    key: Ed25519PublicKey,
    publicKey: string,
    consumedBy: AgentId | null,
    origin: string,
    names: { org: string; name: string },
  ): Promise<PortResult<JoinResult>> {
    const message = joinMessage({
      origin,
      org: names.org,
      repo: names.name,
      inviteId: request.inviteId,
      publicKey: request.publicKey,
    });
    const verdict = await verifySshSig(
      request.publicKey,
      request.signature,
      new TextEncoder().encode(message),
    );
    if (!verdict.ok) return refused();

    // A join that arrived second, or a retry after a lost response, finds the invite consumed.
    if (consumedBy !== null) return resume(consumedBy, publicKey);
    const code = await confirmationCode(key, request.inviteId);
    if (code === undefined) return refused();
    const keyFingerprint = `SHA256:${base64(await sha256(key.blob)).replace(/=+$/, "")}`;
    const agentId: AgentId = `agt_${randomHex(16)}`;

    const at = clock();
    const committed = log.transaction((tx) => {
      const row = tx.sql
        .exec<{ name: string; owner_id: string; agent_id: string | null; expires_at: number }>(
          "SELECT name, owner_id, agent_id, expires_at FROM identity_invite WHERE invite_id = ?",
          request.inviteId,
        )
        .toArray()[0];
      if (row === undefined) return { kind: "refused" } as const;
      if (row.agent_id !== null) return { kind: "consumed", agentId: row.agent_id } as const;
      if (row.expires_at <= at) return { kind: "refused" } as const;
      const taken = tx.sql
        .exec("SELECT 1 FROM identity_agent WHERE public_key = ?", publicKey)
        .toArray();
      // One key is one identity: a key already enrolled through another invite is refused.
      if (taken.length > 0) return { kind: "refused" } as const;
      tx.sql.exec(
        "UPDATE identity_invite SET agent_id = ? WHERE invite_id = ?",
        agentId,
        request.inviteId,
      );
      tx.sql.exec(
        `INSERT INTO identity_agent (agent_id, invite_id, name, owner_id, public_key,
             key_fingerprint, code, standing, joined_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        agentId,
        request.inviteId,
        row.name,
        row.owner_id,
        publicKey,
        keyFingerprint,
        code,
        at,
      );
      tx.append(IDENTITY_ACTOR, {
        type: "agent.joined",
        data: { agentId, inviteId: request.inviteId, name: row.name, keyFingerprint },
      });
      return { kind: "joined" } as const;
    });
    switch (committed.value.kind) {
      case "refused":
        return refused();
      case "consumed":
        return resume(committed.value.agentId, publicKey);
      case "joined":
        return resume(agentId, publicKey);
      default:
        return unreachable(committed.value);
    }
  }

  return {
    join: attemptJoin,

    async createInvite(grant) {
      if (grant.repoId !== repoId) return stale();
      const { name } = grant.action;
      const secret = randomBase64Url(32);
      const secretHash = await sha256(new TextEncoder().encode(secret));
      const inviteId = `inv_${randomHex(16)}`;
      const { origin } = dependencies;
      const names = repoNames();
      if (origin === undefined || names === null) return misconfigured();
      const now = clock();
      const expiresAt = now + INVITE_TTL_MS;
      try {
        const committed = log.transaction((tx) => {
          // An expired invite nobody used holds nothing; a used one stays with its agent.
          tx.sql.exec(
            "DELETE FROM identity_invite WHERE agent_id IS NULL AND expires_at <= ?",
            now,
          );
          const open = tx.sql
            .exec<{ n: number }>("SELECT COUNT(*) AS n FROM identity_invite WHERE agent_id IS NULL")
            .one().n;
          const agents = tx.sql
            .exec<{ n: number }>(
              "SELECT COUNT(*) AS n FROM identity_agent WHERE standing != 'revoked'",
            )
            .one().n;
          if (open >= MAX_OPEN_INVITES || open + agents >= MAX_AGENTS) return false;
          tx.sql.exec(
            `INSERT INTO identity_invite (invite_id, secret_hash, name, owner_id, expires_at)
             VALUES (?, ?, ?, ?, ?)`,
            inviteId,
            secretHash,
            name,
            grant.userId,
            expiresAt,
          );
          tx.append(
            { kind: "human", id: grant.userId },
            {
              type: "agent.invited",
              data: { inviteId, name },
            },
          );
          return true;
        });
        if (!committed.value) {
          return fail("quota_exceeded", "This repository has too many agents or open invites.");
        }
      } catch (error) {
        if (error instanceof EventLogError && error.code === "invalid_event") {
          return fail(
            "invalid_request",
            "The agent name must be lowercase letters, digits and dashes.",
          );
        }
        throw error;
      }
      return ok({ inviteId, inviteUrl: inviteUrl(origin, names, inviteId, secret), expiresAt });
    },

    async confirm(grant) {
      return settle(grant, "pending", "confirmed", (agent) =>
        agent.code === grant.action.code ? null : "The code does not match this join.",
      );
    },

    async revoke(grant) {
      return settle(grant, null, "revoked", () => null);
    },

    async pendingJoins() {
      const rows = sql
        .exec<AgentRow>(
          `SELECT * FROM identity_agent WHERE standing = 'pending'
            ORDER BY joined_at, agent_id LIMIT ?`,
          MAX_AGENTS,
        )
        .toArray();
      return ok(
        rows.map((row): PendingJoin => ({
          agentId: row.agent_id,
          inviteId: row.invite_id,
          name: row.name,
          keyFingerprint: row.key_fingerprint,
          code: row.code,
          joinedAt: row.joined_at,
        })),
      );
    },

    async view(principal) {
      const row = readAgent(principal.agentId);
      if (row === null || principal.repoId !== repoId || row.owner_id !== principal.ownerId) {
        return fail("unauthenticated", "No such agent in this repository.");
      }
      const view = agentView(row);
      return view === null ? revoked() : ok(view);
    },

    async credential(agentId) {
      const row = readAgent(agentId);
      if (row === null) return ok(null);
      const credential: AgentCredential = {
        agentId: row.agent_id,
        publicKey: row.public_key,
        ownerId: row.owner_id,
        standing: row.standing,
      };
      return ok(credential);
    },
  };

  function readAgent(agentId: AgentId): AgentRow | null {
    return (
      sql.exec<AgentRow>("SELECT * FROM identity_agent WHERE agent_id = ?", agentId).toArray()[0] ??
      null
    );
  }

  function repoNames(): { org: string; name: string } | null {
    // The `Repo` writes this row before it composes any module.
    return (
      sql
        .exec<{ org: string; name: string }>("SELECT org, name FROM repo WHERE id = 1")
        .toArray()[0] ?? null
    );
  }

  /** The enrollment `agentId` holds, for the key that proved itself; otherwise a refusal. */
  function resume(agentId: AgentId, publicKey: string): PortResult<JoinResult> {
    const row = readAgent(agentId);
    if (row === null || row.public_key !== publicKey) return refused();
    const view = agentView(row);
    if (view === null) return revoked();
    return ok({
      agent: view,
      code: row.code,
      pollAfterMs: view.state === "pending" ? JOIN_POLL_MS : 0,
    });
  }

  /**
   * Moves the grant's agent from `from` (any unrevoked standing when `null`) to `to` and records
   * the event, unless `check` names why the action no longer applies.
   */
  function settle(
    grant: GrantFor<"agent.confirm"> | GrantFor<"agent.revoke">,
    from: "pending" | null,
    to: "confirmed" | "revoked",
    check: (agent: AgentRow) => string | null,
  ): PortResult<{ agentId: AgentId }> {
    if (grant.repoId !== repoId) return stale();
    const { agentId } = grant.action;
    const committed = log.transaction((tx) => {
      const row = tx.sql
        .exec<AgentRow>("SELECT * FROM identity_agent WHERE agent_id = ?", agentId)
        .toArray()[0];
      if (row === undefined || row.owner_id !== grant.userId) return "No such agent.";
      if (row.standing === "revoked" || (from !== null && row.standing !== from)) {
        return `The agent is already ${row.standing}.`;
      }
      const reason = check(row);
      if (reason !== null) return reason;
      tx.sql.exec("UPDATE identity_agent SET standing = ? WHERE agent_id = ?", to, agentId);
      tx.append(
        { kind: "human", id: grant.userId },
        { type: to === "confirmed" ? "agent.confirmed" : "agent.revoked", data: { agentId } },
      );
      return null;
    });
    return committed.value === null ? ok({ agentId }) : fail("action_stale", committed.value);
  }
}

/**
 * The invite URL, `<origin>/join/<org>/<repo>/<inviteId>#<inviteSecret>`. The secret is only in
 * the fragment, which a browser or HTTP client never sends to a server.
 */
export function inviteUrl(
  origin: string,
  names: { org: string; name: string },
  inviteId: string,
  secret: string,
): string {
  return `${origin}/join/${names.org}/${names.name}/${inviteId}#${secret}`;
}

function agentView(row: AgentRow): AgentView | null {
  if (row.standing === "revoked") return null;
  return { agentId: row.agent_id, name: row.name, ownerId: row.owner_id, state: row.standing };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function refused(): PortResult<never> {
  return fail("join_refused", "The invite cannot be used with this key.");
}

function revoked(): PortResult<never> {
  return fail("identity_revoked", "This agent was revoked.");
}

function stale(): PortResult<never> {
  return fail("action_stale", "The action is for another repository.");
}

function misconfigured(): PortResult<never> {
  return fail("internal", "This instance has no origin configured.");
}

function unreachable(value: never): never {
  throw new Error(`unexpected join outcome ${JSON.stringify(value)}`);
}
