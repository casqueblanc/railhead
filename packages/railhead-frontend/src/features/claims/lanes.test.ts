import { describe, expect, it } from "vitest";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import {
  SYNTH_REPO,
  SYNTH_TRAIN,
  seqWhere,
  synthCommit,
  syntheticLog,
  type SyntheticStep,
} from "../../../../../fixtures/board/syntheticLog";
import {
  UPLOAD,
  decide,
  enrol,
  inbox,
  push,
  ready,
  sizeDecision,
  uploadPrelude,
} from "../../../../../fixtures/board/uploadSteps";
import { emptyBoardState, foldEvents, inboxKey, type BoardState } from "../board/boardState";
import { claimLanes, type ClaimLane } from "./lanes";

const fold = (steps: readonly SyntheticStep[]): BoardState => {
  const state = foldEvents(
    emptyBoardState(SYNTH_REPO),
    syntheticLog("Synthetic lanes", steps).events,
  );
  // A fixture that the fold refuses would make every assertion below vacuous.
  expect(state.stream).toEqual({ kind: "consistent" });
  return state;
};

const lane = (lanes: readonly ClaimLane[], claimId: string): ClaimLane => {
  const found = lanes.find((candidate) => candidate.claimId === claimId);
  if (found === undefined) throw new Error(`no lane for ${claimId}`);
  return found;
};

describe("claimLanes over the decision reversal", () => {
  it("puts the lane waiting on a question ahead of a working one", () => {
    const asked = seqWhere(decisionReversal, (e) => e.type === "question.asked");
    const state = foldEvents(emptyBoardState(SYNTH_REPO), decisionReversal.events.slice(0, asked));
    const lanes = claimLanes(state);

    expect(lanes.map((l) => [l.claimId, l.status])).toEqual([
      [UPLOAD.atlasClaim, { kind: "waiting_on_decision", questions: [UPLOAD.question] }],
      [UPLOAD.birchClaim, { kind: "working" }],
    ]);
    const atlas = lane(lanes, UPLOAD.atlasClaim);
    expect(atlas).toMatchObject({
      issueTitle: "Accept large uploads",
      agentName: "atlas",
      agentStatus: "confirmed",
      generation: 1,
      head: synthCommit(1),
      staleRefusal: null,
      inbox: [],
      landings: 0,
    });
    expect(lane(lanes, UPLOAD.birchClaim).head).toBeNull();
  });

  it("shows the refused lane first with the decision it has not acknowledged", () => {
    const lanes = claimLanes(foldEvents(emptyBoardState(SYNTH_REPO), decisionReversal.events));

    expect(lanes.map((l) => l.claimId)).toEqual([UPLOAD.birchClaim, UPLOAD.atlasClaim]);
    const birch = lane(lanes, UPLOAD.birchClaim);
    expect(birch.status).toEqual({ kind: "refused", reason: "unacked_decision" });
    expect(birch.inbox).toEqual([
      { key: inboxKey(UPLOAD.birch, 2), kind: "decision", decision: sizeDecision(2) },
    ]);

    const atlas = lane(lanes, UPLOAD.atlasClaim);
    expect(atlas.status).toEqual({ kind: "landed" });
    expect(atlas.inbox).toEqual([]);
    expect(atlas.landings).toBe(2);
    expect(atlas.pushes.map((p) => p.to)).toEqual([synthCommit(4), synthCommit(2), synthCommit(1)]);
  });
});

describe("claimLanes at the edges", () => {
  it("returns no lanes for a board without claims", () => {
    expect(claimLanes(emptyBoardState(SYNTH_REPO))).toEqual([]);
  });

  it("shows a ready lane's pinned commit and the decisions it relied on", () => {
    const state = fold([
      ...uploadPrelude(),
      decide(1, "chunk"),
      ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), [sizeDecision(1)]),
    ]);
    expect(lane(claimLanes(state), UPLOAD.atlasClaim).status).toEqual({
      kind: "ready",
      commit: synthCommit(1),
      decisions: [sizeDecision(1)],
    });
  });

  it("keeps a refusal against an older generation as history, not as a block", () => {
    const state = fold([
      ...uploadPrelude(),
      ...enrol("agt_synthcedar", "cedar", "inv_synthcedar"),
      {
        type: "claim.refused",
        actor: SYNTH_TRAIN,
        data: { claimId: UPLOAD.birchClaim, generation: 1, reason: "after_ready" },
      },
      {
        type: "claim.reassigned",
        actor: SYNTH_TRAIN,
        data: {
          claimId: UPLOAD.birchClaim,
          from: UPLOAD.birch,
          to: "agt_synthcedar",
          generation: 2,
        },
      },
    ]);
    const birch = lane(claimLanes(state), UPLOAD.birchClaim);
    expect(birch.status).toEqual({ kind: "working" });
    expect(birch.agentName).toBe("cedar");
    expect(birch.generation).toBe(2);
    expect(birch.staleRefusal).toEqual({ generation: 1, reason: "after_ready" });
  });

  it("names the other claim's issue for a conflict waiting on the agent", () => {
    const state = fold([
      ...uploadPrelude(),
      push(UPLOAD.birch, UPLOAD.birchClaim, null, synthCommit(2)),
      ...inbox(
        UPLOAD.birch,
        UPLOAD.birchClaim,
        1,
        { kind: "conflict", otherClaimId: UPLOAD.atlasClaim, path: "src/uploads/limits.ts" },
        "delivered",
      ),
    ]);
    expect(lane(claimLanes(state), UPLOAD.birchClaim).inbox).toEqual([
      {
        key: inboxKey(UPLOAD.birch, 1),
        kind: "conflict",
        otherClaimId: UPLOAD.atlasClaim,
        otherIssueTitle: "Accept large uploads",
        path: "src/uploads/limits.ts",
      },
    ]);
  });

  it("lists an expired claim last and does not report it as refused", () => {
    const state = fold([
      ...uploadPrelude(),
      {
        type: "claim.refused",
        actor: SYNTH_TRAIN,
        data: { claimId: UPLOAD.birchClaim, generation: 1, reason: "stale_generation" },
      },
      {
        type: "claim.expired",
        actor: SYNTH_TRAIN,
        data: { claimId: UPLOAD.birchClaim, generation: 1 },
      },
    ]);
    const lanes = claimLanes(state);
    expect(lanes.at(-1)?.claimId).toBe(UPLOAD.birchClaim);
    expect(lane(lanes, UPLOAD.birchClaim).status).toEqual({ kind: "expired" });
  });
});
