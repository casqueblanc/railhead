import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  AGENT_PATH_PREFIX,
  CHALLENGE_TTL_MS,
  joinMessage,
  loginMessage,
  SESSION_TTL_MS,
  type AgentResponse,
  type ChallengeResult,
  type SessionRequest,
  type SessionResult,
} from "@railhead/shared/agent-api";
import type { OwnerAction } from "@railhead/shared/board-api";
import {
  deriveSessionKey,
  MIN_SIGNING_SECRET_LENGTH,
  signSessionToken,
  verifySessionToken,
} from "../src/auth/sessionToken";
import type { IdentityPort, SessionsPort } from "../src/contracts/identity";
import type { GrantFor, SessionClaims } from "../src/contracts/principals";
import type { PortResult } from "../src/contracts/result";
import { createSessions, MAX_LOGINS_PER_WINDOW } from "../src/modules/sessions/entry";
import { composeRepo, type RepoContext } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";

const ORIGIN = "https://railhead.mashin.workers.dev";
const ORG = "acme";
const USER = "usr_owner01";
const enc = new TextEncoder();
/** The signing secret `vitest.config.ts` gives the pool, so modules composed from `env` share it. */
const SECRET = "test-only-session-signing-secret-0123456789";

/** A token key derived from a fresh random secret. */
async function randomKey(): Promise<CryptoKey> {
  const key = await deriveSessionKey(crypto.randomUUID(), "rep_demo0001", "token");
  if (key === undefined) throw new Error("a UUID is a long enough secret");
  return key;
}

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

// ---------------------------------------------------------------------------------------------
// A repository composed over its storage with a controllable clock, and agents enrolled through
// the identity module with grants as the owner module builds them.

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
): GrantFor<K> {
  return { kind: "human", userId: USER, repoId, grantId: unique("pkc_"), action };
}

/** `text` with the character at `index` changed. */
function flipAt(text: string, index: number): string {
  const at = index < 0 ? text.length + index : index;
  const replacement = text[at] === "a" ? "b" : "a";
  return `${text.slice(0, at)}${replacement}${text.slice(at + 1)}`;
}

/** The claims part of a token, decoded without checking anything. */
function claimsOf(token: string): unknown {
  const payload = token.split(".")[1] ?? "";
  return JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
}

interface Agent {
  agentId: string;
  key: AgentKey;
}

interface Harness {
  sessions: SessionsPort;
  identity: IdentityPort;
  repoId: string;
  repo: string;
  clock: { now: number };
  context: RepoContext;
  consumed(): number;
  /** Invites, joins and, unless `pending`, confirms an agent. */
  enroll(options?: { pending?: boolean }): Promise<Agent>;
  /** A challenge for `agent`, signed by `signer` in `namespace`. */
  login(
    agent: Agent,
    overrides?: { signer?: AgentKey; namespace?: string },
  ): Promise<{ challenge: ChallengeResult; request: SessionRequest }>;
  /** A second sessions module over the same storage, as after the Repo restarts. */
  restart(options?: { signingSecret: string | undefined }): SessionsPort;
}

async function withSessions(body: (harness: Harness) => Promise<void>): Promise<void> {
  const repo = unique("r");
  const stub: DurableObjectStub<Repo> = env.REPO.getByName(repoObjectName(ORG, repo));
  const { repoId } = value(await stub.initialize(ORG, repo));
  await runInDurableObject(stub, async (_instance, state) => {
    const clock = { now: Date.now() };
    const log = EventLog.open(state.storage, repoId, () => clock.now);
    const context: RepoContext = {
      repoId,
      storage: state.storage,
      log,
      clock: () => clock.now,
      env,
      wake: () => {},
    };
    const ports = composeRepo(context);
    const { sessions, identity } = ports;
    let count = 0;
    await body({
      sessions,
      identity,
      repoId,
      repo,
      clock,
      context,
      consumed: () =>
        state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sessions_challenge").one()
          .n,
      async enroll(options = {}) {
        count += 1;
        const key = await AgentKey.create();
        const created = value(
          await identity.createInvite(grant(repoId, { kind: "invite.create", name: `a-${count}` })),
        );
        const [inviteId, inviteSecret] =
          /\/(inv_[0-9a-f]+)#(.+)$/.exec(created.inviteUrl)?.slice(1) ?? [];
        if (inviteId === undefined || inviteSecret === undefined) throw new Error("bad invite URL");
        const joined = value(
          await identity.join({
            inviteId,
            inviteSecret,
            publicKey: key.publicKey,
            signature: await key.sign(
              joinMessage({ origin: ORIGIN, org: ORG, repo, inviteId, publicKey: key.publicKey }),
            ),
          }),
        );
        const { agentId } = joined.agent;
        if (options.pending !== true) {
          value(
            await identity.confirm(
              grant(repoId, { kind: "agent.confirm", agentId, code: joined.code }),
            ),
          );
        }
        return { agentId, key };
      },
      async login(agent, overrides = {}) {
        const challenge = value(await sessions.issueChallenge({ agentId: agent.agentId }));
        const request = {
          agentId: agent.agentId,
          challengeId: challenge.challengeId,
          signature: await (overrides.signer ?? agent.key).sign(
            challenge.message,
            overrides.namespace,
          ),
        };
        return { challenge, request };
      },
      restart: ({ signingSecret } = { signingSecret: SECRET }) =>
        createSessions(context, () => ports, { origin: ORIGIN, signingSecret }),
    });
  });
}

// ---------------------------------------------------------------------------------------------

describe("challenges", () => {
  it("issues a challenge bound to the agent and repository without storing anything", async () => {
    await withSessions(async ({ sessions, repo, clock, consumed }) => {
      const challenge = value(await sessions.issueChallenge({ agentId: "agt_atlas01" }));
      expect(challenge.challengeId).toMatch(/^chl_[0-9a-f]{60}$/);
      expect(challenge.expiresAt).toBe(clock.now + CHALLENGE_TTL_MS);
      // The CLI builds the same text itself and refuses a challenge whose message differs.
      expect(challenge.message).toBe(
        loginMessage({
          origin: ORIGIN,
          org: ORG,
          repo,
          agentId: "agt_atlas01",
          challengeId: challenge.challengeId,
          expiresAt: challenge.expiresAt,
        }),
      );
      const again = value(await sessions.issueChallenge({ agentId: "agt_atlas01" }));
      expect(again.challengeId).not.toBe(challenge.challengeId);
      expect(consumed()).toBe(0);
    });
  });

  it("refuses to issue a challenge when the instance has no origin", async () => {
    await withSessions(async ({ context }) => {
      const sessions = createSessions(context, () => composeRepo(context), {
        origin: undefined,
        signingSecret: SECRET,
      });
      expect(await sessions.issueChallenge({ agentId: "agt_atlas01" })).toMatchObject({
        ok: false,
        code: "internal",
      });
    });
  });
});

describe("the signing secret", () => {
  it("leaves every call unavailable without a usable secret, changing nothing", async () => {
    await withSessions(async ({ sessions, enroll, login, restart, consumed }) => {
      const agent = await enroll();
      const { request } = await login(agent);
      const { token } = value(await sessions.redeem((await login(agent)).request));
      for (const secret of [undefined, "", "x".repeat(MIN_SIGNING_SECRET_LENGTH - 1)]) {
        const unsigned = restart({ signingSecret: secret });
        const refused = { ok: false, code: "unavailable" };
        expect(await unsigned.issueChallenge({ agentId: agent.agentId })).toMatchObject(refused);
        expect(await unsigned.redeem(request)).toMatchObject(refused);
        expect(await unsigned.authenticate(token)).toMatchObject(refused);
      }
      expect(consumed()).toBe(1);
      // The same challenge still redeems once the secret is back.
      value(await restart().redeem(request));
    });
  });

  it("accepts a secret of exactly the shortest length", async () => {
    await withSessions(async ({ enroll, restart }) => {
      const sessions = restart({ signingSecret: "s".repeat(MIN_SIGNING_SECRET_LENGTH) });
      const agent = await enroll();
      const challenge = value(await sessions.issueChallenge({ agentId: agent.agentId }));
      const request = {
        agentId: agent.agentId,
        challengeId: challenge.challengeId,
        signature: await agent.key.sign(challenge.message),
      };
      const { token } = value(await sessions.redeem(request));
      value(await sessions.authenticate(token));
      // Its keys are not the configured secret's.
      expect(await restart().authenticate(token)).toMatchObject({
        ok: false,
        code: "unauthenticated",
      });
    });
  });

  it("stores no signing key, and a replaced secret ends sessions and open challenges", async () => {
    await withSessions(async ({ sessions, enroll, login, restart, context }) => {
      const agent = await enroll();
      const open = await login(agent);
      const { token } = value(await sessions.redeem((await login(agent)).request));
      const tables = context.storage.sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE 'sessions%'")
        .toArray()
        .map((row) => row.name)
        .toSorted();
      expect(tables).toEqual(["sessions_challenge", "sessions_challenge_agent"]);

      const rotated = restart({ signingSecret: `${SECRET}-rotated` });
      expect(await rotated.authenticate(token)).toMatchObject({
        ok: false,
        code: "unauthenticated",
      });
      expect(await rotated.redeem(open.request)).toMatchObject({
        ok: false,
        code: "challenge_invalid",
      });
      value(await restart().authenticate(token));
    });
  });

  it("derives a separate key per repository and purpose, and none from a short secret", async () => {
    const data = enc.encode("same input");
    async function mac(secret: string, repoId: string, purpose: "challenge" | "token") {
      const key = await deriveSessionKey(secret, repoId, purpose);
      if (key === undefined) throw new Error("expected a key");
      return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
    }
    const base = await mac(SECRET, "rep_demo0001", "token");
    expect(await mac(SECRET, "rep_demo0001", "token")).toEqual(base);
    expect(await mac(SECRET, "rep_demo0002", "token")).not.toEqual(base);
    expect(await mac(SECRET, "rep_demo0001", "challenge")).not.toEqual(base);
    expect(await mac(`${SECRET}!`, "rep_demo0001", "token")).not.toEqual(base);
    expect(await deriveSessionKey(undefined, "rep_demo0001", "token")).toBeUndefined();
    expect(await deriveSessionKey("short", "rep_demo0001", "token")).toBeUndefined();
  });
});

describe("redeeming a challenge", () => {
  it("returns a ten-minute token naming the agent, owner and repository", async () => {
    await withSessions(async ({ sessions, enroll, login, repoId, clock, consumed }) => {
      const agent = await enroll();
      const { request } = await login(agent);
      const session = value(await sessions.redeem(request));
      expect(session).toEqual({
        token: expect.any(String),
        expiresAt: clock.now + SESSION_TTL_MS,
        agent: { agentId: agent.agentId, name: "a-1", ownerId: USER, state: "confirmed" },
        repoId,
      });
      expect(claimsOf(session.token)).toEqual({
        v: 1,
        sub: agent.agentId,
        owner: USER,
        repo: repoId,
        iat: clock.now,
        exp: session.expiresAt,
        jti: expect.stringMatching(/^[0-9a-f]{32}$/),
      });
      expect(value(await sessions.authenticate(session.token))).toEqual({
        kind: "agent",
        agentId: agent.agentId,
        ownerId: USER,
        repoId,
      });
      expect(consumed()).toBe(1);
    });
  });

  it("gives exactly one session when one challenge is redeemed concurrently", async () => {
    await withSessions(async ({ sessions, enroll, login, consumed }) => {
      const { request } = await login(await enroll());
      const results = await Promise.all([1, 2, 3, 4, 5].map(() => sessions.redeem(request)));
      expect(results.map((r) => (r.ok ? "ok" : r.code)).toSorted()).toEqual([
        "challenge_invalid",
        "challenge_invalid",
        "challenge_invalid",
        "challenge_invalid",
        "ok",
      ]);
      expect(consumed()).toBe(1);
    });
  });

  it("refuses a repeat after a lost response, and a new challenge logs in again", async () => {
    await withSessions(async ({ sessions, enroll, login, restart }) => {
      const agent = await enroll();
      const { request } = await login(agent);
      value(await sessions.redeem(request));
      // The response was lost; the CLI repeats it, also against a restarted Repo.
      expect(await sessions.redeem(request)).toMatchObject({
        ok: false,
        code: "challenge_invalid",
      });
      expect(await restart().redeem(request)).toMatchObject({
        ok: false,
        code: "challenge_invalid",
      });
      const retry = await login(agent);
      expect(value(await sessions.redeem(retry.request)).agent.agentId).toBe(agent.agentId);
    });
  });

  it("refuses a signature in another namespace or by another key, consuming nothing", async () => {
    await withSessions(async ({ sessions, enroll, login, consumed }) => {
      const agent = await enroll();
      const other = await enroll();
      const { challenge, request } = await login(agent, { namespace: "git" });
      expect(await sessions.redeem(request)).toMatchObject({
        ok: false,
        code: "challenge_invalid",
      });
      const byOther = await login(agent, { signer: other.key });
      expect(await sessions.redeem(byOther.request)).toMatchObject({
        ok: false,
        code: "challenge_invalid",
      });
      // Another agent cannot redeem a challenge issued to this one, even signing it itself.
      expect(
        await sessions.redeem({
          agentId: other.agentId,
          challengeId: challenge.challengeId,
          signature: await other.key.sign(challenge.message),
        }),
      ).toMatchObject({ ok: false, code: "challenge_invalid" });
      expect(consumed()).toBe(0);
      // The challenge was never consumed, so the right signature still redeems it.
      const signed = { ...request, signature: await agent.key.sign(challenge.message) };
      value(await sessions.redeem(signed));
    });
  });

  it("refuses an unknown agent and a forged or altered challenge id like a bad signature", async () => {
    await withSessions(async ({ sessions, enroll, login, clock, repo, consumed }) => {
      const agent = await enroll();
      const unknown = { agentId: "agt_nobody01", key: agent.key };
      expect(await sessions.redeem((await login(unknown)).request)).toMatchObject({
        ok: false,
        code: "challenge_invalid",
      });

      const { challenge } = await login(agent);
      const sign = async (challengeId: string, expiresAt: number) => ({
        agentId: agent.agentId,
        challengeId,
        signature: await agent.key.sign(
          loginMessage({
            origin: ORIGIN,
            org: ORG,
            repo,
            agentId: agent.agentId,
            challengeId,
            expiresAt,
          }),
        ),
      });
      // A changed MAC, nonce or expiry: the last pushes the expiry out by a minute.
      const later = (challenge.expiresAt + CHALLENGE_TTL_MS).toString(16).padStart(12, "0");
      for (const [challengeId, expiresAt] of [
        [flipAt(challenge.challengeId, -1), challenge.expiresAt],
        [flipAt(challenge.challengeId, 20), challenge.expiresAt],
        [`chl_${later}${challenge.challengeId.slice(16)}`, challenge.expiresAt + CHALLENGE_TTL_MS],
        [`chl_${"0".repeat(20)}`, clock.now + CHALLENGE_TTL_MS],
      ] as const) {
        expect(await sessions.redeem(await sign(challengeId, expiresAt))).toMatchObject({
          ok: false,
          code: "challenge_invalid",
        });
      }
      expect(consumed()).toBe(0);
    });
  });

  it("redeems until the challenge expires, and not at its expiry", async () => {
    await withSessions(async ({ sessions, enroll, login, clock }) => {
      const agent = await enroll();
      const first = await login(agent);
      clock.now = first.challenge.expiresAt - 1;
      value(await sessions.redeem(first.request));

      const second = await login(agent);
      clock.now = second.challenge.expiresAt;
      expect(await sessions.redeem(second.request)).toMatchObject({
        ok: false,
        code: "challenge_invalid",
      });
    });
  });

  it("refuses a challenge that expires while its signature is being checked, consuming nothing", async () => {
    await withSessions(async ({ enroll, login, clock, context, consumed }) => {
      const ports = composeRepo(context);
      let expiresAt = 0;
      // The clock passes the challenge's expiry between the open check and the consuming transaction.
      const sessions = createSessions(
        context,
        () => ({
          ...ports,
          identity: {
            ...ports.identity,
            view: async (principal) => {
              clock.now = expiresAt;
              return ports.identity.view(principal);
            },
          },
        }),
        { origin: ORIGIN, signingSecret: SECRET },
      );
      const agent = await enroll();
      const { challenge, request } = await login(agent);
      expiresAt = challenge.expiresAt;
      expect(await sessions.redeem(request)).toMatchObject({
        ok: false,
        code: "challenge_invalid",
      });
      expect(consumed()).toBe(0);
    });
  });

  it("refuses unconfirmed and revoked agents after their signature checks, consuming nothing", async () => {
    await withSessions(async ({ sessions, identity, enroll, login, repoId, consumed }) => {
      const pending = await enroll({ pending: true });
      expect(await sessions.redeem((await login(pending)).request)).toMatchObject({
        ok: false,
        code: "identity_pending",
      });
      const revoked = await enroll();
      value(
        await identity.revoke(grant(repoId, { kind: "agent.revoke", agentId: revoked.agentId })),
      );
      expect(await sessions.redeem((await login(revoked)).request)).toMatchObject({
        ok: false,
        code: "identity_revoked",
      });
      // Standing is told only to the key holder; a wrong signature is the usual refusal.
      const other = await AgentKey.create();
      expect(
        await sessions.redeem((await login(revoked, { signer: other })).request),
      ).toMatchObject({ ok: false, code: "challenge_invalid" });
      expect(consumed()).toBe(0);
    });
  });

  it("bounds logins per agent and window, and frees them a window after redemption", async () => {
    await withSessions(async ({ sessions, enroll, login, clock, consumed }) => {
      const agent = await enroll();
      for (let i = 0; i < MAX_LOGINS_PER_WINDOW; i += 1) {
        value(await sessions.redeem((await login(agent)).request));
      }
      const over = await login(agent);
      expect(await sessions.redeem(over.request)).toMatchObject({
        ok: false,
        code: "rate_limited",
      });
      // Another agent has its own budget.
      value(await sessions.redeem((await login(await enroll())).request));

      clock.now += CHALLENGE_TTL_MS;
      value(await sessions.redeem((await login(agent)).request));
      expect(consumed()).toBe(1);
    });
  });

  it("counts a login from its redemption, so redeeming challenges near expiry cannot pass the limit", async () => {
    await withSessions(async ({ sessions, enroll, login, clock, consumed }) => {
      const agent = await enroll();
      const issuedAt = clock.now;
      const early = [];
      for (let i = 0; i < MAX_LOGINS_PER_WINDOW; i += 1) early.push(await login(agent));
      // Every challenge was issued at `issuedAt`; all are redeemed one millisecond before expiry.
      const redeemedAt = issuedAt + CHALLENGE_TTL_MS - 1;
      clock.now = redeemedAt;
      for (const { request } of early) value(await sessions.redeem(request));

      // The early challenges have expired, but their logins still fill this window.
      clock.now = issuedAt + CHALLENGE_TTL_MS;
      const fresh = await login(agent);
      expect(await sessions.redeem(fresh.request)).toMatchObject({
        ok: false,
        code: "rate_limited",
      });
      clock.now = redeemedAt + CHALLENGE_TTL_MS - 1;
      expect(await sessions.redeem(fresh.request)).toMatchObject({
        ok: false,
        code: "rate_limited",
      });
      // The refusals consumed nothing, so the same challenge logs in once the window has passed.
      expect(consumed()).toBe(MAX_LOGINS_PER_WINDOW);
      clock.now = redeemedAt + CHALLENGE_TTL_MS;
      value(await sessions.redeem(fresh.request));
      expect(consumed()).toBe(1);
    });
  });
});

describe("authenticating a token", () => {
  it("accepts a token until it expires, also after a restart, and not at its expiry", async () => {
    await withSessions(async ({ sessions, enroll, login, clock, restart }) => {
      const session = value(await sessions.redeem((await login(await enroll())).request));
      clock.now = session.expiresAt - 1;
      value(await restart().authenticate(session.token));
      clock.now = session.expiresAt;
      expect(await sessions.authenticate(session.token)).toMatchObject({
        ok: false,
        code: "unauthenticated",
      });
    });
  });

  it("refuses a token at its next use once the agent is revoked", async () => {
    await withSessions(async ({ sessions, identity, enroll, login, repoId }) => {
      const agent = await enroll();
      const session = value(await sessions.redeem((await login(agent)).request));
      value(await identity.revoke(grant(repoId, { kind: "agent.revoke", agentId: agent.agentId })));
      expect(await sessions.authenticate(session.token)).toMatchObject({
        ok: false,
        code: "identity_revoked",
      });
    });
  });

  it("refuses altered, malformed and foreign tokens", async () => {
    await withSessions(async ({ sessions, enroll, login, repoId, clock }) => {
      const agent = await enroll();
      const { token } = value(await sessions.redeem((await login(agent)).request));
      const [header = "", payload = "", mac = ""] = token.split(".");
      const forgedClaims: SessionClaims = {
        v: 1,
        sub: agent.agentId,
        owner: USER,
        repo: repoId,
        iat: clock.now,
        exp: clock.now + SESSION_TTL_MS,
        jti: "0".repeat(32),
      };
      // Claims re-encoded under the real MAC, and valid claims under a key this repository lacks.
      const otherKey = await randomKey();
      const foreign = await signSessionToken(otherKey, forgedClaims);
      const reencoded = `${header}.${foreign.split(".")[1] ?? ""}.${mac}`;
      for (const bad of [
        "",
        "not-a-token",
        `${header}.${payload}`,
        `${header}.${payload}.${flipAt(mac, 3)}`,
        `${header}.${flipAt(payload, 5)}.${mac}`,
        `${flipAt(header, 2)}.${payload}.${mac}`,
        `${token}.extra`,
        "a".repeat(5000),
        reencoded,
        foreign,
      ]) {
        expect(await sessions.authenticate(bad)).toMatchObject({
          ok: false,
          code: "unauthenticated",
        });
      }
    });
  });

  it("refuses a token issued by another repository, even for the same agent id", async () => {
    let foreign = "";
    await withSessions(async ({ sessions, enroll, login }) => {
      foreign = value(await sessions.redeem((await login(await enroll())).request)).token;
    });
    await withSessions(async ({ sessions }) => {
      expect(await sessions.authenticate(foreign)).toMatchObject({
        ok: false,
        code: "unauthenticated",
      });
    });
  });
});

/** `text`, a binary string, as base64url without padding. */
function part(text: string): string {
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A token over arbitrary claims, built here independently of `signSessionToken`. */
async function signRaw(key: CryptoKey, claims: unknown): Promise<string> {
  const body = `${part('{"alg":"HS256","typ":"JWT"}')}.${part(JSON.stringify(claims))}`;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${part(String.fromCharCode(...mac))}`;
}

describe("session tokens", () => {
  const claims: SessionClaims = {
    v: 1,
    sub: "agt_atlas01",
    owner: USER,
    repo: "rep_demo0001",
    iat: 1_790_000_000_000,
    exp: 1_790_000_000_000 + SESSION_TTL_MS,
    jti: "0123456789abcdef0123456789abcdef",
  };

  it("round-trips its claims and refuses claims that break the layout", async () => {
    const key = await randomKey();
    const token = await signSessionToken(key, claims);
    expect(await verifySessionToken(key, token, claims.iat)).toEqual({ ok: true, claims });
    expect(await verifySessionToken(key, token, claims.exp)).toEqual({
      ok: false,
      reason: "expired",
    });
    for (const broken of [
      { ...claims, v: 2 },
      { ...claims, exp: claims.exp + 1 },
      { ...claims, sub: "usr_atlas01" },
      { ...claims, repo: "acme/demo" },
      { ...claims, jti: "short" },
      { ...claims, iat: -SESSION_TTL_MS, exp: 0 },
    ]) {
      // Validly signed but malformed claims are refused, never trusted for having a MAC.
      const signed = await signRaw(key, broken);
      expect(await verifySessionToken(key, signed, claims.iat)).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });
});

describe("the agent routes", () => {
  it("log in over HTTP and authenticate session routes against the current identity", async () => {
    const repo = unique("r");
    const stub: DurableObjectStub<Repo> = env.REPO.getByName(repoObjectName(ORG, repo));
    const { repoId } = value(await stub.initialize(ORG, repo));
    const key = await AgentKey.create();
    const base = `${ORIGIN}${AGENT_PATH_PREFIX}/${ORG}/${repo}`;
    async function post<T>(path: string, body: unknown, token?: string): Promise<AgentResponse<T>> {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (token !== undefined) headers.authorization = `Bearer ${token}`;
      const reply = await SELF.fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      return reply.json();
    }
    async function status(token: string): Promise<AgentResponse<unknown>> {
      const reply = await SELF.fetch(`${base}/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return reply.json();
    }

    const agentId = await runInDurableObject(stub, async (_instance, state) => {
      const log = EventLog.open(state.storage, repoId);
      const { identity } = composeRepo({
        repoId,
        storage: state.storage,
        log,
        clock: Date.now,
        env,
        wake: () => {},
      });
      const created = value(
        await identity.createInvite(grant(repoId, { kind: "invite.create", name: "atlas" })),
      );
      const [inviteId = "", inviteSecret = ""] =
        /\/(inv_[0-9a-f]+)#(.+)$/.exec(created.inviteUrl)?.slice(1) ?? [];
      const joined = value(
        await identity.join({
          inviteId,
          inviteSecret,
          publicKey: key.publicKey,
          signature: await key.sign(
            joinMessage({ origin: ORIGIN, org: ORG, repo, inviteId, publicKey: key.publicKey }),
          ),
        }),
      );
      const id = joined.agent.agentId;
      value(
        await identity.confirm(
          grant(repoId, { kind: "agent.confirm", agentId: id, code: joined.code }),
        ),
      );
      return id;
    });

    const challenge = await post<ChallengeResult>("/session/challenge", { agentId });
    if (!challenge.ok) throw new Error(challenge.error.code);
    const request = {
      agentId,
      challengeId: challenge.data.challengeId,
      signature: await key.sign(challenge.data.message),
    };
    const session = await post<SessionResult>("/session", request);
    if (!session.ok) throw new Error(session.error.code);
    expect(session.data).toMatchObject({ repoId, agent: { agentId, state: "confirmed" } });
    expect(await post("/session", request)).toMatchObject({
      ok: false,
      error: { code: "challenge_invalid" },
    });

    // Authenticated, status answers for the session's agent, which holds no claim yet.
    expect(await status(session.data.token)).toMatchObject({
      ok: true,
      data: { agent: { agentId, state: "confirmed" }, claim: null },
    });
    expect(await status(flipAt(session.data.token, -2))).toMatchObject({
      ok: false,
      error: { code: "unauthenticated" },
    });

    await runInDurableObject(stub, async (_instance, state) => {
      const log = EventLog.open(state.storage, repoId);
      const { identity } = composeRepo({
        repoId,
        storage: state.storage,
        log,
        clock: Date.now,
        env,
        wake: () => {},
      });
      value(await identity.revoke(grant(repoId, { kind: "agent.revoke", agentId })));
    });
    expect(await status(session.data.token)).toMatchObject({
      ok: false,
      error: { code: "identity_revoked" },
    });
  });
});
