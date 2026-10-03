// SYNTHETIC. See syntheticLog.ts.

import { syntheticLog, synthCommit } from "./syntheticLog";
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
 * One batch lands atlas and birch together. Birch marked ready before the owner decided, so its
 * work depends on no decision; the decision then reaches its inbox while it is offline. Atlas
 * acknowledges the decision and marks ready against it. The intent's combined decisions name the
 * decision for the whole batch, while the backend records atlas alone as adapted.
 */
export const mixedBatch = syntheticLog("Synthetic two-claim batch with mixed dependencies", [
  ...uploadPrelude(),
  push(UPLOAD.birch, UPLOAD.birchClaim, null, synthCommit(6)),
  ready(UPLOAD.birch, UPLOAD.birchClaim, synthCommit(6), []),
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
    "queued",
  ),
  ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), [sizeDecision(1)]),
  checkResult("chk_synth30", synthCommit(3), "accept-reject", "pass", {
    decision: sizeDecision(1),
    option: "reject",
  }),
  intend(
    "int_synth30",
    UPLOAD_BASE,
    synthCommit(3),
    [UPLOAD.atlasClaim, UPLOAD.birchClaim],
    [sizeDecision(1)],
    "chk_synth30",
  ),
  moveMain("int_synth30", "updated", synthCommit(3)),
  adapt(UPLOAD.atlasClaim, "int_synth30", sizeDecision(1)),
]);
