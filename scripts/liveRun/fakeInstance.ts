// A qualification instance in memory for the live run driver's tests, reached over a real Cap'n Web
// session on a message channel. The demo seed and the board's log are the demo seed's
// `FakeBackend`; the owner's enrollment, every owner challenge and every assertion go through the
// backend's own passkey verifier (`../ownerKey/backendVerifier.ts`), so only a key the instance
// enrolled can act. Agents join through `join`, as `rh join` would over HTTP. It is not the backend.

import { createHash, randomBytes, randomInt } from "node:crypto";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import type { RailheadApi } from "../../packages/railhead-shared/src/api.ts";
import type {
  ActionChallenge,
  BoardErrorCode,
  BoardResult,
  DemoSeedAction,
  DemoSeedResult,
  DemoSeedState,
  EnrollmentChallenge,
  EventPage,
  OwnerAction,
  OwnerActionResult,
  PasskeyAssertion,
  PasskeyRegistration,
  PendingJoin,
} from "../../packages/railhead-shared/src/board-api.ts";
import { FakeBackend, issueEvent, REPO_ID, signedFor } from "../demoSeed/fakeBackend.ts";
import {
  actionChallenge,
  isRecord,
  relyingParty,
  verifyActionAssertion,
  verifyRegistration,
  type Enrolled,
} from "../ownerKey/backendVerifier.ts";
import type { DriverSession } from "./driver.ts";

/** The qualification instance's host. */
export const HOST = "railhead.mashin.workers.dev";

/** The origin the tests run against. */
export const ORIGIN = `https://${HOST}`;

/** The bootstrap token the instance was deployed with. */
export const BOOTSTRAP_TOKEN = "bootstrap-token-for-tests";

const fail = <T>(code: BoardErrorCode): BoardResult<T> => ({
  ok: false,
  code,
  message: `The fake instance refused with ${code}.`,
});

/** One action challenge the instance issued. */
interface Issued {
  readonly binding: {
    readonly repoId: string;
    readonly challengeId: string;
    readonly nonce: string;
    readonly expiresAt: number;
    readonly action: OwnerAction | DemoSeedAction;
  };
}

/** A join the instance recorded, confirmed or not. */
interface Join extends PendingJoin {
  confirmed: boolean;
}

/** A qualification instance in memory. */
export class FakeInstance {
  /** The demo seed and the board's log. */
  readonly backend = new FakeBackend();
  /** The owner's credential, once enrolled. */
  owner: Enrolled | null = null;
  /** The owner actions performed, in order. */
  readonly performed: OwnerAction["kind"][] = [];
  /** How many enrollments were prepared. */
  enrollmentsPrepared = 0;
  /** The invites created: id, the name it fixes and its secret. */
  readonly invites = new Map<string, { name: string; secret: string; used: boolean }>();
  /** Every join, in order. */
  readonly joins: Join[] = [];
  readonly #challenges = new Map<string, Issued>();
  #enrollment: EnrollmentChallenge | null = null;
  #ids = 0;

  /** A session with this instance, as the driver's `openSession` returns. */
  session(): DriverSession {
    const channel = new MessageChannel();
    newMessagePortRpcSession(channel.port1, new Api(this));
    const stub = newMessagePortRpcSession<RailheadApi>(channel.port2);
    return {
      ownerEnrollment: () => stub.ownerEnrollment(),
      demoSeed: () => stub.demoSeed(),
      openBoard: (org, repo) => stub.openBoard(org, repo),
      [Symbol.dispose]() {
        stub[Symbol.dispose]();
        channel.port1.close();
        channel.port2.close();
      },
    };
  }

  /** Records a join of `publicKey` with the invite in `inviteUrl`, as the agent wire would. */
  join(inviteUrl: string, publicKey: string): { agentId: string; code: string } {
    const url = new URL(inviteUrl);
    const id = url.pathname.split("/").at(-1) ?? "";
    const invite = this.invites.get(id);
    if (invite === undefined || invite.used || url.hash !== `#${invite.secret}`) {
      throw new Error("join refused");
    }
    invite.used = true;
    const agentId = this.#id("agt");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.joins.push({
      agentId,
      inviteId: id,
      name: invite.name,
      keyFingerprint: fingerprint(publicKey),
      code,
      joinedAt: Date.now(),
      confirmed: false,
    });
    return { agentId, code };
  }

  /** Whether the owner confirmed `agentId`. */
  confirmed(agentId: string): boolean {
    return this.joins.some((join) => join.agentId === agentId && join.confirmed);
  }

  prepareEnrollment(token: string): BoardResult<EnrollmentChallenge> {
    this.enrollmentsPrepared += 1;
    if (this.owner !== null || token !== BOOTSTRAP_TOKEN) return fail("bootstrap_closed");
    this.#enrollment = {
      challengeId: this.#id("enr"),
      challenge: randomBytes(32).toString("base64url"),
      rpId: HOST,
      userHandle: randomBytes(16).toString("base64url"),
      expiresAt: Date.now() + 60_000,
    };
    return { ok: true, value: this.#enrollment };
  }

  async completeEnrollment(
    challengeId: string,
    registration: PasskeyRegistration,
  ): Promise<BoardResult<{ ownerId: string }>> {
    const prepared = this.#enrollment;
    if (prepared === null || prepared.challengeId !== challengeId || this.owner !== null) {
      return fail("bootstrap_closed");
    }
    const result = await verifyRegistration({
      relyingParty: await relyingParty(HOST),
      challenge: prepared.challenge,
      registration,
    });
    if (!isRecord(result) || result.ok !== true || !isRecord(result.credential)) {
      return fail("proof_invalid");
    }
    const { credentialId, publicKey } = result.credential;
    if (typeof credentialId !== "string" || !(publicKey instanceof Uint8Array)) {
      return fail("proof_invalid");
    }
    this.owner = { credentialId, publicKey, userHandle: prepared.userHandle, signCount: 0 };
    this.#enrollment = null;
    return { ok: true, value: { ownerId: "usr_owner" } };
  }

  /** Issues a challenge for `action` under `challengeId`, as the backend binds it. */
  async challenge(
    challengeId: string,
    action: OwnerAction | DemoSeedAction,
  ): Promise<BoardResult<ActionChallenge>> {
    if (this.owner === null) return fail("unavailable");
    const binding = {
      repoId: REPO_ID,
      challengeId,
      nonce: randomBytes(16).toString("base64url"),
      expiresAt: Date.now() + 60_000,
      action,
    };
    const computed = await actionChallenge(await relyingParty(HOST), binding);
    if (!isRecord(computed) || typeof computed.challenge !== "string") return fail("internal");
    this.#challenges.set(challengeId, { binding });
    return {
      ok: true,
      value: {
        challengeId,
        challenge: computed.challenge,
        rpId: HOST,
        allowCredentials: [this.owner.credentialId],
        expiresAt: binding.expiresAt,
      },
    };
  }

  /** The action `assertion` approves, once, if the backend's verifier accepts it. */
  async verified(
    challengeId: string,
    assertion: PasskeyAssertion,
  ): Promise<OwnerAction | DemoSeedAction | null> {
    const issued = this.#challenges.get(challengeId);
    if (issued === undefined || this.owner === null) return null;
    this.#challenges.delete(challengeId);
    const result = await verifyActionAssertion({
      relyingParty: await relyingParty(HOST),
      binding: issued.binding,
      credential: this.owner,
      assertion,
      now: Date.now(),
    });
    if (!isRecord(result) || result.ok !== true || typeof result.signCount !== "number") {
      return null;
    }
    this.owner = { ...this.owner, signCount: result.signCount };
    return issued.binding.action;
  }

  async performOwner(
    challengeId: string,
    assertion: PasskeyAssertion,
  ): Promise<BoardResult<OwnerActionResult>> {
    const action = await this.verified(challengeId, assertion);
    if (action === null) return fail("proof_invalid");
    switch (action.kind) {
      case "issue.file": {
        const seq = (this.backend.events.at(-1)?.seq ?? 0) + 1;
        this.backend.events.push(issueEvent(seq, action.title, action.body));
        this.performed.push(action.kind);
        return { ok: true, value: { kind: "issue.file", issueId: `iss_${seq}` } };
      }
      case "invite.create": {
        const inviteId = this.#id("inv");
        const secret = randomBytes(16).toString("base64url");
        this.invites.set(inviteId, { name: action.name, secret, used: false });
        this.performed.push(action.kind);
        return {
          ok: true,
          value: {
            kind: "invite.create",
            inviteId,
            inviteUrl: `${ORIGIN}/join/demo/upload-app/${inviteId}#${secret}`,
            expiresAt: Date.now() + 15 * 60_000,
          },
        };
      }
      case "agent.confirm": {
        const join = this.joins.find(
          (j) => j.agentId === action.agentId && j.code === action.code && !j.confirmed,
        );
        if (join === undefined) return fail("action_stale");
        join.confirmed = true;
        this.performed.push(action.kind);
        return { ok: true, value: { kind: "agent.confirm", agentId: action.agentId } };
      }
      case "agent.revoke":
      case "decision.record":
      case "check.approve":
      case "demo.seed":
      case "demo.reset":
        return fail("invalid_request");
      default:
        return unreachable(action);
    }
  }

  #id(prefix: string): string {
    this.#ids += 1;
    return `${prefix}_${String(this.#ids).padStart(16, "0")}`;
  }
}

/** The OpenSSH SHA256 fingerprint of an `ssh-ed25519 <base64>` key, computed apart from the driver. */
export function fingerprint(publicKey: string): string {
  const blob = Buffer.from(publicKey.split(" ")[1] ?? "", "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

class Enrollment extends RpcTarget {
  readonly #instance: FakeInstance;
  constructor(instance: FakeInstance) {
    super();
    this.#instance = instance;
  }
  prepare(token: string): BoardResult<EnrollmentChallenge> {
    return this.#instance.prepareEnrollment(token);
  }
  complete(
    challengeId: string,
    registration: PasskeyRegistration,
  ): Promise<BoardResult<{ ownerId: string }>> {
    return this.#instance.completeEnrollment(challengeId, registration);
  }
}

class DemoSeed extends RpcTarget {
  readonly #instance: FakeInstance;
  constructor(instance: FakeInstance) {
    super();
    this.#instance = instance;
  }
  read(): BoardResult<DemoSeedState | null> {
    const { backend } = this.#instance;
    return { ok: true, value: backend.exists ? { repo: REPO_ID, main: backend.main } : null };
  }
  async prepare(action: DemoSeedAction): Promise<BoardResult<ActionChallenge>> {
    const issued = this.#instance.backend.prepare(action);
    if (!issued.ok) return issued;
    return this.#instance.challenge(issued.value.challengeId, action);
  }
  async perform(
    challengeId: string,
    assertion: PasskeyAssertion,
    bundle: Uint8Array | null,
  ): Promise<BoardResult<DemoSeedResult>> {
    const action = await this.#instance.verified(challengeId, assertion);
    if (action === null) return fail("proof_invalid");
    // The backend's stand-in for an assertion, once the real verifier accepted this one.
    return this.#instance.backend.perform(challengeId, signedFor(challengeId), bundle);
  }
}

class Owner extends RpcTarget {
  readonly #instance: FakeInstance;
  constructor(instance: FakeInstance) {
    super();
    this.#instance = instance;
  }
  prepare(action: OwnerAction): Promise<BoardResult<ActionChallenge>> {
    return this.#instance.challenge(`oac_${randomBytes(8).toString("hex")}`, action);
  }
  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
  ): Promise<BoardResult<OwnerActionResult>> {
    return this.#instance.performOwner(challengeId, assertion);
  }
}

class Board extends RpcTarget {
  readonly #instance: FakeInstance;
  constructor(instance: FakeInstance) {
    super();
    this.#instance = instance;
  }
  readEvents(cursor: number, limit: number, history?: string): BoardResult<EventPage> {
    return this.#instance.backend.readEvents(cursor, limit, history);
  }
  pendingJoins(): BoardResult<PendingJoin[]> {
    const pending = this.#instance.joins
      .filter((join) => !join.confirmed)
      .map(({ confirmed: _, ...join }) => join);
    return { ok: true, value: pending };
  }
  owner(): Owner {
    return new Owner(this.#instance);
  }
}

class Api extends RpcTarget {
  readonly #instance: FakeInstance;
  constructor(instance: FakeInstance) {
    super();
    this.#instance = instance;
  }
  ownerEnrollment(): Enrollment {
    return new Enrollment(this.#instance);
  }
  demoSeed(): DemoSeed {
    return new DemoSeed(this.#instance);
  }
  openBoard(org: string, repo: string): BoardResult<Board> {
    const { backend } = this.#instance;
    if (!backend.exists || `${org}/${repo}` !== "demo/upload-app") return fail("not_found");
    return { ok: true, value: new Board(this.#instance) };
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled ${JSON.stringify(value)}`);
}
