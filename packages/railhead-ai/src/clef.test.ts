import { describe, expect, it } from "vitest";
import {
  askChoice,
  CLEF_MODEL,
  MAX_STATE_LENGTH,
  type ChoiceQuestion,
  type WorkersAi,
} from "./clef";

type Option = "compatible" | "contradictory";

const QUESTION: ChoiceQuestion<Option> = {
  instructions: "Decide whether both changes can be kept.",
  options: [
    { key: "compatible", criterion: "Both can be kept." },
    { key: "contradictory", criterion: "A person must choose." },
  ],
};

const STATE = { path: "src/router.ts", ours: "a", theirs: "b" };

/** A recorded Clef response from the #7 spike (c01-routes), in the published output shape. */
const RECORDED = {
  model: "clef",
  answers: {
    relation: {
      type: "choice",
      choice: "compatible",
      probabilities: { compatible: 0.982, contradictory: 0.018 },
      confidence: 0.9293,
    },
  },
  usage: { input_tokens: 357, output_tokens: 0 },
};

interface Call {
  model: string;
  inputs: Record<string, unknown>;
  signal: AbortSignal;
}

/** A binding that answers every call with `answer`, recording each call. */
function fake(answer: (call: Call) => Promise<unknown>): { ai: WorkersAi; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ai: {
      run(model, inputs, { signal }) {
        const call = { model, inputs, signal };
        calls.push(call);
        return answer(call);
      },
    },
  };
}

/** The recorded response with its `relation` answer replaced. */
function withAnswer(relation: unknown): unknown {
  return { ...RECORDED, answers: { relation } };
}

describe("askChoice", () => {
  it("sends one choice question to Clef and returns the validated answer", async () => {
    const { ai, calls } = fake(async () => RECORDED);
    const result = await askChoice(ai, STATE, QUESTION, 1_000);
    expect(result).toEqual({
      kind: "answer",
      choice: "compatible",
      probabilities: new Map([
        ["compatible", 0.982],
        ["contradictory", 0.018],
      ]),
      model: "clef",
      inputTokens: 357,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(CLEF_MODEL);
    expect(calls[0]?.inputs).toEqual({
      model: "clef",
      state: STATE,
      questions: {
        relation: {
          type: "choice",
          instructions: QUESTION.instructions,
          criteria: { compatible: "Both can be kept.", contradictory: "A person must choose." },
        },
      },
    });
  });

  it.each([
    ["a non-object response", "not json"],
    ["a response without answers", { model: "clef", usage: RECORDED.usage }],
    ["a response without usage", { model: "clef", answers: RECORDED.answers }],
    ["a response without a model", { answers: RECORDED.answers, usage: RECORDED.usage }],
    ["an answer under another id", { ...RECORDED, answers: { other: RECORDED.answers.relation } }],
    ["a score answer", withAnswer({ ...RECORDED.answers.relation, type: "score" })],
    ["a choice outside the options", withAnswer({ ...RECORDED.answers.relation, choice: "maybe" })],
    [
      "a missing option",
      withAnswer({ ...RECORDED.answers.relation, probabilities: { compatible: 1 } }),
    ],
    [
      "an extra option",
      withAnswer({
        ...RECORDED.answers.relation,
        probabilities: { compatible: 0.5, contradictory: 0.4, unsure: 0.1 },
      }),
    ],
    [
      "a probability above one",
      withAnswer({
        ...RECORDED.answers.relation,
        probabilities: { compatible: 1.2, contradictory: -0.2 },
      }),
    ],
    [
      "a probability that is not a number",
      withAnswer({
        ...RECORDED.answers.relation,
        probabilities: { compatible: "0.98", contradictory: 0.02 },
      }),
    ],
    [
      "probabilities that do not sum to one",
      withAnswer({
        ...RECORDED.answers.relation,
        probabilities: { compatible: 0.95, contradictory: 0.95 },
      }),
    ],
    [
      "a choice that is not the most probable option",
      withAnswer({
        ...RECORDED.answers.relation,
        probabilities: { compatible: 0.1, contradictory: 0.9 },
      }),
    ],
    ["a missing confidence", withAnswer({ ...RECORDED.answers.relation, confidence: undefined })],
    ["fractional token usage", { ...RECORDED, usage: { input_tokens: 1.5, output_tokens: 0 } }],
  ])("refuses %s as malformed", async (_name, response) => {
    const { ai } = fake(async () => response);
    expect(await askChoice(ai, STATE, QUESTION, 1_000)).toEqual({
      kind: "failed",
      reason: "malformed",
    });
  });

  it("accepts a state at the length limit and refuses one past it without calling", async () => {
    // `{"t":""}` serializes to 8 characters around the text.
    const atLimit = { t: "x".repeat(MAX_STATE_LENGTH - 8) };
    const { ai, calls } = fake(async () => RECORDED);
    expect((await askChoice(ai, atLimit, QUESTION, 1_000)).kind).toBe("answer");
    expect(calls).toHaveLength(1);

    const pastLimit = { t: "x".repeat(MAX_STATE_LENGTH - 7) };
    expect(await askChoice(ai, pastLimit, QUESTION, 1_000)).toEqual({
      kind: "failed",
      reason: "too_large",
    });
    expect(calls).toHaveLength(1);
  });

  it("gives up after the timeout and aborts the call, even when the binding ignores the signal", async () => {
    const { ai, calls } = fake(() => new Promise<never>(() => {}));
    const started = Date.now();
    expect(await askChoice(ai, STATE, QUESTION, 20)).toEqual({ kind: "failed", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls[0]?.signal.aborted).toBe(true);
  });

  it("reports a thrown binding as unavailable", async () => {
    const { ai } = fake(async () => {
      throw new Error("3040: capacity exceeded");
    });
    expect(await askChoice(ai, STATE, QUESTION, 1_000)).toEqual({
      kind: "failed",
      reason: "unavailable",
    });
  });

  it("rejects a question without two distinct options", async () => {
    const { ai, calls } = fake(async () => RECORDED);
    const single: ChoiceQuestion<Option> = {
      instructions: "x",
      options: [{ key: "compatible", criterion: "a" }],
    };
    const repeated: ChoiceQuestion<Option> = {
      instructions: "x",
      options: [
        { key: "compatible", criterion: "a" },
        { key: "compatible", criterion: "b" },
      ],
    };
    await expect(askChoice(ai, STATE, single, 1_000)).rejects.toThrow("two or more");
    await expect(askChoice(ai, STATE, repeated, 1_000)).rejects.toThrow("two or more");
    expect(calls).toHaveLength(0);
  });
});
