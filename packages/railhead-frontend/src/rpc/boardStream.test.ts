import { afterEach, describe, expect, it, vi } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import { checkBeforeLand } from "../../../../fixtures/board/checkBeforeLand";
import { SYNTH_REPO } from "../../../../fixtures/board/syntheticLog";
import { type BoardState, emptyBoardState, foldEvents } from "../features/board/boardState";
import {
  BoardStream,
  MAX_RESYNCS_WITHOUT_PROGRESS,
  type StreamPhase,
  type StreamSink,
} from "./boardStream";
import { CALL_DEADLINE_MS } from "./deadline";
import { FakeBoard, releaseTarget } from "./fakeApi";

const LOG = checkBeforeLand.events;
const HEAD = LOG.length;

/** A sink that folds into a board and records every phase. */
const folding = () => {
  let board: BoardState | null = null;
  const phases: StreamPhase["kind"][] = [];
  const stops: string[] = [];
  const sink: StreamSink = {
    onRepo: (repo) => {
      board ??= emptyBoardState(repo);
    },
    onEvents: (events) => {
      if (board === null) throw new Error("events before the repository");
      board = foldEvents(board, events);
      return { cursor: board.cursor, halted: board.stream.kind === "halted" };
    },
    onPhase: (phase) => {
      phases.push(phase.kind);
      if (phase.kind === "stopped") stops.push(phase.reason);
    },
  };
  return {
    sink,
    phases,
    stops,
    board: (): BoardState => {
      if (board === null) throw new Error("no board yet");
      return board;
    },
  };
};

/** Lets every pending promise chain settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const event = (seq: number): RailheadEvent => {
  const found = LOG[seq - 1];
  if (found === undefined) throw new Error(`the fixture has no event ${seq}`);
  return found;
};

describe("BoardStream", () => {
  let stream: BoardStream | null = null;
  afterEach(() => {
    stream?.[Symbol.dispose]();
    stream = null;
  });
  /** Starts a stream on fake timers over a board that holds `call` pending. */
  const stalled = (call: "readEvents" | "subscribe") => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const board = new FakeBoard(SYNTH_REPO, LOG);
    board.stalls.names.add(call);
    const sink = folding();
    stream = new BoardStream(board, sink.sink, 0);
    return { board, sink };
  };

  it("pages the log up to its head, then subscribes from the cursor it reached", async () => {
    const board = new FakeBoard(SYNTH_REPO, LOG);
    board.pageSize = 2;
    const sink = folding();
    stream = new BoardStream(board, sink.sink, 0);
    await settle();

    expect(board.reads).toEqual(LOG.filter((_, i) => i % 2 === 0).map((e) => e.seq - 1));
    expect(board.subscriptions.map((s) => s.cursor)).toEqual([HEAD]);
    expect(sink.board().cursor).toBe(HEAD);
    expect(sink.board().stream).toEqual({ kind: "consistent" });
    expect(sink.phases).toEqual(["catching_up", "live"]);
  });

  it("applies pushed events after the subscription's cursor", async () => {
    const board = new FakeBoard(SYNTH_REPO, LOG.slice(0, HEAD - 2));
    const sink = folding();
    stream = new BoardStream(board, sink.sink, 0);
    await settle();

    await board.latest().listener.events([event(HEAD - 1), event(HEAD)]);

    expect(sink.board().cursor).toBe(HEAD);
    expect(board.subscriptions).toHaveLength(1);
  });

  it("subscribes at 0 to an empty log and still reports its repository", async () => {
    const board = new FakeBoard(SYNTH_REPO, []);
    const sink = folding();
    stream = new BoardStream(board, sink.sink, 0);
    await settle();

    expect(sink.board()).toEqual(emptyBoardState(SYNTH_REPO));
    expect(board.subscriptions.map((s) => s.cursor)).toEqual([0]);
    expect(sink.phases).toEqual(["catching_up", "live"]);
  });

  it("resumes from a cursor it already holds without rereading earlier events", async () => {
    const board = new FakeBoard(SYNTH_REPO, LOG);
    const sink = folding();
    sink.sink.onRepo(SYNTH_REPO);
    sink.sink.onEvents(LOG.slice(0, 3));
    stream = new BoardStream(board, sink.sink, 3);
    await settle();

    expect(board.reads).toEqual([3]);
    expect(sink.board().cursor).toBe(HEAD);
  });

  it("closes a gap in pushed events by paging over it and subscribing again", async () => {
    const board = new FakeBoard(SYNTH_REPO, LOG.slice(0, 2));
    const sink = folding();
    stream = new BoardStream(board, sink.sink, 0);
    await settle();
    const first = board.latest();

    board.append(...LOG.slice(2));
    await first.listener.events([event(4)]);
    await settle();

    expect(first.handle.disposed).toBe(true);
    expect(board.reads).toEqual([0, 2]);
    expect(board.subscriptions.map((s) => s.cursor)).toEqual([2, HEAD]);
    expect(sink.board().cursor).toBe(HEAD);
    expect(sink.board().stream).toEqual({ kind: "consistent" });
  });

  it("resubscribes after a slow end and ignores the ended listener's late events", async () => {
    const board = new FakeBoard(SYNTH_REPO, LOG.slice(0, 2));
    const sink = folding();
    stream = new BoardStream(board, sink.sink, 0);
    await settle();
    const first = board.latest();

    await first.listener.ended("slow");
    await settle();
    await first.listener.events([event(3)]);

    expect(board.subscriptions.map((s) => s.cursor)).toEqual([2, 2]);
    expect(sink.board().cursor).toBe(2);
  });

  it("stops without resubscribing when access is revoked", async () => {
    const board = new FakeBoard(SYNTH_REPO, LOG);
    const sink = folding();
    stream = new BoardStream(board, sink.sink, 0);
    await settle();

    await board.latest().listener.ended("revoked");
    await settle();

    expect(sink.stops).toEqual(["revoked"]);
    expect(board.subscriptions).toHaveLength(1);
    expect(board.latest().handle.disposed).toBe(true);
  });

  describe("when the backend releases the listener without ending it", () => {
    it("leaves live, catches up and subscribes again", async () => {
      const board = new FakeBoard(SYNTH_REPO, LOG.slice(0, 2));
      const sink = folding();
      stream = new BoardStream(board, sink.sink, 0);
      await settle();
      const first = board.latest();

      board.append(...LOG.slice(2));
      first.handle.release();
      expect(sink.phases.at(-1)).toBe("catching_up");
      await settle();

      expect(board.reads).toEqual([0, 2]);
      expect(board.subscriptions.map((s) => s.cursor)).toEqual([2, HEAD]);
      expect(sink.board().cursor).toBe(HEAD);
      expect(sink.phases).toEqual(["catching_up", "live", "catching_up", "live"]);
    });

    it("ignores the late release of a listener it already replaced", async () => {
      const board = new FakeBoard(SYNTH_REPO, LOG);
      const sink = folding();
      stream = new BoardStream(board, sink.sink, 0);
      await settle();
      const first = board.latest();
      await first.listener.ended("restart");
      await settle();
      const reads = board.reads.length;

      // The client disposed the first handle, which released its listener; this is a second release.
      releaseTarget(first.listener);
      await settle();

      expect(board.subscriptions).toHaveLength(2);
      expect(board.reads).toHaveLength(reads);
      expect(sink.phases.at(-1)).toBe("live");
    });

    it("subscribes again when the release arrives before subscribe resolves", async () => {
      const gate: { answer?: () => void } = {};
      const board = new FakeBoard(SYNTH_REPO, LOG);
      const subscribe = board.subscribe.bind(board);
      board.subscribe = (cursor, listener) => {
        board.subscribe = subscribe;
        return new Promise((resolve) => {
          gate.answer = () => {
            const result = subscribe(cursor, listener);
            releaseTarget(listener);
            resolve(result);
          };
        });
      };
      const sink = folding();
      stream = new BoardStream(board, sink.sink, 0);
      await settle();
      if (gate.answer === undefined) throw new Error("the stream never subscribed");
      gate.answer();
      await settle();

      expect(board.subscriptions).toHaveLength(2);
      expect(board.subscriptions[0]?.handle.disposed).toBe(true);
      expect(board.latest().handle.disposed).toBe(false);
      expect(sink.phases).toEqual(["catching_up", "catching_up", "live"]);
    });

    it("stops after a bounded number of releases that make no progress", async () => {
      const board = new FakeBoard(SYNTH_REPO, LOG);
      const sink = folding();
      stream = new BoardStream(board, sink.sink, 0);
      await settle();

      for (let i = 0; i <= MAX_RESYNCS_WITHOUT_PROGRESS + 2; i += 1) {
        board.latest().handle.release();
        await settle();
      }

      expect(board.subscriptions).toHaveLength(MAX_RESYNCS_WITHOUT_PROGRESS + 1);
      expect(sink.stops).toEqual(["failed"]);
    });

    it("ignores the release that follows its own disposal", async () => {
      const board = new FakeBoard(SYNTH_REPO, LOG);
      const sink = folding();
      const disposed = new BoardStream(board, sink.sink, 0);
      await settle();

      disposed[Symbol.dispose]();
      await settle();

      expect(board.latest().handle.disposed).toBe(true);
      expect(board.reads).toEqual([0]);
      expect(sink.phases).toEqual(["catching_up", "live"]);
    });
  });

  it("stops after a bounded number of restarts that make no progress", async () => {
    const board = new FakeBoard(SYNTH_REPO, LOG);
    const sink = folding();
    stream = new BoardStream(board, sink.sink, 0);
    await settle();

    for (let i = 0; i <= MAX_RESYNCS_WITHOUT_PROGRESS + 2; i += 1) {
      await board.latest().listener.ended("restart");
      await settle();
    }

    expect(board.subscriptions).toHaveLength(MAX_RESYNCS_WITHOUT_PROGRESS + 1);
    expect(sink.stops).toEqual(["failed"]);
  });

  it("reports a repository the backend does not serve as unavailable", async () => {
    const board = new FakeBoard(SYNTH_REPO, LOG);
    board.readFault = "unavailable";
    const sink = folding();
    stream = new BoardStream(board, sink.sink, 0);
    await settle();

    expect(sink.stops).toEqual(["unavailable"]);
    expect(board.subscriptions).toHaveLength(0);
  });

  it("fails on a cursor ahead of the log, and on a session that breaks", async () => {
    const ahead = new FakeBoard(SYNTH_REPO, LOG.slice(0, 2));
    const aheadSink = folding();
    stream = new BoardStream(ahead, aheadSink.sink, 5);
    const broken = new FakeBoard(SYNTH_REPO, LOG);
    broken.subscribeFault = "throw";
    const brokenSink = folding();
    const brokenStream = new BoardStream(broken, brokenSink.sink, 0);
    await settle();

    expect(aheadSink.stops).toEqual(["failed"]);
    expect(brokenSink.stops).toEqual(["failed"]);
    expect(broken.subscriptions).toHaveLength(0);
    brokenStream[Symbol.dispose]();
  });

  it("halts on an event the fold rejects and does not subscribe", async () => {
    const forged = { ...event(2), seq: 2, v: 99 } as const satisfies RailheadEvent;
    const board = new FakeBoard(SYNTH_REPO, [event(1), forged]);
    const sink = folding();
    stream = new BoardStream(board, sink.sink, 0);
    await settle();

    expect(sink.stops).toEqual(["halted"]);
    expect(sink.board().stream.kind).toBe("halted");
    expect(board.subscriptions).toHaveLength(0);
  });

  describe("when a call stays pending", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails at the deadline of a page that never arrives and folds none that arrives late", async () => {
      const { board, sink } = stalled("readEvents");
      await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS - 1);
      expect(sink.phases).toEqual(["catching_up"]);

      await vi.advanceTimersByTimeAsync(1);
      expect(sink.stops).toEqual(["failed"]);

      board.stalls.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(() => sink.board()).toThrow("no board yet");
      expect(board.subscriptions).toHaveLength(0);
      expect(sink.phases).toEqual(["catching_up", "stopped"]);
    });

    it("fails at the deadline of a subscription and disposes the one that arrives late", async () => {
      const { board, sink } = stalled("subscribe");
      await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS);
      expect(sink.stops).toEqual(["failed"]);
      expect(sink.board().cursor).toBe(HEAD);

      board.stalls.resume();
      await vi.advanceTimersByTimeAsync(0);
      expect(board.latest().handle.disposed).toBe(true);
      expect(sink.phases).toEqual(["catching_up", "stopped"]);
    });

    it("goes live when the subscription answers just before its deadline", async () => {
      const { board, sink } = stalled("subscribe");
      await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS - 1);
      board.stalls.resume();
      await vi.advanceTimersByTimeAsync(CALL_DEADLINE_MS);

      expect(sink.phases).toEqual(["catching_up", "live"]);
      expect(board.latest().handle.disposed).toBe(false);
    });
  });

  it("folds nothing once disposed, even when a page was already requested", async () => {
    const board = new FakeBoard(SYNTH_REPO, LOG);
    const sink = folding();
    const disposed = new BoardStream(board, sink.sink, 0);
    disposed[Symbol.dispose]();
    await settle();

    expect(board.reads).toEqual([0]);
    expect(board.subscriptions).toHaveLength(0);
    expect(sink.board).toThrow("no board yet");
    expect(sink.phases).toEqual(["catching_up"]);
  });

  it("disposes a subscription that arrives after the stream was disposed", async () => {
    const gate: { answer?: () => void } = {};
    const board = new FakeBoard(SYNTH_REPO, LOG);
    const subscribe = board.subscribe.bind(board);
    board.subscribe = (cursor, listener) =>
      new Promise((resolve) => {
        gate.answer = () => resolve(subscribe(cursor, listener));
      });
    const sink = folding();
    const disposed = new BoardStream(board, sink.sink, 0);
    await settle();
    disposed[Symbol.dispose]();
    if (gate.answer === undefined) throw new Error("the stream never subscribed");
    gate.answer();
    await settle();

    expect(board.latest().handle.disposed).toBe(true);
    expect(sink.phases).toEqual(["catching_up"]);
  });
});
