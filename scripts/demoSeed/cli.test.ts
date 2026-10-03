import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { run } from "./cli.ts";
import { loadManifest, SeedRefusal } from "./manifest.ts";

const root = join(import.meta.dirname, "..", "..");
const manifest = loadManifest(join(root, "fixtures", "demo", "seed.json"));
const scratch = mkdtempSync(join(tmpdir(), "railhead-demo-cli-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const CHECKS = "demo/upload-app/acceptance/checks.json";
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Someone",
  GIT_AUTHOR_EMAIL: "someone@example.com",
  GIT_COMMITTER_NAME: "Someone",
  GIT_COMMITTER_EMAIL: "someone@example.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: gitEnv,
  }).trim();
}

/**
 * A source repository holding this checkout's demo app and every file the standalone overlay
 * reads, committed once, so the run does not depend on how deep this checkout's history is.
 */
function sourceRepo(name: string): string {
  const source = join(scratch, name);
  for (const path of ["demo/upload-app", "fixtures/demo/standalone", "scripts/assert-workerd.ts"]) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    cpSync(join(root, path), join(source, path), {
      recursive: true,
      // Installed and generated files are not part of the app.
      filter: (from) => !["node_modules", ".wrangler"].includes(basename(from)),
    });
  }
  cpSync(join(root, ".node-version"), join(source, ".node-version"));
  git(source, ["init", "--quiet"]);
  git(source, ["add", "--all"]);
  git(source, ["commit", "--quiet", "-m", "feat: add the app"]);
  return source;
}

/** `checks.json` naming another decision than the manifest's. */
function otherDecision(): string {
  const checks: unknown = JSON.parse(readFileSync(join(root, CHECKS), "utf8"));
  assert.ok(typeof checks === "object" && checks !== null);
  return `${JSON.stringify({ ...checks, decision: "another-decision" })}\n`;
}

const source = sourceRepo("source");

test("seed --dry-run names the repository, its main, every issue and the decision", async () => {
  const lines = await run(["seed", "--dry-run", "--source-root", source]);

  // The app's one commit, then the commit that makes it stand alone.
  assert.match(lines[0] ?? "", /^main [0-9a-f]{40} \(2 commits, full history\)$/);
  assert.match(lines[1] ?? "", /^todo seed repository demo\/upload-app@main = [0-9a-f]{40}$/);
  assert.equal(
    lines.filter((line) => line.startsWith("todo owner files issue demo/upload-app#")).length,
    3,
  );
  // Each issue's payload as plain text: the body's paragraph breaks are blank lines, not `\\n`.
  const [, second] = manifest.issues;
  assert.ok(second !== undefined);
  const start = lines.indexOf("--- issue demo/upload-app#seed-2 title");
  const end = lines.indexOf("--- end issue demo/upload-app#seed-2");
  assert.deepEqual(lines.slice(start, end + 1), [
    "--- issue demo/upload-app#seed-2 title",
    second.title,
    "--- issue demo/upload-app#seed-2 body",
    ...second.body.split("\n"),
    "--- end issue demo/upload-app#seed-2",
  ]);
  assert.equal(lines.filter((line) => line.startsWith("--- end issue")).length, 3);
  assert.deepEqual(lines.slice(-2), [
    "note decision upload-size-limit (a, b) is opened by an agent's question, not seeded",
    "note planned against an empty instance: no live target exists yet",
  ]);
});

test("reset --dry-run names only the demo repository", async () => {
  assert.deepEqual(await run(["reset", "--dry-run", "--source-root", source]), [
    "todo delete repository demo/upload-app",
    "note no live target exists yet",
  ]);
});

test("another organisation or repository is refused before anything is planned", async () => {
  for (const args of [
    ["--org", "acme"],
    ["--repo", "upload-app-2"],
    ["--org", "demo", "--repo", "other"],
  ]) {
    await assert.rejects(run(["reset", "--dry-run", "--source-root", source, ...args]), /refusing/);
    await assert.rejects(run(["seed", "--dry-run", "--source-root", source, ...args]), /refusing/);
  }
});

test("seed and reset without --dry-run, and unknown commands, are refused", async () => {
  await assert.rejects(run(["seed", "--source-root", source]), /no live target yet/);
  await assert.rejects(run(["reset", "--source-root", source]), /no live target yet/);
  await assert.rejects(run(["deploy", "--source-root", source]), /Usage/);
  await assert.rejects(run(["seed", "extra", "--dry-run", "--source-root", source]), SeedRefusal);
  await assert.rejects(run(["bundle", "--source-root", source]), /needs --out/);
  await assert.rejects(run(["seed", "--dry-run", "--source-root", scratch]), /not a commit/);
  // A revision that Git would read as an option.
  await assert.rejects(
    run(["seed", "--dry-run", "--source-root", source, "--revision=--all"]),
    /--all is not a commit/,
  );
});

test("bundle --dry-run is refused and writes nothing", async () => {
  const absent = join(scratch, "dry-run.bundle");
  await assert.rejects(
    run(["bundle", "--dry-run", "--out", absent, "--source-root", source]),
    /bundle has no dry run/,
  );
  assert.equal(existsSync(absent), false);

  // An existing file keeps its bytes, and the refusal comes before any other check fails.
  const existing = join(scratch, "existing.bundle");
  writeFileSync(existing, "not a bundle");
  await assert.rejects(
    run(["bundle", "--dry-run", "--out", existing, "--source-root", source]),
    /bundle has no dry run/,
  );
  await assert.rejects(
    run(["bundle", "--dry-run", "--out", existing, "--source-root", scratch]),
    /bundle has no dry run/,
  );
  assert.equal(readFileSync(existing, "utf8"), "not a bundle");
});

test("the acceptance checks are read from the selected commit, never the working tree", async () => {
  const repo = sourceRepo("checks");
  const compatible = readFileSync(join(repo, CHECKS), "utf8");
  // HEAD~1 holds compatible checks; HEAD commits checks for another decision.
  writeFileSync(join(repo, CHECKS), otherDecision());
  git(repo, ["commit", "--quiet", "--all", "-m", "chore: rename the decision"]);
  const out = join(scratch, "checks.bundle");

  // A working tree that matches the manifest does not make the incompatible commit pass.
  writeFileSync(join(repo, CHECKS), compatible);
  await assert.rejects(
    run(["bundle", "--out", out, "--source-root", repo]),
    /names a different decision/,
  );
  assert.equal(existsSync(out), false);

  // A working tree that does not match does not make the compatible commit fail.
  writeFileSync(join(repo, CHECKS), otherDecision());
  const lines = await run(["bundle", "--out", out, "--revision", "HEAD~1", "--source-root", repo]);
  assert.match(lines[0] ?? "", /^main [0-9a-f]{40} \(2 commits, full history\)$/);
  const clone = join(scratch, "checks-clone");
  execFileSync("git", ["clone", "--quiet", "--branch", "main", out, clone]);
  assert.equal(readFileSync(join(clone, "acceptance", "checks.json"), "utf8"), compatible);

  // A commit whose checks are not JSON is refused, naming that commit.
  writeFileSync(join(repo, CHECKS), "{");
  git(repo, ["commit", "--quiet", "--all", "-m", "chore: break the checks"]);
  await assert.rejects(run(["seed", "--dry-run", "--source-root", repo]), /are not JSON/);
});

test("the bundle is a repository that installs and runs its checks on its own", async () => {
  const out = join(scratch, "main.bundle");
  const [planned] = await run(["seed", "--dry-run", "--source-root", source]);

  const lines = await run(["bundle", "--out", out, "--source-root", source]);

  assert.equal(lines[0], planned);
  // An empty directory outside any workspace: nothing above it can supply a package or config.
  const clone = join(mkdtempSync(join(tmpdir(), "railhead-demo-standalone-")), "upload-app");
  after(() => rmSync(dirname(clone), { recursive: true, force: true }));
  execFileSync("git", ["clone", "--quiet", "--branch", "main", out, clone]);
  assert.deepEqual(readdirSync(clone).toSorted(), [
    ".git",
    ".node-version",
    "README.md",
    "__tests__",
    "acceptance",
    "assert-workerd.ts",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "src",
    "tsconfig.json",
    "vitest.config.ts",
    "worker-configuration.d.ts",
    "wrangler.jsonc",
  ]);
  for (const file of ["package.json", "tsconfig.json", "vitest.config.ts"]) {
    const text = readFileSync(join(clone, file), "utf8");
    assert.doesNotMatch(text, /catalog:|workspace:|@railhead\/scripts|\.\.\//, file);
  }

  // From the bundle's own lockfile, offline: the versions are the catalog's (standalone.test.ts),
  // so the store the monorepo's install filled holds every package, and the test never reaches
  // the registry. The release-age policy needs registry metadata the store lacks; the monorepo's
  // own install already applied it to these same versions.
  const pnpm = (args: string[]) =>
    execFileSync("pnpm", args, { cwd: clone, encoding: "utf8", timeout: 180_000 });
  pnpm(["install", "--frozen-lockfile", "--offline", "--config.minimum-release-age=0"]);
  pnpm(["run", "typecheck"]);
  // The fixture's own tests and the current option's suite, under workerd.
  // The default reporter lists each file; Vitest picks a terser one when it detects an agent.
  const tests = stripVTControlCharacters(pnpm(["run", "test:run", "--reporter=default"]));
  assert.match(tests, /✓ acceptance\/option-a\.test\.ts/);
  assert.match(tests, /Test Files {2}\d+ passed \(\d+\)\n/);
});
