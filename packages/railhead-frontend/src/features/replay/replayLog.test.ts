import { describe, expect, it } from "vitest";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import {
  SYNTH_REPO,
  synthAgent,
  synthCommit,
  syntheticLog,
  withReplayOverlap,
} from "../../../../../fixtures/board/syntheticLog";
import { emptyBoardState, foldEvent, foldEvents } from "../board/boardState";
import { serializeCapture, type Capture } from "./captureFile";
import { firstFrame, frameAt, lastFrame, openReplay, replayCapture } from "./replayLog";
import { syntheticCapture } from "./syntheticReplays";

const capture = syntheticCapture(decisionReversal);
const textOf = (value: Capture): string => {
  const serialized = serializeCapture(value);
  if (!serialized.ok) throw new Error("serialize failed");
  return serialized.text;
};
const opened = () => {
  const result = openReplay(textOf(capture));
  if (!result.ok) throw new Error(result.message);
  return result.replay;
};

describe("openReplay", () => {
  it("ends at the board the live stream reached, including after a reconnect replay", () => {
    // The live board receives events one call at a time, and a reconnect repeats some of them.
    const live = withReplayOverlap(decisionReversal, 20, 12).reduce(
      foldEvent,
      emptyBoardState(SYNTH_REPO),
    );
    const replay = opened();
    expect(replay.final).toEqual(live);
    expect(replay.final.cursor).toBe(capture.head);
    expect(replay.final.stream).toEqual({ kind: "consistent" });
  });

  it("refuses a file it cannot parse, saying why", () => {
    expect(openReplay("{")).toEqual({ ok: false, message: "The file is not JSON." });
  });

  it("refuses a log the board fold halts on", () => {
    // Shape and invariants are valid, but the push names a claim the log never opened.
    const orphan = syntheticLog("Synthetic push to an unopened claim", [
      {
        actor: synthAgent("agt_synthatlas"),
        type: "claim.pushed",
        data: {
          claimId: "clm_synthnone",
          generation: 1,
          ref: "refs/heads/main",
          from: null,
          to: synthCommit(1),
        },
      },
    ]);
    expect(openReplay(textOf(syntheticCapture(orphan)))).toEqual({
      ok: false,
      message: "The board cannot apply event 1 of this capture, so it cannot be replayed.",
    });
  });

  it("refuses a capture whose events stop short of their head", () => {
    // `replayCapture` takes a parsed capture; a gap here can only come from a caller's bug.
    const short: Capture = { ...capture, events: capture.events.slice(0, 5) };
    expect(replayCapture(short)).toEqual({
      ok: false,
      message: `The capture folds to event 5, not to its head ${capture.head}.`,
    });
  });
});

const prefix = (count: number) =>
  foldEvents(emptyBoardState(SYNTH_REPO), capture.events.slice(0, count));

describe("frameAt", () => {
  const replay = opened();

  it("folds forward from the current frame to the board at that event", () => {
    const at10 = frameAt(replay, firstFrame(replay), 10);
    const at25 = frameAt(replay, at10, 25);
    expect(at10).toEqual({ position: 10, board: prefix(10) });
    expect(at25).toEqual({ position: 25, board: prefix(25) });
  });

  it("refolds from the start when moving back", () => {
    expect(frameAt(replay, lastFrame(replay), 3)).toEqual({ position: 3, board: prefix(3) });
  });

  it("clamps to the first and last frames", () => {
    expect(frameAt(replay, lastFrame(replay), -4)).toEqual(firstFrame(replay));
    expect(frameAt(replay, firstFrame(replay), capture.head + 9)).toEqual(lastFrame(replay));
    expect(frameAt(replay, firstFrame(replay), capture.head).board).toBe(replay.final);
  });
});
