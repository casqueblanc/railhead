import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// `events.ts` has no imports and only erasable syntax, so it loads under plain `node`.
import * as sharedEvents from "../../packages/railhead-shared/src/events.ts";
import { parseCheckDefinitions } from "../../demo/upload-app/acceptance/select.ts";
import {
  assertAskable,
  assertDemoTarget,
  assertMatchesChecks,
  DEMO_ORG,
  DEMO_REPO,
  loadManifest,
  MAX_ISSUE_BODY_LENGTH,
  MAX_LIST_LENGTH,
  MAX_OPTION_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_PATH_LENGTH,
  MAX_QUESTION_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_OPTIONS,
  OPTION_KEY,
  overlaps,
  parseManifest,
  SeedRefusal,
  type Ask,
} from "./manifest.ts";

const root = join(import.meta.dirname, "..", "..");
const manifestPath = join(root, "fixtures", "demo", "seed.json");

function fixture(): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return { ...value };
}

function object(value: unknown): object {
  assert.ok(typeof value === "object" && value !== null);
  return value;
}

function issues(manifest: Record<string, unknown>): Record<string, unknown>[] {
  const list = manifest["issues"];
  assert.ok(Array.isArray(list));
  return list.map((issue: unknown) => {
    assert.ok(typeof issue === "object" && issue !== null);
    return { ...issue };
  });
}

test("the committed manifest seeds demo/upload-app with three issues, two on the decision", () => {
  const manifest = loadManifest(manifestPath);

  assert.equal(`${manifest.org}/${manifest.repo}`, "demo/upload-app");
  assert.equal(manifest.source, "demo/upload-app");
  assert.equal(manifest.issues.length, 3);
  const colliding = manifest.issues
    .filter((issue) => overlaps(issue.touches, manifest.decision.scope))
    .map((issue) => issue.title);
  assert.deepEqual(colliding, [
    "Warn before uploading a file above the size limit",
    "Let people upload files larger than 10 MB",
  ]);
});

/** A `checks.json` suite entry tagged `option`. */
function suite(option: string, version: number) {
  return { option, version, file: `acceptance/option-${option}.test.ts` };
}

/** `count` distinct options with wire-valid keys. */
function manyOptions(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    key: `o${index}`,
    label: `Option ${index}`,
  }));
}

test("the manifest's decision matches the app's tagged acceptance suites", () => {
  const manifest = loadManifest(manifestPath);
  const checks: unknown = JSON.parse(
    readFileSync(join(root, "demo", "upload-app", "acceptance", "checks.json"), "utf8"),
  );
  const both = [suite("a", 1), suite("b", 2)];

  // Every suite's file, the one not in force included, for the caller to find in the app.
  assert.deepEqual(assertMatchesChecks(manifest, checks), [
    "acceptance/option-a.test.ts",
    "acceptance/option-b.test.ts",
  ]);
  assert.throws(
    () => assertMatchesChecks(manifest, { decision: "other", current: suite("a", 1), suites: [] }),
    /different decision/,
  );
  // A suite for an option the decision lacks, an option no suite checks.
  const withOptions = (...keys: string[]) => ({
    ...manifest,
    decision: {
      ...manifest.decision,
      options: keys.map((key) => ({ key, label: `Option ${key}` })),
    },
  });
  assert.throws(
    () =>
      assertMatchesChecks(withOptions("a", "c"), {
        decision: "upload-size-limit",
        current: suite("a", 1),
        suites: both,
      }),
    /suites\[1\] tags an option the decision lacks/,
  );
  assert.throws(
    () =>
      assertMatchesChecks(withOptions("a", "b", "c"), {
        decision: "upload-size-limit",
        current: suite("a", 1),
        suites: both,
      }),
    /offers c, which no checks.json suite tags/,
  );
  assert.throws(
    () =>
      assertMatchesChecks(manifest, {
        decision: "upload-size-limit",
        current: suite("a", 1),
        suites: [suite("a", 1)],
      }),
    /offers b, which no checks.json suite tags/,
  );
  // The option in force at a version no suite carries: the app's checks could not start.
  assert.throws(
    () =>
      assertMatchesChecks(manifest, {
        decision: "upload-size-limit",
        current: suite("a", 2),
        suites: both,
      }),
    (error) =>
      error instanceof SeedRefusal &&
      /app would refuse its checks: No acceptance suite is tagged a@2/.test(error.message),
  );
  assert.doesNotThrow(() =>
    assertMatchesChecks(manifest, {
      decision: "upload-size-limit",
      current: suite("b", 2),
      suites: both,
    }),
  );
});

/** The committed checks with `edit` applied to a copy. */
function committedChecks(edit: (checks: { current: unknown; suites: unknown[] }) => void): unknown {
  const checks: unknown = JSON.parse(
    readFileSync(join(root, "demo", "upload-app", "acceptance", "checks.json"), "utf8"),
  );
  assert.ok(typeof checks === "object" && checks !== null);
  assert.ok("current" in checks && "suites" in checks && Array.isArray(checks.suites));
  const copy = { ...checks, current: checks.current, suites: [...checks.suites] };
  edit(copy);
  return copy;
}

test("the seed accepts exactly the checks the standalone app accepts", () => {
  const manifest = loadManifest(manifestPath);
  const both = [suite("a", 1), suite("b", 2)];
  const near: [string, unknown][] = [
    // The review's case: the current version is numeric, the suite carrying it a string.
    [
      "a string suite version",
      committedChecks((c) => (c.suites[0] = { ...suite("a", 1), version: "1" })),
    ],
    // A malformed version on a suite that is not the one in force.
    ...[0, -2, 2.5, "2", null, true, 2 ** 53].map((version): [string, unknown] => [
      `suite version ${JSON.stringify(version)}`,
      {
        decision: "upload-size-limit",
        current: suite("a", 1),
        suites: [suite("a", 1), { ...suite("b", 2), version }],
      },
    ]),
    ...[0, 1.5, "1", null].map((version): [string, unknown] => [
      `current version ${JSON.stringify(version)}`,
      { decision: "upload-size-limit", current: { option: "a", version }, suites: both },
    ]),
    [
      "a missing suite version",
      {
        decision: "upload-size-limit",
        current: suite("a", 1),
        suites: [suite("a", 1), { option: "b", file: "acceptance/option-b.test.ts" }],
      },
    ],
    [
      "a duplicate tag",
      { decision: "upload-size-limit", current: suite("a", 1), suites: [...both, suite("a", 1)] },
    ],
    [
      "a suite file outside acceptance/",
      {
        decision: "upload-size-limit",
        current: suite("a", 1),
        suites: [suite("a", 1), { ...suite("b", 2), file: "../option-b.test.ts" }],
      },
    ],
    [
      "an uppercase option",
      {
        decision: "upload-size-limit",
        current: suite("A", 1),
        suites: [suite("A", 1), suite("B", 2)],
      },
    ],
    ["no suites", { decision: "upload-size-limit", current: suite("a", 1), suites: [] }],
  ];
  for (const [name, checks] of near) {
    assert.throws(() => parseCheckDefinitions(checks), Error, `the app accepts ${name}`);
    assert.throws(
      () => assertMatchesChecks(manifest, checks),
      (error) => error instanceof SeedRefusal && /app would refuse its checks/.test(error.message),
      `the seed accepts ${name}`,
    );
  }
  // The largest version the app accepts is accepted by the seed as well.
  const largest = {
    decision: "upload-size-limit",
    current: suite("a", Number.MAX_SAFE_INTEGER),
    suites: [suite("a", Number.MAX_SAFE_INTEGER), suite("b", 2)],
  };
  assert.doesNotThrow(() => parseCheckDefinitions(largest));
  assert.doesNotThrow(() => assertMatchesChecks(manifest, largest));
});

/** The `ask` route's wire fixture, which the backend and the Rust protocol crate both check. */
function askFixture(): { accepted: Ask[]; refused: { name: string; ask: Ask }[] } {
  const value: unknown = JSON.parse(
    readFileSync(join(root, "fixtures", "protocol", "wire", "agent", "ask.json"), "utf8"),
  );
  const route = Object.fromEntries(Object.entries(object(value)));
  const exchanges = route["exchanges"];
  const rejected = route["rejectedRequests"];
  assert.ok(Array.isArray(exchanges) && Array.isArray(rejected));
  const askOf = (body: unknown): Ask | null => {
    const { text, options, scope } = Object.fromEntries(Object.entries(object(body)));
    if (typeof text !== "string" || !Array.isArray(options) || !Array.isArray(scope)) return null;
    return {
      text,
      options: options.map((option: unknown) => {
        const { key, label } = Object.fromEntries(Object.entries(object(option)));
        assert.ok(typeof key === "string" && typeof label === "string");
        return { key, label };
      }),
      scope: scope.map((path: unknown) => {
        assert.ok(typeof path === "string");
        return path;
      }),
    };
  };
  const accepted = exchanges.map((exchange: unknown) => {
    const { request } = Object.fromEntries(Object.entries(object(exchange)));
    const ask = askOf(Object.fromEntries(Object.entries(object(request)))["body"]);
    assert.ok(ask !== null);
    return ask;
  });
  const refused = rejected.flatMap((entry: unknown) => {
    const { name, body, stage } = Object.fromEntries(Object.entries(object(entry)));
    assert.ok(typeof name === "string");
    // Shape refusals lack a field; a bad request id is not part of the question.
    const ask = stage === "invariant" && name !== "bad request id" ? askOf(body) : null;
    return ask === null ? [] : [{ name, ask }];
  });
  return { accepted, refused };
}

test("the manifest's decision follows the agent wire's ask rules", () => {
  const manifest = loadManifest(manifestPath);
  const { accepted, refused } = askFixture();
  assert.ok(accepted.length > 0);
  assert.ok(refused.some(({ name }) => name === "option key with capitals"));

  assert.doesNotThrow(() =>
    assertAskable({
      text: manifest.decision.question,
      options: manifest.decision.options,
      scope: manifest.decision.scope,
    }),
  );
  for (const ask of accepted) assert.doesNotThrow(() => assertAskable(ask));
  for (const { name, ask } of refused) assert.throws(() => assertAskable(ask), SeedRefusal, name);
});

test("a decision the wire would refuse is refused, at the option-count limits", () => {
  const base = fixture();
  const decision = Object.fromEntries(Object.entries(object(base["decision"])));
  const withDecision = (change: Record<string, unknown>) =>
    parseManifest({ ...base, decision: { ...decision, ...change } });

  assert.throws(
    () => withDecision({ options: [{ key: "A", label: "Upper" }, ...manyOptions(1)] }),
    /options\[0\]\.key is not an option key/,
  );
  assert.equal(withDecision({ options: manyOptions(MAX_OPTIONS) }).decision.options.length, 8);
  assert.throws(() => withDecision({ options: manyOptions(MAX_OPTIONS + 1) }), /between 2 and 8/);
  assert.equal(withDecision({ options: manyOptions(MIN_OPTIONS) }).decision.options.length, 2);
  assert.throws(() => withDecision({ options: manyOptions(MIN_OPTIONS - 1) }), /between 2 and 8/);
  assert.throws(
    () => withDecision({ scope: [`src/${"x".repeat(MAX_PATH_LENGTH)}`] }),
    /decision.scope\[0\] is not a relative repository path/,
  );
});

test("the restated wire rules match @railhead/shared", () => {
  const shared = join(root, "packages", "railhead-shared", "src");
  const events = readFileSync(join(shared, "events.ts"), "utf8");
  const agentApi = readFileSync(join(shared, "agent-api.ts"), "utf8");

  for (const source of [events, agentApi]) {
    assert.ok(source.includes(`const OPTION_KEY = /${OPTION_KEY.source}/;`), "OPTION_KEY");
  }
  assert.ok(events.includes(`export const MIN_OPTIONS = ${MIN_OPTIONS};`));
  assert.ok(events.includes(`export const MAX_OPTIONS = ${MAX_OPTIONS};`));
  assert.ok(events.includes(`export const MAX_PATH_LENGTH = ${MAX_PATH_LENGTH};`));
  assert.equal(MAX_TITLE_LENGTH, sharedEvents.MAX_TITLE_LENGTH);
  assert.equal(MAX_ISSUE_BODY_LENGTH, sharedEvents.MAX_ISSUE_BODY_LENGTH);
  assert.equal(MAX_QUESTION_LENGTH, sharedEvents.MAX_QUESTION_LENGTH);
  assert.equal(MAX_OPTION_LABEL_LENGTH, sharedEvents.MAX_OPTION_LABEL_LENGTH);
  assert.equal(MAX_LIST_LENGTH, sharedEvents.MAX_LIST_LENGTH);
  // MAX_SCOPE_BYTES is half the request limit; the scope-bytes vectors above check the sum.
  assert.ok(agentApi.includes("export const MAX_AGENT_REQUEST_BYTES = 16 * 1024;"));
  assert.ok(agentApi.includes("export const MAX_SCOPE_BYTES = MAX_AGENT_REQUEST_BYTES / 2;"));
});

test("the demo repository is the board's default repository", () => {
  const apiSession = readFileSync(
    join(root, "packages", "railhead-frontend", "src", "rpc", "apiSession.ts"),
    "utf8",
  );
  assert.ok(
    apiSession.includes(
      `export const DEFAULT_BOARD_REPO: BoardRepo = { org: "${DEMO_ORG}", repo: "${DEMO_REPO}" };`,
    ),
  );
});

test("a manifest naming another repository is refused", () => {
  for (const [org, repo] of [
    ["acme", "upload-app"],
    ["demo", "other"],
    ["Demo", "upload-app"],
  ]) {
    assert.throws(() => parseManifest({ ...fixture(), org, repo }), SeedRefusal);
  }
  assert.throws(() => assertDemoTarget("demo", "upload-app-2"), /refusing "demo\/upload-app-2"/);
  assert.doesNotThrow(() => assertDemoTarget("demo", "upload-app"));
});

test("malformed manifests are refused with the field that is wrong", () => {
  const base = fixture();
  const cases: [unknown, RegExp][] = [
    [null, /manifest must be an object/],
    [[], /manifest must be an object/],
    [{ ...base, source: "../outside" }, /source is not a relative repository path/],
    [{ ...base, source: "/abs" }, /source is not a relative repository path/],
    [{ ...base, issues: "three" }, /issues must be a list/],
    [{ ...base, decision: { ...object(base["decision"]), key: "Bad Key" } }, /decision.key/],
  ];
  for (const [value, message] of cases) assert.throws(() => parseManifest(value), message);
});

test("the issue count and collision are exact, not minimums", () => {
  const base = fixture();
  const [first, second, third] = issues(base);
  assert.ok(first !== undefined && second !== undefined && third !== undefined);

  assert.throws(() => parseManifest({ ...base, issues: [first, second] }), /exactly 3 tasks/);
  assert.throws(
    () => parseManifest({ ...base, issues: [first, second, third, { ...third, title: "Four" }] }),
    /exactly 3 tasks/,
  );
  assert.throws(
    () => parseManifest({ ...base, issues: [first, { ...second, title: first["title"] }, third] }),
    /issue titles must not repeat/,
  );
  // All three on the decision: no longer one independent task.
  assert.throws(
    () =>
      parseManifest({ ...base, issues: [first, second, { ...third, touches: ["src/limits.ts"] }] }),
    /Exactly two issues must touch the decision's scope; 3 do/,
  );
  // Only one on it: nothing collides.
  assert.throws(
    () => parseManifest({ ...base, issues: [first, { ...second, touches: ["README.md"] }, third] }),
    /Exactly two issues must touch the decision's scope; 1 do/,
  );
});

test("a title at the shared limit passes and one character more is refused", () => {
  const base = fixture();
  const [first, second, third] = issues(base);
  assert.ok(first !== undefined && second !== undefined && third !== undefined);

  const limit = sharedEvents.MAX_TITLE_LENGTH;
  const atLimit = parseManifest({
    ...base,
    issues: [{ ...first, title: "t".repeat(limit) }, second, third],
  });
  assert.equal(atLimit.issues[0]?.title.length, limit);
  assert.throws(
    () =>
      parseManifest({
        ...base,
        issues: [{ ...first, title: "t".repeat(limit + 1) }, second, third],
      }),
    new RegExp(`title is longer than ${limit} characters`),
  );
});

test("issue text may break body lines and carries no other control character", () => {
  const base = fixture();
  const [first, second, third] = issues(base);
  assert.ok(first !== undefined && second !== undefined && third !== undefined);

  const parsed = parseManifest({
    ...base,
    issues: [{ ...first, body: "One.\n\nTwo.\n" }, second, third],
  });
  assert.equal(parsed.issues[0]?.body, "One.\n\nTwo.\n");
  for (const issue of [
    { ...first, body: "Red \u001b[31mtext" },
    { ...first, body: "Carriage\r\nreturn" },
    { ...first, title: "Two\nlines" },
    { ...first, title: "Tab\there" },
    // Format characters: a bidi override and isolate, and a zero-width space and joiner.
    { ...first, title: "Fix \u202Etxt.exe" },
    { ...first, body: "Line \u2066hidden\u2069 text" },
    { ...first, title: "Zero\u200Bwidth" },
    { ...first, body: "Join\u200Dme" },
  ]) {
    assert.throws(
      () => parseManifest({ ...base, issues: [issue, second, third] }),
      /issues\[0\] holds a control character; only a body may break lines/,
    );
  }
});

test("a scope directory covers the paths below it and nothing beside it", () => {
  assert.equal(overlaps(["src/upload/limits.ts"], ["src/upload"]), true);
  assert.equal(overlaps(["src/uploads.ts"], ["src/upload"]), false);
  assert.equal(overlaps([], ["src"]), false);
});

test("a touched directory covers the scope paths below it and nothing beside it", () => {
  assert.equal(overlaps(["src"], ["src/limits.ts"]), true);
  assert.equal(overlaps(["src/upload"], ["src/upload/limits.ts"]), true);
  // A sibling sharing a prefix, and a scope path above the touched one's directory.
  assert.equal(overlaps(["src/upload"], ["src/uploads.ts"]), false);
  assert.equal(overlaps(["src/up"], ["src/upload/limits.ts"]), false);
  assert.equal(overlaps(["src/limits"], ["src/limits.ts"]), false);
});

test("a third task touching a directory that holds the scope is a third collision", () => {
  const base = fixture();
  const [first, second, third] = issues(base);
  assert.ok(first !== undefined && second !== undefined && third !== undefined);

  assert.throws(
    () => parseManifest({ ...base, issues: [first, second, { ...third, touches: ["src"] }] }),
    /Exactly two issues must touch the decision's scope; 3 do\./,
  );
  // The fixture's third task touches files beside the scope and stays independent.
  assert.equal(parseManifest(base).issues.length, 3);
});

test("an unreadable or unparsable manifest is refused", () => {
  assert.throws(() => loadManifest(join(root, "fixtures", "demo", "missing.json")), /Cannot read/);
  assert.throws(() => loadManifest(join(root, "package.json")), /org must be non-blank text/);
});
