// SYNTHETIC. See syntheticLog.ts.

import { SYNTH_TRAIN, syntheticLog, synthCommit } from "./syntheticLog";
import {
  UPLOAD,
  UPLOAD_BASE,
  adapt,
  checkResult,
  decide,
  inbox,
  intend,
  moveMain,
  push,
  ready,
  sizeDecision,
  uploadPrelude,
} from "./uploadSteps";

/**
 * The demo's decision reversal. The owner answers "reject"; both agents acknowledge, and atlas's
 * work lands with the reject acceptance check passing, so the backend records it adapted. The owner
 * then supersedes the decision with "chunk". Atlas receives the new version and a rework item,
 * acknowledges both, reworks and lands with the chunk acceptance check passing, and is recorded
 * adapted again. Birch stays disconnected: its new item remains queued and its `ready` is refused.
 */
export const decisionReversal = syntheticLog("Synthetic decision reversal, reject then chunk", [
  ...uploadPrelude(),
  decide(1, "reject"),
  ...inbox(
    UPLOAD.atlas,
    UPLOAD.atlasClaim,
    1,
    { kind: "decision", decision: sizeDecision(1) },
    "acknowledged",
  ),
  ...inbox(
    UPLOAD.birch,
    UPLOAD.birchClaim,
    1,
    { kind: "decision", decision: sizeDecision(1) },
    "acknowledged",
  ),
  push(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), synthCommit(2)),
  ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(2), [sizeDecision(1)]),
  checkResult("chk_synth01", synthCommit(3), "test", "pass"),
  checkResult("chk_synth01", synthCommit(3), "accept-reject", "pass", {
    decision: sizeDecision(1),
    option: "reject",
  }),
  intend(
    "int_synth01",
    UPLOAD_BASE,
    synthCommit(3),
    [UPLOAD.atlasClaim],
    [sizeDecision(1)],
    "chk_synth01",
  ),
  moveMain("int_synth01", "updated", synthCommit(3)),
  adapt(UPLOAD.atlasClaim, "int_synth01", sizeDecision(1)),
  decide(2, "chunk"),
  ...inbox(
    UPLOAD.atlas,
    UPLOAD.atlasClaim,
    2,
    { kind: "decision", decision: sizeDecision(2) },
    "queued",
  ),
  ...inbox(
    UPLOAD.atlas,
    UPLOAD.atlasClaim,
    3,
    { kind: "rework", decision: sizeDecision(2) },
    "queued",
  ),
  ...inbox(
    UPLOAD.birch,
    UPLOAD.birchClaim,
    2,
    { kind: "decision", decision: sizeDecision(2) },
    "queued",
  ),
  {
    type: "claim.refused",
    actor: SYNTH_TRAIN,
    data: { claimId: UPLOAD.birchClaim, generation: 1, reason: "unacked_decision" },
  },
  {
    type: "inbox.delivered",
    actor: SYNTH_TRAIN,
    data: { agentId: UPLOAD.atlas, claimId: UPLOAD.atlasClaim, item: 2 },
  },
  {
    type: "inbox.delivered",
    actor: SYNTH_TRAIN,
    data: { agentId: UPLOAD.atlas, claimId: UPLOAD.atlasClaim, item: 3 },
  },
  {
    type: "inbox.acked",
    actor: { kind: "agent", id: UPLOAD.atlas },
    data: {
      agentId: UPLOAD.atlas,
      claimId: UPLOAD.atlasClaim,
      item: 2,
      plan: "Synthetic plan: chunk.",
    },
  },
  {
    type: "inbox.acked",
    actor: { kind: "agent", id: UPLOAD.atlas },
    data: {
      agentId: UPLOAD.atlas,
      claimId: UPLOAD.atlasClaim,
      item: 3,
      plan: "Synthetic plan: redo.",
    },
  },
  push(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(2), synthCommit(4)),
  ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(4), [sizeDecision(2)]),
  checkResult("chk_synth02", synthCommit(5), "test", "pass"),
  checkResult("chk_synth02", synthCommit(5), "accept-chunk", "pass", {
    decision: sizeDecision(2),
    option: "chunk",
  }),
  intend(
    "int_synth02",
    synthCommit(3),
    synthCommit(5),
    [UPLOAD.atlasClaim],
    [sizeDecision(2)],
    "chk_synth02",
  ),
  moveMain("int_synth02", "updated", synthCommit(5)),
  adapt(UPLOAD.atlasClaim, "int_synth02", sizeDecision(2)),
]);
