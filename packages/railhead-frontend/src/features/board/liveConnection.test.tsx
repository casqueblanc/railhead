import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import { checkBeforeLand } from "../../../../../fixtures/board/checkBeforeLand";
import { SYNTH_REPO } from "../../../../../fixtures/board/syntheticLog";
import { CALL_DEADLINE_MS } from "../../rpc/deadline";
import { FakeApi, FakeBoard, type Fault } from "../../rpc/fakeApi";
import type { RecordDecisionRequest } from "../decisions/decisionActions";
import { FAKE_ENCODED, fakeAuthenticator, type FakeAnswer } from "../enrollment/fakeAuthenticator";
import type { Authenticator } from "../enrollment/webauthn";
import { gateOnConnection, type BoardPorts } from "./boardPorts";
import { useLiveBoardPorts } from "./liveConnection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LOG = checkBeforeLand.events;
const HEAD = LOG.length;
const TARGET = { org: "demo", repo: "upload-app" };
const REQUEST: RecordDecisionRequest = {
  decisionId: "dec_size",
  option: "chunk",
  expectedVersion: 1,
};

const WITHDRAWN = {
  ok: false,
  message: "The board lost its session before the answer was sent. Nothing was recorded.",
};

const event = (seq: number): RailheadEvent => {
  const found = LOG[seq - 1];
  if (found === undefined) throw new Error(`the fixture has no event ${seq}`);
  return found;
};

/** Passes one call deadline on fake timers. */
const expire = () => act(async () => vi.advanceTimersByTime(CALL_DEADLINE_MS));

/** Answers held calls after their deadline. */
const late = async (resume: () => void) => {
  resume();
  await act(async () => {});
};

/** A log whose second event the fold rejects. */
const halting = (forged: RailheadEvent) => new FakeBoard(SYNTH_REPO, [event(1), forged]);

describe("useLiveBoardPorts", () => {
  let root: Root;
  let sessions: FakeApi[];
  let ports: BoardPorts;
  let opens: (FakeBoard | Fault)[];
  let authenticator: Authenticator | null;
  let answer: FakeAnswer;
  /** Calls the next session holds pending. */
  let stalled: ("openBoard" | "ownerEnrollment")[];
  let reloads: number;

  const connect = () => {
    const next = opens.shift() ?? "unavailable";
    const session = new FakeApi(next);
    for (const call of stalled.splice(0)) session.stalls.names.add(call);
    sessions.push(session);
    return session;
  };
  const authenticate = () => authenticator;
  const reload = () => {
    reloads += 1;
  };
  const Probe = () => {
    ports = useLiveBoardPorts(TARGET, connect, authenticate, reload);
    return null;
  };
  const session = (attempt: number): FakeApi => {
    const opened = sessions[attempt];
    if (!opened) throw new Error(`attempt ${attempt} opened no session`);
    return opened;
  };
  const mount = async () => {
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
  };
  /** The board the page reads, failing the test when it has none. */
  const feed = () => {
    if (ports.board.kind !== "available") throw new Error("the board is unavailable");
    return ports.board.feed;
  };
  const cursor = () => {
    const current = feed();
    if (current.kind !== "board") throw new Error(`the feed is ${current.kind}`);
    return current.board.cursor;
  };

  /** Mounts and lets the session's probe answer. */
  const start = async () => {
    await mount();
    await act(async () => session(0).answer());
  };

  /** Records `REQUEST` through the decisions port, failing the test when it is unavailable. */
  const record = async () => {
    if (ports.decisions.kind !== "available") throw new Error("decisions unavailable");
    return ports.decisions.onRecordDecision(REQUEST, {
      signal: new AbortController().signal,
      onSent: () => {},
    });
  };

  beforeEach(() => {
    sessions = [];
    opens = [];
    stalled = [];
    reloads = 0;
    answer = "sign";
    authenticator = fakeAuthenticator(() => answer).authenticator;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  describe("on a repository with a log", () => {
    let board: FakeBoard;

    beforeEach(async () => {
      board = new FakeBoard(SYNTH_REPO, LOG.slice(0, HEAD - 2));
      opens = [board];
      await mount();
      await act(async () => session(0).answer());
    });

    it("opens the repository once over one session and shows its folded log live", () => {
      expect(sessions).toHaveLength(1);
      expect(session(0).opened).toEqual(["demo/upload-app"]);
      expect(ports.connection).toBe("connected");
      expect(feed()).toMatchObject({ kind: "board", connection: "live", recovered: false });
      expect(cursor()).toBe(HEAD - 2);
      expect(ports.owner.kind).toBe("available");
      expect(ports.enrollment.kind).toBe("available");
      expect(ports.decisions.kind).toBe("available");
    });

    it("folds pushed events into the board", async () => {
      await act(async () => board.latest().listener.events([event(HEAD - 1), event(HEAD)]));

      expect(cursor()).toBe(HEAD);
    });

    it("keeps one owner port object per session and sends its calls to that session", async () => {
      const owner = ports.owner;
      await act(async () => root.render(<Probe />));
      expect(ports.owner).toBe(owner);
      if (owner.kind !== "available") throw new Error("owner unavailable");

      await owner.onPrepareAction({ kind: "agent.revoke", agentId: "agt_one" });

      expect(board.ownerStub.prepared).toEqual([{ kind: "agent.revoke", agentId: "agt_one" }]);
    });

    it("sends enrollment calls to the session's enrollment capability", async () => {
      if (ports.enrollment.kind !== "available") throw new Error("enrollment unavailable");

      const result = await ports.enrollment.onPrepareEnrollment("token-1");

      expect(result).toMatchObject({ ok: false, code: "bootstrap_closed" });
      expect(session(0).enrollment.tokens).toEqual(["token-1"]);
    });

    it("shows the retained board stale while the session is lost", async () => {
      await act(async () => session(0).break());

      expect(ports.connection).toBe("lost");
      expect(feed()).toMatchObject({ kind: "board", connection: "lost" });
      expect(cursor()).toBe(HEAD - 2);
    });

    it("leaves live while a silently released subscription is replaced, then resumes", async () => {
      const first = board.latest();
      const subscribe = board.subscribe.bind(board);
      const gate: { answer?: () => void } = {};
      board.subscribe = (from, listener) =>
        new Promise((resolve) => {
          gate.answer = () => resolve(subscribe(from, listener));
        });

      await act(async () => first.handle.release());

      expect(ports.connection).toBe("connected");
      expect(feed()).toMatchObject({ kind: "board", connection: "lost" });
      expect(gateOnConnection(ports).decisions).toEqual({ kind: "unavailable", reason: "offline" });
      expect(board.reads).toEqual([0, HEAD - 2]);

      await act(async () => gate.answer?.());
      expect(feed()).toMatchObject({ kind: "board", connection: "live" });
      expect(board.latest().cursor).toBe(HEAD - 2);
    });

    it("replays from its cursor on reconnect and reports the board recovered", async () => {
      const next = new FakeBoard(SYNTH_REPO, LOG.slice(0, HEAD - 1));
      opens = [next];
      await act(async () => session(0).break());
      await act(async () => ports.onReconnect());
      await act(async () => session(1).answer());

      expect(sessions).toHaveLength(2);
      expect(next.reads).toEqual([HEAD - 2]);
      expect(next.subscriptions.map((s) => s.cursor)).toEqual([HEAD - 1]);
      expect(feed()).toMatchObject({ kind: "board", connection: "live", recovered: true });
      expect(cursor()).toBe(HEAD - 1);

      await act(async () => next.latest().listener.events([event(HEAD)]));
      expect(feed()).toMatchObject({ recovered: false });
      expect(cursor()).toBe(HEAD);
    });

    it("lets nothing from the replaced session change the board or the ports", async () => {
      const old = board.latest();
      const oldOwner = ports.owner;
      opens = [new FakeBoard(SYNTH_REPO, LOG.slice(0, HEAD - 2))];
      await act(async () => ports.onReconnect());
      await act(async () => session(1).answer());

      await act(async () => old.listener.events([event(HEAD - 1)]));
      await act(async () => old.listener.ended("revoked"));
      await act(async () => session(0).break());

      expect(cursor()).toBe(HEAD - 2);
      expect(feed()).toMatchObject({ connection: "live" });
      expect(ports.connection).toBe("connected");
      expect(ports.owner).not.toBe(oldOwner);
    });

    it("disposes the subscription and every capability of a replaced session", async () => {
      const old = board.latest();
      await act(async () => ports.onReconnect());

      expect(old.handle.disposed).toBe(true);
      expect(board.disposed).toBe(true);
      expect(board.ownerStub.disposed).toBe(true);
      expect(session(0).enrollment.disposed).toBe(true);
      expect(session(0).disposed).toBe(true);
      expect(session(1).disposed).toBe(false);
    });

    it("disposes everything when the page unmounts", async () => {
      const subscription = board.latest();
      await act(async () => root.unmount());
      await mount();

      expect(subscription.handle.disposed).toBe(true);
      expect(board.disposed).toBe(true);
      expect(board.ownerStub.disposed).toBe(true);
      expect(session(0).enrollment.disposed).toBe(true);
      expect(session(0).disposed).toBe(true);
    });
  });

  describe("when the fold halts", () => {
    it("reloads the board from a fresh fold, not from the halted one", async () => {
      opens = [halting({ ...event(2), repo: "rep_otherrepo" })];
      await mount();
      await act(async () => session(0).answer());
      const halted = feed();
      expect(halted).toMatchObject({
        kind: "board",
        board: { cursor: 1, stream: { kind: "halted" } },
      });

      const fresh = new FakeBoard(SYNTH_REPO, LOG);
      opens = [fresh];
      await act(async () => ports.onReconnect());
      await act(async () => session(1).answer());

      expect(fresh.reads).toEqual([0]);
      expect(fresh.subscriptions.map((s) => s.cursor)).toEqual([HEAD]);
      expect(feed()).toMatchObject({
        kind: "board",
        connection: "live",
        recovered: false,
        board: { cursor: HEAD, stream: { kind: "consistent" } },
      });
      expect(reloads).toBe(0);
    });

    it("reloads the page when the log needs a newer board to read it", async () => {
      opens = [halting({ ...event(2), v: 99 })];
      await mount();
      await act(async () => session(0).answer());

      await act(async () => ports.onReconnect());

      expect(reloads).toBe(1);
      expect(sessions).toHaveLength(1);
    });

    it("keeps resuming from the cursor when the board did not halt", async () => {
      opens = [new FakeBoard(SYNTH_REPO, LOG.slice(0, 2)), new FakeBoard(SYNTH_REPO, LOG)];
      await mount();
      await act(async () => session(0).answer());

      await act(async () => ports.onReconnect());
      await act(async () => session(1).answer());

      expect(feed()).toMatchObject({ kind: "board", recovered: true, board: { cursor: HEAD } });
      expect(reloads).toBe(0);
    });
  });

  describe("when a call never answers", () => {
    let board: FakeBoard;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      board = new FakeBoard(SYNTH_REPO, LOG);
      opens = [board];
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("fails the board at the open's deadline and disposes a board opened late", async () => {
      stalled = ["openBoard"];
      await start();
      expect(feed()).toEqual({ kind: "loading" });

      await expire();
      expect(feed()).toEqual({ kind: "failed" });
      expect(ports.connection).toBe("connected");

      await late(() => session(0).stalls.resume());
      expect(board.disposed).toBe(true);
      expect(board.reads).toEqual([]);
      expect(feed()).toEqual({ kind: "failed" });

      opens = [new FakeBoard(SYNTH_REPO, LOG)];
      await act(async () => ports.onReconnect());
      await act(async () => session(1).answer());
      expect(feed()).toMatchObject({ kind: "board", connection: "live" });
    });

    it("opens a board that answers one millisecond before the deadline", async () => {
      stalled = ["openBoard"];
      await start();
      await act(async () => vi.advanceTimersByTime(CALL_DEADLINE_MS - 1));
      await late(() => session(0).stalls.resume());
      await expire();

      expect(feed()).toMatchObject({ kind: "board", connection: "live" });
      expect(board.disposed).toBe(false);
    });

    it("fails the board at the first page's deadline and folds no page that arrives late", async () => {
      board.stalls.names.add("readEvents");
      await start();

      await expire();
      expect(feed()).toEqual({ kind: "failed" });

      await late(() => board.stalls.resume());
      expect(feed()).toEqual({ kind: "failed" });
      expect(board.subscriptions).toHaveLength(0);
    });

    it("shows the board stale at the subscription's deadline and disposes a late one", async () => {
      board.stalls.names.add("subscribe");
      await start();
      expect(feed()).toEqual({ kind: "loading" });

      await expire();
      expect(feed()).toMatchObject({ kind: "board", connection: "lost" });

      await late(() => board.stalls.resume());
      expect(board.latest().handle.disposed).toBe(true);
      expect(feed()).toMatchObject({ kind: "board", connection: "lost" });
    });

    it("fails the session at the owner's deadline and disposes an owner that arrives late", async () => {
      board.stalls.names.add("owner");
      await start();
      expect(feed()).toMatchObject({ kind: "board", connection: "live" });

      await expire();
      expect(feed()).toMatchObject({ kind: "board", connection: "lost" });
      expect(ports.owner).toEqual({ kind: "unavailable", reason: "offline" });
      expect(ports.decisions).toEqual({ kind: "unavailable", reason: "offline" });
      expect(board.latest().handle.disposed).toBe(true);

      await late(() => board.stalls.resume());
      expect(board.ownerStub.disposed).toBe(true);
      expect(ports.owner).toEqual({ kind: "unavailable", reason: "offline" });
    });

    it("fails the session at enrollment's deadline and disposes enrollment that arrives late", async () => {
      stalled = ["ownerEnrollment"];
      await start();

      await expire();
      expect(ports.enrollment).toEqual({ kind: "unavailable", reason: "offline" });
      expect(feed()).toMatchObject({ kind: "board", connection: "lost" });

      await late(() => session(0).stalls.resume());
      expect(session(0).enrollment.disposed).toBe(true);
    });

    it("turns an owner call that never answers into a failed result at its deadline", async () => {
      board.ownerStub.prepare = () => new Promise(() => {});
      await start();
      if (ports.owner.kind !== "available") throw new Error("owner unavailable");

      const pending = ports.owner.onPrepareAction({ kind: "agent.revoke", agentId: "agt_x" });
      await expire();

      expect(await pending).toMatchObject({ ok: false, code: "internal" });
    });
  });

  describe("recording a decision", () => {
    let board: FakeBoard;

    beforeEach(async () => {
      board = new FakeBoard(SYNTH_REPO, LOG);
      opens = [board];
    });

    it("prepares exactly that answer, signs it and performs it once", async () => {
      await mount();

      expect(await record()).toEqual({ ok: true, version: 7 });
      expect(board.ownerStub.prepared).toEqual([{ kind: "decision.record", ...REQUEST }]);
      expect(board.ownerStub.performed).toEqual([
        {
          challengeId: "chl_1",
          assertion: {
            credentialId: FAKE_ENCODED.credentialId,
            clientDataJson: FAKE_ENCODED.clientDataJson,
            authenticatorData: FAKE_ENCODED.authenticatorData,
            signature: FAKE_ENCODED.signature,
            userHandle: FAKE_ENCODED.userHandle,
          },
        },
      ]);
    });

    it("performs nothing when the passkey prompt is dismissed", async () => {
      answer = "dismiss";
      await mount();

      expect(await record()).toMatchObject({ ok: false });
      expect(board.ownerStub.performed).toHaveLength(0);
    });

    it("reports a stale answer by its code, not the backend's text", async () => {
      board.ownerStub.performFault = "action_stale";
      await mount();

      expect(await record()).toEqual({
        ok: false,
        message: "The answer changed since this board read it. Nothing was recorded.",
      });
    });

    it("refuses a result for another decision", async () => {
      board.ownerStub.result = () => ({
        kind: "decision.record",
        decisionId: "dec_other",
        version: 2,
      });
      await mount();

      expect(await record()).toMatchObject({ ok: false });
    });

    it("withdraws an answer whose session was replaced before it was sent", async () => {
      await mount();
      const pending = record();
      await act(async () => ports.onReconnect());

      expect(await pending).toEqual({
        ok: false,
        message: "The board lost its session before the answer was sent. Nothing was recorded.",
      });
      expect(board.ownerStub.performed).toHaveLength(0);
    });

    describe("when the board stops being current while the passkey prompt is open", () => {
      let sign: (() => void) | null;

      beforeEach(() => {
        sign = null;
        const signer = fakeAuthenticator().authenticator;
        authenticator = {
          get: (options) =>
            new Promise((resolve) => {
              sign = () => resolve(signer.get(options));
            }),
          create: signer.create,
        };
      });

      const signed = async (pending: Promise<unknown>) => {
        if (sign === null) throw new Error("the passkey prompt never opened");
        sign();
        return pending;
      };

      it("performs nothing once access to the repository is revoked", async () => {
        await mount();
        const pending = record();
        await act(async () => {});

        await act(async () => board.latest().listener.ended("revoked"));

        expect(await signed(pending)).toEqual(WITHDRAWN);
        expect(board.ownerStub.performed).toHaveLength(0);
        expect(feed()).toMatchObject({ kind: "board", connection: "lost" });
      });

      it("performs nothing once the subscription is released and the board catches up", async () => {
        await mount();
        const pending = record();
        await act(async () => {});

        await act(async () => board.latest().handle.release());

        expect(await signed(pending)).toEqual(WITHDRAWN);
        expect(board.ownerStub.performed).toHaveLength(0);
        expect(feed()).toMatchObject({ kind: "board", connection: "live" });
      });

      it("performs a later answer once the board is live again", async () => {
        await mount();
        await act(async () => board.latest().handle.release());
        const pending = record();
        await act(async () => {});

        expect(await signed(pending)).toEqual({ ok: true, version: 7 });
        expect(board.ownerStub.performed).toHaveLength(1);
      });
    });

    it("is unavailable without a passkey in this browser", async () => {
      authenticator = null;
      await mount();

      expect(ports.decisions).toEqual({ kind: "unavailable", reason: "no_passkey" });
    });
  });

  describe("when the board cannot be read", () => {
    it("is loading and offers no actions before the board opens", async () => {
      opens = [new FakeBoard(SYNTH_REPO, LOG)];
      root = createRoot(document.createElement("div"));
      act(() => root.render(<Probe />));

      expect(feed()).toEqual({ kind: "loading" });
      expect(ports.owner).toEqual({ kind: "unavailable", reason: "offline" });
      expect(ports.decisions).toEqual({ kind: "unavailable", reason: "offline" });
      await act(async () => {});
    });

    it("reports a repository the backend does not have as unavailable", async () => {
      opens = ["not_found"];
      await mount();

      expect(ports.board).toEqual({ kind: "unavailable" });
    });

    it("reports a failed open as a failed board, and a broken one too", async () => {
      opens = ["internal", "throw"];
      await mount();
      expect(feed()).toEqual({ kind: "failed" });

      await act(async () => ports.onReconnect());
      expect(feed()).toEqual({ kind: "failed" });
      expect(sessions).toHaveLength(2);
    });

    it("reports a log that cannot be read as failed with no board", async () => {
      const board = new FakeBoard(SYNTH_REPO, LOG);
      board.readFault = "internal";
      opens = [board];
      await mount();

      expect(feed()).toEqual({ kind: "failed" });
      expect(board.subscriptions).toHaveLength(0);
    });

    it("turns a call on a broken session into a failed result instead of throwing", async () => {
      const board = new FakeBoard(SYNTH_REPO, LOG);
      board.ownerStub.prepareFault = "throw";
      opens = [board];
      await mount();
      if (ports.owner.kind !== "available") throw new Error("owner unavailable");

      const result = await ports.owner.onPrepareAction({ kind: "agent.revoke", agentId: "agt_x" });

      expect(result).toMatchObject({ ok: false, code: "internal" });
    });
  });
});
