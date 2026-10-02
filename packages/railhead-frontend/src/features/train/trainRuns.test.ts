import { describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import { checkBeforeLand } from "../../../../../fixtures/board/checkBeforeLand";
import {
  SYNTH_REPO,
  SYNTH_START_MS,
  seqWhere,
  synthCommit,
  syntheticLog,
  type SyntheticStep,
} from "../../../../../fixtures/board/syntheticLog";
import {
  UPLOAD,
  UPLOAD_BASE,
  checkResult,
  intend,
  moveMain,
  push,
  ready,
  uploadPrelude,
} from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import { trainRuns } from "./trainRuns";

const fold = (events: readonly RailheadEvent[]): BoardState => {
  const state = foldEvents(emptyBoardState(SYNTH_REPO), events);
  // A fixture that the fold refuses would make every assertion below vacuous.
  expect(state.stream).toEqual({ kind: "consistent" });
  return state;
};

const append = (state: BoardState, step: SyntheticStep): BoardState =>
  foldEvents(state, [
    { v: 1, seq: state.cursor + 1, at: SYNTH_START_MS, repo: SYNTH_REPO, ...step },
  ]);

const beforeMain = (intentId: string): BoardState =>
  fold(
    checkBeforeLand.events.slice(
      0,
      seqWhere(checkBeforeLand, (e) => e.type === "train.main" && e.data.intentId === intentId) - 1,
    ),
  );

describe("trainRuns over the check-before-land log", () => {
  it("lists every intent newest first with its outcome and the main it saw", () => {
    const runs = trainRuns(fold(checkBeforeLand.events));

    expect(runs.map((run) => [run.intentId, run.outcome])).toEqual([
      ["int_synth12", { kind: "landed_after_read_back" }],
      ["int_synth11", { kind: "main_moved", main: synthCommit(7) }],
      ["int_synth10", { kind: "landed" }],
    ]);
    expect(runs[1]).toMatchObject({
      expectedMain: UPLOAD_BASE,
      candidate: synthCommit(3),
      claims: [{ claimId: UPLOAD.atlasClaim, issueTitle: "Accept large uploads" }],
      checks: {
        checkRunId: "chk_synth11",
        candidate: synthCommit(3),
        counts: { pass: 2, fail: 0, error: 0 },
      },
    });
  });

  it("shows an intent without a main update as pending", () => {
    const runs = trainRuns(beforeMain("int_synth10"));
    expect(runs.map((run) => [run.intentId, run.outcome.kind])).toEqual([
      ["int_synth11", "pending"],
      ["int_synth10", "pending"],
    ]);
  });

  it("does not land a read-back intent when main is another commit", () => {
    const state = append(
      beforeMain("int_synth12"),
      moveMain("int_synth12", "reconciled", synthCommit(7)),
    );
    expect(state.stream).toEqual({ kind: "consistent" });
    expect(trainRuns(state)[0]?.outcome).toEqual({
      kind: "not_landed_after_read_back",
      main: synthCommit(7),
    });
  });

  it("returns nothing for a board the train never touched", () => {
    expect(trainRuns(emptyBoardState(SYNTH_REPO))).toEqual([]);
  });

  it("counts failed checks and checks that could not run", () => {
    const state = fold(
      syntheticLog("Synthetic failing checks", [
        ...uploadPrelude(),
        push(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), synthCommit(2)),
        ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(2), []),
        checkResult("chk_synthfail", synthCommit(3), "test", "fail"),
        checkResult("chk_synthfail", synthCommit(3), "lint", "error"),
        intend(
          "int_synthfail",
          UPLOAD_BASE,
          synthCommit(3),
          [UPLOAD.atlasClaim],
          [],
          "chk_synthfail",
        ),
      ]).events,
    );
    expect(trainRuns(state)[0]?.checks.counts).toEqual({ pass: 0, fail: 1, error: 1 });
  });
});
