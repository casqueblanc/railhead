import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CALL_DEADLINE_MS } from "./deadline";
import { FakeApi } from "./fakeApi";
import { useApiConnection } from "./useApiConnection";

// React flushes effects and state updates inside act() only when the environment opts in.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useApiConnection", () => {
  let root: Root;
  let sessions: FakeApi[];
  let connection: ReturnType<typeof useApiConnection>;

  const connect = () => {
    const session = new FakeApi("unavailable");
    sessions.push(session);
    return session;
  };
  const Probe = () => {
    connection = useApiConnection(connect);
    return null;
  };
  /** The session opened by the given attempt, failing the test when it was never opened. */
  const session = (attempt: number): FakeApi => {
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

  it("exposes the session it opened, before the backend answers", () => {
    expect(sessions).toHaveLength(1);
    expect(connection.session?.api).toBe(session(0));
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
    expect(connection.session?.api).toBe(session(1));

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

  describe("when the backend never answers the probe", () => {
    // The probe's deadline starts with the session, so the session is opened under fake timers.
    beforeEach(async () => {
      await act(async () => root.unmount());
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      sessions = [];
      root = createRoot(document.createElement("div"));
      await act(async () => root.render(<Probe />));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("is lost at the probe's deadline and stays lost when the answer arrives late", async () => {
      await act(async () => vi.advanceTimersByTime(CALL_DEADLINE_MS - 1));
      expect(connection.status).toBe("connecting");

      await act(async () => vi.advanceTimersByTime(1));
      expect(connection.status).toBe("lost");

      await act(async () => session(0).answer());
      expect(connection.status).toBe("lost");
    });

    it("connects on retry once the replacement answers", async () => {
      await act(async () => vi.advanceTimersByTime(CALL_DEADLINE_MS));
      await act(async () => connection.onRetry());
      await act(async () => session(1).answer());

      expect(connection.status).toBe("connected");
    });
  });

  it("disposes its session when the component unmounts", async () => {
    await act(async () => root.unmount());
    root = createRoot(document.createElement("div"));

    expect(session(0).disposed).toBe(true);
  });
});
