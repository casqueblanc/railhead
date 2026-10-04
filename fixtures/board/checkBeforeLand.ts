// SYNTHETIC. See syntheticLog.ts.

import { syntheticLog, synthCommit } from "./syntheticLog";
import {
  UPLOAD,
  UPLOAD_BASE,
  checkResult,
  decide,
  inbox,
  intend,
  moveMain,
  merge,
  push,
  ready,
  sizeDecision,
  uploadPrelude,
} from "./uploadSteps";

/**
 * A passing acceptance check is not a landing. Atlas's candidate passes the reject acceptance check,
 * but birch's batch moves main first, so atlas's intent is rejected. The train rebuilds atlas's
 * candidate on the new main and lands it after reading main back from an uncertain push; only
 * then does the acceptance check run on the landed commit and pass.
 */
export const checkBeforeLand = syntheticLog("Synthetic acceptance check before landing", [
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
  ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), [sizeDecision(1)]),
  push(UPLOAD.birch, UPLOAD.birchClaim, null, synthCommit(6)),
  ready(UPLOAD.birch, UPLOAD.birchClaim, synthCommit(6), [sizeDecision(1)]),
  checkResult("chk_synth10", synthCommit(7), "test", "pass"),
  intend(
    "int_synth10",
    UPLOAD_BASE,
    synthCommit(7),
    [UPLOAD.birchClaim],
    [sizeDecision(1)],
    "chk_synth10",
  ),
  checkResult("chk_synth11", synthCommit(3), "test", "pass"),
  checkResult("chk_synth11", synthCommit(3), "accept-reject", "pass", {
    decision: sizeDecision(1),
    option: "reject",
  }),
  intend(
    "int_synth11",
    UPLOAD_BASE,
    synthCommit(3),
    [UPLOAD.atlasClaim],
    [sizeDecision(1)],
    "chk_synth11",
  ),
  moveMain("int_synth10", "updated", synthCommit(7)),
  merge(UPLOAD.birchClaim, synthCommit(7)),
  moveMain("int_synth11", "rejected", synthCommit(7)),
  checkResult("chk_synth12", synthCommit(8), "test", "pass"),
  intend(
    "int_synth12",
    synthCommit(7),
    synthCommit(8),
    [UPLOAD.atlasClaim],
    [sizeDecision(1)],
    "chk_synth12",
  ),
  moveMain("int_synth12", "reconciled", synthCommit(8)),
  merge(UPLOAD.atlasClaim, synthCommit(8)),
  checkResult("chk_synth13", synthCommit(8), "accept-reject", "pass", {
    decision: sizeDecision(1),
    option: "reject",
  }),
]);
