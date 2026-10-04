// The conflicts module's classifier, against Clef responses recorded by the #7 and #14 spikes. The
// conflicts in the fixture file are the spikes' cases: #7's are synthetic, #14's are regions of
// tauri-apps/tauri (MIT OR Apache-2.0) at the merge each one names. Each response keeps the recorded
// model, choice, probabilities, confidence and usage in Workers AI's published output shape. No
// test reaches Workers AI: the pool runs without remote bindings.

import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkersAi } from "@railhead/ai/clef";
import { createConflicts } from "../src/modules/conflicts/entry";
import {
  COMPATIBLE_GATE,
  MAX_REGION_LENGTH,
  MAX_REGIONS,
  type ConflictInput,
  type ConflictRegion,
} from "../src/train/classification/classify";
import recorded from "./conflicts-classify.fixtures.json";

const REPO = "org/repo";

interface Call {
  model: string;
  state: unknown;
}

/** A binding that answers each call with the next of `answers`, recording what it was sent. */
function replay(...answers: (() => Promise<unknown>)[]): { ai: WorkersAi; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    ai: {
      run(model, inputs) {
        calls.push({ model, state: inputs["state"] });
        const next = answers[calls.length - 1];
        if (next === undefined) throw new Error("no recorded answer left");
        return next();
      },
    },
  };
}

/** A Clef response with `compatible` at probability `p`. */
function answer(p: number): () => Promise<unknown> {
  const contradictory = Math.round((1 - p) * 10_000) / 10_000;
  return async () => ({
    model: "clef",
    answers: {
      relation: {
        type: "choice",
        choice: p >= contradictory ? "compatible" : "contradictory",
        probabilities: { compatible: p, contradictory },
        confidence: Math.abs(p - contradictory),
      },
    },
    usage: { input_tokens: 400, output_tokens: 0 },
  });
}

function fixture(id: string): (typeof recorded)[number] {
  const found = recorded.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no fixture ${id}`);
  return found;
}

/** The recorded conflict of `id` as the classifier's input. */
function inputOf(id: string): ConflictInput {
  const { path, base, ours, theirs, oursIntent, theirsIntent } = fixture(id).conflict;
  return { regions: [{ path, base, ours, theirs }], oursIntent, theirsIntent };
}

const REGION: ConflictRegion = {
  path: "src/router.ts",
  base: 'router.get("/health", health);\n',
  ours: 'router.get("/health", health);\nrouter.get("/issues", listIssues);\n',
  theirs: 'router.get("/health", health);\nrouter.get("/claims", listClaims);\n',
};

function conflict(regions: readonly ConflictRegion[]): ConflictInput {
  return {
    regions,
    oursIntent: "Add the endpoint that lists issues.",
    theirsIntent: "Add the endpoint that lists claims.",
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("conflict classification on recorded Clef answers", () => {
  it.each([
    ["c01-routes", { route: "redo", class: "compatible", probability: 0.982 }],
    [
      "merge-93afa71d-core_tauri_src_test_mock_runtime.rs-3",
      { route: "redo", class: "compatible", probability: 0.917 },
    ],
    [
      "c11-two-optional-params",
      { route: "question", class: "compatible", probability: 0.7956, reason: "below_gate" },
    ],
    [
      // 0.8991: a real Tauri conflict just under the gate.
      "merge-c6c59cf2-tooling_bundler_src_bundle_windows_templates_installer.nsi-1",
      { route: "question", class: "compatible", probability: 0.8991, reason: "below_gate" },
    ],
    [
      "d10-same-key-two-values",
      { route: "question", class: "contradictory", probability: 0.984, reason: "contradictory" },
    ],
    [
      "merge-a9b87c05-tooling_cli_node_package.json-1",
      { route: "question", class: "contradictory", probability: 0.9705, reason: "contradictory" },
    ],
  ])("routes %s as the gate requires", async (id, expected) => {
    const { ai, calls } = replay(async () => fixture(id).response);
    const verdict = await createConflicts(REPO, ai, Date.now).classify(inputOf(id));
    expect(verdict).toEqual(expected);
    // One call to Clef, never Clef-flash, carrying exactly the region, its path and both intents.
    expect(calls).toEqual([{ model: "@cf/cloudflare/clef", state: fixture(id).conflict }]);
  });

  it("sends a #14 conflict the maintainers settled by dropping a side to redo, as the spike measured", async () => {
    // A known limit of the gate: both sides look compatible in the region, and the maintainers
    // dropped one for a reason outside it. Redo is still not a merge: the redone work meets every
    // check again.
    const id = "merge-1092865e-.github_workflows_test-core.yml-1";
    expect(fixture(id).label).toBe("contradictory");
    const { ai } = replay(async () => fixture(id).response);
    expect(await createConflicts(REPO, ai, Date.now).classify(inputOf(id))).toEqual({
      route: "redo",
      class: "compatible",
      probability: 0.9643,
    });
  });
});

describe("the gate", () => {
  it("redoes at exactly the gate and asks just below it", async () => {
    expect(COMPATIBLE_GATE).toBe(0.9);
    const at = replay(answer(0.9));
    expect(await createConflicts(REPO, at.ai, Date.now).classify(conflict([REGION]))).toEqual({
      route: "redo",
      class: "compatible",
      probability: 0.9,
    });
    const below = replay(answer(0.899));
    expect(await createConflicts(REPO, below.ai, Date.now).classify(conflict([REGION]))).toEqual({
      route: "question",
      class: "compatible",
      probability: 0.899,
      reason: "below_gate",
    });
  });

  it("redoes several regions only when every one passes, at the least probability", async () => {
    const all = replay(answer(0.97), answer(0.93), answer(0.95));
    const regions = [REGION, { ...REGION, path: "src/a.ts" }, { ...REGION, path: "src/b.ts" }];
    expect(await createConflicts(REPO, all.ai, Date.now).classify(conflict(regions))).toEqual({
      route: "redo",
      class: "compatible",
      probability: 0.93,
    });
    expect(all.calls).toHaveLength(3);

    // The first region that is not a redo ends the classification: no further call is made.
    const second = replay(answer(0.97), answer(0.2), answer(0.99));
    expect(await createConflicts(REPO, second.ai, Date.now).classify(conflict(regions))).toEqual({
      route: "question",
      class: "contradictory",
      probability: 0.8,
      reason: "contradictory",
    });
    expect(second.calls).toHaveLength(2);
  });

  it.each([
    ["an empty intent", { ...conflict([REGION]), oursIntent: "" }],
    ["a blank intent", { ...conflict([REGION]), theirsIntent: "  \n\t" }],
  ])("asks about a conflict with %s, without calling the model", async (_name, input) => {
    const { ai, calls } = replay(answer(0.99));
    expect(await createConflicts(REPO, ai, Date.now).classify(input)).toEqual({
      route: "question",
      class: "contradictory",
      probability: 0,
      reason: "missing_intent",
    });
    expect(calls).toHaveLength(0);
  });

  it("asks about a conflict with no region, without calling the model", async () => {
    const { ai, calls } = replay(answer(0.99));
    expect(await createConflicts(REPO, ai, Date.now).classify(conflict([]))).toMatchObject({
      route: "question",
      reason: "no_regions",
    });
    expect(calls).toHaveLength(0);
  });

  it("sends a region at the size bound and asks about one past it, or too many regions", async () => {
    const atBound = { ...REGION, ours: "x".repeat(MAX_REGION_LENGTH) };
    const sent = replay(answer(0.95));
    expect(
      await createConflicts(REPO, sent.ai, Date.now).classify(conflict([atBound])),
    ).toMatchObject({
      route: "redo",
    });

    const { ai, calls } = replay(answer(0.99));
    const port = createConflicts(REPO, ai, Date.now);
    const pastBound = { ...REGION, theirs: "x".repeat(MAX_REGION_LENGTH + 1) };
    expect(await port.classify(conflict([pastBound]))).toMatchObject({
      route: "question",
      reason: "too_large",
    });
    const many = Array.from({ length: MAX_REGIONS + 1 }, () => REGION);
    expect(await port.classify(conflict(many))).toMatchObject({
      route: "question",
      reason: "too_large",
    });
    expect(calls).toHaveLength(0);
  });
});

describe("model failures", () => {
  it.each([
    ["a malformed answer", async () => ({ model: "clef", answers: {}, usage: {} }), "malformed"],
    [
      "an answer missing an option",
      async () => ({
        model: "clef",
        answers: {
          relation: {
            type: "choice",
            choice: "compatible",
            probabilities: { compatible: 0.99 },
            confidence: 0.98,
          },
        },
        usage: { input_tokens: 400, output_tokens: 0 },
      }),
      "malformed",
    ],
    [
      "a failed call",
      async () => {
        throw new Error("AiError: 5007: no such model");
      },
      "unavailable",
    ],
  ] as const)("asks about a conflict when Clef gives %s", async (_name, respond, reason) => {
    const { ai } = replay(respond);
    expect(await createConflicts(REPO, ai, Date.now).classify(conflict([REGION]))).toEqual({
      route: "question",
      class: "contradictory",
      probability: 0,
      reason,
    });
  });

  it("asks about a conflict when Clef does not answer within the timeout", async () => {
    const { ai } = replay(() => new Promise<never>(() => {}));
    const started = Date.now();
    expect(await createConflicts(REPO, ai, Date.now, 25).classify(conflict([REGION]))).toEqual({
      route: "question",
      class: "contradictory",
      probability: 0,
      reason: "timeout",
    });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("stops at the shared deadline before a later region's call", async () => {
    let now = 0;
    const { ai, calls } = replay(async () => {
      now += 50;
      return answer(0.99)();
    }, answer(0.99));
    const verdict = await createConflicts(REPO, ai, () => now, 40).classify(
      conflict([REGION, REGION]),
    );
    expect(verdict).toMatchObject({ route: "question", reason: "timeout" });
    expect(calls).toHaveLength(1);
  });

  it("asks rather than redoes when the Worker's own binding cannot reach the service", async () => {
    // The test pool runs without remote bindings, so the configured `AI` binding refuses the call.
    const verdict = await createConflicts(REPO, env.AI, Date.now, 2_000).classify(
      conflict([REGION]),
    );
    expect(verdict).toEqual({
      route: "question",
      class: "contradictory",
      probability: 0,
      reason: "unavailable",
    });
  });
});

describe("logging", () => {
  it("logs the verdict and cost without any of the conflict's text", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { ai } = replay(answer(0.95));
    await createConflicts(REPO, ai, Date.now).classify(conflict([REGION]));
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    expect(JSON.parse(line)).toEqual({
      event: "conflicts.classified",
      repo: REPO,
      route: "redo",
      reason: null,
      class: "compatible",
      probability: 0.95,
      regions: 1,
      calls: 1,
      inputTokens: 400,
    });
    for (const text of ["listIssues", "listClaims", "lists issues", REGION.path]) {
      expect(line).not.toContain(text);
    }
  });

  it("counts a model call that failed, but not a conflict never sent", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const failing = replay(answer(0.97), async () => ({ model: "clef", answers: {}, usage: {} }));
    await createConflicts(REPO, failing.ai, Date.now).classify(conflict([REGION, REGION]));
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      reason: "malformed",
      calls: 2,
      inputTokens: 400,
    });

    const unsent = replay(answer(0.99));
    await createConflicts(REPO, unsent.ai, Date.now).classify({
      ...conflict([REGION]),
      oursIntent: "",
    });
    expect(JSON.parse(String(info.mock.calls[1]?.[0]))).toMatchObject({
      reason: "missing_intent",
      calls: 0,
      inputTokens: 0,
    });
  });
});
