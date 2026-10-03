import { SELF, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env, RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { describe, expect, it } from "vitest";
import { API_PATH, type RailheadApi } from "@railhead/shared/api";
import {
  MAX_PUSH_BATCH,
  MAX_UNACKNOWLEDGED_EVENTS,
  type BoardListener,
  type BoardResult,
  type SubscriptionEnd,
} from "@railhead/shared/board-api";
import type { Actor, EventPayload, RailheadEvent } from "@railhead/shared/events";
import { MAX_SUBSCRIPTIONS, streamPort, type StreamListener } from "../src/modules/stream/entry";
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

  it("releases a listener whose ended throws synchronously, and frees its slot", async () => {
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
      value(await port.subscribe(0, listener));
      const others = [];
      for (let n = 1; n < MAX_SUBSCRIPTIONS; n += 1) {
        others.push(value(await port.subscribe(1, new Recorder())));
      }

      await until(() => released === 1);
      await settle();

      expect(released).toBe(1);
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

  it("bounds live subscriptions and frees a slot on cancel", async () => {
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
      await subscriptions[0]?.cancel();
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
});

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
    const handle = value(await stub.subscribe(0, released));
    const others = [];
    for (let n = 1; n < MAX_SUBSCRIPTIONS; n += 1) {
      others.push(value(await stub.subscribe(0, new NativeRecorder())));
    }
    expect(await stub.subscribe(0, new NativeRecorder())).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });

    // The Repo stays resident through the held stubs, and no event is appended to wake anything.
    dispose(handle);
    const reused = await subscribeWhenFree(stub);
    await appendIn(stub, repoId, 1);
    await settle();

    expect(released.seqs).toEqual([]);
    expect(await stub.subscribe(0, new NativeRecorder())).toMatchObject({
      ok: false,
      code: "quota_exceeded",
    });
    for (const other of [reused, ...others]) {
      await other.cancel();
      dispose(other);
    }
  });
});

/** Subscribes once a slot frees, retrying for at most `ms`; the release reaches the Repo later. */
async function subscribeWhenFree(stub: DurableObjectStub<Repo>, ms = 5_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await stub.subscribe(0, new NativeRecorder());
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
    expect(await stub.subscribe(0, new Listener())).toMatchObject({
      ok: false,
      code: "not_found",
    });
    await evictDurableObject(stub);
    expect(await api.openBoard("acme", name)).toMatchObject({ ok: false, code: "not_found" });
    expect(await stub.describe()).toBeNull();
  });
});
