import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { failureReport, run } from "./cli.ts";
import {
  closedPort,
  FakeBackend,
  issueEvent,
  otherEvent,
  sessionWith,
  signedFor,
} from "./fakeBackend.ts";
import { MAX_BUNDLE_BYTES } from "./history.ts";
import {
  ApprovalNeeded,
  LIVE_LIMITS,
  WriteUncertain,
  type LiveLimits,
  type LiveSession,
} from "./liveTarget.ts";
import { loadManifest, SeedRefusal } from "./manifest.ts";

const root = join(import.meta.dirname, "..", "..");
const manifest = loadManifest(join(root, "fixtures", "demo", "seed.json"));
const scratch = mkdtempSync(join(tmpdir(), "railhead-demo-cli-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const CHECKS = "demo/upload-app/acceptance/checks.json";
const MANIFEST = "fixtures/demo/seed.json";
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
  for (const path of [
    "demo/upload-app",
    MANIFEST,
    "fixtures/demo/standalone",
    "scripts/assert-workerd.ts",
  ]) {
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
    "note planned against an empty instance, so every issue shows as still to file: plan with --target ORIGIN before filing any",
  ]);
});

test("reset --dry-run names only the demo repository", async () => {
  assert.deepEqual(await run(["reset", "--dry-run", "--source-root", source]), [
    "todo delete repository demo/upload-app",
    "note planned without a target: pass --target ORIGIN to run it",
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
  await assert.rejects(run(["seed", "--source-root", source]), /writes only with --target ORIGIN/);
  await assert.rejects(run(["reset", "--source-root", source]), /writes only with --target ORIGIN/);
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
  await assert.rejects(
    run(["seed", "--dry-run", "--source-root", repo]),
    /acceptance checks at [0-9a-f]{40}:demo\/upload-app\/acceptance\/checks\.json is not JSON/,
  );
});

test("checks the standalone app would refuse are refused before any bundle is written", async () => {
  const repo = sourceRepo("suite-versions");
  const committed: unknown = JSON.parse(readFileSync(join(repo, CHECKS), "utf8"));
  assert.ok(typeof committed === "object" && committed !== null);
  const out = join(scratch, "suite-versions.bundle");
  // The current suite's version as a string while current.version stays numeric, then a malformed
  // version on the suite that is not in force.
  for (const [a, b] of [
    ["1", 2],
    [1, 0],
  ]) {
    const checks = {
      ...committed,
      current: { option: "a", version: 1 },
      suites: [
        { option: "a", version: a, file: "acceptance/option-a.test.ts" },
        { option: "b", version: b, file: "acceptance/option-b.test.ts" },
      ],
    };
    writeFileSync(join(repo, CHECKS), `${JSON.stringify(checks)}\n`);
    git(repo, ["commit", "--quiet", "--all", "-m", "chore: change a suite version"]);
    await assert.rejects(
      run(["bundle", "--out", out, "--source-root", repo]),
      /app would refuse its checks: checks\.json suites\[[01]\]: version must be a positive integer/,
    );
    assert.equal(existsSync(out), false);
    await assert.rejects(
      run(["seed", "--dry-run", "--source-root", repo]),
      /app would refuse its checks/,
    );
  }
});

test("the manifest is read from the selected commit, never the working tree", async () => {
  const repo = sourceRepo("manifest");
  const committed = readFileSync(join(repo, MANIFEST), "utf8");
  const [first] = manifest.issues;
  assert.ok(first !== undefined);
  // An uncommitted manifest that renames the first issue and points at another directory.
  const edited: unknown = JSON.parse(committed);
  assert.ok(typeof edited === "object" && edited !== null && "issues" in edited);
  assert.ok(Array.isArray(edited.issues));
  const dirty = {
    ...edited,
    source: "fixtures/demo/standalone",
    issues: edited.issues.map((issue: unknown, index) =>
      index === 0 && typeof issue === "object" && issue !== null
        ? { ...issue, title: "An uncommitted title" }
        : issue,
    ),
  };
  writeFileSync(join(repo, MANIFEST), `${JSON.stringify(dirty)}\n`);

  // The plan, the issues printed and the bundle all follow the committed manifest.
  const lines = await run(["seed", "--dry-run", "--source-root", repo]);
  assert.ok(lines.includes(first.title));
  assert.equal(lines.includes("An uncommitted title"), false);
  const out = join(scratch, "manifest.bundle");
  const [head] = await run(["bundle", "--out", out, "--source-root", repo]);
  assert.equal(head, lines[0]);
  const clone = join(scratch, "manifest-clone");
  execFileSync("git", ["clone", "--quiet", "--branch", "main", out, clone]);
  assert.equal(existsSync(join(clone, "acceptance", "checks.json")), true);

  // An explicit --manifest is the override, read from disk.
  const override = join(scratch, "override.json");
  writeFileSync(override, `${JSON.stringify({ ...dirty, source: manifest.source })}\n`);
  const overridden = await run([
    "seed",
    "--dry-run",
    "--source-root",
    repo,
    "--manifest",
    override,
  ]);
  assert.ok(overridden.includes("An uncommitted title"));

  // A commit without a manifest, or with one that is not JSON, is refused.
  git(repo, ["rm", "--quiet", "--force", MANIFEST]);
  git(repo, ["commit", "--quiet", "-m", "chore: drop the manifest"]);
  await assert.rejects(
    run(["seed", "--dry-run", "--source-root", repo]),
    /has no file fixtures\/demo\/seed\.json/,
  );
  mkdirSync(join(repo, "fixtures", "demo"), { recursive: true });
  writeFileSync(join(repo, MANIFEST), "{");
  git(repo, ["add", MANIFEST]);
  git(repo, ["commit", "--quiet", "-m", "chore: break the manifest"]);
  await assert.rejects(
    run(["seed", "--dry-run", "--source-root", repo]),
    /manifest at [0-9a-f]{40}:fixtures\/demo\/seed\.json is not JSON/,
  );
  // Reset reads no manifest, so a broken one does not block it.
  assert.deepEqual(await run(["reset", "--dry-run", "--source-root", repo]), [
    "todo delete repository demo/upload-app",
    "note planned without a target: pass --target ORIGIN to run it",
  ]);
});

test("a decision scope or issue path the app lacks at the selected commit is refused", async () => {
  const repo = sourceRepo("paths");
  // Both the decision's scope and two issues name src/limits.ts, so the manifest alone still
  // shows the collision after the rename.
  git(repo, ["mv", "demo/upload-app/src/limits.ts", "demo/upload-app/src/limit.ts"]);
  git(repo, ["commit", "--quiet", "-m", "refactor: rename the limits"]);
  const out = join(scratch, "paths.bundle");
  const renamed =
    /[0-9a-f]{40}:demo\/upload-app has no decision\.scope src\/limits\.ts, issues\[0\]\.touches src\/limits\.ts, issues\[1\]\.touches src\/limits\.ts\.$/;

  await assert.rejects(run(["seed", "--dry-run", "--source-root", repo]), renamed);
  await assert.rejects(run(["bundle", "--out", out, "--source-root", repo]), renamed);
  assert.equal(existsSync(out), false);
  // The commit before the rename still plans and bundles.
  const lines = await run(["seed", "--dry-run", "--revision", "HEAD~1", "--source-root", repo]);
  assert.match(lines[0] ?? "", /^main [0-9a-f]{40} \(2 commits, full history\)$/);

  // A path only one issue touches counts too.
  git(repo, ["mv", "demo/upload-app/src/limit.ts", "demo/upload-app/src/limits.ts"]);
  git(repo, ["rm", "--quiet", "demo/upload-app/__tests__/app.test.ts"]);
  git(repo, ["commit", "--quiet", "-m", "test: drop the app test"]);
  await assert.rejects(
    run(["seed", "--dry-run", "--source-root", repo]),
    /has no issues\[2\]\.touches __tests__\/app\.test\.ts\.$/,
  );
  // Reset reads no manifest, so a missing path does not block it.
  assert.deepEqual(await run(["reset", "--dry-run", "--source-root", repo]), [
    "todo delete repository demo/upload-app",
    "note planned without a target: pass --target ORIGIN to run it",
  ]);
});

test("an acceptance suite the app lacks at the selected commit is refused", async () => {
  const repo = sourceRepo("suites");
  // Option b's suite is not in force, so the app's own checks would still pass without it.
  git(repo, ["rm", "--quiet", "demo/upload-app/acceptance/option-b.test.ts"]);
  git(repo, ["commit", "--quiet", "-m", "test: drop option b's suite"]);
  const out = join(scratch, "suites.bundle");
  const missing =
    /[0-9a-f]{40}:demo\/upload-app has no checks\.json suite acceptance\/option-b\.test\.ts\.$/;

  await assert.rejects(run(["seed", "--dry-run", "--source-root", repo]), missing);
  await assert.rejects(run(["bundle", "--out", out, "--source-root", repo]), missing);
  assert.equal(existsSync(out), false);
  // The commit before still plans and bundles.
  const lines = await run(["bundle", "--out", out, "--revision", "HEAD~1", "--source-root", repo]);
  assert.match(lines[0] ?? "", /^main [0-9a-f]{40} \(2 commits, full history\)$/);
  assert.equal(existsSync(out), true);
});

test("a revision whose bundle is above 8 MiB is refused by the dry run and the bundle", async () => {
  const repo = sourceRepo("oversized");
  // Random bytes do not compress, so the bundle carries all of them.
  writeFileSync(
    join(repo, "demo/upload-app/src/fixture.bin"),
    randomBytes(MAX_BUNDLE_BYTES + 1024 * 1024),
  );
  git(repo, ["add", "--all"]);
  git(repo, ["commit", "--quiet", "-m", "test: add a large fixture"]);
  const out = join(scratch, "oversized.bundle");
  const oversized = /The bundle is \d+ bytes; the seed accepts at most 8388608\.$/;

  await assert.rejects(run(["seed", "--dry-run", "--source-root", repo]), oversized);
  await assert.rejects(run(["bundle", "--out", out, "--source-root", repo]), oversized);
  assert.equal(existsSync(out), false);
  // The commit before is within the limit and still plans.
  const lines = await run(["seed", "--dry-run", "--revision", "HEAD~1", "--source-root", repo]);
  assert.match(lines[0] ?? "", /^main [0-9a-f]{40} \(2 commits, full history\)$/);
});

test("reset still plans when the committed checks or the source do not match the manifest", async () => {
  const repo = sourceRepo("reset-checks");
  writeFileSync(join(repo, CHECKS), otherDecision());
  git(repo, ["commit", "--quiet", "--all", "-m", "chore: rename the decision"]);
  const expected = [
    "todo delete repository demo/upload-app",
    "note planned without a target: pass --target ORIGIN to run it",
  ];

  // Seed is refused at this commit; reset, the way out, is not.
  await assert.rejects(run(["seed", "--dry-run", "--source-root", repo]), /different decision/);
  assert.deepEqual(await run(["reset", "--dry-run", "--source-root", repo]), expected);
  // Nor does it need a source repository or a revision that exists.
  assert.deepEqual(
    await run(["reset", "--dry-run", "--source-root", scratch, "--revision", "nowhere"]),
    expected,
  );
  // The target check still applies.
  await assert.rejects(
    run(["reset", "--dry-run", "--source-root", scratch, "--org", "acme"]),
    /refusing "acme\/upload-app"/,
  );
  await assert.rejects(
    run(["reset", "--source-root", scratch]),
    /writes only with --target ORIGIN/,
  );
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

test("the CLI seeds through --target and stops after prepare without --assertion", async () => {
  const backend = new FakeBackend();
  const open = (origin: string): LiveSession => {
    assert.equal(origin, "https://railhead.dev");
    return sessionWith(backend);
  };
  const args = ["seed", "--source-root", source, "--target", "https://railhead.dev"];
  const needed = await run(args, open).then(
    () => assert.fail("the seed should stop after prepare"),
    (thrown: unknown) => thrown,
  );
  assert.ok(needed instanceof ApprovalNeeded);
  assert.equal(needed.action.kind, "demo.seed");
  assert.equal(backend.exists, false);

  const file = join(scratch, "assertion.json");
  const { challengeId } = needed.challenge;
  writeFileSync(file, JSON.stringify({ challengeId, assertion: signedFor(challengeId) }));
  const lines = await run([...args, "--assertion", file], open);
  assert.match(lines[0] ?? "", /^main [0-9a-f]{40} /);
  assert.match(lines[1] ?? "", /^ok {3}seed repository demo\/upload-app@main = [0-9a-f]{40}$/);
  assert.equal(backend.main, needed.action.kind === "demo.seed" ? needed.action.head : null);
  assert.equal(lines.filter((line) => line.startsWith("todo owner files issue")).length, 3);
  assert.equal(
    lines.at(-1),
    "note the plan is a best-effort snapshot, so run one operator at a time against this instance",
  );

  // The dry run reads the live target and writes nothing.
  const planned = await run(
    ["seed", "--dry-run", "--source-root", source, "--target", "https://railhead.dev"],
    open,
  );
  assert.deepEqual(planned.slice(-2), [
    "note planned against https://railhead.dev",
    "note the plan is a best-effort snapshot, so run one operator at a time against this instance",
  ]);
  assert.equal(backend.prepared.length, 1);
});

test("the CLI refuses an assertion without a target or with a dry run, and a plain-text host", async () => {
  const backend = new FakeBackend();
  const file = join(scratch, "unused.json");
  writeFileSync(file, JSON.stringify({ challengeId: "dsc_1", assertion: signedFor("dsc_1") }));
  const open = (): LiveSession => sessionWith(backend);
  await assert.rejects(run(["reset", "--assertion", file], open), /needs --target/);
  await assert.rejects(
    run(["reset", "--dry-run", "--target", "https://railhead.dev", "--assertion", file], open),
    /a dry run has none/,
  );
  await assert.rejects(
    run(
      ["reset", "--target", "https://railhead.dev", "--assertion", join(scratch, "none.json")],
      open,
    ),
    /not a readable JSON file/,
  );
  await assert.rejects(
    run(["reset", "--target", "http://railhead.dev"], (origin) => {
      throw new SeedRefusal(`opened ${origin}`);
    }),
    /https origin/,
  );
  assert.equal(backend.prepared.length, 0);
});

/** Runs `args` until it stops after prepare, and writes the owner's assertion for that challenge. */
async function approve(
  args: readonly string[],
  open: () => LiveSession,
  name: string,
): Promise<string> {
  const needed = await run(args, open).then(
    () => assert.fail("the write should stop after prepare"),
    (thrown: unknown) => thrown,
  );
  assert.ok(needed instanceof ApprovalNeeded);
  const file = join(scratch, name);
  const { challengeId } = needed.challenge;
  writeFileSync(file, JSON.stringify({ challengeId, assertion: signedFor(challengeId) }));
  return file;
}

/** A write timeout short enough that a withheld answer fails the run at once. */
const SHORT: LiveLimits = { ...LIVE_LIMITS, writeMs: 50 };

test("a seed whose answer is lost exits 4, and the next run reads main in place and writes nothing", async () => {
  const backend = new FakeBackend();
  const open = (): LiveSession => sessionWith(backend);
  const args = ["seed", "--source-root", source, "--target", "https://railhead.dev"];
  const file = await approve(args, open, "lost-seed.json");

  backend.withholdNextAnswer = true;
  const lost = await run([...args, "--assertion", file], open, SHORT).then(
    () => assert.fail("the seed should fail without an answer"),
    (thrown: unknown) => thrown,
  );
  assert.ok(lost instanceof WriteUncertain);
  const report = failureReport(lost);
  assert.equal(report.exitCode, 4);
  assert.deepEqual(report.stdout, []);
  assert.equal(report.stderr[0], "demoSeed.perform did not answer within 50 ms.");
  assert.match(
    report.stderr[1] ?? "",
    /^the seed of main [0-9a-f]{40} may have happened and was not repeated; run the same seed again: it reads the target first/,
  );
  assert.deepEqual(backend.performed, ["demo.seed"]);
  const head = backend.main;
  assert.ok(head !== null);

  // The operator reruns the same command: it reads main in place and spends nothing.
  const lines = await run([...args, "--assertion", file], open, SHORT);
  assert.equal(lines[1], `ok   seed repository demo/upload-app@main = ${head}`);
  assert.deepEqual(backend.performed, ["demo.seed"]);
  assert.equal(backend.received.length, 1);
  assert.equal(backend.prepared.length, 1);
});

test("a reset whose answer is lost exits 4, tells the owner to inspect, and is never repeated", async () => {
  const backend = new FakeBackend();
  backend.exists = true;
  backend.main = "a".repeat(40);
  const open = (): LiveSession => sessionWith(backend);
  const args = ["reset", "--target", "https://railhead.dev"];
  const file = await approve(args, open, "lost-reset.json");

  backend.withholdNextAnswer = true;
  const lost = await run([...args, "--assertion", file], open, SHORT).then(
    () => assert.fail("the reset should fail without an answer"),
    (thrown: unknown) => thrown,
  );
  assert.ok(lost instanceof WriteUncertain);
  assert.deepEqual(failureReport(lost), {
    stdout: [],
    stderr: [
      "demoSeed.perform did not answer within 50 ms.",
      "the reset may have happened and was not repeated; inspect the instance with seed --dry-run --target ORIGIN or on the board before approving another reset",
    ],
    exitCode: 4,
  });
  assert.deepEqual(backend.performed, ["demo.reset"]);
  assert.equal(backend.exists, false);

  // Rerunning with the same assertion does not delete again: the challenge is spent.
  await assert.rejects(run([...args, "--assertion", file], open, SHORT), /proof_expired/);
  assert.deepEqual(backend.performed, ["demo.reset"]);
});

test("a dry run whose repository is reset while it plans fails and reports nothing done", async () => {
  const backend = new FakeBackend();
  const open = (): LiveSession => sessionWith(backend);
  const args = ["seed", "--source-root", source, "--target", "https://railhead.dev"];
  const file = await approve(args, open, "concurrent-seed.json");
  await run([...args, "--assertion", file], open);
  assert.deepEqual(backend.performed, ["demo.seed"]);

  // Another operator's reset lands after the plan reads main and before it reads the board.
  backend.onOpenBoard = () => {
    backend.exists = false;
    backend.main = null;
  };
  const changed = await run(["seed", "--dry-run", ...args.slice(1)], open).then(
    () => assert.fail("the plan should fail"),
    (thrown: unknown) => thrown,
  );
  assert.deepEqual(failureReport(changed), {
    stdout: [],
    stderr: [
      "demo/upload-app changed during planning: it was read, then the board did not find it; run again.",
    ],
    exitCode: 2,
  });
  assert.deepEqual(backend.performed, ["demo.seed"]);
});

test("a reset that deletes some forks and then answers internal exits 4 and says to inspect", async () => {
  const backend = new FakeBackend();
  backend.exists = true;
  backend.main = "a".repeat(40);
  backend.forks = ["fork-1", "fork-2"];
  const open = (): LiveSession => sessionWith(backend);
  const args = ["reset", "--target", "https://railhead.dev"];
  const file = await approve(args, open, "partial-reset.json");

  backend.failResetAfterForks = 1;
  const failed = await run([...args, "--assertion", file], open).then(
    () => assert.fail("the reset should fail"),
    (thrown: unknown) => thrown,
  );
  assert.deepEqual(failureReport(failed), {
    stdout: [],
    stderr: [
      "demo.reset failed with internal: The fake backend refused with internal.",
      "the reset may have happened and was not repeated; inspect the instance with seed --dry-run --target ORIGIN or on the board before approving another reset",
    ],
    exitCode: 4,
  });
  // One fork went; the repository and the other fork are still there for the owner to inspect.
  assert.deepEqual(backend.forks, ["fork-2"]);
  assert.equal(backend.exists, true);
});

test("a dry run whose repository is reset and reseeded at another head while it plans exits 2", async () => {
  const backend = new FakeBackend();
  const open = (): LiveSession => sessionWith(backend);
  const args = ["seed", "--source-root", source, "--target", "https://railhead.dev"];
  const file = await approve(args, open, "reseeded-seed.json");
  await run([...args, "--assertion", file], open);
  assert.deepEqual(backend.performed, ["demo.seed"]);

  // Another operator resets and seeds another head after the plan reads main, before the board.
  const other = "b".repeat(40);
  backend.onOpenBoard = () => {
    backend.onOpenBoard = null;
    backend.main = other;
    backend.events = [];
  };
  const changed = await run(["seed", "--dry-run", ...args.slice(1)], open).then(
    () => assert.fail("the plan should fail"),
    (thrown: unknown) => thrown,
  );
  assert.deepEqual(failureReport(changed), {
    stdout: [],
    stderr: ["The repository demo/upload-app changed during planning; run again."],
    exitCode: 2,
  });
  assert.equal(backend.main, other);
  assert.deepEqual(backend.performed, ["demo.seed"]);
});

test("a targeted reset dry run reads the instance first and names what it reports", async () => {
  const backend = new FakeBackend();
  const open = (origin: string): LiveSession => {
    assert.equal(origin, "https://railhead.dev");
    return sessionWith(backend);
  };
  const args = ["reset", "--dry-run", "--target", "https://railhead.dev"];
  const plan = "todo delete repository demo/upload-app";
  assert.deepEqual(await run(args, open), [
    plan,
    "note planned for https://railhead.dev, which reports demo/upload-app not initialized",
  ]);

  // Seeded or not, the plan still deletes; the read only shows what the instance reports.
  backend.exists = true;
  backend.main = "a".repeat(40);
  assert.deepEqual(await run(args, open), [
    plan,
    `note planned for https://railhead.dev, which reports demo/upload-app at main ${"a".repeat(40)}`,
  ]);
  backend.main = null;
  assert.deepEqual(await run(args, open), [
    plan,
    "note planned for https://railhead.dev, which reports demo/upload-app without a main",
  ]);
  assert.deepEqual(backend.prepared, []);
  assert.deepEqual(backend.performed, []);
  assert.equal(backend.exists, true);
});

test("a targeted reset dry run against an instance that refuses the connection prints no plan and exits 1", async () => {
  const port = await closedPort();
  const result = spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "cli.ts"),
      "reset",
      "--dry-run",
      "--target",
      `http://127.0.0.1:${port}`,
    ],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "demoSeed failed: WebSocket connection failed.\n");
});

test("the CLI reports a backend it cannot reach in one line and exits 1", async () => {
  const port = await closedPort();
  const result = spawnSync(
    process.execPath,
    [join(import.meta.dirname, "cli.ts"), "reset", "--target", `http://127.0.0.1:${port}`],
    { encoding: "utf8", timeout: 60_000 },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "demoSeed failed: WebSocket connection failed.\n");
});

test("a board log that stops advancing fails the plan in one line with exit 1", async () => {
  const backend = new FakeBackend();
  const open = (): LiveSession => sessionWith(backend);
  const args = ["seed", "--source-root", source, "--target", "https://railhead.dev"];
  const file = await approve(args, open, "stalled-seed.json");
  await run([...args, "--assertion", file], open);
  backend.events = [otherEvent(1), otherEvent(2)];
  backend.stall = true;
  const failed = await run(["seed", "--dry-run", ...args.slice(1)], open).then(
    () => assert.fail("the plan should fail"),
    (thrown: unknown) => thrown,
  );
  assert.deepEqual(failureReport(failed), {
    stdout: [],
    stderr: ["readEvents stopped at cursor 0 before the log's head 2."],
    exitCode: 1,
  });
});

test("a dry run whose repository is reset and reseeded at the same head while it plans exits 2", async () => {
  const backend = new FakeBackend();
  const open = (): LiveSession => sessionWith(backend);
  const args = ["seed", "--source-root", source, "--target", "https://railhead.dev"];
  const file = await approve(args, open, "same-head-seed.json");
  await run([...args, "--assertion", file], open);
  const head = backend.main;
  assert.ok(head !== null);
  const [task] = manifest.issues;
  assert.ok(task !== undefined);
  backend.events = [issueEvent(1, task.title, task.body)];

  // The plan scans the board, then another operator resets and seeds the same head before the plan
  // reads the board's history again: main is unchanged, the scanned issue is gone.
  let opened = 0;
  backend.onOpenBoard = () => {
    opened += 1;
    if (opened !== 2) return;
    backend.events = [];
    backend.startHistory();
  };
  const changed = await run(["seed", "--dry-run", ...args.slice(1)], open).then(
    () => assert.fail("the plan should fail"),
    (thrown: unknown) => thrown,
  );
  assert.deepEqual(failureReport(changed), {
    stdout: [],
    stderr: ["The repository demo/upload-app changed during planning; run again."],
    exitCode: 2,
  });
  assert.equal(backend.main, head);
  assert.deepEqual(backend.performed, ["demo.seed"]);
});
