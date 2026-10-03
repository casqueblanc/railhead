// Opening a capture for replay, and the board at each step of its playback.
//
// A replay folds the captured events with the same `foldEvents` the live board uses, from the same
// empty board, so its final state is the state the live board reached at the capture's head. A
// capture is opened only when the whole log folds without a gap or a fault: a board that would stop
// partway is refused up front rather than replayed to a point and left there.

import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import { captureErrorText, parseCapture, type Capture } from "./captureFile";

/** Events between two stored boards of a replay; a backward move refolds at most this many. */
export const CHECKPOINT_INTERVAL = 64;

/** A capture that folds completely, with the board it ends at. */
export interface Replay {
  capture: Capture;
  /** The board after every event, identical to the live board at `capture.head`. */
  final: BoardState;
  /** The board after each multiple of `CHECKPOINT_INTERVAL` events, from 0 up to `head`. */
  checkpoints: readonly BoardState[];
}

/** A replay, or the sentence saying why the file cannot be replayed. */
export type OpenedReplay = { ok: true; replay: Replay } | { ok: false; message: string };

/** Opens a capture file's text for replay. Never throws. */
export const openReplay = (text: string): OpenedReplay => {
  const parsed = parseCapture(text);
  if (!parsed.ok) return { ok: false, message: captureErrorText(parsed.error) };
  return replayCapture(parsed.capture);
};

/** Folds a parsed capture, refusing one the board cannot fold to its head. */
export const replayCapture = (capture: Capture): OpenedReplay => {
  let final = emptyBoardState(capture.repo);
  const checkpoints = [final];
  for (let start = 0; start < capture.events.length; start += CHECKPOINT_INTERVAL) {
    final = foldEvents(final, capture.events.slice(start, start + CHECKPOINT_INTERVAL));
    if (start + CHECKPOINT_INTERVAL <= capture.events.length) checkpoints.push(final);
  }
  const { stream } = final;
  switch (stream.kind) {
    case "consistent":
      break;
    case "gap":
      return {
        ok: false,
        message: `The capture is missing event ${stream.expected}, so it cannot be replayed.`,
      };
    case "halted":
      return {
        ok: false,
        message: `The board cannot apply event ${stream.fault.seq} of this capture, so it cannot be replayed.`,
      };
    default:
      return unreachable(stream);
  }
  if (final.cursor !== capture.head) {
    return {
      ok: false,
      message: `The capture folds to event ${final.cursor}, not to its head ${capture.head}.`,
    };
  }
  return { ok: true, replay: { capture, final, checkpoints } };
};

/** The board after the first `position` events of a replay, from 0 to its head. */
export interface ReplayFrame {
  position: number;
  board: BoardState;
}

/** The empty board a replay starts from. */
export const firstFrame = (replay: Replay): ReplayFrame => ({
  position: 0,
  board: emptyBoardState(replay.capture.repo),
});

/** The last frame: every event applied. */
export const lastFrame = (replay: Replay): ReplayFrame => ({
  position: replay.capture.head,
  board: replay.final,
});

/**
 * The frame at `position`, clamped to the replay. It folds from whichever is nearer below the
 * target, the current frame or the last checkpoint, since a fold cannot be undone: a move costs at
 * most `CHECKPOINT_INTERVAL` events however far back it goes.
 */
export const frameAt = (replay: Replay, from: ReplayFrame, position: number): ReplayFrame => {
  const { head, events } = replay.capture;
  const target = Math.min(Math.max(Math.trunc(position), 0), head);
  if (target === head) return lastFrame(replay);
  if (target === from.position) return from;
  const index = Math.floor(target / CHECKPOINT_INTERVAL);
  const checkpoint = replay.checkpoints[index];
  const stored: ReplayFrame =
    checkpoint === undefined
      ? firstFrame(replay)
      : { position: index * CHECKPOINT_INTERVAL, board: checkpoint };
  const start = from.position < target && from.position > stored.position ? from : stored;
  return {
    position: target,
    board: foldEvents(start.board, events.slice(start.position, target)),
  };
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled replay variant: ${JSON.stringify(value)}`);
};
