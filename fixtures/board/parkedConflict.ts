// SYNTHETIC. See syntheticLog.ts.

import type { ClaimId } from "../../packages/railhead-shared/src/events";
import { SYNTH_TRAIN, syntheticLog, synthCommit, type SyntheticStep } from "./syntheticLog";
import { UPLOAD, push, ready, uploadPrelude } from "./uploadSteps";

/** The decision the train opens for the conflict. */
export const CONFLICT = {
  question: "qst_synthconflict",
  decision: "dec_synthconflict",
  path: "src/uploads/limits.ts",
} as const;

/** Atlas and birch both ready, and the train finding that their changes to one file contradict. */
export const parkedPair = (): SyntheticStep[] => [
  ...uploadPrelude(),
  ready(UPLOAD.atlas, UPLOAD.atlasClaim, synthCommit(1), []),
  push(UPLOAD.birch, UPLOAD.birchClaim, null, synthCommit(2)),
  ready(UPLOAD.birch, UPLOAD.birchClaim, synthCommit(2), []),
  {
    type: "train.conflict",
    actor: SYNTH_TRAIN,
    data: {
      claims: [UPLOAD.atlasClaim, UPLOAD.birchClaim],
      path: CONFLICT.path,
      class: "contradictory",
      probability: 0.97,
      route: "question",
    },
  },
];

/** The train's question about the pair, naming `claimIds`, or none as an older event does. */
export const conflictQuestion = (claimIds: ClaimId[] | null): SyntheticStep => ({
  type: "question.asked",
  actor: SYNTH_TRAIN,
  data: {
    questionId: CONFLICT.question,
    claimId: UPLOAD.atlasClaim,
    ...(claimIds === null ? {} : { claimIds }),
    decisionId: CONFLICT.decision,
    text:
      `Claims ${UPLOAD.atlasClaim} and ${UPLOAD.birchClaim} both changed ${CONFLICT.path}, and ` +
      "their changes cannot be merged together. Which change should main keep?",
    options: [
      { key: "keep_first", label: `Keep the change from ${UPLOAD.atlasClaim}` },
      { key: "keep_second", label: `Keep the change from ${UPLOAD.birchClaim}` },
    ],
  },
});

/** The train parked the pair and asked the owner which change main keeps; nobody has answered. */
export const parkedConflict = syntheticLog("Synthetic train conflict waiting for the owner", [
  ...parkedPair(),
  conflictQuestion([UPLOAD.atlasClaim, UPLOAD.birchClaim]),
]);
