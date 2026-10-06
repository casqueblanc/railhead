// A backend's demo seed and board in memory, reached over a real Cap'n Web session on a message
// channel, for the live target's tests. It follows the backend's `demo.seed` and `demo.reset` rules
// (#149) closely enough to tell a correct client from a wrong one; it is not the backend.

import { createServer } from "node:net";
import { newMessagePortRpcSession, RpcTarget } from "capnweb";
import type { RailheadApi } from "../../packages/railhead-shared/src/api.ts";
import type {
  ActionChallenge,
  BoardErrorCode,
  BoardResult,
  DemoSeedAction,
  DemoSeedResult,
  DemoSeedState,
  EventPage,
  PasskeyAssertion,
} from "../../packages/railhead-shared/src/board-api.ts";
import type { RailheadEvent } from "../../packages/railhead-shared/src/events.ts";
import type { LiveSession } from "./liveTarget.ts";

/** The demo repository's identifier on the fake backend. */
const REPO_ID = "rep_demo";

/** What the owner's authenticator would return for challenge `id`; the fake accepts only this. */
export function signedFor(id: string): PasskeyAssertion {
  return {
    credentialId: "Y3JlZA",
    clientDataJson: "e30",
    authenticatorData: "YXV0aA",
    signature: Buffer.from(`signed ${id}`).toString("base64url"),
    userHandle: null,
  };
}

const fail = (code: BoardErrorCode): { ok: false; code: BoardErrorCode; message: string } => ({
  ok: false,
  code,
  message: `The fake backend refused with ${code}.`,
});

export function issueEvent(seq: number, title: string, body: string): RailheadEvent {
  return {
    v: 1,
    seq,
    at: 0,
    repo: REPO_ID,
    actor: { kind: "human", id: "usr_owner" },
    type: "issue.filed",
    data: { issueId: `iss_${seq}`, title, body },
  };
}

export function otherEvent(seq: number): RailheadEvent {
  return {
    v: 1,
    seq,
    at: 0,
    repo: REPO_ID,
    actor: { kind: "human", id: "usr_owner" },
    type: "agent.invited",
    data: { inviteId: `inv_${seq}`, name: `agent-${seq}` },
  };
}

/** A backend's demo seed and board in memory, following the `demo.seed` and `demo.reset` rules. */
export class FakeBackend {
  main: string | null = null;
  exists = false;
  events: RailheadEvent[] = [];
  /** The board history; a reset starts another, as the backend's does. */
  history = "h1";
  /** The demo repository's recorded forks, which a reset deletes one by one before main. */
  forks: string[] = [];
  /** The bundles `perform` received, as bytes. */
  readonly received: Uint8Array[] = [];
  readonly prepared: DemoSeedAction[] = [];
  /** The actions `perform` applied, in order. */
  readonly performed: DemoSeedAction["kind"][] = [];
  /** A failure the next `perform` answers with, before doing anything. */
  failNextPerform: BoardErrorCode | null = null;
  /**
   * When set, the next reset deletes this many forks and then answers `internal`, as the backend
   * does when a later deletion fails after earlier ones succeeded.
   */
  failResetAfterForks: number | null = null;
  /** Whether the next `perform` applies its action and then never answers, as a lost response. */
  withholdNextAnswer = false;
  /** Runs as `openBoard` is called, before it looks up the repository. */
  onOpenBoard: (() => void) | null = null;
  /** Runs after `readEvents` builds a page, before it answers. */
  onReadEvents: (() => void) | null = null;
  /** Whether `readEvents` stops advancing its cursor. */
  stall = false;
  readonly #challenges = new Map<string, DemoSeedAction>();
  #histories = 1;

  prepare(action: DemoSeedAction): BoardResult<ActionChallenge> {
    this.prepared.push(action);
    const challengeId = `dsc_${this.#challenges.size + 1}`;
    this.#challenges.set(challengeId, action);
    return {
      ok: true,
      value: {
        challengeId,
        challenge: Buffer.from(challengeId).toString("base64url"),
        rpId: "railhead.dev",
        allowCredentials: ["Y3JlZA"],
        expiresAt: Date.UTC(2026, 9, 3, 12, 0, 0),
      },
    };
  }

  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
    bundle: Uint8Array | null,
  ): BoardResult<DemoSeedResult> {
    if (this.failNextPerform !== null) {
      const code = this.failNextPerform;
      this.failNextPerform = null;
      return fail(code);
    }
    const action = this.#challenges.get(challengeId);
    if (action === undefined) return fail("proof_expired");
    if (assertion.signature !== signedFor(challengeId).signature) return fail("proof_invalid");
    this.#challenges.delete(challengeId);
    switch (action.kind) {
      case "demo.seed":
        if (bundle === null) return fail("invalid_request");
        this.received.push(bundle);
        if (this.main !== null && this.main !== action.head) return fail("action_stale");
        this.main = action.head;
        this.exists = true;
        this.performed.push(action.kind);
        return { ok: true, value: { kind: "demo.seed", repo: REPO_ID, head: action.head } };
      case "demo.reset": {
        if (this.failResetAfterForks !== null) {
          this.forks = this.forks.slice(this.failResetAfterForks);
          this.failResetAfterForks = null;
          return fail("internal");
        }
        const deleted = this.exists || this.main !== null;
        this.forks = [];
        this.exists = false;
        this.main = null;
        this.events = [];
        this.startHistory();
        this.performed.push(action.kind);
        return { ok: true, value: { kind: "demo.reset", deleted } };
      }
      default:
        throw new Error("unknown action");
    }
  }

  /** Starts a new board history, as a reset does. */
  startHistory(): void {
    this.#histories += 1;
    this.history = `h${this.#histories}`;
  }

  readEvents(cursor: number, limit: number, history?: string): BoardResult<EventPage> {
    if (history !== undefined && history !== this.history) return fail("cursor_ahead");
    const events = this.stall ? [] : this.events.filter((e) => e.seq > cursor).slice(0, limit);
    const page: EventPage = {
      repo: REPO_ID,
      events,
      cursor: events.at(-1)?.seq ?? cursor,
      head: this.events.at(-1)?.seq ?? 0,
      history: this.history,
    };
    this.onReadEvents?.();
    return { ok: true, value: page };
  }
}

class FakeDemoSeed extends RpcTarget {
  readonly #backend: FakeBackend;
  constructor(backend: FakeBackend) {
    super();
    this.#backend = backend;
  }
  read(): BoardResult<DemoSeedState | null> {
    const b = this.#backend;
    return { ok: true, value: b.exists ? { repo: REPO_ID, main: b.main } : null };
  }
  prepare(action: DemoSeedAction): BoardResult<ActionChallenge> {
    return this.#backend.prepare(action);
  }
  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
    bundle: Uint8Array | null,
  ): BoardResult<DemoSeedResult> | Promise<never> {
    const backend = this.#backend;
    const answer = backend.perform(challengeId, assertion, bundle);
    if (!backend.withholdNextAnswer) return answer;
    backend.withholdNextAnswer = false;
    return new Promise<never>(() => {});
  }
}

class FakeBoard extends RpcTarget {
  readonly #backend: FakeBackend;
  constructor(backend: FakeBackend) {
    super();
    this.#backend = backend;
  }
  readEvents(cursor: number, limit: number, history?: string): BoardResult<EventPage> {
    return this.#backend.readEvents(cursor, limit, history);
  }
}

class FakeApi extends RpcTarget {
  readonly #backend: FakeBackend;
  constructor(backend: FakeBackend) {
    super();
    this.#backend = backend;
  }
  demoSeed(): FakeDemoSeed {
    return new FakeDemoSeed(this.#backend);
  }
  openBoard(org: string, repo: string): BoardResult<FakeBoard> {
    this.#backend.onOpenBoard?.();
    if (!this.#backend.exists || `${org}/${repo}` !== "demo/upload-app") return fail("not_found");
    return { ok: true, value: new FakeBoard(this.#backend) };
  }
}

/** A real Cap'n Web session with `backend` over a message channel, as the CLI's `openSession`. */
export function sessionWith(backend: FakeBackend): LiveSession {
  const channel = new MessageChannel();
  newMessagePortRpcSession(channel.port1, new FakeApi(backend));
  const stub = newMessagePortRpcSession<RailheadApi>(channel.port2);
  return {
    demoSeed: () => stub.demoSeed(),
    openBoard: (org, repo) => stub.openBoard(org, repo),
    [Symbol.dispose]() {
      stub[Symbol.dispose]();
      channel.port1.close();
      channel.port2.close();
    },
  };
}

/** A port that was just free: nothing listens on it, so a connection to it is refused. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  await new Promise((done) => server.close(done));
  if (address === null || typeof address !== "object") throw new Error("The server has no port.");
  return address.port;
}
