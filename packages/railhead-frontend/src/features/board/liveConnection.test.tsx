import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import { checkBeforeLand } from "../../../../../fixtures/board/checkBeforeLand";
import { SYNTH_REPO } from "../../../../../fixtures/board/syntheticLog";
import { FakeApi, FakeBoard, type Fault } from "../../rpc/fakeApi";
import type { RecordDecisionRequest } from "../decisions/decisionActions";
import { FAKE_ENCODED, fakeAuthenticator, type FakeAnswer } from "../enrollment/fakeAuthenticator";
import type { Authenticator } from "../enrollment/webauthn";
import type { BoardPorts } from "./boardPorts";
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

const event = (seq: number): RailheadEvent => {
  const found = LOG[seq - 1];
  if (found === undefined) throw new Error(`the fixture has no event ${seq}`);
  return found;
};

describe("useLiveBoardPorts", () => {
  let root: Root;
  let sessions: FakeApi[];
  let ports: BoardPorts;
  let opens: (FakeBoard | Fault)[];
  let authenticator: Authenticator | null;
  let answer: FakeAnswer;

  const connect = () => {
    const next = opens.shift() ?? "unavailable";
    const session = new FakeApi(next);
    sessions.push(session);
    return session;
  };
  const authenticate = () => authenticator;
  const Probe = () => {
    ports = useLiveBoardPorts(TARGET, connect, authenticate);
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

  /** Records `REQUEST` through the decisions port, failing the test when it is unavailable. */
  const record = async () => {
    if (ports.decisions.kind !== "available") throw new Error("decisions unavailable");
    return ports.decisions.onRecordDecision(REQUEST);
  };

  beforeEach(() => {
    sessions = [];
    opens = [];
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
