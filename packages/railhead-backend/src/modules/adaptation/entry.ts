// Adaptation: whether landed work follows the current version of a decision. The implementation is
// `createAdaptation` in `src/train/adaptation/`; the train calls `owe` and `recordLanding` when a batch lands, and the Repo's alarm retries pending
// landings through `resume`.

import type { ModuleFactory } from "../../repo/composeRepo";
import { createAdaptation, type AdaptationPort } from "../../train/adaptation/adaptation";

export type { AdaptationPort } from "../../train/adaptation/adaptation";

/** Builds the adaptation module of one repository. */
export const adaptation: ModuleFactory<AdaptationPort> = (context, ports) =>
  createAdaptation({
    storage: context.storage,
    clock: context.clock,
    wake: context.wake,
    readers: () => {
      const { authorization, decisions, train } = ports();
      return {
        intent: (intentId) => authorization.record(intentId),
        attemptOutcome: (attemptId) => train.attemptOutcome(attemptId),
        currentVersions: (claimId) => decisions.currentVersions(claimId),
        currentDecision: (decisionId) => decisions.currentDecision(decisionId),
      };
    },
  });
