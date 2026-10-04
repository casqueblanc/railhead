import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import {
  newWebSocketRpcSession,
  RpcSession,
  RpcTarget,
  WebSocketTransport,
  type RpcStub,
} from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_PATH, type RailheadApi } from "@railhead/shared/api";
import {
  MAX_PUSH_BATCH,
  MAX_UNACKNOWLEDGED_EVENTS,
  type BoardApi,
  type BoardListener,
  type BoardResult,
  type SubscriptionEnd,
} from "@railhead/shared/board-api";
import type { Actor, EventPayload, RailheadEvent } from "@railhead/shared/events";
import {
  DELIVERY_TIMEOUT_MS,
  MAX_SUBSCRIPTIONS,
  streamPort,
  type StreamListener,
  type StreamSubscription,
} from "../src/modules/stream/entry";
import { EventLog } from "../src/repo/eventLog";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";
import type { RepoStorage } from "../src/repo/storage";

const ORIGIN = "https://railhead.invalid";
const REPO = "rep_demo01";
const HUMAN: Actor = { kind: "human", id: "usr_lemarier" };

function issue(n: number): EventPayload {
  return {
    type: "issue.filed",
    data: { issueId: `iss_issue${String(n).padStart(4, "0")}`, title: `Issue ${n}`, body: "" },
  };
}

function append(log: EventLog, count: number): void {
  log.transaction((tx) => {
    for (let n = 1; n <= count; n += 1) tx.append(HUMAN, issue(n));
  });
}

/** Resolves once `condition` holds, or fails after `ms`. */
async function until(condition: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Lets pending deliveries run, for asserting that nothing more arrives. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

/** Records what a subscription delivered. */
class Recorder implements StreamListener {
  readonly batches: number[][] = [];
  readonly ends: SubscriptionEnd[] = [];
  onEvents: (events: RailheadEvent[]) => Promise<void> = async () => {};

  get seqs(): number[] {
    return this.batches.flat();
  }

  async events(events: RailheadEvent[]): Promise<void> {
    this.batches.push(events.map((event) => event.seq));
    await this.onEvents(events);
  }

  async ended(reason: SubscriptionEnd): Promise<void> {
    this.ends.push(reason);
  }
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Runs `body` against a log in the storage of a Durable Object no other test touches. */
function withLog<R>(body: (log: EventLog, storage: RepoStorage) => Promise<R>): Promise<R> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, (_instance, state) =>
    body(EventLog.open(state.storage, REPO), state.storage),
  );
}

function value<T>(
  result: BoardResult<T> | { ok: true; value: T } | { ok: false; code: string },
): T {
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.value;
}

describe("EventLog commit observer", () => {
  it("hears the new head after a commit, from any log on the same storage", async () => {
    await withLog(async (log, storage) => {
      const heads: number[] = [];
      log.observe((head) => heads.push(head));

      append(log, 2);
      append(EventLog.open(storage, REPO), 3);

      expect(heads).toEqual([2, 5]);
    });
  });

  it("hears nothing for a rollback or a transaction that appended no event", async () => {
    await withLog(async (log) => {
      const heads: number[] = [];
      log.observe((head) => heads.push(head));

      expect(() =>
        log.transaction((tx) => {
          tx.append(HUMAN, issue(1));
          throw new Error("abort");
        }),
      ).toThrow("abort");
      log.transaction(() => 0);

      expect(heads).toEqual([]);
      expect(log.head()).toBe(0);
    });
  });

  it("is called after the commit, so an observer reads the committed head", async () => {
    await withLog(async (log) => {
      const seen: number[] = [];
      log.observe(() => seen.push(log.head()));

      append(log, 1);

      expect(seen).toEqual([1]);
    });
  });

  it("stops when unobserved, and a failing observer neither fails the commit nor others", async () => {
    await withLog(async (log) => {
      const heads: number[] = [];
      const stop = log.observe((head) => heads.push(head));
      log.observe(() => {
        throw new Error("observer fault");
      });
      const after: number[] = [];
      log.observe((head) => after.push(head));

      expect(log.transaction((tx) => tx.append(HUMAN, issue(1))).value.seq).toBe(1);
      stop();
      append(log, 1);

      expect(heads).toEqual([1]);
      expect(after).toEqual([1, 2]);
    });
  });
});

describe("stream subscriptions", () => {
  it("delivers a snapshot in bounded batches, then live events, gapless", async () => {
    await withLog(async (log) => {
      append(log, 150);
      const recorder = new Recorder();

      value(await streamPort(log).subscribe(0, recorder));
      await until(() => recorder.seqs.length === 150);
      append(log, 2);
      await until(() => recorder.seqs.length === 152);

      expect(recorder.seqs).toEqual(range(1, 152));
      for (const batch of recorder.batches)
        expect(batch.length).toBeLessThanOrEqual(MAX_PUSH_BATCH);
      expect(recorder.ends).toEqual([]);
    });
  });

  it("loses no event appended while the initial snapshot is being delivered", async () => {
    await withLog(async (log) => {
      append(log, 100);
      const recorder = new Recorder();
      let appended = false;
      recorder.onEvents = async () => {
        if (appended) return;
        appended = true;
        // Between the first page and the next, as another module's commit would land.
        append(log, 30);
        await settle();
        append(log, 1);
      };

      value(await streamPort(log).subscribe(0, recorder));
      await until(() => recorder.seqs.length >= 131);
      await settle();

      expect(recorder.seqs).toEqual(range(1, 131));
    });
  });

  it("starts at the head without delivering, and from a mid cursor without repeating", async () => {
    await withLog(async (log) => {
      append(log, 5);
      const port = streamPort(log);
      const atHead = new Recorder();
      const mid = new Recorder();

      value(await port.subscribe(5, atHead));
      value(await port.subscribe(3, mid));
      await until(() => mid.seqs.length === 2);
      await settle();
      expect(atHead.seqs).toEqual([]);

      append(log, 1);
      await until(() => atHead.seqs.length === 1);
      await until(() => mid.seqs.length === 3);
      expect(atHead.seqs).toEqual([6]);
      expect(mid.seqs).toEqual([4, 5, 6]);
    });
  });

  it("refuses a cursor that is not a whole number from 0, or past the head", async () => {
    await withLog(async (log) => {
      append(log, 2);
      const port = streamPort(log);
      const recorder = new Recorder();

      for (const cursor of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(await port.subscribe(cursor, recorder)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      }
      expect(await port.subscribe(3, recorder)).toMatchObject({ ok: false, code: "cursor_ahead" });
      append(log, 1);
      await settle();
      expect(recorder.batches).toEqual([]);
    });
  });

  it("treats a duplicate subscription as independent and harmless", async () => {
    await withLog(async (log) => {
      append(log, 3);
      const port = streamPort(log);
      const first = new Recorder();
      const second = new Recorder();

      const firstSubscription = value(await port.subscribe(1, first));
      value(await port.subscribe(1, second));
      await until(() => first.seqs.length === 2 && second.seqs.length === 2);
      await firstSubscription.cancel();
      await firstSubscription.cancel();
      append(log, 2);
      await until(() => second.seqs.length === 4);
      await settle();

      expect(first.seqs).toEqual([2, 3]);
      expect(second.seqs).toEqual([2, 3, 4, 5]);
      expect(first.ends).toEqual([]);
    });
  });

  it("ends with slow when the log outruns an unsettled delivery, without buffering", async () => {
    await withLog(async (log) => {
      append(log, 1);
      const recorder = new Recorder();
      let calls = 0;
      recorder.onEvents = () => {
        calls += 1;
        return new Promise(() => {});
      };

      value(await streamPort(log).subscribe(0, recorder));
      await until(() => calls === 1);
      append(log, MAX_UNACKNOWLEDGED_EVENTS);
      await settle();
      expect(recorder.ends).toEqual([]);
      append(log, 1);
      await until(() => recorder.ends.length === 1);
      append(log, 5);
      await settle();

      expect(recorder.ends).toEqual(["slow"]);
      expect(calls).toBe(1);
    });
  });

  it("ends with slow when a delivery is not settled in time", async () => {
    await withLog(async (log) => {
      append(log, 1);
      const recorder = new Recorder();
      recorder.onEvents = () => new Promise(() => {});

      value(await streamPort(log, { deliveryTimeoutMs: 20 }).subscribe(0, recorder));
      await until(() => recorder.ends.length === 1);

      expect(recorder.ends).toEqual(["slow"]);
    });
  });

  it("releases a listener whose ended throws synchronously, and frees its slot with its handle", async () => {
    await withLog(async (log) => {
      append(log, 1);
      let released = 0;
      const listener = {
        events: () => new Promise<void>(() => {}),
        ended: (): Promise<void> => {
          throw new Error("stub disposed");
        },
        dup: () => listener,
        [Symbol.dispose]: () => {
          released += 1;
        },
      };
      const port = streamPort(log, { deliveryTimeoutMs: 20 });
      const handle = value(await port.subscribe(0, listener));
      const others = [];
      for (let n = 1; n < MAX_SUBSCRIPTIONS; n += 1) {
        others.push(value(await port.subscribe(1, new Recorder())));
      }

      await until(() => released === 1);
      await settle();

      expect(released).toBe(1);
      // The ended subscription counts until its handle is released.
      expect(await port.subscribe(1, new Recorder())).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      dispose(handle);
      expect(await port.subscribe(1, new Recorder())).toMatchObject({ ok: true });
      await Promise.all(others.map((other) => other.cancel()));
    });
  });

  it("drops a listener that fails, with no further calls", async () => {
    await withLog(async (log) => {
      append(log, 1);
      const recorder = new Recorder();
      recorder.onEvents = async () => {
        throw new Error("socket closed");
      };

      value(await streamPort(log).subscribe(0, recorder));
      await until(() => recorder.batches.length === 1);
      append(log, 1);
      await settle();

      expect(recorder.batches).toEqual([[1]]);
      expect(recorder.ends).toEqual([]);
    });
  });

  it("bounds live subscriptions and frees a cancelled slot once its handle is released", async () => {
    await withLog(async (log) => {
      const port = streamPort(log);
      const subscriptions = [];
      for (let n = 0; n < MAX_SUBSCRIPTIONS; n += 1) {
        subscriptions.push(value(await port.subscribe(0, new Recorder())));
      }

      expect(await port.subscribe(0, new Recorder())).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      const first = subscriptions[0];
      if (first === undefined) throw new Error("expected a subscription");
      await first.cancel();
      expect(await port.subscribe(0, new Recorder())).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      dispose(first);
      expect(await port.subscribe(0, new Recorder())).toMatchObject({ ok: true });
    });
  });

  it("ends a subscription whose handle is disposed without cancel, once", async () => {
    await withLog(async (log) => {
      const port = streamPort(log);
      const recorder = new Recorder();
      const handle = value(await port.subscribe(0, recorder));
      const others = [];
      for (let n = 1; n < MAX_SUBSCRIPTIONS; n += 1) {
        others.push(value(await port.subscribe(0, new Recorder())));
      }

      dispose(handle);
      dispose(handle);
      await handle.cancel();
      append(log, 1);
      await settle();

      expect(recorder.batches).toEqual([]);
      expect(recorder.ends).toEqual([]);
      expect(await port.subscribe(0, new Recorder())).toMatchObject({ ok: true });
      expect(await port.subscribe(0, new Recorder())).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      await Promise.all(others.map((other) => other.cancel()));
    });
  });

  it("holds a cancelled subscription's slot until its pending delivery settles", async () => {
    await withLog(async (log) => {
      append(log, 1);
      const port = streamPort(log);
      const held = Array.from({ length: MAX_SUBSCRIPTIONS }, () => new Held());
      const handles = [];
      for (const listener of held) handles.push(value(await port.subscribe(0, listener)));
      await until(() => held.every((listener) => listener.batches.length === 1));

      // Churn: a cancel must not admit a replacement while the cancelled delivery is outstanding.
      for (const handle of handles) {
        await handle.cancel();
        dispose(handle);
      }
      expect(await port.subscribe(0, new Recorder())).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      append(log, 1);
      held[0]?.settleNext();
      await settle();

      expect(held.map((listener) => listener.released)).toEqual([
        1,
        ...Array<number>(MAX_SUBSCRIPTIONS - 1).fill(0),
      ]);
      expect(await port.subscribe(0, new Recorder())).toMatchObject({ ok: true });
      expect(await port.subscribe(0, new Recorder())).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });

      for (const listener of held) listener.settleNext();
      await settle();
      expect(held.every((listener) => listener.released === 1)).toBe(true);
      expect(held.every((listener) => listener.seqs.join() === "1")).toBe(true);
      expect(held.every((listener) => listener.ends.length === 0)).toBe(true);
      expect(await port.subscribe(0, new Recorder())).toMatchObject({ ok: true });
    });
  });

  it("holds a slow subscription's slot until its delivery and its ending settle", async () => {
    await withLog(async (log) => {
      append(log, 1);
      const port = streamPort(log);
      const held = Array.from({ length: MAX_SUBSCRIPTIONS }, () => new Held());
      const handles = [];
      for (const listener of held) handles.push(value(await port.subscribe(0, listener)));
      await until(() => held.every((listener) => listener.batches.length === 1));

      append(log, MAX_UNACKNOWLEDGED_EVENTS + 1);
      await until(() => held.every((listener) => listener.ends.length === 1));
      expect(held.every((listener) => listener.ends.join() === "slow")).toBe(true);
      for (const handle of handles) dispose(handle);
      expect(await port.subscribe(0, new Recorder())).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });

      // The deliveries settle; the endings are still in flight.
      for (const listener of held) listener.settleNext();
      await settle();
      expect(held.every((listener) => listener.released === 0)).toBe(true);
      expect(await port.subscribe(0, new Recorder())).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });

      for (const listener of held) listener.settleNext();
      await settle();
      expect(held.every((listener) => listener.released === 1)).toBe(true);
      expect(held.every((listener) => listener.seqs.join() === "1")).toBe(true);
      expect(await port.subscribe(0, new Recorder())).toMatchObject({ ok: true });
    });
  });

  it("frees a cancelled slot once a delivery that never settles times out", async () => {
    await withLog(async (log) => {
      append(log, 1);
      const port = streamPort(log, { deliveryTimeoutMs: 500 });
      const stalled = new Held();
      const handle = value(await port.subscribe(0, stalled));
      const others = [];
      for (let n = 1; n < MAX_SUBSCRIPTIONS; n += 1) {
        others.push(value(await port.subscribe(1, new Recorder())));
      }
      await until(() => stalled.batches.length === 1);

      await handle.cancel();
      dispose(handle);
      expect(await port.subscribe(1, new Recorder())).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });
      await until(() => stalled.released === 1);
      append(log, 1);
      await settle();

      expect(stalled.released).toBe(1);
      expect(stalled.seqs).toEqual([1]);
      expect(stalled.ends).toEqual([]);
      expect(await port.subscribe(1, new Recorder())).toMatchObject({ ok: true });
      await Promise.all(others.map((other) => other.cancel()));
    });
  });
});

/** A listener whose calls stay pending until the test settles them, counting its releases. */
class Held implements StreamListener {
  readonly batches: number[][] = [];
  readonly ends: SubscriptionEnd[] = [];
  released = 0;
  readonly #pending: (() => void)[] = [];

  get seqs(): number[] {
    return this.batches.flat();
  }

  events(events: RailheadEvent[]): Promise<void> {
    this.batches.push(events.map((event) => event.seq));
    return this.#hold();
  }

  ended(reason: SubscriptionEnd): Promise<void> {
    this.ends.push(reason);
    return this.#hold();
  }

  dup(): Held {
    return this;
  }

  [Symbol.dispose](): void {
    this.released += 1;
  }

  /** Settles the oldest call still pending. */
  settleNext(): void {
    this.#pending.shift()?.();
  }

  #hold(): Promise<void> {
    return new Promise((resolve) => this.#pending.push(resolve));
  }
}

function dispose(target: object): void {
  const fn: unknown = Reflect.get(target, Symbol.dispose);
  if (typeof fn !== "function") throw new TypeError("Expected a disposable value.");
  fn.call(target);
}

// Through the Worker, as the board reaches it.

class BoardRecorder extends RpcTarget implements BoardListener {
  readonly seqs: number[] = [];
  readonly ends: SubscriptionEnd[] = [];

  async events(events: RailheadEvent[]): Promise<void> {
    this.seqs.push(...events.map((event) => event.seq));
  }

  async ended(reason: SubscriptionEnd): Promise<void> {
    this.ends.push(reason);
  }
}

async function openSession(): Promise<WebSocket> {
  const response = await SELF.fetch(`${ORIGIN}${API_PATH}`, { headers: { Upgrade: "websocket" } });
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return socket;
}

async function freshRepo(): Promise<{
  name: string;
  stub: DurableObjectStub<Repo>;
  repoId: string;
}> {
  const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const stub = env.REPO.getByName(repoObjectName("acme", name));
  const summary = value(await stub.initialize("acme", name));
  return { name, stub, repoId: summary.repoId };
}

/** Appends inside the Repo through its storage, as a module's transaction would. */
async function appendIn(stub: DurableObjectStub<Repo>, repoId: string, count: number) {
  await runInDurableObject(stub, (_instance, state) => {
    append(EventLog.open(state.storage, repoId), count);
  });
}

class NativeRecorder extends WorkersRpcTarget implements StreamListener {
  readonly seqs: number[] = [];

  async events(events: RailheadEvent[]): Promise<void> {
    this.seqs.push(...events.map((event) => event.seq));
  }

  async ended(): Promise<void> {}
}

describe("subscriptions through the Repo binding", () => {
  it("frees the slot when the native handle is released without cancel", async () => {
    const { stub, repoId } = await freshRepo();
    const released = new NativeRecorder();
    const handle = value(await stub.subscribe(0, released, null));
    const taken = await takeSlots(stub, repoId, MAX_SUBSCRIPTIONS - 1);
    expect(await stub.subscribe(0, new NativeRecorder(), null)).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });

    // No event is appended to wake anything: the release alone must free the slot.
    dispose(handle);
    const reused = await subscribeWhenFree(stub);
    await appendIn(stub, repoId, 1);
    await settle();

    expect(released.seqs).toEqual([]);
    expect(await stub.subscribe(0, new NativeRecorder(), null)).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    await reused.cancel();
    dispose(reused);
    await freeSlots(taken);
  });
});

/** Subscribes once a slot frees, retrying for at most `ms`; the release reaches the Repo later. */
async function subscribeWhenFree(stub: DurableObjectStub<Repo>, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await stub.subscribe(0, new NativeRecorder(), null);
    if (result.ok) return result.value;
    if (result.code !== "quota_exceeded" || Date.now() > deadline) {
      throw new Error(`expected a free slot, got ${result.code}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("board subscriptions over the RPC session", () => {
  it("pages, subscribes from the cursor and receives later commits", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIn(stub, repoId, 3);
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));
    const page = value(await board.readEvents(0, 2));
    const listener = new BoardRecorder();

    using subscription = value(await board.subscribe(page.cursor, listener));
    await appendIn(stub, repoId, 2);
    await until(() => listener.seqs.length === 3);

    expect(listener.seqs).toEqual([3, 4, 5]);
    expect(await board.subscribe(6, new BoardRecorder())).toMatchObject({
      ok: false,
      code: "cursor_ahead",
    });
    expect(await board.subscribe(-1, new BoardRecorder())).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
    await subscription.cancel();
  });

  it("subscribes only under the history the cursor was read in", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIn(stub, repoId, 2);
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));
    const page = value(await board.readEvents(0, 1));

    const refused = new BoardRecorder();
    expect(await board.subscribe(page.cursor, refused, "0".repeat(32))).toMatchObject({
      ok: false,
      code: "cursor_ahead",
    });
    const listener = new BoardRecorder();
    using subscription = value(await board.subscribe(page.cursor, listener, page.history));
    await appendIn(stub, repoId, 1);
    await until(() => listener.seqs.length === 2);

    expect(listener.seqs).toEqual([2, 3]);
    expect(refused.seqs).toEqual([]);
    await subscription.cancel();
  });

  it("stops delivering after cancel", async () => {
    const { name, stub, repoId } = await freshRepo();
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));
    const listener = new BoardRecorder();

    using subscription = value(await board.subscribe(0, listener));
    await appendIn(stub, repoId, 1);
    await until(() => listener.seqs.length === 1);
    await subscription.cancel();
    await appendIn(stub, repoId, 1);
    await settle();

    expect(listener.seqs).toEqual([1]);
  });

  it("keeps the Repo resident while subscribed, and resumes from the cursor after a wake", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIn(stub, repoId, 2);
    const stale = new BoardRecorder();
    {
      using api = newWebSocketRpcSession<RailheadApi>(await openSession());
      using board = value(await api.openBoard("acme", name));
      const subscription = value(await board.subscribe(0, stale));
      await until(() => stale.seqs.length === 2);
      // Left live: closing the session must release it.
      expect(subscription).toBeDefined();
    }

    // Closing the session released every reference the subscription held, so the Repo can sleep.
    await evictDurableObject(stub);
    await appendIn(stub, repoId, 1);

    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));
    const resumed = new BoardRecorder();
    using live = value(await board.subscribe(2, resumed));
    await appendIn(stub, repoId, 1);
    await until(() => resumed.seqs.length === 2);
    await settle();

    expect(resumed.seqs).toEqual([3, 4]);
    expect(stale.seqs).toEqual([1, 2]);
    expect(stale.ends).toEqual([]);
    await live.cancel();
  });

  it("serves a board capability held across a wake from storage, holding no stale subscription", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIn(stub, repoId, 1);
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using board = value(await api.openBoard("acme", name));
    const before = new BoardRecorder();
    const subscription = value(await board.subscribe(0, before));
    await until(() => before.seqs.length === 1);
    // Disposing the stub alone, with the session still open, must release the Repo.
    subscription[Symbol.dispose]();
    await settle();
    await appendIn(stub, repoId, 1);
    await settle();
    expect(before.seqs).toEqual([1]);

    await evictDurableObject(stub);
    await appendIn(stub, repoId, 1);
    const after = new BoardRecorder();
    using live = value(await board.subscribe(2, after));
    await appendIn(stub, repoId, 1);
    await until(() => after.seqs.length === 2);
    await settle();

    expect(after.seqs).toEqual([3, 4]);
    expect(before.seqs).toEqual([1]);
    await live.cancel();
  });

  it("refuses a repository nobody initialized, before and after a wake", async () => {
    const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
    const stub = env.REPO.getByName(repoObjectName("acme", name));
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());

    expect(await api.openBoard("acme", name)).toMatchObject({ ok: false, code: "not_found" });
    class Listener extends WorkersRpcTarget implements StreamListener {
      async events(): Promise<void> {}
      async ended(): Promise<void> {}
    }
    expect(await stub.subscribe(0, new Listener(), null)).toMatchObject({
      ok: false,
      code: "not_found",
    });
    await evictDurableObject(stub);
    expect(await api.openBoard("acme", name)).toMatchObject({ ok: false, code: "not_found" });
    expect(await stub.describe()).toBeNull();
  });
});

// Ends the board did not ask for, through the Worker, with the WebSocket session left open. The
// board's session counts what it exports: its listener and each call the Worker has made on it and
// not yet released. A call the Worker abandons without cancelling stays counted.

/** A board listener whose calls stall or fail as the test sets, counting the deliveries. */
class ScriptedBoard extends RpcTarget implements BoardListener {
  deliveries = 0;
  readonly ends: SubscriptionEnd[] = [];
  readonly #onEvents: () => Promise<void>;
  readonly #onEnded: () => Promise<void>;

  constructor(onEvents: () => Promise<void>, onEnded: () => Promise<void> = async () => {}) {
    super();
    this.#onEvents = onEvents;
    this.#onEnded = onEnded;
  }

  events(): Promise<void> {
    this.deliveries += 1;
    return this.#onEvents();
  }

  ended(reason: SubscriptionEnd): Promise<void> {
    this.ends.push(reason);
    return this.#onEnded();
  }
}

function never(): Promise<void> {
  return new Promise(() => {});
}

async function reject(): Promise<void> {
  throw new Error("the board refused the delivery");
}

/** A board session whose export count the test can read. */
async function countedSession() {
  const session = new RpcSession<RailheadApi>(new WebSocketTransport(await openSession()));
  return { session, api: session.getRemoteMain() };
}

/** Resolves once `condition` holds, waiting on the runtime's scheduler rather than a timer. */
async function waitFor(condition: () => boolean, ms = 5_000): Promise<void> {
  for (let waited = 0; !condition(); waited += 5) {
    if (waited > ms) throw new Error("timed out waiting for the condition");
    await scheduler.wait(5);
  }
}

/** A held delivery timeout. */
interface HeldTimeout {
  expired: boolean;
}

/** Delivery timeouts held and not yet fired or cleared, by id, oldest first. */
const heldTimeouts = new Map<number, HeldTimeout>();

/**
 * Holds every timer set for the delivery timeout, in the Repo and the Worker alike, until the test
 * expires it, so a test asserts what holds before a timeout without racing it. The code that sets
 * a held timer also checks it, on a 1 ms timer, so its callback runs in that code's context; fake
 * timers cannot do that, as the Repo and the Worker share the test's isolate. The check reads only
 * whether the test expired the timer, so a loaded machine delays a timeout but never brings it on.
 */
function holdDeliveryTimeouts(): void {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let lastId = 0;
  vi.stubGlobal("setTimeout", (callback: () => void, ms?: number) => {
    if (ms !== DELIVERY_TIMEOUT_MS) return realSet(callback, ms);
    // Below zero, so a held timer's id never matches a real one.
    lastId -= 1;
    const id = lastId;
    const held: HeldTimeout = { expired: false };
    heldTimeouts.set(id, held);
    const check = () => {
      if (heldTimeouts.get(id) !== held) return;
      if (!held.expired) {
        realSet(check, 1);
        return;
      }
      heldTimeouts.delete(id);
      callback();
    };
    realSet(check, 1);
    return id;
  });
  vi.stubGlobal("clearTimeout", (id: number | null) => {
    if (id === null || !heldTimeouts.delete(id)) realClear(id);
  });
}

/** Expires the oldest delivery timeout still held; it fires on its next check. */
function expireOldestTimeout(): void {
  for (const held of heldTimeouts.values()) {
    if (held.expired) continue;
    held.expired = true;
    return;
  }
  throw new Error("no delivery timeout is held");
}

/** Slots taken inside a Repo, to be freed there. */
interface TakenSlots {
  stub: DurableObjectStub<Repo>;
  handles: StreamSubscription[];
}

/**
 * Takes `count` of the Repo's slots, inside the Repo, with subscriptions it cancels at once. A
 * cancelled subscription holds its slot until its handle is released and delivers nothing, so the
 * slots cost no RPC round trip to take and no work on a commit.
 */
async function takeSlots(
  stub: DurableObjectStub<Repo>,
  repoId: string,
  count: number,
): Promise<TakenSlots> {
  const handles = await runInDurableObject(stub, async (instance, state) => {
    const head = EventLog.open(state.storage, repoId).head();
    const taken = [];
    for (let n = 0; n < count; n += 1) {
      const handle = value(await instance.subscribe(head, new Recorder(), null));
      await handle.cancel();
      taken.push(handle);
    }
    return taken;
  });
  return { stub, handles };
}

async function freeSlots({ stub, handles }: TakenSlots): Promise<void> {
  await runInDurableObject(stub, () => {
    for (const handle of handles) dispose(handle);
  });
}

/** Subscribes `listener` from `cursor` once the board's last slot frees, retrying for at most `ms`. */
async function boardSubscribeWhenFree(
  board: RpcStub<BoardApi>,
  listener: BoardListener,
  cursor = 0,
  ms = 5_000,
) {
  for (let waited = 0; ; waited += 5) {
    const result = await board.subscribe(cursor, listener);
    if (result.ok) return result.value;
    if (result.code !== "quota_exceeded" || waited > ms) {
      throw new Error(`expected a free slot, got ${result.code}`);
    }
    await scheduler.wait(5);
  }
}

describe("board subscriptions the Repo ends, over the RPC session", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    heldTimeouts.clear();
  });

  it("cancels a delivery that timed out on the board's session, and frees its slot", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIn(stub, repoId, 1);
    const taken = await takeSlots(stub, repoId, MAX_SUBSCRIPTIONS - 1);
    const { session, api } = await countedSession();
    using board = value(await api.openBoard("acme", name));
    const baseline = session.getStats().exports;
    holdDeliveryTimeouts();

    const listeners = [];
    const handles = [];
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const listener = new ScriptedBoard(never);
      handles.push(await boardSubscribeWhenFree(board, listener));
      listeners.push(listener);
      await waitFor(() => listener.deliveries === 1);
      expect(session.getStats().exports).toBe(baseline + 2);
      expect(await board.subscribe(0, new ScriptedBoard(never))).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });

      // The Repo's timeout is the oldest: it starts before the Worker forwards the delivery.
      expireOldestTimeout();
      // The stalled call and the listener are released on the board's session, which stays open.
      await waitFor(() => session.getStats().exports === baseline);
      expect(listener.ends).toEqual(["slow"]);
      // Every timer the subscription started is cleared, so the next cycle's are the oldest.
      await waitFor(() => heldTimeouts.size === 0);
    }
    vi.unstubAllGlobals();
    const last = await boardSubscribeWhenFree(board, new ScriptedBoard(async () => {}));
    await appendIn(stub, repoId, 1);
    await settle();

    expect(listeners.map((listener) => listener.deliveries)).toEqual([1, 1, 1]);
    expect(await board.subscribe(0, new ScriptedBoard(never))).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    // The handles the board kept are inert.
    for (const handle of handles) await handle.cancel();
    last[Symbol.dispose]();
    await freeSlots(taken);
    api[Symbol.dispose]();
  });

  it("cancels an ending that never settles, and frees its slot", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIn(stub, repoId, 1);
    const taken = await takeSlots(stub, repoId, MAX_SUBSCRIPTIONS - 1);
    const { session, api } = await countedSession();
    using board = value(await api.openBoard("acme", name));
    const baseline = session.getStats().exports;
    holdDeliveryTimeouts();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const listener = new ScriptedBoard(never, never);
      await boardSubscribeWhenFree(board, listener);
      await waitFor(() => listener.deliveries === 1);
      // The Repo's delivery timeout, as above.
      expireOldestTimeout();
      await waitFor(() => listener.ends.length === 1);
      // The stalled delivery is cancelled; the ending is in flight, so the slot is still held.
      await waitFor(() => session.getStats().exports === baseline + 2);
      expect(await board.subscribe(0, new ScriptedBoard(never))).toMatchObject({
        ok: false,
        code: "quota_exceeded",
      });

      // The ending's timeouts are left, the Repo's and then the Worker's, and both expire.
      await waitFor(() => heldTimeouts.size === 2);
      expireOldestTimeout();
      expireOldestTimeout();
      await waitFor(() => session.getStats().exports === baseline);
      expect(listener.ends).toEqual(["slow"]);
      await waitFor(() => heldTimeouts.size === 0);
    }
    vi.unstubAllGlobals();
    using last = await boardSubscribeWhenFree(board, new ScriptedBoard(async () => {}));

    expect(last).toBeDefined();
    await freeSlots(taken);
    api[Symbol.dispose]();
  });

  it("releases the Repo's side of a subscription whose delivery the board rejected", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIn(stub, repoId, 1);
    const taken = await takeSlots(stub, repoId, MAX_SUBSCRIPTIONS - 1);
    const { session, api } = await countedSession();
    using board = value(await api.openBoard("acme", name));
    const baseline = session.getStats().exports;

    const listeners = [];
    const handles = [];
    for (let cycle = 0; cycle < 5; cycle += 1) {
      const listener = new ScriptedBoard(reject);
      // Each subscription takes the slot the last one freed, while the board keeps every handle.
      handles.push(await boardSubscribeWhenFree(board, listener));
      listeners.push(listener);
      await waitFor(() => listener.deliveries === 1);
      await waitFor(() => session.getStats().exports === baseline);
    }
    await appendIn(stub, repoId, 1);
    await settle();
    expect(listeners.map((listener) => listener.deliveries)).toEqual([1, 1, 1, 1, 1]);
    expect(listeners.every((listener) => listener.ends.length === 0)).toBe(true);

    // With its other subscriptions gone the Repo may sleep; the kept handles do not reach it.
    await freeSlots(taken);
    await evictDurableObject(stub);
    for (const handle of handles) await handle.cancel();
    using fresh = value(await board.subscribe(2, new ScriptedBoard(async () => {})));
    expect(fresh).toBeDefined();
    api[Symbol.dispose]();
  });

  it("cancels the stalled delivery of a subscription that fell behind, without waiting it out", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIn(stub, repoId, 1);
    const taken = await takeSlots(stub, repoId, MAX_SUBSCRIPTIONS - 1);
    const { session, api } = await countedSession();
    using board = value(await api.openBoard("acme", name));
    const baseline = session.getStats().exports;
    const listener = new ScriptedBoard(never);

    using handle = value(await board.subscribe(0, listener));
    await waitFor(() => listener.deliveries === 1);
    await appendIn(stub, repoId, MAX_UNACKNOWLEDGED_EVENTS + 1);
    await waitFor(() => session.getStats().exports === baseline);
    const next = new ScriptedBoard(async () => {});
    using reused = await boardSubscribeWhenFree(board, next);
    await waitFor(() => next.deliveries > 0);

    expect(listener.ends).toEqual(["slow"]);
    expect(listener.deliveries).toBe(1);
    expect(handle).toBeDefined();
    expect(reused).toBeDefined();
    await freeSlots(taken);
    api[Symbol.dispose]();
  });
});

// A log the Repo cannot read, through the Worker. Replay refuses an event whose stored schema
// version it does not support, as it refuses one that is missing.

/** Sets the stored schema version of event `seq`; 1 and 2 are the supported ones. */
async function setSchemaVersion(
  stub: DurableObjectStub<Repo>,
  seq: number,
  version: number,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE events SET body = json_set(body, '$.v', ?) WHERE seq = ?",
      version,
      seq,
    );
  });
}

/** Appends one event that is unreadable from the moment it commits, as the observer reads it. */
async function appendUnreadable(stub: DurableObjectStub<Repo>, repoId: string): Promise<number> {
  return runInDurableObject(stub, (_instance, state) => {
    const { value: seq } = EventLog.open(state.storage, repoId).transaction((tx) => {
      const event = tx.append(HUMAN, issue(0));
      state.storage.sql.exec(
        "UPDATE events SET body = json_set(body, '$.v', 3) WHERE seq = ?",
        event.seq,
      );
      return event.seq;
    });
    return seq;
  });
}

describe("board subscriptions over a log the Repo cannot read", () => {
  it("ends with restart before an unreadable event, releases both sides, and resumes once it reads", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIn(stub, repoId, 3);
    await setSchemaVersion(stub, 3, 3);
    const taken = await takeSlots(stub, repoId, MAX_SUBSCRIPTIONS - 1);
    const { session, api } = await countedSession();
    using board = value(await api.openBoard("acme", name));
    const baseline = session.getStats().exports;
    const failed = new ScriptedBoard(async () => {});

    // The board keeps the ended handle; the Repo frees the slot regardless.
    using handle = value(await board.subscribe(2, failed));
    await waitFor(() => failed.ends.length === 1);
    await waitFor(() => session.getStats().exports === baseline);
    // From the head, which reads nothing, so this subscription stays live and holds the slot.
    const reused = await boardSubscribeWhenFree(board, new ScriptedBoard(async () => {}), 3);
    await settle();

    expect(failed.ends).toEqual(["restart"]);
    expect(failed.deliveries).toBe(0);
    expect(await board.subscribe(0, new ScriptedBoard(never))).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    await handle.cancel();
    reused[Symbol.dispose]();
    await freeSlots(taken);

    // The board resumes from the last cursor it applied once the event reads again.
    await setSchemaVersion(stub, 3, 1);
    const resumed = new BoardRecorder();
    using live = value(await board.subscribe(2, resumed));
    await appendIn(stub, repoId, 1);
    await waitFor(() => resumed.seqs.length === 2);
    await settle();

    expect(resumed.seqs).toEqual([3, 4]);
    expect(resumed.ends).toEqual([]);
    await live.cancel();
    api[Symbol.dispose]();
  });

  it("ends an established subscription with restart when a later event is unreadable", async () => {
    const { name, stub, repoId } = await freshRepo();
    await appendIn(stub, repoId, 2);
    const taken = await takeSlots(stub, repoId, MAX_SUBSCRIPTIONS - 1);
    const { session, api } = await countedSession();
    using board = value(await api.openBoard("acme", name));
    const baseline = session.getStats().exports;
    const listener = new BoardRecorder();

    using handle = value(await board.subscribe(0, listener));
    await waitFor(() => listener.seqs.length === 2);
    const unreadable = await appendUnreadable(stub, repoId);
    await waitFor(() => listener.ends.length === 1);
    await waitFor(() => session.getStats().exports === baseline);
    using reused = await boardSubscribeWhenFree(board, new ScriptedBoard(async () => {}), 3);
    await settle();

    expect(unreadable).toBe(3);
    expect(listener.seqs).toEqual([1, 2]);
    expect(listener.ends).toEqual(["restart"]);
    expect(await board.subscribe(3, new ScriptedBoard(never))).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    await handle.cancel();
    await reused.cancel();
    await freeSlots(taken);

    await setSchemaVersion(stub, unreadable, 1);
    const resumed = new BoardRecorder();
    using live = value(await board.subscribe(2, resumed));
    await waitFor(() => resumed.seqs.length === 1);
    await settle();

    expect(resumed.seqs).toEqual([3]);
    expect(resumed.ends).toEqual([]);
    await live.cancel();
    api[Symbol.dispose]();
  });
});
