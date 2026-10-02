import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");

test("the Volta pin matches .node-version, which CI installs", () => {
  const pinned = readFileSync(join(root, ".node-version"), "utf8").trim();
  const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

  assert.match(pinned, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(
    typeof manifest === "object" && manifest !== null && "volta" in manifest && manifest.volta,
    { node: pinned },
  );
});
