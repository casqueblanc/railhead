import { describe, expect, it } from "vitest";
import { SYNTH_REPO } from "../../../../../fixtures/board/syntheticLog";
import type { BoardFeed } from "../claims/boardFeed";
import { gateOnConnection, type BoardPorts } from "./boardPorts";
import { emptyBoardState } from "./boardState";

const never = () => Promise.reject(new Error("no action may run in this test"));

const ports = (overrides: Partial<BoardPorts> = {}): BoardPorts => ({
  connection: "connected",
  onReconnect: () => {},
  board: { kind: "available", feed: { kind: "loading" } },
  decisions: { kind: "available", onRecordDecision: never },
  owner: { kind: "available", onPrepareAction: never, onPerformAction: never },
  ...overrides,
});

const boardFeed = (connection: "live" | "lost"): BoardFeed => ({
  kind: "board",
  board: emptyBoardState(SYNTH_REPO),
  connection,
  recovered: false,
});

describe("gateOnConnection", () => {
  it("leaves the actions in place while the session is up", () => {
    const connected = ports({ board: { kind: "available", feed: boardFeed("live") } });

    expect(gateOnConnection(connected)).toBe(connected);
  });

  it("withdraws available actions as offline when the session is lost", () => {
    const gated = gateOnConnection(ports({ connection: "lost" }));

    expect(gated.decisions).toEqual({ kind: "unavailable", reason: "offline" });
    expect(gated.owner).toEqual({ kind: "unavailable", reason: "offline" });
    expect(gated.board).toEqual({ kind: "available", feed: { kind: "loading" } });
  });

  it("withdraws the actions when the board's feed is lost even if the binding says connected", () => {
    const gated = gateOnConnection(
      ports({ board: { kind: "available", feed: boardFeed("lost") } }),
    );

    expect(gated.decisions).toEqual({ kind: "unavailable", reason: "offline" });
    expect(gated.owner).toEqual({ kind: "unavailable", reason: "offline" });
  });

  it("keeps a missing module's reason when the session is also lost", () => {
    const gated = gateOnConnection(
      ports({
        connection: "lost",
        decisions: { kind: "unavailable", reason: "no_passkey" },
        owner: { kind: "unavailable", reason: "module_unavailable" },
      }),
    );

    expect(gated.decisions).toEqual({ kind: "unavailable", reason: "no_passkey" });
    expect(gated.owner).toEqual({ kind: "unavailable", reason: "module_unavailable" });
  });
});
