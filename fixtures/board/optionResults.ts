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
  push,
  ready,
  sizeDecision,
  uploadPrelude,
} from "./uploadSteps";

/**
 * Acceptance results that must not count. The decision moves from reject to chunk and atlas lands
 * commit 5 against version 2. On that landed commit the old version's reject check passes, the
 * current version's reject check passes, and the current chunk check fails and then errors; later
 * runs pass the chunk check for version 1 and the reject check for version 2. The chunk check
 * also passes on commit 6, which never lands. Atlas then lands commit 8, whose chunk
 * check fails once and passes on a re-run.
 */
export const optionResults = syntheticLog(
  "Synthetic acceptance results for old and current options",
  [
    ...uploadPrelude(),
    decide(1, "reject"),
    decide(2, "chunk"),
    ...inbox(
      UPLOAD.atlas,
      UPLOAD.atlasClaim,
      1,
      { kind: "decision", decision: sizeDecision(2) },
      "acknowledged",
    ),
    push(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), synthCommit(4)),
    ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(4), [sizeDecision(2)]),
    checkResult("chk_synth20", synthCommit(5), "test", "pass"),
    intend(
      "int_synth20",
      UPLOAD_BASE,
      synthCommit(5),
      [UPLOAD.atlasClaim],
      [sizeDecision(2)],
      "chk_synth20",
    ),
    moveMain("int_synth20", "updated", synthCommit(5)),
    checkResult("chk_synth21", synthCommit(5), "accept-reject", "pass", {
      decision: sizeDecision(1),
      option: "reject",
    }),
    checkResult("chk_synth21", synthCommit(5), "accept-reject", "pass", {
      decision: sizeDecision(2),
      option: "reject",
    }),
    checkResult("chk_synth21", synthCommit(5), "accept-chunk", "fail", {
      decision: sizeDecision(2),
      option: "chunk",
    }),
    checkResult("chk_synth22", synthCommit(5), "accept-chunk", "error", {
      decision: sizeDecision(2),
      option: "chunk",
    }),
    checkResult("chk_synth27", synthCommit(5), "accept-chunk", "pass", {
      decision: sizeDecision(1),
      option: "chunk",
    }),
    checkResult("chk_synth28", synthCommit(5), "accept-reject", "pass", {
      decision: sizeDecision(2),
      option: "reject",
    }),
    checkResult("chk_synth23", synthCommit(6), "accept-chunk", "pass", {
      decision: sizeDecision(2),
      option: "chunk",
    }),
    push(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(4), synthCommit(7)),
    ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(7), [sizeDecision(2)]),
    checkResult("chk_synth24", synthCommit(8), "test", "pass"),
    intend(
      "int_synth24",
      synthCommit(5),
      synthCommit(8),
      [UPLOAD.atlasClaim],
      [sizeDecision(2)],
      "chk_synth24",
    ),
    moveMain("int_synth24", "updated", synthCommit(8)),
    checkResult("chk_synth25", synthCommit(8), "accept-chunk", "fail", {
      decision: sizeDecision(2),
      option: "chunk",
    }),
    checkResult("chk_synth26", synthCommit(8), "accept-chunk", "pass", {
      decision: sizeDecision(2),
      option: "chunk",
    }),
  ],
);
