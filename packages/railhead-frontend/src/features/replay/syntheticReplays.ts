// SYNTHETIC. Replays built from the hand-written board fixtures, for development only. Each one is
// labelled `synthetic` in its source, so the replay page shows it as a synthetic log and never as a
// captured run. The replay route loads this module only in a development build.

import { checkBeforeLand } from "../../../../../fixtures/board/checkBeforeLand";
import { decisionReversal } from "../../../../../fixtures/board/decisionReversal";
import { optionResults } from "../../../../../fixtures/board/optionResults";
import type { SyntheticLog } from "../../../../../fixtures/board/syntheticLog";
import { CAPTURE_FORMAT, CAPTURE_VERSION, type Capture } from "./captureFile";

/** A synthetic fixture as a capture whose source says it is synthetic. */
export const syntheticCapture = (log: SyntheticLog): Capture => {
  const first = log.events[0];
  if (first === undefined) throw new Error(`synthetic log "${log.description}" is empty`);
  return {
    format: CAPTURE_FORMAT,
    version: CAPTURE_VERSION,
    source: { kind: "synthetic", description: log.description },
    repo: first.repo,
    head: log.events.length,
    events: [...log.events],
  };
};

/** The synthetic replays a development build offers. */
export const SYNTHETIC_REPLAYS: readonly Capture[] = [
  decisionReversal,
  checkBeforeLand,
  optionResults,
].map(syntheticCapture);
