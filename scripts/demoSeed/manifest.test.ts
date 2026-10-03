import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertDemoTarget,
  assertMatchesChecks,
  loadManifest,
  overlaps,
  parseManifest,
  SeedRefusal,
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

test("the manifest's decision matches the app's tagged acceptance suites", () => {
  const manifest = loadManifest(manifestPath);
  const checks: unknown = JSON.parse(
    readFileSync(join(root, "demo", "upload-app", "acceptance", "checks.json"), "utf8"),
  );

  assert.doesNotThrow(() => assertMatchesChecks(manifest, checks));
  assert.throws(
    () => assertMatchesChecks(manifest, { decision: "other", suites: [] }),
    /different decision/,
  );
  assert.throws(
    () =>
      assertMatchesChecks(manifest, {
        decision: "upload-size-limit",
        suites: [{ option: "C", version: 3, file: "acceptance/option-c.test.ts" }],
      }),
    /lacks/,
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

  const atLimit = parseManifest({
    ...base,
    issues: [{ ...first, title: "t".repeat(256) }, second, third],
  });
  assert.equal(atLimit.issues[0]?.title.length, 256);
  assert.throws(
    () => parseManifest({ ...base, issues: [{ ...first, title: "t".repeat(257) }, second, third] }),
    /title is longer than 256 characters/,
  );
});

test("a scope directory covers the paths below it and nothing beside it", () => {
  assert.equal(overlaps(["src/upload/limits.ts"], ["src/upload"]), true);
  assert.equal(overlaps(["src/uploads.ts"], ["src/upload"]), false);
  assert.equal(overlaps([], ["src"]), false);
});

test("an unreadable or unparsable manifest is refused", () => {
  assert.throws(() => loadManifest(join(root, "fixtures", "demo", "missing.json")), /Cannot read/);
  assert.throws(() => loadManifest(join(root, "package.json")), /org must be non-blank text/);
});
