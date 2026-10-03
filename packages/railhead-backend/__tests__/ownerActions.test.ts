import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { describe, expect, it } from "vitest";
import { API_PATH, type RailheadApi } from "@railhead/shared/api";
import type {
  OwnerAction,
  OwnerActionResult,
  PasskeyAssertion,
  PasskeyRegistration,
} from "@railhead/shared/board-api";
import { relyingParty, type RelyingParty } from "../src/auth/passkeyVerifier";
import type { ClaimsPort } from "../src/contracts/claims";
import type { DecisionsPort } from "../src/contracts/decisions";
import type { IdentityPort } from "../src/contracts/identity";
import type { GrantFor, HumanGrant } from "../src/contracts/principals";
import { fail, ok, type PortResult } from "../src/contracts/result";
import {
  createOwner,
  MAX_ACTION_BYTES,
  MAX_SEALED_CHALLENGE_LENGTH,
  type OwnerDependencies,
  type OwnerPort,
} from "../src/modules/owner/entry";
import { InstanceOwner, MAX_OPEN_ENROLLMENTS } from "../src/modules/owner/instance";
import { OWNER_OBJECT_NAME, type Owner } from "../src/modules/owner/OwnerObject";
import { composeRepo, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";

// A software authenticator stands in for Touch ID. It registers an ES256 credential with a `none`
// attestation and signs assertions with an advancing counter, so each field can be tampered with.

const HOST = "railhead.mashin.workers.dev";
const ORIGIN = `https://${HOST}`;
const TOKEN = "t".repeat(40);
const enc = new TextEncoder();

function party(): RelyingParty {
  const found = relyingParty(HOST);
  if (found === undefined) throw new Error("the test host is not a relying party host");
  return found;
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
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

function cborBytes(bytes: Uint8Array): number[] {
  return [...cborHead(2, bytes.length), ...bytes];
}

function derInteger(raw: Uint8Array): number[] {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start += 1;
  const body = [...raw.subarray(start)];
  if ((body[0] ?? 0) & 0x80) body.unshift(0);
  return [0x02, body.length, ...body];
}

function toDer(raw: Uint8Array): Uint8Array {
  const body = [...derInteger(raw.subarray(0, 32)), ...derInteger(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

interface RegisterOptions {
  type?: string;
  challenge?: string;
  origin?: string;
  fmt?: string;
  flags?: number;
  /** The COSE algorithm byte: 0x26 is ES256 (-7), 0x27 is EdDSA (-8). */
  alg?: number;
  reportedId?: string;
  /** Encode the COSE key with every CBOR head one size longer than needed, as CBOR permits. */
  longHeads?: boolean;
}

interface AssertOptions {
  signCount?: number;
  signer?: CryptoKey;
}

class Authenticator {
  readonly credentialId: string;
  #counter = 0;

  private constructor(
    readonly privateKey: CryptoKey,
    readonly x: Uint8Array,
    readonly y: Uint8Array,
    readonly idBytes: Uint8Array,
  ) {
    this.credentialId = b64url(idBytes);
  }

  static async create(): Promise<Authenticator> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    if (!("privateKey" in pair)) throw new Error("ECDSA generateKey returned a single key");
    const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
    if (!(exported instanceof ArrayBuffer)) throw new Error("raw export is not bytes");
    const raw = new Uint8Array(exported);
    return new Authenticator(
      pair.privateKey,
      raw.slice(1, 33),
      raw.slice(33),
      crypto.getRandomValues(new Uint8Array(16)),
    );
  }

  async register(challenge: string, options: RegisterOptions = {}): Promise<PasskeyRegistration> {
    const clientData = enc.encode(
      JSON.stringify({
        type: options.type ?? "webauthn.create",
        challenge: options.challenge ?? challenge,
        origin: options.origin ?? ORIGIN,
        crossOrigin: false,
      }),
    );
    const cose = options.longHeads
      ? [
          184,
          5,
          24,
          1,
          24,
          2,
          24,
          3,
          56,
          6,
          56,
          0,
          24,
          1,
          56,
          1,
          89,
          0,
          32,
          ...this.x,
          56,
          2,
          89,
          0,
          32,
          ...this.y,
        ]
      : [
          0xa5,
          0x01,
          0x02,
          0x03,
          options.alg ?? 0x26,
          0x20,
          0x01,
          0x21,
          0x58,
          32,
          ...this.x,
          0x22,
          0x58,
          32,
          ...this.y,
        ];
    const authData = Uint8Array.from([
      ...(await sha256(enc.encode(HOST))),
      options.flags ?? 0x45,
      0,
      0,
      0,
      0,
      ...new Uint8Array(16),
      0,
      this.idBytes.length,
      ...this.idBytes,
      ...cose,
    ]);
    const attestation = Uint8Array.from([
      0xa3,
      ...cborText("fmt"),
      ...cborText(options.fmt ?? "none"),
      ...cborText("attStmt"),
      0xa0,
      ...cborText("authData"),
      ...cborBytes(authData),
    ]);
    return {
      credentialId: options.reportedId ?? this.credentialId,
      clientDataJson: b64url(clientData),
      attestationObject: b64url(attestation),
    };
  }

  async assert(
    challenge: string,
    userHandle: string,
    options: AssertOptions = {},
  ): Promise<PasskeyAssertion> {
    this.#counter += 1;
    const clientData = enc.encode(
      JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
    );
    const authData = new Uint8Array(37);
    authData.set(await sha256(enc.encode(HOST)), 0);
    authData[32] = 0x05;
    new DataView(authData.buffer).setUint32(33, options.signCount ?? this.#counter, false);
    const signed = Uint8Array.from([...authData, ...(await sha256(clientData))]);
    const raw = new Uint8Array(
      await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        options.signer ?? this.privateKey,
        signed,
      ),
    );
    return {
      credentialId: this.credentialId,
      clientDataJson: b64url(clientData),
      authenticatorData: b64url(authData),
      signature: b64url(toDer(raw)),
      userHandle,
    };
  }
}

function unique(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function value<T>(result: PortResult<T>): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.value;
}

interface Clock {
  now: number;
}

/** Runs `body` against an instance owner over a fresh `Owner` object's storage. */
function withInstance<T>(
  body: (owner: InstanceOwner, state: DurableObjectState, clock: Clock) => Promise<T>,
  config: { token?: string | undefined; host?: string } = {},
): Promise<T> {
  const stub = env.OWNER.getByName(unique("owner-"));
  return runInDurableObject(stub, (_instance, state) => {
    const clock = { now: Date.now() };
    const owner = new InstanceOwner(state.storage, {
      bootstrapToken: "token" in config ? config.token : TOKEN,
      relyingParty: relyingParty(config.host ?? HOST),
      clock: () => clock.now,
    });
    return body(owner, state, clock);
  });
}

/** Enrolls `auth` on the `Owner` object `stub` and returns the owner's id and user handle. */
async function enroll(
  stub: DurableObjectStub<Owner>,
  auth: Authenticator,
  options: RegisterOptions = {},
): Promise<{ userId: string; userHandle: string }> {
  return runInDurableObject(stub, async (_instance, state) => {
    const owner = new InstanceOwner(state.storage, {
      bootstrapToken: TOKEN,
      relyingParty: party(),
      clock: Date.now,
    });
    const challenge = value(await owner.prepareEnrollment(TOKEN));
    const { ownerId } = value(
      await owner.completeEnrollment(
        challenge.challengeId,
        await auth.register(challenge.challenge, options),
      ),
    );
    return { userId: ownerId, userHandle: challenge.userHandle };
  });
}

function enrollmentRows(state: DurableObjectState): number {
  return state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM owner_enrollment").one()
    .n;
}

function credentialRows(state: DurableObjectState): number {
  return state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM owner_credential").one()
    .n;
}

describe("owner enrollment", () => {
  it("enrolls one ES256 passkey with the bootstrap token and then closes", async () => {
    const auth = await Authenticator.create();
    await withInstance(async (owner, state) => {
      const challenge = value(await owner.prepareEnrollment(TOKEN));
      expect(challenge.rpId).toBe(HOST);
      expect(challenge.challengeId).toMatch(/^enr_[0-9a-f]{32}$/);
      const enrolled = value(
        await owner.completeEnrollment(
          challenge.challengeId,
          await auth.register(challenge.challenge),
        ),
      );
      expect(enrolled.ownerId).toMatch(/^usr_[0-9a-f]{32}$/);
      expect(owner.credential()).toMatchObject({
        userId: enrolled.ownerId,
        credential: {
          credentialId: auth.credentialId,
          userHandle: challenge.userHandle,
          signCount: 0,
        },
      });

      // Closed for good: the right token opens nothing, and no ceremony is left open.
      expect(await owner.prepareEnrollment(TOKEN)).toMatchObject({
        ok: false,
        code: "bootstrap_closed",
      });
      expect(enrollmentRows(state)).toBe(0);
      expect(credentialRows(state)).toBe(1);
    });
  });

  it("stores the COSE key in its shortest encoding, however the authenticator encoded it", async () => {
    const auth = await Authenticator.create();
    const shortest = Uint8Array.from([
      165,
      1,
      2,
      3,
      38,
      32,
      1,
      33,
      88,
      32,
      ...auth.x,
      34,
      88,
      32,
      ...auth.y,
    ]);
    for (const longHeads of [false, true]) {
      await withInstance(async (owner) => {
        const challenge = value(await owner.prepareEnrollment(TOKEN));
        value(
          await owner.completeEnrollment(
            challenge.challengeId,
            await auth.register(challenge.challenge, { longHeads }),
          ),
        );
        expect(owner.credential()?.credential.publicKey).toEqual(shortest);
      });
    }
  });

  it("refuses a second ceremony opened before the first completed", async () => {
    const first = await Authenticator.create();
    const second = await Authenticator.create();
    await withInstance(async (owner, state) => {
      const a = value(await owner.prepareEnrollment(TOKEN));
      const b = value(await owner.prepareEnrollment(TOKEN));
      const [ra, rb] = await Promise.all([
        first.register(a.challenge).then((r) => owner.completeEnrollment(a.challengeId, r)),
        second.register(b.challenge).then((r) => owner.completeEnrollment(b.challengeId, r)),
      ]);
      const outcomes = [ra, rb].map((r) => (r.ok ? "ok" : r.code)).toSorted();
      expect(outcomes).toEqual(["bootstrap_closed", "ok"]);
      expect(credentialRows(state)).toBe(1);
    });
  });

  it("stays shut for a wrong, missing or short token and stores nothing", async () => {
    await withInstance(async (owner, state) => {
      for (const presented of ["", "x".repeat(40), `${TOKEN}x`, "y".repeat(600)]) {
        expect(await owner.prepareEnrollment(presented)).toMatchObject({
          ok: false,
          code: "bootstrap_closed",
        });
      }
      expect(enrollmentRows(state)).toBe(0);
    });
    for (const token of [undefined, "short-token"]) {
      await withInstance(
        async (owner, state) => {
          expect(await owner.prepareEnrollment(token ?? "")).toMatchObject({
            ok: false,
            code: "bootstrap_closed",
          });
          expect(enrollmentRows(state)).toBe(0);
        },
        { token },
      );
    }
  });

  it("refuses registrations that are not this ceremony's ES256 passkey", async () => {
    const auth = await Authenticator.create();
    const other = await Authenticator.create();
    const cases: RegisterOptions[] = [
      { type: "webauthn.get" },
      { challenge: b64url(new Uint8Array(32)) },
      { origin: "https://railhead.dev" },
      { fmt: "packed" },
      { flags: 0x41 },
      { alg: 0x27 },
      { reportedId: other.credentialId },
    ];
    await withInstance(async (owner, state) => {
      const challenge = value(await owner.prepareEnrollment(TOKEN));
      for (const options of cases) {
        const registration = await auth.register(challenge.challenge, options);
        expect(await owner.completeEnrollment(challenge.challengeId, registration)).toMatchObject({
          ok: false,
          code: "proof_invalid",
        });
      }
      expect(
        await owner.completeEnrollment(challenge.challengeId, {
          credentialId: auth.credentialId,
          clientDataJson: "not base64url!",
          attestationObject: "",
        }),
      ).toMatchObject({ ok: false, code: "proof_invalid" });
      expect(credentialRows(state)).toBe(0);
      // A refused registration leaves the ceremony open for a valid one.
      value(
        await owner.completeEnrollment(
          challenge.challengeId,
          await auth.register(challenge.challenge),
        ),
      );
    });
  });

  it("expires ceremonies and bounds how many are open", async () => {
    const auth = await Authenticator.create();
    await withInstance(async (owner, _state, clock) => {
      const stale = value(await owner.prepareEnrollment(TOKEN));
      for (let n = 1; n < MAX_OPEN_ENROLLMENTS; n += 1) value(await owner.prepareEnrollment(TOKEN));
      expect(await owner.prepareEnrollment(TOKEN)).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      clock.now = stale.expiresAt;
      expect(
        await owner.completeEnrollment(stale.challengeId, await auth.register(stale.challenge)),
      ).toMatchObject({ ok: false, code: "proof_expired" });
      // Expired ceremonies no longer count against the bound.
      value(await owner.prepareEnrollment(TOKEN));
      expect(
        await owner.completeEnrollment("enr_nothex", await auth.register(stale.challenge)),
      ).toMatchObject({ ok: false, code: "invalid_request" });
    });
  });

  it("fails closed when the relying party host is not a Railhead host", async () => {
    await withInstance(
      async (owner, state) => {
        expect(await owner.prepareEnrollment(TOKEN)).toMatchObject({
          ok: false,
          code: "internal",
        });
        expect(enrollmentRows(state)).toBe(0);
      },
      { host: "evil.example" },
    );
  });
});

/** The five ports an owner action may be handed to. */
type ActionPort =
  | "identity.createInvite"
  | "identity.confirm"
  | "identity.revoke"
  | "claims.fileIssue"
  | "decisions.record";

/** A grant as one port received it. */
interface Dispatch {
  port: ActionPort;
  grant: HumanGrant;
}

/** How each fake action port answers. The decisions answer may read and write the event log. */
interface Answers {
  createInvite(grant: GrantFor<"invite.create">): ReturnType<IdentityPort["createInvite"]>;
  confirm(grant: GrantFor<"agent.confirm">): ReturnType<IdentityPort["confirm"]>;
  revoke(grant: GrantFor<"agent.revoke">, log: EventLog): ReturnType<IdentityPort["revoke"]>;
  fileIssue(grant: GrantFor<"issue.file">): ReturnType<ClaimsPort["fileIssue"]>;
  record(grant: GrantFor<"decision.record">): ReturnType<DecisionsPort["record"]>;
}

const INVITE_RESULT = {
  inviteId: "inv_invite01",
  inviteUrl: "https://railhead.mashin.workers.dev/join/inv_invite01#secret",
  expiresAt: 1_900_000_000_000,
};

const DEFAULT_ANSWERS: Answers = {
  createInvite: async () => ok(INVITE_RESULT),
  confirm: async (grant) => ok({ agentId: grant.action.agentId }),
  revoke: async (grant) => ok({ agentId: grant.action.agentId }),
  fileIssue: async () => ok({ issueId: "iss_issue0001" }),
  record: async (grant) =>
    ok({ decisionId: grant.action.decisionId, version: (grant.action.expectedVersion ?? 0) + 1 }),
};

/** `base` with its five action ports replaced by fakes that record each grant they receive. */
function recordingPorts(
  base: RepoPorts,
  dispatched: Dispatch[],
  answers: Answers,
  log: EventLog,
): RepoPorts {
  return {
    ...base,
    identity: {
      ...base.identity,
      async createInvite(grant) {
        dispatched.push({ port: "identity.createInvite", grant });
        return answers.createInvite(grant);
      },
      async confirm(grant) {
        dispatched.push({ port: "identity.confirm", grant });
        return answers.confirm(grant);
      },
      async revoke(grant) {
        dispatched.push({ port: "identity.revoke", grant });
        return answers.revoke(grant, log);
      },
    },
    claims: {
      ...base.claims,
      async fileIssue(grant) {
        dispatched.push({ port: "claims.fileIssue", grant });
        return answers.fileIssue(grant);
      },
    },
    decisions: {
      ...base.decisions,
      async record(grant) {
        dispatched.push({ port: "decisions.record", grant });
        return answers.record(grant);
      },
    },
  };
}

interface Harness {
  owner: OwnerPort;
  auth: Authenticator;
  userId: string;
  userHandle: string;
  repoId: string;
  /** The enrolled credential's stored signature counter. */
  signCount(): Promise<number>;
  /** Every grant an action port received, in order. */
  grants: Dispatch[];
  clock: Clock;
  state: DurableObjectState;
  /** A second owner module over the same storage, as after the Repo restarts. */
  restart(): OwnerPort;
}

const CONFIRM: OwnerAction = { kind: "agent.confirm", agentId: "agt_atlas01", code: "123456" };
const REVOKE: OwnerAction = { kind: "agent.revoke", agentId: "agt_atlas01" };

/**
 * Runs `body` inside a fresh repository with its owner module wired to a freshly enrolled `Owner`
 * object, and with action ports that record the grants they receive and answer with `answers`.
 */
async function withRepoOwner(
  body: (harness: Harness) => Promise<void>,
  answers: Partial<Answers> = {},
  registerOptions: RegisterOptions = {},
): Promise<void> {
  const auth = await Authenticator.create();
  const ownerName = unique("owner-");
  const { userId, userHandle } = await enroll(
    env.OWNER.getByName(ownerName),
    auth,
    registerOptions,
  );
  const name = unique("r");
  const repo: DurableObjectStub<Repo> = env.REPO.getByName(repoObjectName("acme", name));
  const { repoId } = value(await repo.initialize("acme", name));
  await runInDurableObject(repo, async (_instance, state) => {
    const clock = { now: Date.now() };
    const log = EventLog.open(state.storage, repoId);
    const context = { repoId, storage: state.storage, log, clock: () => clock.now, env };
    const grants: Dispatch[] = [];
    const ports = recordingPorts(
      composeRepo(context),
      grants,
      { ...DEFAULT_ANSWERS, ...answers },
      log,
    );
    // The stub is made inside the Repo, as the module's own factory makes it.
    const dependencies: OwnerDependencies = {
      instance: env.OWNER.getByName(ownerName),
      relyingParty: party(),
    };
    const build = () => createOwner(context, () => ports, dependencies);
    await body({
      owner: build(),
      auth,
      userId,
      userHandle,
      repoId,
      signCount: () =>
        runInDurableObject(
          env.OWNER.getByName(ownerName),
          (_owner, ownerState) =>
            ownerState.storage.sql
              .exec<{ sign_count: number }>("SELECT sign_count FROM owner_credential")
              .one().sign_count,
        ),
      grants,
      clock,
      state,
      restart: build,
    });
  });
}

/** The grant id a sealed challenge id names: its first field. */
function grantId(challengeId: string): string {
  return challengeId.split(".")[0] ?? "";
}

/** Whether the challenge `challengeId` seals is recorded as spent. */
function isSpent(state: DurableObjectState, challengeId: string): boolean {
  return (
    state.storage.sql
      .exec("SELECT 1 FROM owner_spent_challenge WHERE challenge_id = ?", grantId(challengeId))
      .toArray().length > 0
  );
}

function rows(state: DurableObjectState, table: string): number {
  return state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
}

/** `challengeId` with its field at `index` replaced by `field`. */
function withField(challengeId: string, index: number, field: string): string {
  const parts = challengeId.split(".");
  parts[index] = field;
  return parts.join(".");
}

describe("owner actions", () => {
  it("performs a prepared action once and hands the port a grant for exactly it", async () => {
    await withRepoOwner(async ({ owner, auth, userId, userHandle, repoId, grants }) => {
      const challenge = value(await owner.prepare(CONFIRM));
      expect(challenge).toMatchObject({ rpId: HOST, allowCredentials: [auth.credentialId] });
      expect(challenge.challengeId).toMatch(
        /^pkc_[0-9a-f]{32}\.[0-9]+\.[\w-]{43}\.[\w-]+\.[\w-]{43}$/,
      );
      const assertion = await auth.assert(challenge.challenge, userHandle);
      expect(await owner.perform(challenge.challengeId, assertion)).toEqual({
        ok: true,
        value: { kind: "agent.confirm", agentId: "agt_atlas01" },
      });
      expect(grants).toEqual([
        {
          port: "identity.confirm",
          grant: {
            kind: "human",
            userId,
            repoId,
            grantId: grantId(challenge.challengeId),
            action: CONFIRM,
          },
        },
      ]);
    });
  });

  it("hands invites, issues and decisions to their own port, once per proof", async () => {
    const cases: { action: OwnerAction; port: ActionPort; result: OwnerActionResult }[] = [
      {
        action: { kind: "invite.create", name: "atlas" },
        port: "identity.createInvite",
        result: { kind: "invite.create", ...INVITE_RESULT },
      },
      {
        action: { kind: "issue.file", title: "Flaky upload", body: "It drops the last chunk." },
        port: "claims.fileIssue",
        result: { kind: "issue.file", issueId: "iss_issue0001" },
      },
      {
        action: {
          kind: "decision.record",
          decisionId: "dec_decision1",
          option: "b",
          expectedVersion: 4,
        },
        port: "decisions.record",
        result: { kind: "decision.record", decisionId: "dec_decision1", version: 5 },
      },
    ];
    await withRepoOwner(async ({ owner, auth, userId, userHandle, repoId, grants, state }) => {
      for (const { action, port, result } of cases) {
        grants.length = 0;
        const challenge = value(await owner.prepare(action));
        const proof = await auth.assert(challenge.challenge, userHandle);
        expect(await owner.perform(challenge.challengeId, proof), port).toEqual({
          ok: true,
          value: result,
        });
        // Exactly one grant, to exactly this port, for exactly the prepared action.
        expect(grants, port).toEqual([
          {
            port,
            grant: {
              kind: "human",
              userId,
              repoId,
              grantId: grantId(challenge.challengeId),
              action,
            },
          },
        ]);
        expect(await owner.perform(challenge.challengeId, proof), port).toMatchObject({
          ok: false,
          code: "proof_expired",
        });
        expect(grants, port).toHaveLength(1);
      }
      expect(rows(state, "owner_spent_challenge")).toBe(cases.length);
    });
  });

  it("returns an invite, issue or decision port's refusal and keeps its proof spent", async () => {
    // A decision whose current version is 1: only `expectedVersion: 1` records the next one.
    let current = 1;
    await withRepoOwner(
      async ({ owner, auth, userHandle, grants, state }) => {
        const refusals: { action: OwnerAction; port: ActionPort; code: string }[] = [
          {
            action: { kind: "invite.create", name: "atlas" },
            port: "identity.createInvite",
            code: "unavailable",
          },
          {
            action: { kind: "issue.file", title: "t", body: "" },
            port: "claims.fileIssue",
            code: "invalid_request",
          },
          {
            action: {
              kind: "decision.record",
              decisionId: "dec_decision1",
              option: "a",
              expectedVersion: null,
            },
            port: "decisions.record",
            code: "action_stale",
          },
        ];
        for (const { action, port, code } of refusals) {
          grants.length = 0;
          const challenge = value(await owner.prepare(action));
          const proof = await auth.assert(challenge.challenge, userHandle);
          expect(await owner.perform(challenge.challengeId, proof), port).toEqual({
            ok: false,
            code,
            message: `refused by ${port}`,
          });
          expect(
            grants.map((d) => [d.port, d.grant.action]),
            port,
          ).toEqual([[port, action]]);
          expect(isSpent(state, challenge.challengeId), port).toBe(true);
          expect(await owner.perform(challenge.challengeId, proof), port).toMatchObject({
            ok: false,
            code: "proof_expired",
          });
          expect(grants, port).toHaveLength(1);
        }
        expect(current).toBe(1);

        // The stale proof cannot be replayed into the corrected action; a fresh proof records it.
        grants.length = 0;
        const fresh: OwnerAction = {
          kind: "decision.record",
          decisionId: "dec_decision1",
          option: "a",
          expectedVersion: 1,
        };
        const challenge = value(await owner.prepare(fresh));
        expect(
          await owner.perform(
            challenge.challengeId,
            await auth.assert(challenge.challenge, userHandle),
          ),
        ).toEqual({
          ok: true,
          value: { kind: "decision.record", decisionId: "dec_decision1", version: 2 },
        });
        expect(grants.map((d) => d.grant.action)).toEqual([fresh]);
        expect(current).toBe(2);
      },
      {
        createInvite: async () => fail("unavailable", "refused by identity.createInvite"),
        fileIssue: async () => fail("invalid_request", "refused by claims.fileIssue"),
        record: async (grant) => {
          if (grant.action.expectedVersion !== current) {
            return fail("action_stale", "refused by decisions.record");
          }
          current += 1;
          return ok({ decisionId: grant.action.decisionId, version: current });
        },
      },
    );
  });

  it("authorizes a concurrently replayed proof once", async () => {
    await withRepoOwner(async ({ owner, auth, userHandle, grants }) => {
      const challenge = value(await owner.prepare(CONFIRM));
      const assertion = await auth.assert(challenge.challenge, userHandle);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => owner.perform(challenge.challengeId, assertion)),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const refused of results.filter((r) => !r.ok)) {
        expect(refused).toMatchObject({ ok: false, code: "proof_expired" });
      }
      expect(grants).toHaveLength(1);
      expect(await owner.perform(challenge.challengeId, assertion)).toMatchObject({
        code: "proof_expired",
      });
    });
  });

  it("performs with a passkey whose enrolled COSE key used longer CBOR heads", async () => {
    await withRepoOwner(
      async ({ owner, auth, userHandle, grants }) => {
        const challenge = value(await owner.prepare(REVOKE));
        const assertion = await auth.assert(challenge.challenge, userHandle);
        expect(await owner.perform(challenge.challengeId, assertion)).toEqual({
          ok: true,
          value: { kind: "agent.revoke", agentId: "agt_atlas01" },
        });
        expect(grants).toHaveLength(1);
      },
      {},
      { longHeads: true },
    );
  });

  it("refuses a proof signed for another action and leaves both challenges unused", async () => {
    await withRepoOwner(async ({ owner, auth, userHandle, grants, state }) => {
      const confirm = value(await owner.prepare(CONFIRM));
      const revoke = value(await owner.prepare(REVOKE));
      const forRevoke = await auth.assert(revoke.challenge, userHandle);
      expect(await owner.perform(confirm.challengeId, forRevoke)).toMatchObject({
        ok: false,
        code: "proof_invalid",
      });
      expect(grants).toEqual([]);
      expect(isSpent(state, confirm.challengeId)).toBe(false);
      expect(isSpent(state, revoke.challengeId)).toBe(false);
      // A tampered signature is refused without consuming the challenge.
      const tampered = { ...forRevoke, signature: forRevoke.signature.slice(0, -4) + "AAAA" };
      expect(await owner.perform(revoke.challengeId, tampered)).toMatchObject({
        ok: false,
        code: "proof_invalid",
      });
      expect(isSpent(state, revoke.challengeId)).toBe(false);
      // The other challenge's action sealed into this one's id breaks the seal.
      const swapped = withField(confirm.challengeId, 3, revoke.challengeId.split(".")[3] ?? "");
      expect(await owner.perform(swapped, forRevoke)).toMatchObject({
        ok: false,
        code: "proof_invalid",
      });
      expect(grants).toEqual([]);
      // Both challenges still work for their own action.
      value(await owner.perform(revoke.challengeId, forRevoke));
      value(
        await owner.perform(confirm.challengeId, await auth.assert(confirm.challenge, userHandle)),
      );
    });
  });

  it("refuses an assertion from a key that is not the owner's", async () => {
    const intruder = await Authenticator.create();
    await withRepoOwner(async ({ owner, auth, userHandle, grants }) => {
      const challenge = value(await owner.prepare(CONFIRM));
      const forged = await auth.assert(challenge.challenge, userHandle, {
        signer: intruder.privateKey,
      });
      expect(await owner.perform(challenge.challengeId, forged)).toMatchObject({
        ok: false,
        code: "proof_invalid",
      });
      expect(grants).toEqual([]);
    });
  });

  it("keeps a proof consumed when the action fails or rolls back", async () => {
    let calls = 0;
    await withRepoOwner(
      async ({ owner, auth, userHandle, grants, state, repoId, restart }) => {
        const failing = value(await owner.prepare(CONFIRM));
        const failingProof = await auth.assert(failing.challenge, userHandle);
        expect(await owner.perform(failing.challengeId, failingProof)).toMatchObject({
          ok: false,
          code: "action_stale",
        });
        expect(await owner.perform(failing.challengeId, failingProof)).toMatchObject({
          code: "proof_expired",
        });

        const throwing = value(await owner.prepare(REVOKE));
        const throwingProof = await auth.assert(throwing.challenge, userHandle);
        await expect(owner.perform(throwing.challengeId, throwingProof)).rejects.toThrow(
          "action rolled back",
        );
        // The action's own writes rolled back; the consumption did not.
        expect(EventLog.open(state.storage, repoId).head()).toBe(0);
        expect(isSpent(state, throwing.challengeId)).toBe(true);
        expect(await restart().perform(throwing.challengeId, throwingProof)).toMatchObject({
          code: "proof_expired",
        });
        expect(grants).toHaveLength(2);
      },
      {
        confirm: async () => {
          calls += 1;
          return fail("action_stale", "The code differs.");
        },
        revoke: async (grant, log) => {
          calls += 1;
          log.transaction((tx) => {
            tx.append(
              { kind: "human", id: grant.userId },
              { type: "issue.filed", data: { issueId: "iss_issue0001", title: "x", body: "" } },
            );
            throw new Error("action rolled back");
          });
          return ok({ agentId: "agt_atlas01" });
        },
      },
    );
    expect(calls).toBe(2);
  });

  it("refuses expired, forged and malformed challenges without acting", async () => {
    await withRepoOwner(async ({ owner, auth, userHandle, grants, clock, state }) => {
      const challenge = value(await owner.prepare(CONFIRM));
      const assertion = await auth.assert(challenge.challenge, userHandle);
      const { challengeId } = challenge;
      // A seal that is not this repository's, or fields the seal does not cover.
      const forged = [
        withField(challengeId, 4, b64url(new Uint8Array(32))),
        withField(challengeId, 0, `pkc_${"0".repeat(32)}`),
        withField(challengeId, 1, String(challenge.expiresAt + 60_000)),
        withField(challengeId, 2, b64url(new Uint8Array(32))),
        withField(challengeId, 3, b64url(enc.encode(JSON.stringify(REVOKE)))),
      ];
      for (const id of forged) {
        expect(await owner.perform(id, assertion)).toMatchObject({
          ok: false,
          code: "proof_invalid",
        });
      }
      const malformed = [
        "chl_x",
        `pkc_${"0".repeat(32)}`,
        `${challengeId}.x`,
        withField(challengeId, 1, "0"),
        withField(challengeId, 3, "not base64url!"),
        withField(challengeId, 3, b64url(enc.encode("{"))),
        `${challengeId}${"A".repeat(MAX_SEALED_CHALLENGE_LENGTH)}`,
      ];
      for (const id of malformed) {
        expect(await owner.perform(id, assertion)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      }
      clock.now = challenge.expiresAt;
      expect(await owner.perform(challengeId, assertion)).toMatchObject({
        ok: false,
        code: "proof_expired",
      });
      expect(rows(state, "owner_spent_challenge")).toBe(0);
      // The largest action still yields an id within the stated bound, read back intact.
      const empty = JSON.stringify({ kind: "issue.file", title: "t", body: "" }).length;
      const largest = value(
        await owner.prepare({
          kind: "issue.file",
          title: "t",
          body: "b".repeat(MAX_ACTION_BYTES - empty),
        }),
      );
      expect(largest.challengeId.length).toBeLessThanOrEqual(MAX_SEALED_CHALLENGE_LENGTH);
      expect(grants).toEqual([]);
      expect(
        await owner.perform(largest.challengeId, await auth.assert(largest.challenge, userHandle)),
      ).toEqual({ ok: true, value: { kind: "issue.file", issueId: "iss_issue0001" } });
      expect(isSpent(state, largest.challengeId)).toBe(true);
      expect(grants.map(({ port, grant }) => [port, grant.action])).toEqual([
        [
          "claims.fileIssue",
          { kind: "issue.file", title: "t", body: "b".repeat(MAX_ACTION_BYTES - empty) },
        ],
      ]);
      expect(
        await owner.prepare({ kind: "issue.file", title: "t", body: "b".repeat(70_000) }),
      ).toMatchObject({ ok: false, code: "invalid_request" });
      expect(grants).toHaveLength(1);
    });
  });

  it("issues challenges to any caller without storing them, and still serves the owner", async () => {
    await withRepoOwner(async ({ owner, auth, userHandle, grants, state }) => {
      // Far more than any open-challenge quota would have allowed.
      for (let n = 0; n < 200; n += 1) value(await owner.prepare(REVOKE));
      expect(rows(state, "owner_spent_challenge")).toBe(0);
      expect(rows(state, "owner_seal_key")).toBe(1);
      const challenge = value(await owner.prepare(REVOKE));
      const proof = await auth.assert(challenge.challenge, userHandle);
      expect(await owner.perform(challenge.challengeId, proof)).toEqual({
        ok: true,
        value: { kind: "agent.revoke", agentId: "agt_atlas01" },
      });
      expect(grants).toHaveLength(1);
    });
  });

  it("keeps a spent challenge only until it expires", async () => {
    await withRepoOwner(async ({ owner, auth, userHandle, state, clock, restart }) => {
      const first = value(await owner.prepare(CONFIRM));
      const firstProof = await auth.assert(first.challenge, userHandle);
      value(await owner.perform(first.challengeId, firstProof));
      expect(rows(state, "owner_spent_challenge")).toBe(1);
      // A restarted module reads the same seal key and the same spent record.
      expect(await restart().perform(first.challengeId, firstProof)).toMatchObject({
        code: "proof_expired",
      });
      clock.now = first.expiresAt;
      const second = value(await owner.prepare(REVOKE));
      value(
        await restart().perform(
          second.challengeId,
          await auth.assert(second.challenge, userHandle),
        ),
      );
      // Spending the second pruned the first, whose expiry already made it unusable.
      expect(isSpent(state, first.challengeId)).toBe(false);
      expect(isSpent(state, second.challengeId)).toBe(true);
      expect(await owner.perform(first.challengeId, firstProof)).toMatchObject({
        code: "proof_expired",
      });
    });
  });

  it("refuses an assertion whose signature counter does not advance", async () => {
    await withRepoOwner(async ({ owner, auth, userHandle, grants }) => {
      const first = value(await owner.prepare(CONFIRM));
      const second = value(await owner.prepare(REVOKE));
      const third = value(await owner.prepare(REVOKE));
      // Two proofs carrying the same counter race: the counter advances for one of them only.
      const [a, b] = await Promise.all([
        auth
          .assert(first.challenge, userHandle, { signCount: 7 })
          .then((p) => owner.perform(first.challengeId, p)),
        auth
          .assert(second.challenge, userHandle, { signCount: 7 })
          .then((p) => owner.perform(second.challengeId, p)),
      ]);
      expect([a, b].filter((r) => r.ok)).toHaveLength(1);
      expect([a, b].find((r) => !r.ok)).toMatchObject({ code: "proof_invalid" });
      // A later proof with a lower counter is a possible cloned authenticator.
      const regressed = await auth.assert(third.challenge, userHandle, { signCount: 3 });
      expect(await owner.perform(third.challengeId, regressed)).toMatchObject({
        ok: false,
        code: "proof_invalid",
      });
      expect(grants).toHaveLength(1);
    });
  });

  it("performs with an authenticator that does not count, one use per proof", async () => {
    await withRepoOwner(
      async ({ owner, auth, userId, userHandle, repoId, grants, signCount, restart }) => {
        const zero = { signCount: 0 };
        const grantFor = (challengeId: string, action: OwnerAction) => ({
          kind: "human",
          userId,
          repoId,
          grantId: grantId(challengeId),
          action,
        });
        // Two independently prepared actions both succeed with a counter that stays at zero.
        const first = value(await owner.prepare(CONFIRM));
        expect(
          await owner.perform(
            first.challengeId,
            await auth.assert(first.challenge, userHandle, zero),
          ),
        ).toEqual({ ok: true, value: { kind: "agent.confirm", agentId: "agt_atlas01" } });
        const second = value(await owner.prepare(REVOKE));
        expect(
          await owner.perform(
            second.challengeId,
            await auth.assert(second.challenge, userHandle, zero),
          ),
        ).toEqual({ ok: true, value: { kind: "agent.revoke", agentId: "agt_atlas01" } });
        expect(grants).toEqual([
          { port: "identity.confirm", grant: grantFor(first.challengeId, CONFIRM) },
          { port: "identity.revoke", grant: grantFor(second.challengeId, REVOKE) },
        ]);
        expect(await signCount()).toBe(0);

        // The counter cannot tell a replay apart, so the spent challenge alone stops one.
        const third = value(await owner.prepare(REVOKE));
        const proof = await auth.assert(third.challenge, userHandle, zero);
        const results = await Promise.all(
          Array.from({ length: 5 }, () => owner.perform(third.challengeId, proof)),
        );
        expect(results.filter((r) => r.ok)).toEqual([
          { ok: true, value: { kind: "agent.revoke", agentId: "agt_atlas01" } },
        ]);
        for (const refused of results.filter((r) => !r.ok)) {
          expect(refused).toMatchObject({ ok: false, code: "proof_expired" });
        }
        expect(grants).toHaveLength(3);
        expect(grants[2]).toEqual({
          port: "identity.revoke",
          grant: grantFor(third.challengeId, REVOKE),
        });
        for (const spent of [first, second, third]) {
          expect(
            await restart().perform(
              spent.challengeId,
              await auth.assert(spent.challenge, userHandle, zero),
            ),
          ).toMatchObject({ ok: false, code: "proof_expired" });
        }
        expect(grants).toHaveLength(3);
        expect(await signCount()).toBe(0);

        // Once a counting proof advances the counter, a zero counter is a regression.
        const counting = value(await owner.prepare(CONFIRM));
        value(
          await owner.perform(
            counting.challengeId,
            await auth.assert(counting.challenge, userHandle, { signCount: 5 }),
          ),
        );
        expect(await signCount()).toBe(5);
        const regressed = value(await owner.prepare(CONFIRM));
        expect(
          await owner.perform(
            regressed.challengeId,
            await auth.assert(regressed.challenge, userHandle, zero),
          ),
        ).toMatchObject({ ok: false, code: "proof_invalid" });
        expect(grants).toHaveLength(4);
        expect(await signCount()).toBe(5);
      },
    );
  });

  it("refuses to issue a challenge before any owner is enrolled", async () => {
    const name = unique("r");
    const repo = env.REPO.getByName(repoObjectName("acme", name));
    const { repoId } = value(await repo.initialize("acme", name));
    await runInDurableObject(repo, async (_instance, state) => {
      const context = {
        repoId,
        storage: state.storage,
        log: EventLog.open(state.storage, repoId),
        clock: Date.now,
        env,
      };
      const owner = createOwner(context, () => composeRepo(context), {
        instance: env.OWNER.getByName(unique("owner-")),
        relyingParty: party(),
      });
      expect(await owner.prepare(CONFIRM)).toMatchObject({ ok: false, code: "unavailable" });
      expect(rows(state, "owner_spent_challenge")).toBe(0);
    });
  });
});

describe("human-only actions through the Worker", () => {
  it("gives an agent no route to decide, approve or add an agent", async () => {
    const name = unique("r");
    const repo = env.REPO.getByName(repoObjectName("acme", name));
    const { repoId } = value(await repo.initialize("acme", name));
    const paths = [
      "/decisions",
      "/decisions/dec_decision1",
      "/questions/qst_question1/answer",
      "/agents",
      "/agents/agt_atlas01/confirm",
      "/agents/agt_atlas01/approve",
      "/invites",
      "/issues",
      "/owner/perform",
    ];
    for (const path of paths) {
      const response = await SELF.fetch(`${ORIGIN}/agent/v1/acme/${name}${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer aaaa.bbbb.cccc", "Content-Type": "application/json" },
        body: JSON.stringify({ option: "a", code: "123456", name: "atlas" }),
      });
      expect(response.status, path).toBe(404);
    }
    const head = await runInDurableObject(repo, (_instance, state) =>
      EventLog.open(state.storage, repoId).head(),
    );
    expect(head).toBe(0);
  });

  it("performs a board action once through the RPC session, with the instance's passkey", async () => {
    const auth = await Authenticator.create();
    const { userHandle } = await enroll(env.OWNER.getByName(OWNER_OBJECT_NAME), auth);
    const name = unique("r");
    value(await env.REPO.getByName(repoObjectName("acme", name)).initialize("acme", name));

    const response = await SELF.fetch(`${ORIGIN}${API_PATH}`, {
      headers: { Upgrade: "websocket" },
    });
    const socket = response.webSocket;
    if (socket === null) throw new Error("no WebSocket");
    socket.accept();
    using api = newWebSocketRpcSession<RailheadApi>(socket);
    const opened = await api.openBoard("acme", name);
    if (!opened.ok) throw new Error(opened.code);
    using board = opened.value;
    using owner = await board.owner();

    // An anonymous session asks for more challenges than any open-challenge quota would allow.
    const other = await SELF.fetch(`${ORIGIN}${API_PATH}`, { headers: { Upgrade: "websocket" } });
    const otherSocket = other.webSocket;
    if (otherSocket === null) throw new Error("no WebSocket");
    otherSocket.accept();
    using anonymous = newWebSocketRpcSession<RailheadApi>(otherSocket);
    const anonymousBoard = await anonymous.openBoard("acme", name);
    if (!anonymousBoard.ok) throw new Error(anonymousBoard.code);
    using anonymousOwner = await anonymousBoard.value.owner();
    const flood = await Promise.all(
      Array.from({ length: 40 }, () => anonymousOwner.prepare(REVOKE)),
    );
    expect(flood.every((r) => r.ok)).toBe(true);
    anonymousBoard.value[Symbol.dispose]();

    const challenge = await owner.prepare(REVOKE);
    if (!challenge.ok) throw new Error(challenge.code);
    expect(challenge.value.rpId).toBe(HOST);
    const proof = await auth.assert(challenge.value.challenge, userHandle);
    // The proof is consumed even though the action does not complete: without the identity module
    // the port is unavailable, and with it the revocation of an unregistered agent is stale.
    const first = await owner.perform(challenge.value.challengeId, proof);
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error("the action should not complete");
    expect(["unavailable", "action_stale"]).toContain(first.code);
    expect(await owner.perform(challenge.value.challengeId, proof)).toMatchObject({
      ok: false,
      code: "proof_expired",
    });

    // A second enrollment is refused once the instance has its owner.
    using enrollment = await api.ownerEnrollment();
    expect(await enrollment.prepare(TOKEN)).toMatchObject({ ok: false, code: "bootstrap_closed" });
  });
});
