import { describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import { checkBeforeLand } from "../../../../../fixtures/board/checkBeforeLand";
import { SYNTH_REPO, synthCommit, syntheticLog } from "../../../../../fixtures/board/syntheticLog";
import {
  checkResult,
  checkTimedOut,
  sizeDecision,
} from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import { MAX_LISTED_CHECK_RUNS, checkRuns } from "./checkRuns";

const fold = (events: readonly RailheadEvent[]): BoardState => {
  const state = foldEvents(emptyBoardState(SYNTH_REPO), events);
  expect(state.stream).toEqual({ kind: "consistent" });
  return state;
};

const runs = (count: number) =>
  fold(
    syntheticLog(
      "Synthetic check runs",
      Array.from({ length: count }, (_, n) =>
        checkResult(`chk_synthrun${n}`, synthCommit(n + 1), "test", n % 2 === 0 ? "pass" : "fail"),
      ),
    ).events,
  );

describe("checkRuns", () => {
  it("lists every run newest first with its results and the intents citing it", () => {
    const { runs: listed, omitted } = checkRuns(fold(checkBeforeLand.events));

    expect(listed.map((run) => [run.checkRunId, run.intents])).toEqual([
      ["chk_synth13", []],
      ["chk_synth12", ["int_synth12"]],
      ["chk_synth11", ["int_synth11"]],
      ["chk_synth10", ["int_synth10"]],
    ]);
    expect(listed[2]).toEqual({
      checkRunId: "chk_synth11",
      candidate: synthCommit(3),
      results: [
        { check: "test", result: "pass", acceptance: null },
        {
          check: "accept-reject",
          result: "pass",
          acceptance: { decision: sizeDecision(1), option: "reject" },
        },
      ],
      overall: "pass",
      intents: ["int_synth11"],
    });
    expect(omitted).toBe(0);
  });

  it("lists a timed-out run by when it ended, with no results", () => {
    const state = fold(
      syntheticLog("Synthetic timed-out run", [
        checkResult("chk_synthbefore", synthCommit(1), "test", "pass"),
        checkTimedOut("chk_synthlate", synthCommit(2)),
        checkResult("chk_synthafter", synthCommit(3), "test", "fail"),
      ]).events,
    );

    const { runs: listed } = checkRuns(state);

    expect(listed.map((run) => [run.checkRunId, run.overall])).toEqual([
      ["chk_synthafter", "fail"],
      ["chk_synthlate", "timed_out"],
      ["chk_synthbefore", "pass"],
    ]);
    expect(listed[1]).toMatchObject({ candidate: synthCommit(2), results: [], intents: [] });
  });

  it("lists a failed run no merge cites, and ranks failure over an error", () => {
    const state = fold(
      syntheticLog("Synthetic failed and errored runs", [
        checkResult("chk_synthmixed", synthCommit(1), "test", "error"),
        checkResult("chk_synthmixed", synthCommit(1), "lint", "fail"),
        checkResult("chk_syntherror", synthCommit(2), "test", "error"),
      ]).events,
    );

    expect(checkRuns(state).runs.map((run) => [run.checkRunId, run.overall, run.intents])).toEqual([
      ["chk_syntherror", "error", []],
      ["chk_synthmixed", "fail", []],
    ]);
  });

  it("orders a run by its latest result, so a run that gets a new result moves to the top", () => {
    const state = fold(
      syntheticLog("Synthetic interleaved runs", [
        checkResult("chk_syntholder", synthCommit(1), "test", "pass"),
        checkResult("chk_synthnewer", synthCommit(2), "test", "pass"),
        checkResult("chk_syntholder", synthCommit(1), "lint", "fail"),
      ]).events,
    );

    expect(checkRuns(state).runs.map((run) => run.checkRunId)).toEqual([
      "chk_syntholder",
      "chk_synthnewer",
    ]);
  });

  it(`lists at most ${MAX_LISTED_CHECK_RUNS} runs and counts the rest`, () => {
    expect(checkRuns(runs(MAX_LISTED_CHECK_RUNS))).toMatchObject({ omitted: 0 });
    const over = checkRuns(runs(MAX_LISTED_CHECK_RUNS + 3));

    expect(over.runs).toHaveLength(MAX_LISTED_CHECK_RUNS);
    expect(over.omitted).toBe(3);
    expect(over.runs[0]?.checkRunId).toBe(`chk_synthrun${MAX_LISTED_CHECK_RUNS + 2}`);
  });

  it("lists nothing for a board with no checks", () => {
    expect(checkRuns(emptyBoardState(SYNTH_REPO))).toEqual({ runs: [], omitted: 0 });
  });
});
