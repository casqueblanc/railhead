import { describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import { checkBeforeLand } from "../../../../../fixtures/board/checkBeforeLand";
import {
  SYNTH_REPO,
  SYNTH_START_MS,
  synthCommit,
  syntheticLog,
  withReplayOverlap,
  type SyntheticStep,
} from "../../../../../fixtures/board/syntheticLog";
import {
  UPLOAD,
  checkResult,
  push,
  uploadPrelude,
} from "../../../../../fixtures/board/uploadSteps";
import {
  ACTIVITY_WINDOW_MINUTES,
  emptyBoardState,
  foldEvents,
  type BoardState,
} from "../board/boardState";
import { boardMetrics } from "./metrics";

const MINUTE = 60_000;

const fold = (events: readonly RailheadEvent[]): BoardState => {
  const state = foldEvents(emptyBoardState(SYNTH_REPO), events);
  expect(state.stream).toEqual({ kind: "consistent" });
  return state;
};

/** `steps` numbered from seq 1, the `n`th recorded at `at(n)`. */
const timed = (steps: readonly SyntheticStep[], at: (index: number) => number): RailheadEvent[] =>
  steps.map((step, index) => ({ v: 1, seq: index + 1, at: at(index), repo: SYNTH_REPO, ...step }));

describe("boardMetrics", () => {
  it("counts questions, human actions, checks, landed changes and active claims from the log", () => {
    expect(boardMetrics(fold(checkBeforeLand.events))).toEqual({
      questionsAsked: 1,
      // Two invites, two confirmations, two filed issues and one decision.
      humanActions: 7,
      checks: { pass: 5, fail: 0, error: 0 },
      // Birch's merge landed, and atlas's after a rejected first intent.
      changesLanded: 2,
      activeClaims: 0,
      // The whole synthetic log is recorded within its first minute.
      recent: { minutes: 1, claimsOpened: 2, checksRun: 5, changesLanded: 2 },
    });
  });

  it("does not count an event twice when a replay repeats part of the log", () => {
    const once = boardMetrics(fold(checkBeforeLand.events));
    const replayed = boardMetrics(fold(withReplayOverlap(checkBeforeLand, 4, 20)));

    expect(replayed).toEqual(once);
  });

  it("counts failed checks and checks that could not run, with claims still open as active", () => {
    const state = fold(
      syntheticLog("Synthetic failing checks", [
        ...uploadPrelude(),
        checkResult("chk_synthfail", synthCommit(2), "test", "fail"),
        checkResult("chk_synthfail", synthCommit(2), "lint", "pass"),
        checkResult("chk_syntherr", synthCommit(3), "test", "error"),
      ]).events,
    );

    const metrics = boardMetrics(state);

    expect(metrics.checks).toEqual({ pass: 1, fail: 1, error: 1 });
    expect(metrics.changesLanded).toBe(0);
    expect(metrics.activeClaims).toBe(2);
    expect(metrics.recent?.checksRun).toBe(3);
  });

  it("reports nothing recent and only zeros for a log with no events", () => {
    expect(boardMetrics(emptyBoardState(SYNTH_REPO))).toEqual({
      questionsAsked: 0,
      humanActions: 0,
      checks: { pass: 0, fail: 0, error: 0 },
      changesLanded: 0,
      activeClaims: 0,
      recent: null,
    });
  });

  it("counts only the window ending at the newest event, and says how long that window is", () => {
    const prelude = uploadPrelude();
    const checks = [0, 1, 2, 3].map((n) =>
      checkResult(`chk_synthwin${n}`, synthCommit(n + 2), "test", "pass"),
    );
    // The prelude in the first minute, then one check at minutes 0, 5, 10 and 12.
    const minutes = [0, 5, 10, 12];
    const events = timed([...prelude, ...checks], (index) =>
      index < prelude.length
        ? SYNTH_START_MS + index
        : SYNTH_START_MS + (minutes[index - prelude.length] ?? 0) * MINUTE,
    );

    const at = (count: number) => boardMetrics(fold(events.slice(0, prelude.length + count)));

    // After minute 5 the log spans six minutes.
    expect(at(2).recent).toEqual({ minutes: 6, claimsOpened: 2, checksRun: 2, changesLanded: 0 });
    // After minute 12 the window is minutes 3 to 12: the prelude and minute 0 fell out.
    expect(at(4).recent).toEqual({
      minutes: ACTIVITY_WINDOW_MINUTES,
      claimsOpened: 0,
      checksRun: 3,
      changesLanded: 0,
    });
    // The totals still count everything.
    expect(at(4).checks.pass).toBe(4);
  });

  it("does not count a late event older than the window as recent", () => {
    const prelude = uploadPrelude();
    const steps = [
      ...prelude,
      push(UPLOAD.birch, UPLOAD.birchClaim, null, synthCommit(5)),
      checkResult("chk_synthlate", synthCommit(6), "test", "fail"),
    ];
    // The push is recorded 20 minutes after the prelude; the check carries an earlier time.
    const events = timed(steps, (index) => {
      if (index < prelude.length) return SYNTH_START_MS + index;
      return index === prelude.length ? SYNTH_START_MS + 20 * MINUTE : SYNTH_START_MS + MINUTE;
    });

    const metrics = boardMetrics(fold(events));

    expect(metrics.checks.fail).toBe(1);
    expect(metrics.recent).toEqual({
      minutes: ACTIVITY_WINDOW_MINUTES,
      claimsOpened: 0,
      checksRun: 0,
      changesLanded: 0,
    });
  });
});
