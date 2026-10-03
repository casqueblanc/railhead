// Test support: an in-memory backend session with one repository's log. It records every call and
// disposal so tests can assert what reached the backend and what was released. Nothing here is a
// real Cap'n Web stub.

import {
  MAX_EVENT_PAGE,
  type ActionChallenge,
  type BoardErrorCode,
  type BoardFailure,
  type BoardListener,
  type BoardResult,
  type EnrollmentChallenge,
  type EventPage,
  type OwnerAction,
  type OwnerActionResult,
  type PasskeyAssertion,
  type PasskeyRegistration,
} from "@railhead/shared/board-api";
import type { RailheadEvent, RepoId, UserId } from "@railhead/shared/events";
import type {
  ApiSession,
  BoardSession,
  EnrollmentSession,
  OwnerSession,
  SubscriptionSession,
} from "./apiSession";

const failure = (code: BoardErrorCode): BoardFailure => ({ ok: false, code, message: code });

/** What a scripted call does instead of answering normally. */
export type Fault = BoardErrorCode | "throw";

const fault = <T>(
  scripted: Fault | null,
  answer: () => BoardResult<T>,
): Promise<BoardResult<T>> => {
  if (scripted === "throw") return Promise.reject(new Error("session broken"));
  return Promise.resolve(scripted === null ? answer() : failure(scripted));
};

/**
 * Calls a test holds pending, as a backend that never answers over an open session would. Each held
 * call answers normally, late, once the test resumes it.
 */
export class Stalls<Name extends string> {
  readonly names = new Set<Name>();
  readonly #held: (() => void)[] = [];

  /** Answers with `answer` now, or holds the call while `name` is stalled. */
  gate<T>(name: Name, answer: () => Promise<T>): Promise<T> {
    if (!this.names.has(name)) return answer();
    return new Promise((resolve, reject) => {
      this.#held.push(() => answer().then(resolve, reject));
    });
  }

  /** Stops stalling and answers every held call. */
  resume(): void {
    this.names.clear();
    for (const answer of this.#held.splice(0)) answer();
  }
}

/** Disposes `listener` the way Cap'n Web disposes a target once its last remote reference goes. */
export const releaseTarget = (listener: BoardListener): void => {
  const dispose: unknown = Reflect.get(listener, Symbol.dispose);
  if (typeof dispose === "function") dispose.call(listener);
};

/**
 * A subscription handle. Like the backend, it releases the client's listener when the handle is
 * disposed or cancelled, so a client sees that disposal arrive for a subscription it dropped.
 */
export class FakeSubscription implements SubscriptionSession {
  disposed = false;
  #listener: BoardListener | null;

  constructor(listener: BoardListener) {
    this.#listener = listener;
  }

  /** Releases the listener without calling `ended`, as the backend does on a delivery failure. */
  release(): void {
    const listener = this.#listener;
    this.#listener = null;
    if (listener !== null) releaseTarget(listener);
  }

  cancel(): Promise<void> {
    this.disposed = true;
    this.release();
    return Promise.resolve();
  }

  [Symbol.dispose](): void {
    this.disposed = true;
    this.release();
  }
}

export class FakeOwner implements OwnerSession {
  disposed = false;
  readonly prepared: OwnerAction[] = [];
  readonly performed: { challengeId: string; assertion: PasskeyAssertion }[] = [];
  prepareFault: Fault | null = null;
  performFault: Fault | null = null;
  /** What `perform` reports, given the action last prepared. */
  result: (action: OwnerAction | undefined) => OwnerActionResult = (action) =>
    action?.kind === "decision.record"
      ? { kind: "decision.record", decisionId: action.decisionId, version: 7 }
      : { kind: "agent.revoke", agentId: "agt_none" };

  prepare(action: OwnerAction): Promise<BoardResult<ActionChallenge>> {
    this.prepared.push(action);
    return fault(this.prepareFault, () => ({
      ok: true,
      value: {
        challengeId: `chl_${this.prepared.length}`,
        challenge: "AQID",
        rpId: "localhost",
        allowCredentials: ["AQID"],
        expiresAt: Date.now() + 60_000,
      },
    }));
  }

  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
  ): Promise<BoardResult<OwnerActionResult>> {
    this.performed.push({ challengeId, assertion });
    return fault(this.performFault, () => ({ ok: true, value: this.result(this.prepared.at(-1)) }));
  }

  [Symbol.dispose](): void {
    this.disposed = true;
  }
}

export class FakeEnrollment implements EnrollmentSession {
  disposed = false;
  readonly tokens: string[] = [];

  prepare(bootstrapToken: string): Promise<BoardResult<EnrollmentChallenge>> {
    this.tokens.push(bootstrapToken);
    return Promise.resolve(failure("bootstrap_closed"));
  }

  complete(
    _challengeId: string,
    _registration: PasskeyRegistration,
  ): Promise<BoardResult<{ ownerId: UserId }>> {
    return Promise.resolve(failure("bootstrap_closed"));
  }

  [Symbol.dispose](): void {
    this.disposed = true;
  }
}

/** One subscription the board opened, with the listener the client passed. */
export interface Subscribed {
  cursor: number;
  listener: BoardListener;
  handle: FakeSubscription;
}

/** A repository's log, read and subscribed to like `BoardApi`. */
export class FakeBoard implements BoardSession {
  disposed = false;
  /** Most events one page returns; a page may hold fewer than the requested limit. */
  pageSize: number = MAX_EVENT_PAGE;
  readFault: Fault | null = null;
  subscribeFault: Fault | null = null;
  readonly stalls = new Stalls<"readEvents" | "subscribe" | "owner">();
  /** The cursor of every `readEvents` call. */
  readonly reads: number[] = [];
  readonly subscriptions: Subscribed[] = [];
  readonly ownerStub = new FakeOwner();
  readonly #repo: RepoId;
  readonly #log: RailheadEvent[];

  /** `log` is gapless from seq 1. */
  constructor(repo: RepoId, log: readonly RailheadEvent[]) {
    this.#repo = repo;
    this.#log = [...log];
  }

  /** Appends to the log without delivering anything. */
  append(...events: RailheadEvent[]): void {
    this.#log.push(...events);
  }

  readEvents(cursor: number, limit: number): Promise<BoardResult<EventPage>> {
    this.reads.push(cursor);
    return this.stalls.gate("readEvents", () => this.#page(cursor, limit));
  }

  #page(cursor: number, limit: number): Promise<BoardResult<EventPage>> {
    return fault(this.readFault, (): BoardResult<EventPage> => {
      if (cursor > this.#log.length) return failure("cursor_ahead");
      const events = this.#log.slice(cursor, cursor + Math.min(limit, this.pageSize));
      return {
        ok: true,
        value: {
          repo: this.#repo,
          events,
          cursor: events.at(-1)?.seq ?? cursor,
          head: this.#log.length,
          history: "fake",
        },
      };
    });
  }

  subscribe(cursor: number, listener: BoardListener): Promise<BoardResult<SubscriptionSession>> {
    return this.stalls.gate("subscribe", () =>
      fault(this.subscribeFault, () => {
        const handle = new FakeSubscription(listener);
        this.subscriptions.push({ cursor, listener, handle });
        return { ok: true, value: handle };
      }),
    );
  }

  owner(): Promise<OwnerSession> {
    return this.stalls.gate("owner", () => Promise.resolve(this.ownerStub));
  }

  /** The newest subscription. */
  latest(): Subscribed {
    const subscription = this.subscriptions.at(-1);
    if (subscription === undefined) throw new Error("nothing subscribed");
    return subscription;
  }

  [Symbol.dispose](): void {
    this.disposed = true;
  }
}

/** A backend session whose probe, break and board are driven by the test. */
export class FakeApi implements ApiSession {
  disposed = false;
  answer: () => void = () => {};
  refuse: () => void = () => {};
  break: () => void = () => {};
  readonly opened: string[] = [];
  readonly enrollment = new FakeEnrollment();
  /** Held until resumed; the probe is held until `answer` or `refuse`. */
  readonly stalls = new Stalls<"openBoard" | "ownerEnrollment">();
  /** What `openBoard` answers with: the board, or a scripted fault. */
  board: FakeBoard | Fault;
  readonly #probe = new Promise<void>((resolve, reject) => {
    this.answer = resolve;
    this.refuse = () => reject(new Error("probe refused"));
  });

  constructor(board: FakeBoard | Fault) {
    this.board = board;
  }

  ping(): Promise<void> {
    return this.#probe;
  }

  onRpcBroken(callback: (error: unknown) => void): void {
    this.break = () => callback(new Error("session broken"));
  }

  openBoard(org: string, repo: string): Promise<BoardResult<BoardSession>> {
    this.opened.push(`${org}/${repo}`);
    const { board } = this;
    return this.stalls.gate("openBoard", () =>
      board instanceof FakeBoard
        ? Promise.resolve({ ok: true, value: board })
        : fault(board, () => failure("internal")),
    );
  }

  ownerEnrollment(): Promise<EnrollmentSession> {
    return this.stalls.gate("ownerEnrollment", () => Promise.resolve(this.enrollment));
  }

  [Symbol.dispose](): void {
    this.disposed = true;
  }
}
