import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiSession } from "../../rpc/apiSession";
import type { BoardPorts } from "./boardPorts";
import { useLiveBoardPorts } from "./liveConnection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A backend session whose probe is settled by the test. */
class FakeSession implements ApiSession {
  disposed = false;
  answer: () => void = () => {};
  refuse: () => void = () => {};
  readonly #probe = new Promise<void>((resolve, reject) => {
    this.answer = resolve;
    this.refuse = () => reject(new Error("probe refused"));
  });

  ping(): Promise<void> {
    return this.#probe;
  }

  onRpcBroken(): void {}

  [Symbol.dispose](): void {
    this.disposed = true;
  }
}

describe("useLiveBoardPorts", () => {
  let root: Root;
  let sessions: FakeSession[];
  let ports: BoardPorts;

  const connect = () => {
    const session = new FakeSession();
    sessions.push(session);
    return session;
  };
  const Probe = () => {
    ports = useLiveBoardPorts(connect);
    return null;
  };
  const first = (): FakeSession => {
    const [session] = sessions;
    if (!session) throw new Error("no session was opened");
    return session;
  };

  beforeEach(async () => {
    sessions = [];
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it("reports the board and every action unavailable once the backend answers", async () => {
    await act(async () => first().answer());

    expect(ports.connection).toBe("connected");
    expect(ports.board).toEqual({ kind: "unavailable" });
    expect(ports.decisions).toEqual({ kind: "unavailable", reason: "module_unavailable" });
    expect(ports.owner).toEqual({ kind: "unavailable", reason: "module_unavailable" });
  });

  it("reports the actions offline when the backend does not answer", async () => {
    await act(async () => first().refuse());

    expect(ports.connection).toBe("lost");
    expect(ports.decisions).toEqual({ kind: "unavailable", reason: "offline" });
    expect(ports.owner).toEqual({ kind: "unavailable", reason: "offline" });
  });

  it("opens one session across renders and disposes it on unmount", async () => {
    await act(async () => first().answer());
    await act(async () => root.render(<Probe />));

    expect(sessions).toHaveLength(1);
    await act(async () => root.unmount());
    expect(first().disposed).toBe(true);
    root = createRoot(document.createElement("div"));
  });

  it("replaces a lost session with exactly one new one on reconnect", async () => {
    await act(async () => first().refuse());
    await act(async () => ports.onReconnect());

    expect(sessions).toHaveLength(2);
    expect(first().disposed).toBe(true);
    expect(ports.connection).toBe("connecting");
  });
});
