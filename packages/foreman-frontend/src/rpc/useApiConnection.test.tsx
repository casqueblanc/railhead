import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ApiSession } from "./apiSession";
import { useApiConnection } from "./useApiConnection";

// React flushes effects and state updates inside act() only when the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A backend session whose probe and break are driven by the test. */
class FakeSession implements ApiSession {
  disposed = false;
  answer: () => void = () => {};
  refuse: () => void = () => {};
  break: () => void = () => {};
  readonly #probe = new Promise<void>((resolve, reject) => {
    this.answer = resolve;
    this.refuse = () => reject(new Error("probe refused"));
  });

  ping(): Promise<void> {
    return this.#probe;
  }

  onRpcBroken(callback: (error: unknown) => void): void {
    this.break = () => callback(new Error("session broken"));
  }

  [Symbol.dispose](): void {
    this.disposed = true;
  }
}

describe("useApiConnection", () => {
  let root: Root;
  let sessions: FakeSession[];
  let connection: ReturnType<typeof useApiConnection>;

  const connect = () => {
    const session = new FakeSession();
    sessions.push(session);
    return session;
  };
  const Probe = () => {
    connection = useApiConnection(connect);
    return null;
  };
  /** The session opened by the given attempt, failing the test when it was never opened. */
  const session = (attempt: number): FakeSession => {
    const opened = sessions[attempt];
    if (!opened) throw new Error(`attempt ${attempt} opened no session`);
    return opened;
  };

  beforeEach(async () => {
    sessions = [];
    root = createRoot(document.createElement("div"));
    await act(async () => root.render(<Probe />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  it("is connecting until the backend answers, then connected", async () => {
    expect(connection.status).toBe("connecting");

    await act(async () => session(0).answer());

    expect(connection.status).toBe("connected");
  });

  it("is lost when the first probe fails", async () => {
    await act(async () => session(0).refuse());

    expect(connection.status).toBe("lost");
  });

  it("is lost when a connected session breaks", async () => {
    await act(async () => session(0).answer());

    await act(async () => session(0).break());

    expect(connection.status).toBe("lost");
  });

  it("replaces a lost session on retry and ignores the old one from then on", async () => {
    await act(async () => session(0).refuse());

    await act(async () => connection.onRetry());

    expect(sessions).toHaveLength(2);
    expect(session(0).disposed).toBe(true);
    expect(connection.status).toBe("connecting");

    await act(async () => session(0).break());
    expect(connection.status).toBe("connecting");

    await act(async () => session(1).answer());
    expect(connection.status).toBe("connected");
    expect(session(1).disposed).toBe(false);
  });

  it("ignores a late answer from a session it already replaced", async () => {
    await act(async () => connection.onRetry());

    await act(async () => session(0).answer());

    expect(connection.status).toBe("connecting");
  });

  it("disposes its session when the component unmounts", async () => {
    await act(async () => root.unmount());

    expect(session(0).disposed).toBe(true);
  });
});
