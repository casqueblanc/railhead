import { describe, expect, it } from "vitest";
import type { RailheadEvent } from "@railhead/shared/events";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import {
  SYNTH_REPO,
  SYNTH_TRAIN,
  seqWhere,
  synthAgent,
  syntheticLog,
  type SyntheticStep,
} from "../../../../../fixtures/board/syntheticLog";
import { UPLOAD, decide, uploadPrelude } from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents, type BoardState } from "../board/boardState";
import { decisionQueue } from "./decisionQueue";

const fold = (events: readonly RailheadEvent[]): BoardState =>
  foldEvents(emptyBoardState(SYNTH_REPO), events);

const ask = (
  agentId: string,
  claimId: string,
  questionId: string,
  decisionId: string,
): SyntheticStep => ({
  type: "question.asked",
  actor: synthAgent(agentId),
  data: {
    questionId,
    claimId,
    decisionId,
    text: `Synthetic question ${questionId}`,
    options: [
      { key: "yes", label: "Yes" },
      { key: "no", label: "No" },
    ],
  },
});

const isDecision = (version: number) => (event: RailheadEvent) =>
  event.type === "decision.recorded" && event.data.version === version;

describe("decisionQueue", () => {
  it("lists a decided decision with its history, newest first, and its ripple", () => {
    const queue = decisionQueue(fold(decisionReversal.events));

    expect(queue.open).toEqual([]);
    expect(queue.decided).toHaveLength(1);
    const [view] = queue.decided;
    expect(view?.decisionId).toBe(UPLOAD.decision);
    expect(view?.versions).toEqual([
      { version: 2, option: "chunk", label: "Upload them in chunks", scope: ["src/uploads"] },
      { version: 1, option: "reject", label: "Reject them", scope: ["src/uploads"] },
    ]);
    expect(view?.affectedClaims).toEqual([UPLOAD.atlasClaim, UPLOAD.birchClaim]);
    expect(view?.ripple).toEqual([
      {
        agentId: UPLOAD.atlas,
        claimId: UPLOAD.atlasClaim,
        delivery: "acknowledged",
        adapted: true,
      },
      { agentId: UPLOAD.birch, claimId: UPLOAD.birchClaim, delivery: "queued", adapted: false },
    ]);
  });

  it("drops the adapted indication when the decision is superseded", () => {
    const beforeReversal = fold(
      decisionReversal.events.slice(0, seqWhere(decisionReversal, isDecision(2)) - 1),
    );
    expect(decisionQueue(beforeReversal).decided[0]?.ripple).toContainEqual(
      expect.objectContaining({ agentId: UPLOAD.atlas, adapted: true }),
    );

    const reversed = fold(
      decisionReversal.events.slice(0, seqWhere(decisionReversal, isDecision(2))),
    );
    const view = decisionQueue(reversed).decided[0];
    expect(view?.versions[0]?.version).toBe(2);
    // No item for version 2 has been queued yet, so no agent shows any progress on it.
    expect(view?.ripple).toEqual([]);
  });

  it("puts unanswered decisions first, ordered by affected claims, ties in asked order", () => {
    const log = syntheticLog("Synthetic queue ordering", [
      ...uploadPrelude(),
      ask(UPLOAD.birch, UPLOAD.birchClaim, "qst_synthfirst", "dec_synthfirst"),
      ask(UPLOAD.atlas, UPLOAD.atlasClaim, "qst_synthsecond", "dec_synthsecond"),
      // Birch asks the upload question too, so that decision now holds up two claims.
      ask(UPLOAD.birch, UPLOAD.birchClaim, "qst_synthsizetwo", UPLOAD.decision),
      ask(UPLOAD.atlas, UPLOAD.atlasClaim, "qst_synthanswered", "dec_synthanswered"),
      {
        type: "decision.recorded",
        actor: { kind: "human", id: "usr_synthowner" },
        data: {
          decisionId: "dec_synthanswered",
          version: 1,
          questionId: "qst_synthanswered",
          option: "yes",
          supersedes: null,
          scope: ["src/synth"],
        },
      },
    ]);
    const state = fold(log.events);
    expect(state.stream).toEqual({ kind: "consistent" });
    const queue = decisionQueue(state);

    expect(queue.open.map((view) => view.decisionId)).toEqual([
      UPLOAD.decision,
      "dec_synthfirst",
      "dec_synthsecond",
    ]);
    expect(queue.open[0]?.questions.map((question) => question.questionId)).toEqual([
      UPLOAD.question,
      "qst_synthsizetwo",
    ]);
    expect(queue.open[0]?.affectedClaims).toEqual([UPLOAD.atlasClaim, UPLOAD.birchClaim]);
    expect(queue.decided.map((view) => view.decisionId)).toEqual(["dec_synthanswered"]);
    expect(queue.decided[0]?.ripple).toEqual([]);
  });

  it("returns an empty queue for a board without questions", () => {
    expect(decisionQueue(emptyBoardState(SYNTH_REPO))).toEqual({ open: [], decided: [] });
    expect(decisionQueue(fold(syntheticLog("Synthetic prelude", uploadPrelude()).events))).toEqual(
      expect.objectContaining({ decided: [] }),
    );
  });

  it("stops counting a claim once it expires", () => {
    const log = syntheticLog("Synthetic expired asker", [
      ...uploadPrelude(),
      decide(1, "reject"),
      {
        type: "claim.expired",
        actor: SYNTH_TRAIN,
        data: { claimId: UPLOAD.atlasClaim, generation: 1 },
      },
    ]);
    const view = decisionQueue(fold(log.events)).decided[0];
    expect(view?.decisionId).toBe(UPLOAD.decision);
    expect(view?.affectedClaims).toEqual([]);
  });
});
