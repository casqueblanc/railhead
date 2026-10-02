import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import {
  AGENT_PATH_PREFIX,
  joinMessage,
  type AgentResponse,
  type JoinRequest,
  type JoinResult,
} from "@railhead/shared/agent-api";
import { API_PATH, type RailheadApi } from "@railhead/shared/api";
import {
  INVITE_TTL_MS,
  type OwnerAction,
  type PasskeyAssertion,
  type PasskeyRegistration,
} from "@railhead/shared/board-api";
import type { RailheadEvent } from "@railhead/shared/events";
import auth from "../../../fixtures/protocol/wire/auth.json";
import { relyingParty } from "../src/auth/passkeyVerifier";
import type { IdentityPort } from "../src/contracts/identity";
import type { AgentPrincipal, GrantFor } from "../src/contracts/principals";
import type { PortResult } from "../src/contracts/result";
import {
  createIdentity,
  JOIN_POLL_MS,
  MAX_AGENTS,
  MAX_OPEN_INVITES,
} from "../src/modules/identity/entry";
import { InstanceOwner } from "../src/modules/owner/instance";
import { OWNER_OBJECT_NAME } from "../src/modules/owner/OwnerObject";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";

const HOST = "railhead.mashin.workers.dev";
const ORIGIN = `https://${HOST}`;
const ORG = "acme";
const USER = "usr_owner01";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------------------------
// An agent's SSH key: Ed25519 from WebCrypto, signing armored SSHSIG as `ssh-keygen -Y sign` does.

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function str(bytes: Uint8Array | string): number[] {
  const raw = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  return [...u32(raw.length), ...raw];
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

class AgentKey {
  private constructor(
    readonly privateKey: CryptoKey,
    readonly blob: Uint8Array,
  ) {}

  static async create(): Promise<AgentKey> {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    if (!("privateKey" in pair)) throw new Error("Ed25519 generateKey returned a single key");
    const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
    if (!(exported instanceof ArrayBuffer)) throw new Error("raw export is not bytes");
    const blob = Uint8Array.from([...str("ssh-ed25519"), ...str(new Uint8Array(exported))]);
    return new AgentKey(pair.privateKey, blob);
  }

  get publicKey(): string {
    return `ssh-ed25519 ${base64(this.blob)}`;
  }

  async sign(message: string, namespace = "railhead-auth"): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-512", enc.encode(message)));
    const signed = Uint8Array.from([
      ...enc.encode("SSHSIG"),
      ...str(namespace),
      ...str(""),
      ...str("sha512"),
      ...str(digest),
    ]);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, this.privateKey, signed),
    );
    const sig = Uint8Array.from([
      ...enc.encode("SSHSIG"),
      ...u32(1),
      ...str(this.blob),
      ...str(namespace),
      ...str(""),
      ...str("sha512"),
      ...str(Uint8Array.from([...str("ssh-ed25519"), ...str(raw)])),
    ]);
    const lines = base64(sig).match(/.{1,70}/g) ?? [];
    return `-----BEGIN SSH SIGNATURE-----\n${lines.join("\n")}\n-----END SSH SIGNATURE-----\n`;
  }
}

/** `text` with its last character changed. */
function flipLast(text: string): string {
  return `${text.slice(0, -1)}${text.endsWith("A") ? "B" : "A"}`;
}

const INVITE_URL =
  /^https:\/\/([a-z0-9.-]+)\/join\/([a-z0-9-]+)\/([a-z0-9-]+)\/(inv_[A-Za-z0-9]+)#([A-Za-z0-9_-]{43})$/;

/** Splits an invite URL into the invite id and its secret, as the CLI reads it. */
function parseInvite(url: string): { inviteId: string; inviteSecret: string } {
  const [, , , , inviteId, inviteSecret] = INVITE_URL.exec(url) ?? [];
  if (inviteId === undefined || inviteSecret === undefined) throw new Error("not an invite URL");
  return { inviteId, inviteSecret };
}

async function joinRequest(
  key: AgentKey,
  invite: { inviteId: string; inviteSecret: string },
  repo: string,
  overrides: { origin?: string; signer?: AgentKey; namespace?: string } = {},
): Promise<JoinRequest> {
  const message = joinMessage({
    origin: overrides.origin ?? ORIGIN,
    org: ORG,
    repo,
    inviteId: invite.inviteId,
    publicKey: key.publicKey,
  });
  return {
    inviteId: invite.inviteId,
    inviteSecret: invite.inviteSecret,
    publicKey: key.publicKey,
    signature: await (overrides.signer ?? key).sign(message, overrides.namespace),
  };
}

// ---------------------------------------------------------------------------------------------
// A repository with the identity module over its storage, and grants as the owner module builds
// them after consuming a passkey proof.

function unique(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function value<T>(result: PortResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
  return result.value;
}

function grant<K extends OwnerAction["kind"]>(
  repoId: string,
  action: Extract<OwnerAction, { kind: K }>,
  userId = USER,
): GrantFor<K> {
  return { kind: "human", userId, repoId, grantId: unique("pkc_"), action };
}

interface Harness {
  identity: IdentityPort;
  repoId: string;
  repo: string;
  clock: { now: number };
  state: DurableObjectState;
  events(): RailheadEvent[];
  rows(table: "identity_invite" | "identity_agent"): number;
  /** Creates an invite and returns what its URL carries. */
  invite(name?: string): Promise<{ inviteId: string; inviteSecret: string }>;
  /** A second identity module over the same storage, as after the Repo restarts. */
  restart(): IdentityPort;
}

async function withIdentity(
  body: (harness: Harness) => Promise<void>,
  options: { refusalsPerWindow?: number; origin?: string | undefined } = {},
): Promise<void> {
  const repo = unique("r");
  const stub: DurableObjectStub<Repo> = env.REPO.getByName(repoObjectName(ORG, repo));
  const { repoId } = value(await stub.initialize(ORG, repo));
  await runInDurableObject(stub, async (_instance, state) => {
    const clock = { now: Date.now() };
    const log = EventLog.open(state.storage, repoId, () => clock.now);
    const context = { repoId, storage: state.storage, log, clock: () => clock.now, env };
    const build = () =>
      createIdentity(context, {
        origin: "origin" in options ? options.origin : ORIGIN,
        refusalsPerWindow: options.refusalsPerWindow ?? 1000,
      });
    const identity = build();
    await body({
      identity,
      repoId,
      repo,
      clock,
      state,
      events: () => log.replay(0, 256).events,
      rows: (table) =>
        state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n,
      async invite(name = "atlas") {
        const created = value(
          await identity.createInvite(grant(repoId, { kind: "invite.create", name })),
        );
        return parseInvite(created.inviteUrl);
      },
      restart: build,
    });
  });
}

function principal(repoId: string, agentId: string, ownerId = USER): AgentPrincipal {
  return { kind: "agent", agentId, ownerId, repoId };
}

describe("invites", () => {
  it("creates a single-use invite whose URL carries a secret that is stored only hashed", async () => {
    await withIdentity(async ({ identity, repoId, repo, clock, state, events }) => {
      const created = value(
        await identity.createInvite(grant(repoId, { kind: "invite.create", name: "atlas" })),
      );
      expect(created.inviteId).toMatch(/^inv_[0-9a-f]{32}$/);
      expect(created.expiresAt).toBe(clock.now + INVITE_TTL_MS);
      const { inviteId, inviteSecret } = parseInvite(created.inviteUrl);
      expect(inviteId).toBe(created.inviteId);
      expect(created.inviteUrl).toBe(`${ORIGIN}/join/${ORG}/${repo}/${inviteId}#${inviteSecret}`);

      // Neither storage nor the log holds the secret.
      const stored = state.storage.sql
        .exec<{ secret_hash: ArrayBuffer }>("SELECT secret_hash FROM identity_invite")
        .toArray();
      expect(stored).toHaveLength(1);
      expect(new Uint8Array(stored[0]?.secret_hash ?? new ArrayBuffer(0))).toHaveLength(32);
      expect(JSON.stringify(events())).not.toContain(inviteSecret);
      expect(events()).toMatchObject([
        {
          type: "agent.invited",
          actor: { kind: "human", id: USER },
          data: { inviteId, name: "atlas" },
        },
      ]);
    });
  });

  it("refuses an invalid name and a grant for another repository, storing nothing", async () => {
    await withIdentity(async ({ identity, repoId, rows, events }) => {
      for (const name of ["Atlas", "", "a".repeat(33), "has space"]) {
        expect(
          await identity.createInvite(grant(repoId, { kind: "invite.create", name })),
        ).toMatchObject({ ok: false, code: "invalid_request" });
      }
      expect(
        await identity.createInvite(grant("rep_other01", { kind: "invite.create", name: "atlas" })),
      ).toMatchObject({ ok: false, code: "action_stale" });
      expect(rows("identity_invite")).toBe(0);
      expect(events()).toEqual([]);
    });
  });

  it("bounds open invites and frees the slots of expired ones", async () => {
    await withIdentity(async ({ identity, repoId, clock, invite, rows }) => {
      for (let i = 0; i < MAX_OPEN_INVITES; i += 1) await invite(`agent-${i}`);
      expect(
        await identity.createInvite(grant(repoId, { kind: "invite.create", name: "late" })),
      ).toMatchObject({ ok: false, code: "quota_exceeded" });
      expect(rows("identity_invite")).toBe(MAX_OPEN_INVITES);

      clock.now += INVITE_TTL_MS;
      await invite("late");
      expect(rows("identity_invite")).toBe(1);
    });
  });

  it("bounds the agents of one repository, counting open invites but not revoked agents", async () => {
    await withIdentity(async ({ identity, repoId, repo, invite }) => {
      const agents: string[] = [];
      for (let i = 0; i < MAX_AGENTS; i += 1) {
        const joined = value(
          await identity.join(
            await joinRequest(await AgentKey.create(), await invite(`a-${i}`), repo),
          ),
        );
        agents.push(joined.agent.agentId);
      }
      expect(
        await identity.createInvite(grant(repoId, { kind: "invite.create", name: "one-more" })),
      ).toMatchObject({ ok: false, code: "quota_exceeded" });
      const [first] = agents;
      if (first === undefined) throw new Error("no agent");
      value(await identity.revoke(grant(repoId, { kind: "agent.revoke", agentId: first })));
      await invite("one-more");
    });
  });
});

describe("joins", () => {
  it("records one pending agent and shows the owner the code the agent shows", async () => {
    await withIdentity(async ({ identity, repoId, repo, invite, events, clock }) => {
      const key = await AgentKey.create();
      const ticket = await invite();
      const joined = value(await identity.join(await joinRequest(key, ticket, repo)));
      expect(joined).toMatchObject({
        agent: { name: "atlas", ownerId: USER, state: "pending" },
        pollAfterMs: JOIN_POLL_MS,
      });
      expect(joined.agent.agentId).toMatch(/^agt_[0-9a-f]{32}$/);
      expect(joined.code).toMatch(/^\d{6}$/);

      const pending = value(await identity.pendingJoins());
      expect(pending).toEqual([
        {
          agentId: joined.agent.agentId,
          inviteId: ticket.inviteId,
          name: "atlas",
          keyFingerprint: expect.stringMatching(/^SHA256:[A-Za-z0-9+/]{43}$/),
          code: joined.code,
          joinedAt: clock.now,
        },
      ]);
      expect(events().at(-1)).toMatchObject({
        type: "agent.joined",
        actor: { kind: "system", id: "sys_identity" },
        data: { agentId: joined.agent.agentId, inviteId: ticket.inviteId, name: "atlas" },
      });
      expect(value(await identity.credential(joined.agent.agentId))).toEqual({
        agentId: joined.agent.agentId,
        publicKey: key.publicKey,
        ownerId: USER,
        standing: "pending",
      });
      expect(value(await identity.credential("agt_nobody01"))).toBeNull();
    });
  });

  it("verifies a real ssh-keygen join signature and derives the shared confirmation code", async () => {
    // The fixture was signed by `ssh-keygen -Y sign` for casqueblanc/demo on railhead.dev.
    const stub: DurableObjectStub<Repo> = env.REPO.getByName(repoObjectName("casqueblanc", "demo"));
    const { repoId } = value(await stub.initialize("casqueblanc", "demo"));
    await runInDurableObject(stub, async (_instance, state) => {
      const log = EventLog.open(state.storage, repoId);
      const identity = createIdentity(
        { repoId, storage: state.storage, log, clock: Date.now, env },
        { origin: auth.join.fields.origin, refusalsPerWindow: 10 },
      );
      const secret = "s".repeat(43);
      state.storage.sql.exec(
        `INSERT INTO identity_invite (invite_id, secret_hash, name, owner_id, expires_at)
         VALUES (?, ?, 'atlas', ?, ?)`,
        auth.join.fields.inviteId,
        new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(secret))),
        USER,
        Date.now() + INVITE_TTL_MS,
      );
      const joined = value(
        await identity.join({
          inviteId: auth.join.fields.inviteId,
          inviteSecret: secret,
          publicKey: auth.join.fields.publicKey,
          signature: auth.join.signature,
        }),
      );
      const vector = auth.confirmationCodes.find(
        (v) => v.key === "rfc8032-test1" && v.inviteId === auth.join.fields.inviteId,
      );
      expect(joined.code).toBe(vector?.code);
      expect(value(await identity.pendingJoins())[0]?.keyFingerprint).toBe(
        auth.keys["rfc8032-test1"].fingerprint,
      );
    });
  });

  it("resumes the same enrollment for the same key, also after the invite expired or a restart", async () => {
    await withIdentity(async ({ identity, repo, invite, clock, restart, rows, events }) => {
      const key = await AgentKey.create();
      const request = await joinRequest(key, await invite(), repo);
      const first = value(await identity.join(request));
      clock.now += INVITE_TTL_MS + 1;
      expect(value(await restart().join(request))).toEqual(first);
      // A fresh signature over the same message is the same proof of the same key.
      expect(
        value(
          await identity.join({
            ...request,
            signature: await key.sign(
              joinMessage({
                origin: ORIGIN,
                org: ORG,
                repo,
                inviteId: request.inviteId,
                publicKey: key.publicKey,
              }),
            ),
          }),
        ),
      ).toEqual(first);
      expect(rows("identity_agent")).toBe(1);
      expect(events().filter((e) => e.type === "agent.joined")).toHaveLength(1);
    });
  });

  it("enrolls exactly one key when different keys consume one invite concurrently", async () => {
    await withIdentity(async ({ identity, repo, invite, rows, events }) => {
      const ticket = await invite();
      const keys = await Promise.all([1, 2, 3, 4].map(() => AgentKey.create()));
      const requests = await Promise.all(keys.map((key) => joinRequest(key, ticket, repo)));
      const results = await Promise.all(requests.map((request) => identity.join(request)));
      const outcomes = results.map((r) => (r.ok ? "ok" : r.code)).toSorted();
      expect(outcomes).toEqual(["join_refused", "join_refused", "join_refused", "ok"]);
      expect(rows("identity_agent")).toBe(1);
      expect(events().filter((e) => e.type === "agent.joined")).toHaveLength(1);

      // The winner keeps resuming; the losers keep being refused.
      const winner = results.findIndex((r) => r.ok);
      for (const [index, request] of requests.entries()) {
        const again = await identity.join(request);
        expect(again.ok).toBe(index === winner);
      }
    });
  });

  it("refuses every invalid join the same way and stores nothing", async () => {
    await withIdentity(async ({ identity, repo, invite, rows, events, clock }) => {
      const key = await AgentKey.create();
      const other = await AgentKey.create();
      const ticket = await invite();
      const valid = await joinRequest(key, ticket, repo);
      const before = events().length;
      const attempts: JoinRequest[] = [
        { ...valid, inviteId: "inv_unknown01" },
        { ...valid, inviteSecret: "x".repeat(43) },
        { ...valid, inviteSecret: flipLast(ticket.inviteSecret) },
        await joinRequest(key, ticket, repo, { signer: other }),
        await joinRequest(key, ticket, repo, { origin: "https://railhead.dev" }),
        await joinRequest(key, ticket, "elsewhere"),
        await joinRequest(key, ticket, repo, { namespace: "git" }),
        { ...valid, publicKey: other.publicKey },
        { ...valid, publicKey: "ssh-rsa AAAA" },
        { ...valid, signature: "not a signature" },
      ];
      for (const attempt of attempts) {
        expect(await identity.join(attempt)).toEqual({
          ok: false,
          code: "join_refused",
          message: "The invite cannot be used with this key.",
        });
      }
      expect(rows("identity_agent")).toBe(0);
      expect(events()).toHaveLength(before);

      // The invite was not spent by any of them, until it expires.
      clock.now += INVITE_TTL_MS;
      expect(await identity.join(valid)).toMatchObject({ ok: false, code: "join_refused" });
      expect(rows("identity_agent")).toBe(0);
      expect(events()).toHaveLength(before);
    });
  });

  it("refuses a key already enrolled through another invite", async () => {
    await withIdentity(async ({ identity, repo, invite, rows }) => {
      const key = await AgentKey.create();
      value(await identity.join(await joinRequest(key, await invite("atlas"), repo)));
      const second = await invite("borealis");
      expect(await identity.join(await joinRequest(key, second, repo))).toMatchObject({
        ok: false,
        code: "join_refused",
      });
      expect(rows("identity_agent")).toBe(1);
      // The second invite is still usable by a new key.
      value(await identity.join(await joinRequest(await AgentKey.create(), second, repo)));
    });
  });

  it("rate limits joins after too many refusals in a window, without storing anything", async () => {
    await withIdentity(
      async ({ identity, repo, invite, clock, rows }) => {
        // An agent polling its own pending join is never limited.
        const poller = await joinRequest(await AgentKey.create(), await invite("poller"), repo);
        for (let i = 0; i < 10; i += 1) value(await identity.join(poller));

        const ticket = await invite();
        const key = await AgentKey.create();
        for (let i = 0; i < 3; i += 1) {
          expect(
            await identity.join({
              ...(await joinRequest(key, ticket, repo)),
              inviteId: "inv_unknown01",
            }),
          ).toMatchObject({ code: "join_refused" });
        }
        const valid = await joinRequest(key, ticket, repo);
        expect(await identity.join(valid)).toMatchObject({ ok: false, code: "rate_limited" });
        expect(await identity.join(poller)).toMatchObject({ ok: false, code: "rate_limited" });
        expect(rows("identity_agent")).toBe(1);
        clock.now += 60_000;
        value(await identity.join(valid));
      },
      { refusalsPerWindow: 3 },
    );
  });

  it("fails closed without a configured origin", async () => {
    await withIdentity(
      async ({ identity, repoId, repo, rows, state }) => {
        expect(
          await identity.createInvite(grant(repoId, { kind: "invite.create", name: "atlas" })),
        ).toMatchObject({ ok: false, code: "internal" });
        expect(rows("identity_invite")).toBe(0);
        const secret = "s".repeat(43);
        state.storage.sql.exec(
          `INSERT INTO identity_invite (invite_id, secret_hash, name, owner_id, expires_at)
           VALUES ('inv_fixed01', ?, 'atlas', ?, ?)`,
          new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(secret))),
          USER,
          Date.now() + INVITE_TTL_MS,
        );
        const key = await AgentKey.create();
        const request = await joinRequest(
          key,
          { inviteId: "inv_fixed01", inviteSecret: secret },
          repo,
        );
        expect(await identity.join(request)).toMatchObject({ ok: false, code: "internal" });
        expect(rows("identity_agent")).toBe(0);
      },
      { origin: undefined },
    );
  });
});

describe("confirmation and revocation", () => {
  it("confirms a pending agent whose code matches, once", async () => {
    await withIdentity(async ({ identity, repoId, repo, invite, events }) => {
      const key = await AgentKey.create();
      const request = await joinRequest(key, await invite(), repo);
      const joined = value(await identity.join(request));
      const { agentId } = joined.agent;
      const wrong = joined.code === "000000" ? "000001" : "000000";
      expect(
        await identity.confirm(grant(repoId, { kind: "agent.confirm", agentId, code: wrong })),
      ).toMatchObject({ ok: false, code: "action_stale" });
      expect(value(await identity.view(principal(repoId, agentId)))).toMatchObject({
        state: "pending",
      });

      expect(
        await identity.confirm(
          grant(repoId, { kind: "agent.confirm", agentId, code: joined.code }),
        ),
      ).toEqual({ ok: true, value: { agentId } });
      expect(events().at(-1)).toMatchObject({
        type: "agent.confirmed",
        actor: { kind: "human", id: USER },
        data: { agentId },
      });
      expect(value(await identity.pendingJoins())).toEqual([]);
      expect(value(await identity.join(request))).toMatchObject({
        agent: { state: "confirmed" },
        pollAfterMs: 0,
      });
      expect(value(await identity.credential(agentId))).toMatchObject({ standing: "confirmed" });

      // A second proof for the same confirmation finds nothing to do.
      expect(
        await identity.confirm(
          grant(repoId, { kind: "agent.confirm", agentId, code: joined.code }),
        ),
      ).toMatchObject({ ok: false, code: "action_stale" });
      expect(events().filter((e) => e.type === "agent.confirmed")).toHaveLength(1);
    });
  });

  it("refuses to confirm an unknown agent, another owner's agent or one for another repository", async () => {
    await withIdentity(async ({ identity, repoId, repo, invite, events }) => {
      const joined = value(
        await identity.join(await joinRequest(await AgentKey.create(), await invite(), repo)),
      );
      const { agentId } = joined.agent;
      const before = events().length;
      for (const attempt of [
        grant(repoId, { kind: "agent.confirm", agentId: "agt_nobody01", code: joined.code }),
        grant(repoId, { kind: "agent.confirm", agentId, code: joined.code }, "usr_someone01"),
        grant("rep_other01", { kind: "agent.confirm", agentId, code: joined.code }),
      ] as const) {
        expect(await identity.confirm(attempt)).toMatchObject({ ok: false, code: "action_stale" });
      }
      expect(events()).toHaveLength(before);
      expect(value(await identity.credential(agentId))).toMatchObject({ standing: "pending" });
    });
  });

  it("rejects a revoked identity at its next call", async () => {
    await withIdentity(async ({ identity, repoId, repo, invite, events, restart }) => {
      const request = await joinRequest(await AgentKey.create(), await invite(), repo);
      const joined = value(await identity.join(request));
      const { agentId } = joined.agent;
      value(
        await identity.confirm(
          grant(repoId, { kind: "agent.confirm", agentId, code: joined.code }),
        ),
      );
      expect(value(await identity.view(principal(repoId, agentId)))).toEqual({
        agentId,
        name: "atlas",
        ownerId: USER,
        state: "confirmed",
      });

      expect(await identity.revoke(grant(repoId, { kind: "agent.revoke", agentId }))).toEqual({
        ok: true,
        value: { agentId },
      });
      expect(events().at(-1)).toMatchObject({ type: "agent.revoked", data: { agentId } });
      const after = restart();
      expect(await after.view(principal(repoId, agentId))).toMatchObject({
        ok: false,
        code: "identity_revoked",
      });
      expect(await after.join(request)).toMatchObject({ ok: false, code: "identity_revoked" });
      expect(value(await after.credential(agentId))).toMatchObject({ standing: "revoked" });
      // Revoked is final: neither a confirmation nor a second revocation applies.
      expect(
        await after.confirm(grant(repoId, { kind: "agent.confirm", agentId, code: joined.code })),
      ).toMatchObject({ ok: false, code: "action_stale" });
      expect(await after.revoke(grant(repoId, { kind: "agent.revoke", agentId }))).toMatchObject({
        ok: false,
        code: "action_stale",
      });
    });
  });

  it("revokes a pending join, which then never appears for confirmation", async () => {
    await withIdentity(async ({ identity, repoId, repo, invite }) => {
      const joined = value(
        await identity.join(await joinRequest(await AgentKey.create(), await invite(), repo)),
      );
      value(
        await identity.revoke(
          grant(repoId, { kind: "agent.revoke", agentId: joined.agent.agentId }),
        ),
      );
      expect(value(await identity.pendingJoins())).toEqual([]);
    });
  });

  it("answers view only for an agent of this repository and owner", async () => {
    await withIdentity(async ({ identity, repoId, repo, invite }) => {
      const joined = value(
        await identity.join(await joinRequest(await AgentKey.create(), await invite(), repo)),
      );
      const { agentId } = joined.agent;
      for (const who of [
        principal(repoId, "agt_nobody01"),
        principal("rep_other01", agentId),
        principal(repoId, agentId, "usr_someone01"),
      ]) {
        expect(await identity.view(who)).toMatchObject({ ok: false, code: "unauthenticated" });
      }
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The whole path through the Worker: the owner invites and confirms with passkey assertions, and
// the agent joins over HTTP. Pre-enrolling agents before a demo is exactly this path.

function b64url(bytes: Uint8Array): string {
  return base64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

function cborHead(major: number, length: number): number[] {
  if (length < 24) return [(major << 5) | length];
  if (length < 256) return [(major << 5) | 24, length];
  return [(major << 5) | 25, length >> 8, length & 0xff];
}

function cborText(text: string): number[] {
  const bytes = enc.encode(text);
  return [...cborHead(3, bytes.length), ...bytes];
}

function derInteger(raw: Uint8Array): number[] {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start += 1;
  const body = [...raw.subarray(start)];
  if ((body[0] ?? 0) & 0x80) body.unshift(0);
  return [0x02, body.length, ...body];
}

/** A software ES256 passkey with a `none` attestation and an advancing counter. */
class Passkey {
  #counter = 0;
  private constructor(
    readonly privateKey: CryptoKey,
    readonly point: Uint8Array,
    readonly id: Uint8Array,
  ) {}

  static async create(): Promise<Passkey> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    if (!("privateKey" in pair)) throw new Error("ECDSA generateKey returned a single key");
    const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
    if (!(exported instanceof ArrayBuffer)) throw new Error("raw export is not bytes");
    return new Passkey(
      pair.privateKey,
      new Uint8Array(exported),
      crypto.getRandomValues(new Uint8Array(16)),
    );
  }

  async register(challenge: string): Promise<PasskeyRegistration> {
    const clientData = enc.encode(
      JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN, crossOrigin: false }),
    );
    const x = this.point.slice(1, 33);
    const y = this.point.slice(33);
    const cose = [
      0xa5,
      0x01,
      0x02,
      0x03,
      0x26,
      0x20,
      0x01,
      0x21,
      0x58,
      32,
      ...x,
      0x22,
      0x58,
      32,
      ...y,
    ];
    const authData = Uint8Array.from([
      ...(await sha256(enc.encode(HOST))),
      0x45,
      0,
      0,
      0,
      0,
      ...new Uint8Array(16),
      0,
      this.id.length,
      ...this.id,
      ...cose,
    ]);
    const attestation = Uint8Array.from([
      0xa3,
      ...cborText("fmt"),
      ...cborText("none"),
      ...cborText("attStmt"),
      0xa0,
      ...cborText("authData"),
      ...cborHead(2, authData.length),
      ...authData,
    ]);
    return {
      credentialId: b64url(this.id),
      clientDataJson: b64url(clientData),
      attestationObject: b64url(attestation),
    };
  }

  async assert(challenge: string, userHandle: string): Promise<PasskeyAssertion> {
    this.#counter += 1;
    const clientData = enc.encode(
      JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
    );
    const authData = new Uint8Array(37);
    authData.set(await sha256(enc.encode(HOST)), 0);
    authData[32] = 0x05;
    new DataView(authData.buffer).setUint32(33, this.#counter, false);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        this.privateKey,
        Uint8Array.from([...authData, ...(await sha256(clientData))]),
      ),
    );
    const der = [...derInteger(raw.subarray(0, 32)), ...derInteger(raw.subarray(32))];
    return {
      credentialId: b64url(this.id),
      clientDataJson: b64url(clientData),
      authenticatorData: b64url(authData),
      signature: b64url(Uint8Array.from([0x30, der.length, ...der])),
      userHandle,
    };
  }
}

describe("enrollment through the Worker", () => {
  it("invites, joins over HTTP and confirms with one passkey assertion per owner action", async () => {
    const passkey = await Passkey.create();
    const party = relyingParty(HOST);
    if (party === undefined) throw new Error("the test host is not a relying party host");
    const userHandle = await runInDurableObject(
      env.OWNER.getByName(OWNER_OBJECT_NAME),
      async (_instance, state) => {
        const owner = new InstanceOwner(state.storage, {
          bootstrapToken: "t".repeat(40),
          relyingParty: party,
          clock: Date.now,
        });
        const challenge = value(await owner.prepareEnrollment("t".repeat(40)));
        value(
          await owner.completeEnrollment(
            challenge.challengeId,
            await passkey.register(challenge.challenge),
          ),
        );
        return challenge.userHandle;
      },
    );
    const repo = unique("r");
    value(await env.REPO.getByName(repoObjectName(ORG, repo)).initialize(ORG, repo));

    const response = await SELF.fetch(`${ORIGIN}${API_PATH}`, {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (socket === null) throw new Error("no WebSocket");
    socket.accept();
    using api = newWebSocketRpcSession<RailheadApi>(socket);
    const opened = await api.openBoard(ORG, repo);
    if (!opened.ok) throw new Error(opened.code);
    using board = opened.value;
    using owner = await board.owner();

    async function act(action: OwnerAction) {
      const challenge = await owner.prepare(action);
      if (!challenge.ok) throw new Error(challenge.code);
      const proof = await passkey.assert(challenge.value.challenge, userHandle);
      return owner.perform(challenge.value.challengeId, proof);
    }

    const invited = await act({ kind: "invite.create", name: "atlas" });
    if (!invited.ok || invited.value.kind !== "invite.create") throw new Error("no invite");
    const ticket = parseInvite(invited.value.inviteUrl);

    const key = await AgentKey.create();
    const join = async (): Promise<AgentResponse<JoinResult>> => {
      const reply = await SELF.fetch(`${ORIGIN}${AGENT_PATH_PREFIX}/${ORG}/${repo}/join`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(await joinRequest(key, ticket, repo)),
      });
      return reply.json();
    };
    const joined = await join();
    if (!joined.ok) throw new Error(joined.error.code);
    expect(joined.data.agent.state).toBe("pending");

    const pending = await board.pendingJoins();
    expect(pending).toMatchObject({ ok: true, value: [{ code: joined.data.code, name: "atlas" }] });

    const { agentId } = joined.data.agent;
    expect(await act({ kind: "agent.confirm", agentId, code: joined.data.code })).toEqual({
      ok: true,
      value: { kind: "agent.confirm", agentId },
    });
    const resumed = await join();
    expect(resumed).toMatchObject({ ok: true, data: { agent: { agentId, state: "confirmed" } } });
  });
});
