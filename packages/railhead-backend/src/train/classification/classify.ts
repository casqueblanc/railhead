// Classifying a merge conflict between two claims: a compatible overlap the losing agent can redo
// on the new base, or a disagreement a person must settle. The model only routes; it never writes
// code, resolves the conflict or touches main, and a wrong `redo` still meets every check the
// redone work must pass.
//
// The gate is the one #7 and #14 measured: Clef, never Clef-flash, with both intents present, and
// `redo` only when every region is `compatible` with probability at least `COMPATIBLE_GATE`.
// Everything else is a question: `contradictory` at any probability, `compatible` below the gate,
// an empty intent, a conflict too large to send whole, and every failure of the model, whether a
// timeout, an error or an answer that fails validation. On real Tauri conflicts the gate admitted
// about 30% of compatible conflicts, so most conflicts become questions.
//
// The question text is the one both spikes measured, unchanged: the gate is calibrated against it,
// so a new wording needs a new measurement. Each region is asked alone, as the spikes asked, with
// its file's path and both intents, and nothing else of the repository. Regions are asked in turn
// and the first that is not a redo ends the classification, so a question costs no further calls.
// Conflict text and intents are repository content and agent text: they go to the model and
// nowhere else, never into a log or an error.

import { askChoice, type ChoiceQuestion, type WorkersAi } from "@railhead/ai/clef";
import type { ConflictClass, ConflictRoute } from "@railhead/shared/events";

/** The least probability of `compatible` that sends a region to redo. */
export const COMPATIBLE_GATE = 0.9;

/** Most regions one conflict may have; a larger conflict is a question without a model call. */
export const MAX_REGIONS = 8;

/** Longest base, ours or theirs text of one region, in UTF-16 code units, as the spikes bounded it. */
export const MAX_REGION_LENGTH = 8 * 1024;

/** Longest intent, in UTF-16 code units. */
const MAX_INTENT_LENGTH = 1024;

/** Longest path, in UTF-16 code units. */
export const MAX_PATH_LENGTH = 1024;

/**
 * Longest wait for the whole classification. Each region's call gets what is left of it. Clef
 * answered within 770 ms at p95 in both spikes (measured on `wrangler dev`, not deployed), and the
 * bound stays well under the train's own limit on one port call.
 */
export const CLASSIFY_TIMEOUT_MS = 10_000;

/** One conflicted region of a file, with diff3's three versions. */
export interface ConflictRegion {
  /** The file's path in the repository. */
  readonly path: string;
  /** The region before either change. */
  readonly base: string;
  /** The region as the earlier claim, already ahead in the batch, changed it. */
  readonly ours: string;
  /** The region as the later claim, which loses the conflict, changed it. */
  readonly theirs: string;
}

/** A conflict between two claims, as the classifier sees it. Untrusted text throughout. */
export interface ConflictInput {
  /** Every conflicted region, in file order. */
  readonly regions: readonly ConflictRegion[];
  /** What the earlier claim's agent meant to do: its issue's title. */
  readonly oursIntent: string;
  /** What the later claim's agent meant to do: its issue's title. */
  readonly theirsIntent: string;
}

/** Why a conflict became a question. */
export type QuestionReason =
  /** Clef answered `contradictory`. */
  | "contradictory"
  /** Clef answered `compatible` below `COMPATIBLE_GATE`. */
  | "below_gate"
  /** An intent is empty: without both, #14 saw a disagreement pass the gate. */
  | "missing_intent"
  /** The conflict has no region. */
  | "no_regions"
  /** The conflict exceeds a size bound, so it was not sent. */
  | "too_large"
  /** Clef did not answer in time. */
  | "timeout"
  /** The Workers AI call failed. */
  | "unavailable"
  /** Clef's answer failed validation. */
  | "malformed";

/**
 * Where a conflict goes, with the class and probability `train.conflict` records. `probability` is
 * that of `class`. A conflict Clef did not classify records `contradictory` at probability 0, the
 * train's value for a conflict no model judged.
 */
export type ConflictVerdict =
  | { route: Extract<ConflictRoute, "redo">; class: "compatible"; probability: number }
  | {
      route: Extract<ConflictRoute, "question">;
      class: ConflictClass;
      probability: number;
      reason: QuestionReason;
    };

/** What a classification costs, for the caller's log. Never any of the conflict's text. */
export interface ClassificationUsage {
  /** Model calls made, including any that failed or timed out. */
  readonly calls: number;
  /** Input tokens the answered calls reported; a failed call reports none. */
  readonly inputTokens: number;
}

/** A verdict with its usage. */
export interface Classification {
  readonly verdict: ConflictVerdict;
  readonly usage: ClassificationUsage;
}

const QUESTION: ChoiceQuestion<ConflictClass> = {
  instructions:
    "Two agents changed the same region of a file and Git reported a merge conflict. `base` is the region before either change, `ours` and `theirs` are the two changed versions, and `oursIntent` and `theirsIntent` say what each agent meant to do. Decide whether both changes can be kept together or whether they disagree about how the product should behave.",
  options: [
    {
      key: "compatible",
      criterion:
        "Both changes can be kept in one merged version that fully satisfies both intents. They add or modify different things that happen to sit at the same place, and neither needs the other to be dropped or weakened.",
    },
    {
      key: "contradictory",
      criterion:
        "The two sides implement different behaviour for the same thing, so no single merged version satisfies both intents. Keeping one means dropping or overriding the other, and a person must choose.",
    },
  ],
};

/**
 * Classifies `conflict` through Clef on `ai`, waiting at most `timeoutMs` in all. Never rejects:
 * every failure is a question.
 */
export async function classifyConflict(
  ai: WorkersAi,
  conflict: ConflictInput,
  clock: () => number = Date.now,
  timeoutMs: number = CLASSIFY_TIMEOUT_MS,
): Promise<Classification> {
  const usage = { calls: 0, inputTokens: 0 };
  const oursIntent = conflict.oursIntent.trim();
  const theirsIntent = conflict.theirsIntent.trim();
  if (oursIntent === "" || theirsIntent === "") return unjudged("missing_intent", usage);
  if (conflict.regions.length === 0) return unjudged("no_regions", usage);
  if (!withinBounds(conflict)) return unjudged("too_large", usage);

  const deadline = clock() + timeoutMs;
  let least = 1;
  for (const region of conflict.regions) {
    const left = deadline - clock();
    if (left <= 0) return unjudged("timeout", usage);
    const state = {
      path: region.path,
      base: region.base,
      ours: region.ours,
      theirs: region.theirs,
      oursIntent,
      theirsIntent,
    };
    const answer = await askChoice(ai, state, QUESTION, left);
    // Every call that reached the model counts, answered or not; a too-large state never did.
    if (answer.kind === "answer" || answer.reason !== "too_large") usage.calls += 1;
    if (answer.kind === "failed") return unjudged(answer.reason, usage);
    usage.inputTokens += answer.inputTokens;
    const compatible = answer.probabilities.get("compatible") ?? 0;
    switch (answer.choice) {
      case "contradictory":
        return question(
          "contradictory",
          answer.probabilities.get("contradictory") ?? 0,
          "contradictory",
          usage,
        );
      case "compatible":
        if (compatible < COMPATIBLE_GATE) {
          return question("compatible", compatible, "below_gate", usage);
        }
        least = Math.min(least, compatible);
        break;
      default:
        return unreachable(answer.choice);
    }
  }
  return { verdict: { route: "redo", class: "compatible", probability: least }, usage };
}

/** Whether every field of `conflict` is within its bound. */
function withinBounds(conflict: ConflictInput): boolean {
  return (
    conflict.regions.length <= MAX_REGIONS &&
    conflict.oursIntent.length <= MAX_INTENT_LENGTH &&
    conflict.theirsIntent.length <= MAX_INTENT_LENGTH &&
    conflict.regions.every(
      (region) =>
        region.path.length <= MAX_PATH_LENGTH &&
        region.base.length <= MAX_REGION_LENGTH &&
        region.ours.length <= MAX_REGION_LENGTH &&
        region.theirs.length <= MAX_REGION_LENGTH,
    )
  );
}

function question(
  conflictClass: ConflictClass,
  probability: number,
  reason: QuestionReason,
  usage: ClassificationUsage,
): Classification {
  return { verdict: { route: "question", class: conflictClass, probability, reason }, usage };
}

/** A question no answer of Clef's decided. */
function unjudged(reason: QuestionReason, usage: ClassificationUsage): Classification {
  return question("contradictory", 0, reason, usage);
}

function unreachable(value: never): never {
  throw new Error(`unexpected conflict class: ${String(value)}`);
}
