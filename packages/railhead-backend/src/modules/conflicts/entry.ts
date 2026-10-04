// Conflicts: classifying a merge conflict between two claims as an overlap the losing agent redoes
// or a disagreement a person settles, through Clef on the Worker's `AI` binding. The module holds
// no storage and no authority: it returns a verdict, and the train decides what to do with it. It
// cannot write code, resolve a conflict or move main.
//
// Each classification logs one line with its route, reason, probability and cost, so the gate's
// admission rate can be read from production without any of the conflict's text.

import type { RepoId } from "@railhead/shared/events";
import type { WorkersAi } from "@railhead/ai/clef";
import type { ModuleFactory } from "../../repo/composeRepo";
import {
  classifyConflict,
  type ConflictInput,
  type ConflictVerdict,
} from "../../train/classification/classify";

/** The conflicts module's port. */
export interface ConflictsPort {
  /**
   * Classifies a conflict between two claims. Resolves `redo` only when Clef judged every region
   * compatible at the gate with both intents present; every other outcome, including a model
   * failure or timeout, is a `question`. Never rejects.
   */
  classify(conflict: ConflictInput): Promise<ConflictVerdict>;
}

/** Builds the conflicts module of one repository, over the Worker's Workers AI binding. */
export const conflicts: ModuleFactory<ConflictsPort> = (context) =>
  createConflicts(context.repoId, context.env.AI, context.clock);

/** The conflicts port over `ai`. Tests pass a binding that replays recorded answers. */
export function createConflicts(
  repoId: RepoId,
  ai: WorkersAi,
  clock: () => number,
  timeoutMs?: number,
): ConflictsPort {
  return {
    async classify(conflict) {
      const { verdict, usage } = await classifyConflict(ai, conflict, clock, timeoutMs);
      console.info(
        JSON.stringify({
          event: "conflicts.classified",
          repo: repoId,
          route: verdict.route,
          reason: verdict.route === "question" ? verdict.reason : null,
          class: verdict.class,
          probability: verdict.probability,
          regions: conflict.regions.length,
          calls: usage.calls,
          inputTokens: usage.inputTokens,
        }),
      );
      return verdict;
    },
  };
}
