// Clef on Workers AI: one choice question about a state, answered with a probability for every
// option. This module is the only code that knows Clef's request and response format; callers see
// a validated answer or a closed failure.
//
// The model's answer is untrusted. It is validated as `unknown` against the published output
// schema, and an answer that is not exactly one probability per asked option, summing to one, with
// the highest one chosen, is `malformed`. Nothing here logs the state, the question or the answer.
//
// Each call is bounded twice: the state's serialized size before the call, and the wait for an
// answer after it. The binding is passed an abort signal, and the wait also ends on its own when the
// binding ignores the signal, so a hung call costs at most `timeoutMs`.

/** The Workers AI model. Clef only: #7 found Clef-flash's probabilities too compressed to gate. */
export const CLEF_MODEL = "@cf/cloudflare/clef";

/** The model selector Clef's request carries beside the model name. */
const CLEF_SELECTOR = "clef";

/** The id the question is asked and answered under. */
const QUESTION_ID = "relation";

/**
 * Most UTF-16 code units the serialized state may hold. Clef's window is 65,536 tokens and it cuts
 * a longer state silently, so a state is refused well below that rather than judged in part.
 */
export const MAX_STATE_LENGTH = 64 * 1024;

/** How far the probabilities may sum from one before the answer is refused. */
const SUM_TOLERANCE = 0.01;

/** The part of the Workers AI binding Clef needs. The Worker's `env.AI` satisfies it. */
export interface WorkersAi {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options: { signal: AbortSignal },
  ): Promise<unknown>;
}

/** One option of a choice question, with the criterion that tells the model when it applies. */
export interface ChoiceOption<O extends string> {
  /** The option's key, which the answer's probabilities are keyed by. */
  readonly key: O;
  /** When this option is the right answer, in plain words. */
  readonly criterion: string;
}

/** A question with a fixed set of options. */
export interface ChoiceQuestion<O extends string> {
  /** What to decide about the state. */
  readonly instructions: string;
  /** Two or more options with distinct keys. */
  readonly options: readonly ChoiceOption<O>[];
}

/** Why a question got no usable answer. */
export type ChoiceFailure =
  /** The state is longer than `MAX_STATE_LENGTH`; the model was not called. */
  | "too_large"
  /** The model did not answer within the timeout. */
  | "timeout"
  /** The binding threw: the service refused or failed the call. */
  | "unavailable"
  /** The answer does not match the output schema or the options asked. */
  | "malformed";

/** Clef's answer to one choice question, or why there is none. */
export type ChoiceResult<O extends string> =
  | {
      kind: "answer";
      /** The option with the highest probability. */
      choice: O;
      /** The probability of every option asked. */
      probabilities: ReadonlyMap<O, number>;
      /** The model that answered, as the service names it. */
      model: string;
      /** Input tokens the call used. */
      inputTokens: number;
    }
  | { kind: "failed"; reason: ChoiceFailure };

/**
 * Asks Clef one choice question about `state`, waiting at most `timeoutMs` for the answer. Every
 * failure of the call, including a thrown binding, is a `failed` result; it rejects only for a
 * question without two distinct options, which is the caller's bug.
 */
export async function askChoice<O extends string>(
  ai: WorkersAi,
  state: Readonly<Record<string, string>>,
  question: ChoiceQuestion<O>,
  timeoutMs: number,
): Promise<ChoiceResult<O>> {
  const keys = question.options.map((option) => option.key);
  if (keys.length < 2 || new Set(keys).size !== keys.length) {
    throw new Error("a choice question needs two or more distinct options");
  }
  if (JSON.stringify(state).length > MAX_STATE_LENGTH) return failed("too_large");
  const inputs = {
    model: CLEF_SELECTOR,
    state,
    questions: {
      [QUESTION_ID]: {
        type: "choice",
        instructions: question.instructions,
        criteria: Object.fromEntries(
          question.options.map(({ key, criterion }) => [key, criterion]),
        ),
      },
    },
  };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, timeoutMs);
  });
  let raw: unknown;
  try {
    const answered = ai.run(CLEF_MODEL, inputs, { signal: controller.signal }).then(
      (value) => ({ value }),
      () => "unavailable" as const,
    );
    const settled = await Promise.race([answered, expired]);
    if (settled === "timeout" || controller.signal.aborted) return failed("timeout");
    if (settled === "unavailable") return failed("unavailable");
    raw = settled.value;
  } finally {
    clearTimeout(timer);
  }
  return parseAnswer(raw, keys) ?? failed("malformed");
}

function failed<O extends string>(reason: ChoiceFailure): ChoiceResult<O> {
  return { kind: "failed", reason };
}

/** The answer when `raw` is a valid response to a question over `keys`, otherwise `null`. */
function parseAnswer<O extends string>(raw: unknown, keys: readonly O[]): ChoiceResult<O> | null {
  if (!isRecord(raw) || typeof raw["model"] !== "string") return null;
  const { answers, usage } = raw;
  if (!isRecord(answers) || !isRecord(usage)) return null;
  const inputTokens = usage["input_tokens"];
  const outputTokens = usage["output_tokens"];
  if (!isCount(inputTokens) || !isCount(outputTokens)) return null;
  const answer = answers[QUESTION_ID];
  if (!isRecord(answer) || answer["type"] !== "choice") return null;
  const { choice, probabilities, confidence } = answer;
  if (!isProbability(confidence) || !isRecord(probabilities)) return null;
  if (Object.keys(probabilities).length !== keys.length) return null;
  const entries: [O, number][] = [];
  for (const key of keys) {
    const probability = probabilities[key];
    if (!isProbability(probability)) return null;
    entries.push([key, probability]);
  }
  const sum = entries.reduce((total, [, probability]) => total + probability, 0);
  if (Math.abs(sum - 1) > SUM_TOLERANCE) return null;
  const chosen = entries.find(([key]) => key === choice);
  if (chosen === undefined) return null;
  // The schema defines the choice as the highest-probability option; any other choice is not one.
  if (entries.some(([, probability]) => probability > chosen[1])) return null;
  return {
    kind: "answer",
    choice: chosen[0],
    probabilities: new Map(entries),
    model: raw["model"],
    inputTokens,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
