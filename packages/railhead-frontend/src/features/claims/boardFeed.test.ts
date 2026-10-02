import { describe, expect, it } from "vitest";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import { SYNTH_REPO, withLostEvents } from "../../../../../fixtures/board/syntheticLog";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import { feedView } from "./boardFeed";

const complete = foldEvents(emptyBoardState(SYNTH_REPO), decisionReversal.events);
const gapped = foldEvents(emptyBoardState(SYNTH_REPO), withLostEvents(decisionReversal, [10]));
const halted: BoardState = {
  ...complete,
  stream: { kind: "halted", fault: { kind: "foreign_repo", seq: complete.cursor + 1 } },
};

describe("feedView", () => {
  it("shows a consistent board on a live connection as live", () => {
    expect(
      feedView({ kind: "board", board: complete, connection: "live", recovered: false }),
    ).toEqual({ kind: "live", board: complete });
  });

  it("passes loading and failure through without a board", () => {
    expect(feedView({ kind: "loading" })).toEqual({ kind: "loading" });
    expect(feedView({ kind: "failed" })).toEqual({ kind: "failed" });
  });

  it("marks a board with missing events as stale and names the range", () => {
    expect(
      feedView({ kind: "board", board: gapped, connection: "live", recovered: false }),
    ).toEqual({
      kind: "stale",
      board: gapped,
      reason: { kind: "gap", expected: 10, through: decisionReversal.events.length },
    });
  });

  it("reports a lost connection before a gap it cannot close", () => {
    expect(feedView({ kind: "board", board: gapped, connection: "lost", recovered: true })).toEqual(
      {
        kind: "stale",
        board: gapped,
        reason: { kind: "disconnected" },
      },
    );
  });

  it("reports a halted fold even when the connection is lost or recovered", () => {
    for (const connection of ["live", "lost"] as const) {
      expect(feedView({ kind: "board", board: halted, connection, recovered: true })).toEqual({
        kind: "halted",
        board: halted,
        fault: { kind: "foreign_repo", seq: complete.cursor + 1 },
      });
    }
  });

  it("shows recovery only once the board is consistent again", () => {
    expect(
      feedView({ kind: "board", board: complete, connection: "live", recovered: true }),
    ).toEqual({
      kind: "recovered",
      board: complete,
    });
    expect(
      feedView({ kind: "board", board: gapped, connection: "live", recovered: true }).kind,
    ).toBe("stale");
  });
});
