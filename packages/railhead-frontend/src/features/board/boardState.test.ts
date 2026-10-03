import { describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import { checkBeforeLand } from "../../../../../fixtures/board/checkBeforeLand";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import { optionResults } from "../../../../../fixtures/board/optionResults";
import {
  SYNTH_OWNER,
  SYNTH_REPO,
  SYNTH_START_MS,
  SYNTH_TRAIN,
  seqWhere,
  synthAgent,
  synthCommit,
  syntheticLog,
  withLostEvents,
  withReplayOverlap,
  type SyntheticLog,
  type SyntheticStep,
} from "../../../../../fixtures/board/syntheticLog";
import {
  UPLOAD,
  checkResult,
  decide,
  inbox,
  moveMain,
  push,
  ready,
  sizeDecision,
  uploadPrelude,
} from "../../../../../fixtures/board/uploadSteps";
import {
  MAX_LANE_PUSHES,
  decisionRipple,
  emptyBoardState,
  foldEvent,
  foldEvents,
  inboxKey,
  isClaimAdapted,
  type BoardState,
} from "./boardState";

const fold = (events: readonly RailheadEvent[]): BoardState =>
  foldEvents(emptyBoardState(SYNTH_REPO), events);

/** The board after the log's events up to and including `seq`. */
const through = (log: SyntheticLog, seq: number): BoardState => fold(log.events.slice(0, seq));

/** The board after the first event matching `predicate`. */
const after = (log: SyntheticLog, predicate: (event: RailheadEvent) => boolean): BoardState =>
  through(log, seqWhere(log, predicate));

/** `step` as the next event of `state`'s log. */
const next = (state: BoardState, step: SyntheticStep): RailheadEvent => ({
  v: 1,
  seq: state.cursor + 1,
  at: SYNTH_START_MS + state.cursor * 1000,
  repo: SYNTH_REPO,
  ...step,
});

const append = (state: BoardState, step: SyntheticStep): BoardState =>
  foldEvent(state, next(state, step));

const atlasAdapted = (state: BoardState): boolean =>
  isClaimAdapted(state, UPLOAD.atlasClaim, UPLOAD.decision);

const isMain = (intentId: string) => (event: RailheadEvent) =>
  event.type === "train.main" && event.data.intentId === intentId;

const isCheck = (checkRunId: string) => (event: RailheadEvent) =>
  event.type === "train.check" && event.data.checkRunId === checkRunId;

const last = (log: SyntheticLog): number => log.events.length;

const atlasItem = (state: BoardState, item: number) => state.inbox[inboxKey(UPLOAD.atlas, item)];

const ripple = (state: BoardState) => decisionRipple(state, UPLOAD.decision);

const birch = (state: BoardState) => state.claims[UPLOAD.birchClaim];

const atlas = (state: BoardState) => state.claims[UPLOAD.atlasClaim];

/** Atlas's ready claim reopened at `decisions`. */
const reopen = (decisions = [sizeDecision(2)]): SyntheticStep => ({
  type: "claim.reopened",
  actor: SYNTH_TRAIN,
  data: { claimId: UPLOAD.atlasClaim, generation: 1, decisions },
});

describe("foldEvents over a delivered stream", () => {
  it("applies a complete log in order", () => {
    const state = fold(decisionReversal.events);
    expect(state.cursor).toBe(last(decisionReversal));
    expect(state.stream).toEqual({ kind: "consistent" });
    expect(state.main).toBe(synthCommit(5));
    expect(Object.keys(state.agents)).toEqual([UPLOAD.atlas, UPLOAD.birch]);
    expect(state.claims[UPLOAD.birchClaim]?.refusal).toEqual({
      generation: 1,
      reason: "unacked_decision",
    });
  });

  it("ignores events a replay repeats, leaving the board as if each arrived once", () => {
    const straight = fold(decisionReversal.events);
    const replayed = fold(withReplayOverlap(decisionReversal, 20, 12));
    expect(replayed).toEqual(straight);

    const duplicate = decisionReversal.events[last(decisionReversal) - 1];
    if (duplicate === undefined) throw new Error("fixture is empty");
    expect(foldEvent(straight, duplicate)).toBe(straight);
  });

  it("stops at a gap and applies nothing beyond it", () => {
    const lost = 25;
    const state = fold(withLostEvents(decisionReversal, [lost]));
    expect(state.stream).toEqual({
      kind: "gap",
      expected: lost,
      through: last(decisionReversal),
    });
    expect(state.cursor).toBe(lost - 1);
    expect({ ...state, stream: null }).toEqual({
      ...through(decisionReversal, lost - 1),
      stream: null,
    });
  });

  it("stays in the gap until a replay reaches the newest event seen, then recovers", () => {
    const gapped = fold(withLostEvents(decisionReversal, [25]));
    const partial = foldEvents(gapped, decisionReversal.events.slice(24, 30));
    expect(partial.stream).toEqual({ kind: "gap", expected: 31, through: last(decisionReversal) });

    const recovered = foldEvents(partial, decisionReversal.events.slice(24));
    expect(recovered).toEqual(fold(decisionReversal.events));
  });

  it("treats a log that does not start at seq 1 as a gap", () => {
    const state = fold(decisionReversal.events.slice(1));
    expect(state.stream).toEqual({ kind: "gap", expected: 1, through: last(decisionReversal) });
    expect(state.cursor).toBe(0);
    expect(state.agents).toEqual({});
  });

  it("keeps only the most recent pushes on a lane", () => {
    let state = through(
      decisionReversal,
      seqWhere(decisionReversal, (e) => e.type === "question.asked"),
    );
    for (let n = 0; n <= MAX_LANE_PUSHES; n += 1) {
      state = append(
        state,
        push(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(100 + n), synthCommit(101 + n)),
      );
    }
    expect(state.stream).toEqual({ kind: "consistent" });
    const pushes = state.claims[UPLOAD.atlasClaim]?.pushes ?? [];
    expect(pushes).toHaveLength(MAX_LANE_PUSHES);
    expect(pushes.at(0)?.from).toBe(synthCommit(101));
    expect(state.claims[UPLOAD.atlasClaim]?.head).toBe(synthCommit(101 + MAX_LANE_PUSHES));
  });
});

describe("foldEvent on events it must not apply", () => {
  const base = through(
    decisionReversal,
    seqWhere(decisionReversal, (e) => e.type === "question.asked"),
  );
  const seq = base.cursor + 1;

  it("halts on an unsupported schema version and ignores everything after", () => {
    const newer = {
      ...next(base, { type: "agent.revoked", actor: SYNTH_OWNER, data: { agentId: UPLOAD.birch } }),
      v: 2,
    };
    const halted = foldEvent(base, newer);
    expect(halted.stream).toEqual({
      kind: "halted",
      fault: { kind: "unsupported_version", seq, version: 2 },
    });
    expect(halted.cursor).toBe(base.cursor);
    expect(halted.agents).toBe(base.agents);
    expect(foldEvents(halted, decisionReversal.events.slice(base.cursor))).toBe(halted);
  });

  it("halts on an event that fails validation", () => {
    const halted = append(base, push(UPLOAD.atlas, UPLOAD.atlasClaim, null, "not-a-commit"));
    expect(halted.stream).toEqual({
      kind: "halted",
      fault: { kind: "invalid_event", seq, message: "to is not a commit id" },
    });
    expect(halted.claims).toBe(base.claims);
  });

  it("halts on an event from another repository", () => {
    const foreign = {
      ...next(base, push(UPLOAD.atlas, UPLOAD.atlasClaim, null, synthCommit(9))),
      repo: "rep_otherrepo",
    };
    expect(foldEvent(base, foreign).stream).toEqual({
      kind: "halted",
      fault: { kind: "foreign_repo", seq },
    });
  });

  it.each<[string, SyntheticStep, string]>([
    [
      "an inbox item never queued",
      {
        type: "inbox.delivered",
        actor: SYNTH_TRAIN,
        data: { agentId: UPLOAD.atlas, claimId: UPLOAD.atlasClaim, item: 9 },
      },
      `inbox item ${inboxKey(UPLOAD.atlas, 9)} was never recorded`,
    ],
    [
      "a decision version that skips one",
      {
        type: "decision.recorded",
        actor: SYNTH_OWNER,
        data: {
          decisionId: UPLOAD.decision,
          version: 2,
          questionId: UPLOAD.question,
          option: "chunk",
          supersedes: 1,
          scope: ["src"],
        },
      },
      `decision ${UPLOAD.decision} recorded version 2 after 0`,
    ],
    [
      "a decision for an option the question does not offer",
      {
        type: "decision.recorded",
        actor: SYNTH_OWNER,
        data: {
          decisionId: UPLOAD.decision,
          version: 1,
          questionId: UPLOAD.question,
          option: "ignore",
          supersedes: null,
          scope: ["src"],
        },
      },
      `question ${UPLOAD.question} offers no option ignore`,
    ],
    [
      "a push at a stale generation",
      {
        type: "claim.pushed",
        actor: synthAgent(UPLOAD.atlas),
        data: {
          claimId: UPLOAD.atlasClaim,
          generation: 2,
          ref: "refs/heads/work",
          from: null,
          to: synthCommit(9),
        },
      },
      `claim ${UPLOAD.atlasClaim} is at generation 1, not 2`,
    ],
    [
      "an outcome for an intent never recorded",
      moveMain("int_synthnone", "updated", synthCommit(9)),
      "intent int_synthnone was never recorded",
    ],
  ])("halts on %s", (_, step, message) => {
    const halted = append(base, step);
    expect(halted.stream).toEqual({
      kind: "halted",
      fault: { kind: "inconsistent", seq, message },
    });
    expect(halted.cursor).toBe(base.cursor);
  });

  it("halts when a train update lands a commit other than the candidate", () => {
    const pending = through(
      decisionReversal,
      seqWhere(decisionReversal, isMain("int_synth01")) - 1,
    );
    const halted = append(pending, moveMain("int_synth01", "updated", synthCommit(9)));
    expect(halted.stream.kind).toBe("halted");
    expect(atlasAdapted(halted)).toBe(false);
  });
});

describe("a ready claim that loses a redo conflict", () => {
  const conflicted = syntheticLog("Synthetic redo conflict between two ready claims", [
    ...uploadPrelude(),
    ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), []),
    push(UPLOAD.birch, UPLOAD.birchClaim, null, synthCommit(2)),
    ready(UPLOAD.birch, UPLOAD.birchClaim, synthCommit(2), []),
    {
      type: "train.conflict",
      actor: SYNTH_TRAIN,
      data: {
        claims: [UPLOAD.atlasClaim, UPLOAD.birchClaim],
        path: "src/uploads/limits.ts",
        class: "compatible",
        probability: 0.8,
        route: "redo",
      },
    },
    ...inbox(
      UPLOAD.birch,
      UPLOAD.birchClaim,
      1,
      { kind: "conflict", otherClaimId: UPLOAD.atlasClaim, path: "src/uploads/limits.ts" },
      "acknowledged",
    ),
  ]);
  const before = fold(conflicted.events);

  it("takes the redo push, then becomes ready again at the new head", () => {
    expect(birch(before)?.phase).toBe("ready");
    const pushed = append(
      before,
      push(UPLOAD.birch, UPLOAD.birchClaim, synthCommit(2), synthCommit(3)),
    );
    expect(pushed.stream).toEqual({ kind: "consistent" });
    expect(birch(pushed)).toMatchObject({ phase: "working", head: synthCommit(3), ready: null });

    const readyAgain = append(pushed, ready(UPLOAD.birch, UPLOAD.birchClaim, synthCommit(3), []));
    expect(readyAgain.stream).toEqual({ kind: "consistent" });
    expect(readyAgain.cursor).toBe(before.cursor + 2);
    expect(birch(readyAgain)).toMatchObject({
      phase: "ready",
      head: synthCommit(3),
      ready: { commit: synthCommit(3), decisions: [] },
    });
    expect(readyAgain.claims[UPLOAD.atlasClaim]?.phase).toBe("ready");
  });

  it("halts on a second ready without a push in between", () => {
    const halted = append(before, ready(UPLOAD.birch, UPLOAD.birchClaim, synthCommit(3), []));
    expect(halted.stream).toEqual({
      kind: "halted",
      fault: {
        kind: "inconsistent",
        seq: before.cursor + 1,
        message: `claim ${UPLOAD.birchClaim} cannot become ready while ready`,
      },
    });
  });

  it("halts on a push once the claim has expired", () => {
    const expired = append(before, {
      type: "claim.expired",
      actor: SYNTH_TRAIN,
      data: { claimId: UPLOAD.birchClaim, generation: 1 },
    });
    const halted = append(
      expired,
      push(UPLOAD.birch, UPLOAD.birchClaim, synthCommit(2), synthCommit(3)),
    );
    expect(halted.stream).toEqual({
      kind: "halted",
      fault: {
        kind: "inconsistent",
        seq: expired.cursor + 1,
        message: `claim ${UPLOAD.birchClaim} cannot take a push while expired`,
      },
    });
    expect(birch(halted)?.head).toBe(synthCommit(2));
  });
});

describe("a ready claim whose decision is superseded", () => {
  const superseded = syntheticLog("Synthetic reopen of a ready claim", [
    ...uploadPrelude(),
    decide(1, "reject"),
    ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), [sizeDecision(1)]),
    decide(2, "chunk"),
  ]);
  const before = fold(superseded.events);

  it("returns the claim to working with no pin, then lets it become ready at the new version", () => {
    expect(atlas(before)?.phase).toBe("ready");
    const reopened = append(before, reopen());
    expect(reopened.stream).toEqual({ kind: "consistent" });
    expect(atlas(reopened)).toMatchObject({ phase: "working", head: synthCommit(1), ready: null });

    const readyAgain = append(
      append(reopened, push(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), synthCommit(2))),
      ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(2), [sizeDecision(2)]),
    );
    expect(readyAgain.stream).toEqual({ kind: "consistent" });
    expect(atlas(readyAgain)).toMatchObject({
      phase: "ready",
      ready: { commit: synthCommit(2), decisions: [sizeDecision(2)] },
    });
  });

  it("folds what the backend records for ready, a refused late push and the reopen", () => {
    // A push refused after ready, or granted before it and landing after, records no
    // `claim.pushed`; a repeated `ready` of the moved head records an `after_ready` refusal.
    const steps: SyntheticStep[] = [
      {
        type: "claim.refused",
        actor: SYNTH_TRAIN,
        data: { claimId: UPLOAD.atlasClaim, generation: 1, reason: "after_ready" },
      },
      reopen(),
      push(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), synthCommit(2)),
      ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(2), [sizeDecision(2)]),
    ];
    let state = before;
    for (const step of steps) {
      state = append(state, step);
      expect([step.type, state.stream]).toEqual([step.type, { kind: "consistent" }]);
    }
    expect(atlas(state)).toMatchObject({
      phase: "ready",
      refusal: { generation: 1, reason: "after_ready" },
      ready: { commit: synthCommit(2), decisions: [sizeDecision(2)] },
    });
  });

  it("halts on a reopen of a claim that is not ready", () => {
    const reopened = append(before, reopen());
    const halted = append(reopened, reopen());
    expect(halted.stream).toEqual({
      kind: "halted",
      fault: {
        kind: "inconsistent",
        seq: reopened.cursor + 1,
        message: `claim ${UPLOAD.atlasClaim} cannot reopen while working`,
      },
    });
  });

  it("halts on a reopen naming a decision version never recorded", () => {
    const halted = append(before, reopen([sizeDecision(3)]));
    expect(halted.stream.kind).toBe("halted");
    expect(atlas(halted)?.phase).toBe("ready");
  });
});

describe("inbox delivery states", () => {
  const queued = seqWhere(decisionReversal, (e) => e.type === "inbox.queued" && e.data.item === 2);

  it("keeps queued, delivered and acknowledged apart", () => {
    expect(atlasItem(through(decisionReversal, queued), 2)?.delivery).toBe("queued");
    const delivered = seqWhere(
      decisionReversal,
      (e) => e.type === "inbox.delivered" && e.data.item === 2,
    );
    expect(atlasItem(through(decisionReversal, delivered), 2)?.delivery).toBe("delivered");
    const acked = seqWhere(decisionReversal, (e) => e.type === "inbox.acked" && e.data.item === 2);
    expect(atlasItem(through(decisionReversal, acked), 2)).toMatchObject({
      delivery: "acknowledged",
      plan: "Synthetic plan: chunk.",
    });
  });

  it("never moves an acknowledged item back on redelivery", () => {
    const state = fold(decisionReversal.events);
    const redelivered = append(state, {
      type: "inbox.delivered",
      actor: SYNTH_TRAIN,
      data: { agentId: UPLOAD.atlas, claimId: UPLOAD.atlasClaim, item: 2 },
    });
    expect(atlasItem(redelivered, 2)?.delivery).toBe("acknowledged");
    expect(redelivered.cursor).toBe(state.cursor + 1);
  });

  it("refuses a delivery naming another claim", () => {
    const state = through(decisionReversal, queued);
    const halted = append(state, {
      type: "inbox.delivered",
      actor: SYNTH_TRAIN,
      data: { agentId: UPLOAD.atlas, claimId: UPLOAD.birchClaim, item: 2 },
    });
    expect(halted.stream.kind).toBe("halted");
    expect(atlasItem(halted, 2)?.delivery).toBe("queued");
  });
});

describe("decision ripple and adaptation through a reversal", () => {
  it("shows acknowledgement without adaptation before the work lands", () => {
    const state = after(decisionReversal, isCheck("chk_synth01"));
    expect(ripple(state)).toEqual([
      {
        agentId: UPLOAD.atlas,
        claimId: UPLOAD.atlasClaim,
        delivery: "acknowledged",
        adapted: false,
      },
      {
        agentId: UPLOAD.birch,
        claimId: UPLOAD.birchClaim,
        delivery: "acknowledged",
        adapted: false,
      },
    ]);
  });

  it("marks the claim adapted once its landed commit passes the current option's check", () => {
    const state = after(decisionReversal, isMain("int_synth01"));
    expect(atlasAdapted(state)).toBe(true);
    expect(state.claims[UPLOAD.atlasClaim]?.phase).toBe("landed");
    expect(isClaimAdapted(state, UPLOAD.birchClaim, UPLOAD.decision)).toBe(false);
  });

  it("removes the adapted badge as soon as the decision is superseded", () => {
    const state = after(
      decisionReversal,
      (e) => e.type === "decision.recorded" && e.data.version === 2,
    );
    expect(atlasAdapted(state)).toBe(false);
    expect(ripple(state)).toEqual([]);
  });

  it("shows each agent's least advanced item for the current version", () => {
    const state = after(decisionReversal, (e) => e.type === "inbox.acked" && e.data.item === 2);
    expect(ripple(state)).toEqual([
      { agentId: UPLOAD.atlas, claimId: UPLOAD.atlasClaim, delivery: "delivered", adapted: false },
      { agentId: UPLOAD.birch, claimId: UPLOAD.birchClaim, delivery: "queued", adapted: false },
    ]);
  });

  it("does not adapt on acknowledgement or a ready claim alone", () => {
    const state = after(
      decisionReversal,
      (e) => e.type === "claim.ready" && e.data.decisions[0]?.version === 2,
    );
    expect(ripple(state)[0]).toEqual({
      agentId: UPLOAD.atlas,
      claimId: UPLOAD.atlasClaim,
      delivery: "acknowledged",
      adapted: false,
    });
  });

  it("adapts the reworked claim and leaves the disconnected agent queued", () => {
    expect(ripple(fold(decisionReversal.events))).toEqual([
      {
        agentId: UPLOAD.atlas,
        claimId: UPLOAD.atlasClaim,
        delivery: "acknowledged",
        adapted: true,
      },
      { agentId: UPLOAD.birch, claimId: UPLOAD.birchClaim, delivery: "queued", adapted: false },
    ]);
  });

  it("does not count work authorised against an older version, even if the new check passes on it", () => {
    const superseded = after(
      decisionReversal,
      (e) => e.type === "decision.recorded" && e.data.version === 2,
    );
    const state = append(
      superseded,
      checkResult("chk_synth09", synthCommit(3), "accept-chunk", "pass", {
        decision: sizeDecision(2),
        option: "chunk",
      }),
    );
    expect(state.stream).toEqual({ kind: "consistent" });
    expect(atlasAdapted(state)).toBe(false);
  });

  it("returns no ripple and no adaptation for an unknown decision", () => {
    const state = fold(decisionReversal.events);
    expect(decisionRipple(state, "dec_synthnone")).toEqual([]);
    expect(isClaimAdapted(state, UPLOAD.atlasClaim, "dec_synthnone")).toBe(false);
    expect(isClaimAdapted(state, "clm_synthnone", UPLOAD.decision)).toBe(false);
  });
});

describe("acceptance checks before and after landing", () => {
  it("does not adapt on a passing check whose intent is still pending", () => {
    const state = after(
      checkBeforeLand,
      (e) => e.type === "train.intent" && e.data.intentId === "int_synth11",
    );
    expect(state.intents["int_synth11"]?.landing).toEqual({ kind: "pending" });
    expect(atlasAdapted(state)).toBe(false);
  });

  it("does not adapt when main moved first and the intent was rejected", () => {
    const state = after(checkBeforeLand, isMain("int_synth11"));
    expect(state.main).toBe(synthCommit(7));
    expect(state.intents["int_synth11"]?.landing).toEqual({
      kind: "not_landed",
      outcome: "rejected",
      main: synthCommit(7),
    });
    expect(state.claims[UPLOAD.atlasClaim]?.phase).toBe("ready");
    expect(atlasAdapted(state)).toBe(false);
  });

  it("lands on a reconciled push but waits for the check on the landed commit", () => {
    const landed = after(checkBeforeLand, isMain("int_synth12"));
    expect(landed.claims[UPLOAD.atlasClaim]?.phase).toBe("landed");
    expect(atlasAdapted(landed)).toBe(false);
    expect(atlasAdapted(fold(checkBeforeLand.events))).toBe(true);
  });

  it("does not land a reconciled intent when main is elsewhere", () => {
    const pending = through(checkBeforeLand, seqWhere(checkBeforeLand, isMain("int_synth12")) - 1);
    const state = append(pending, moveMain("int_synth12", "reconciled", synthCommit(7)));
    const final = append(
      state,
      checkResult("chk_synth13", synthCommit(8), "accept-reject", "pass", {
        decision: sizeDecision(1),
        option: "reject",
      }),
    );
    expect(final.stream).toEqual({ kind: "consistent" });
    expect(final.intents["int_synth12"]?.landing.kind).toBe("not_landed");
    expect(final.claims[UPLOAD.atlasClaim]?.phase).toBe("ready");
    expect(atlasAdapted(final)).toBe(false);
  });
});

describe("acceptance results for old and current options", () => {
  it("ignores passes for the old version and for another option, and a failed current check", () => {
    const state = after(optionResults, isCheck("chk_synth21"));
    const failed = through(optionResults, seqWhere(optionResults, isCheck("chk_synth22")) - 1);
    expect(failed.checkRuns["chk_synth21"]?.results.map((r) => r.result)).toEqual([
      "pass",
      "pass",
      "fail",
    ]);
    expect(atlasAdapted(state)).toBe(false);
    expect(atlasAdapted(failed)).toBe(false);
  });

  it("does not adapt when the current check could not run", () => {
    expect(atlasAdapted(after(optionResults, isCheck("chk_synth22")))).toBe(false);
  });

  it("does not adapt on a later pass for the old version or for another option", () => {
    expect(atlasAdapted(after(optionResults, isCheck("chk_synth27")))).toBe(false);
    expect(atlasAdapted(after(optionResults, isCheck("chk_synth28")))).toBe(false);
  });

  it("does not adapt on a pass for a commit that never landed", () => {
    expect(atlasAdapted(after(optionResults, isCheck("chk_synth23")))).toBe(false);
  });

  it("uses the latest result on the landed commit", () => {
    expect(atlasAdapted(after(optionResults, isCheck("chk_synth25")))).toBe(false);
    const state = fold(optionResults.events);
    expect(atlasAdapted(state)).toBe(true);

    const regressed = append(
      state,
      checkResult("chk_synth29", synthCommit(8), "accept-chunk", "fail", {
        decision: sizeDecision(2),
        option: "chunk",
      }),
    );
    expect(regressed.stream).toEqual({ kind: "consistent" });
    expect(atlasAdapted(regressed)).toBe(false);
  });
});

/** Folds `events` from an empty board and measures how long it took. */
const timed = (events: readonly RailheadEvent[]): { state: BoardState; ms: number } => {
  const started = performance.now();
  const state = fold(events);
  return { state, ms: performance.now() - started };
};

/** A synthetic issue id numbered `n`. */
const issueId = (n: number) => `iss_long${n.toString().padStart(6, "0")}`;

describe("folding a long log", () => {
  /**
   * The bound for 20,000 events. A fold that copied every record per event took 46 s for 20,000
   * filed issues (#179); a linear fold takes tens of milliseconds, so the bound leaves room for a slow
   * runner while still failing a quadratic fold by orders of magnitude.
   */
  const LONG_LOG_EVENTS = 20_000;
  const LONG_LOG_BUDGET_MS = 1_000;

  it(`folds ${LONG_LOG_EVENTS} filed issues within ${LONG_LOG_BUDGET_MS} ms`, () => {
    const log = syntheticLog(
      "a long run of filed issues",
      Array.from({ length: LONG_LOG_EVENTS }, (_, n): SyntheticStep => ({
        type: "issue.filed",
        actor: SYNTH_OWNER,
        data: { issueId: issueId(n), title: `Issue ${n}`, body: "" },
      })),
    );
    const { state, ms } = timed(log.events);
    expect(state.stream).toEqual({ kind: "consistent" });
    expect(state.cursor).toBe(LONG_LOG_EVENTS);
    expect(Object.keys(state.issues)).toHaveLength(LONG_LOG_EVENTS);
    expect(state.issues[issueId(LONG_LOG_EVENTS - 1)]?.title).toBe(`Issue ${LONG_LOG_EVENTS - 1}`);
    expect(ms).toBeLessThan(LONG_LOG_BUDGET_MS);
  });

  it(`folds ${LONG_LOG_EVENTS} results of one check run in order within ${LONG_LOG_BUDGET_MS} ms`, () => {
    const log = syntheticLog(
      "a check run with many results",
      Array.from({ length: LONG_LOG_EVENTS }, (_, n) =>
        checkResult("chk_longrun", synthCommit(1), `check ${n}`, "pass"),
      ),
    );
    const { state, ms } = timed(log.events);
    const results = state.checkRuns["chk_longrun"]?.results ?? [];
    expect(results).toHaveLength(LONG_LOG_EVENTS);
    expect(results.map((entry) => entry.seq)).toEqual(log.events.map((event) => event.seq));
    expect(ms).toBeLessThan(LONG_LOG_BUDGET_MS);
  });

  it("produces the same board in one batch as one event at a time", () => {
    for (const log of [decisionReversal, checkBeforeLand, optionResults]) {
      const stepwise = log.events.reduce(foldEvent, emptyBoardState(SYNTH_REPO));
      expect(fold(log.events)).toEqual(stepwise);
    }
  });

  it("leaves the board it started from unchanged", () => {
    for (let cut = 1; cut < last(decisionReversal); cut += 1) {
      const before = through(decisionReversal, cut);
      const snapshot = structuredClone(before);
      const folded = foldEvents(before, decisionReversal.events.slice(cut));
      expect(folded.cursor).toBe(last(decisionReversal));
      expect(before).toEqual(snapshot);
    }
  });

  it("returns the board itself for an empty batch", () => {
    const state = through(decisionReversal, 10);
    expect(foldEvents(state, [])).toBe(state);
  });

  it("keeps a halted batch's earlier writes and none of the halting event's", () => {
    const run = "chk_haltrun";
    const log = syntheticLog("a check run that changes its candidate", [
      {
        type: "issue.filed",
        actor: SYNTH_OWNER,
        data: { issueId: issueId(1), title: "One", body: "" },
      },
      checkResult(run, synthCommit(1), "first", "pass"),
      checkResult(run, synthCommit(1), "second", "fail"),
      checkResult(run, synthCommit(2), "moved", "pass"),
      {
        type: "issue.filed",
        actor: SYNTH_OWNER,
        data: { issueId: issueId(2), title: "Two", body: "" },
      },
    ]);
    const halted = fold(log.events);
    expect(halted.stream).toEqual({
      kind: "halted",
      fault: { kind: "inconsistent", seq: 4, message: `check run ${run} changed its candidate` },
    });
    expect(halted.cursor).toBe(3);
    expect(halted.checkRuns[run]?.results.map((entry) => entry.check)).toEqual(["first", "second"]);
    expect(Object.keys(halted.issues)).toEqual([issueId(1)]);
    expect({ ...halted, stream: null }).toEqual({ ...fold(log.events.slice(0, 3)), stream: null });
  });
});
