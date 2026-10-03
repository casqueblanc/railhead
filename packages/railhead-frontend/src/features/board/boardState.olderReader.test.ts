// The fold as a board built before schema version 2 runs it: that board reads version 1 only. A
// held check must stop it with a version fault, which reloads the page into newer code, never with
// an invalid-event fault that reads as a corrupt log.

import { describe, expect, it, vi } from "vitest";
import {
  SYNTH_REPO,
  SYNTH_TRAIN,
  synthCommit,
  syntheticLog,
} from "../../../../../fixtures/board/syntheticLog";
import { UPLOAD, UPLOAD_BASE, uploadPrelude } from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents } from "./boardState";

vi.mock("@railhead/shared/events", async (importOriginal) => {
  const events = await importOriginal<typeof import("@railhead/shared/events")>();
  return { ...events, EVENT_SCHEMA_VERSION: 1, isReadableVersion: (v: number) => v === 1 };
});

const prelude = uploadPrelude();
const log = syntheticLog("Synthetic held check met by a version 1 board", [
  ...prelude,
  {
    type: "train.held",
    actor: SYNTH_TRAIN,
    data: {
      checkRunId: "chk_synthheld",
      expectedMain: UPLOAD_BASE,
      candidate: synthCommit(9),
      claims: [UPLOAD.atlasClaim],
      paths: [".railhead/check.json"],
      digest: null,
    },
  },
]);

describe("a version 1 board meeting a held check", () => {
  it("folds the version 1 history, then halts on the held check by its version", () => {
    const board = foldEvents(emptyBoardState(SYNTH_REPO), log.events);

    expect(board.cursor).toBe(prelude.length);
    expect(board.stream).toEqual({
      kind: "halted",
      fault: { kind: "unsupported_version", seq: prelude.length + 1, version: 2 },
    });
  });
});
