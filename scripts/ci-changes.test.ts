import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";

const script = join(import.meta.dirname, "ci-changes.mjs");

/** Runs the classifier as CI does, with `paths` on stdin, and returns its decision for `job`. */
function decide(job: string, paths: string[]): { status: number | null; stdout: string } {
  const result = spawnSync(process.execPath, [script, job], {
    input: paths.map((path) => `${path}\n`).join(""),
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout };
}

function runs(job: string, paths: string[]): boolean {
  const { status, stdout } = decide(job, paths);
  assert.equal(status, 0);
  assert.match(stdout, /^run=(?:true|false)\n$/);
  return stdout === "run=true\n";
}

test("a frontend change runs lint and test but not Rust", () => {
  const paths = ["packages/railhead-frontend/src/main.tsx"];
  assert.equal(runs("lint", paths), true);
  assert.equal(runs("test", paths), true);
  assert.equal(runs("rust", paths), false);
});

test("a Rust source change runs only Rust", () => {
  const paths = ["crates/railhead-cli/src/main.rs", "Cargo.lock"];
  assert.equal(runs("lint", paths), false);
  assert.equal(runs("test", paths), false);
  assert.equal(runs("rust", paths), true);
});

test("a Cargo manifest change also runs lint, which formats TOML", () => {
  for (const path of ["Cargo.toml", "crates/railhead-cli/Cargo.toml", "rust-toolchain.toml"]) {
    assert.equal(runs("lint", [path]), true, path);
    assert.equal(runs("test", [path]), false, path);
    assert.equal(runs("rust", [path]), true, path);
  }
});

test("a docs change runs only lint, which formats Markdown", () => {
  const paths = ["docs/demo-seed.md", "README.md"];
  assert.equal(runs("lint", paths), true);
  assert.equal(runs("test", paths), false);
  assert.equal(runs("rust", paths), false);
});

test("fixtures the crates read run Rust as well as test", () => {
  for (const path of ["fixtures/protocol/wire/events.json", "fixtures/auth/agent.pub"]) {
    assert.equal(runs("test", [path]), true, path);
    assert.equal(runs("rust", [path]), true, path);
  }
  assert.equal(runs("rust", ["fixtures/board/syntheticLog.ts"]), false);
});

test("the Rust gate script runs Rust and lint, and no other script runs Rust", () => {
  assert.equal(runs("rust", ["scripts/rust-check.mjs"]), true);
  assert.equal(runs("lint", ["scripts/rust-check.mjs"]), true);
  assert.equal(runs("test", ["scripts/rust-check.mjs"]), false);
  assert.equal(runs("rust", ["scripts/worker-config.ts"]), false);
});

test("a workflow, this classifier or an unlisted path runs every job", () => {
  for (const path of [".github/workflows/ci.yml", "scripts/ci-changes.mjs", "newdir/file.txt"]) {
    for (const job of ["lint", "test", "rust"]) {
      assert.equal(runs(job, [path]), true, `${job} ${path}`);
    }
  }
});

test("a nested Markdown file is not mistaken for root prose", () => {
  assert.equal(runs("test", ["packages/railhead-frontend/AGENTS.md"]), true);
  assert.equal(runs("rust", ["crates/railhead-cli/README.md"]), true);
});

test("one input among skippable paths runs the job", () => {
  assert.equal(runs("test", ["docs/demo-seed.md", "crates/x.rs", "packages/x/src/a.ts"]), true);
});

test("no changed paths runs nothing", () => {
  for (const job of ["lint", "test", "rust"]) {
    assert.equal(runs(job, []), false, job);
  }
});

test("an unknown or missing job name fails without a decision", () => {
  for (const args of [["deploy"], ["toString"], []]) {
    const result = spawnSync(process.execPath, [script, ...args], { input: "", encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
  }
});
