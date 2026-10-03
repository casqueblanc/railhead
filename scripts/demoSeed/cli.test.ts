import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { run } from "./cli.ts";
import { SeedRefusal } from "./manifest.ts";

const root = join(import.meta.dirname, "..", "..");
const scratch = mkdtempSync(join(tmpdir(), "railhead-demo-cli-test-"));
const source = join(scratch, "source");
after(() => rmSync(scratch, { recursive: true, force: true }));

// A source repository holding the app's real acceptance tags, so the run does not depend on how
// deep this checkout's history is.
before(() => {
  const acceptance = join(source, "demo", "upload-app", "acceptance");
  mkdirSync(acceptance, { recursive: true });
  copyFileSync(
    join(root, "demo", "upload-app", "acceptance", "checks.json"),
    join(acceptance, "checks.json"),
  );
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Someone",
    GIT_AUTHOR_EMAIL: "someone@example.com",
    GIT_COMMITTER_NAME: "Someone",
    GIT_COMMITTER_EMAIL: "someone@example.com",
  };
  execFileSync("git", ["-C", source, "init", "--quiet"], { env });
  execFileSync("git", ["-C", source, "add", "--all"], { env });
  execFileSync(
    "git",
    ["-C", source, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "feat: add the app"],
    { env },
  );
});

test("seed --dry-run names the repository, its main, every issue and the decision", async () => {
  const lines = await run(["seed", "--dry-run", "--source-root", source]);

  assert.match(lines[0] ?? "", /^main [0-9a-f]{40} \(1 commits, full history\)$/);
  assert.deepEqual(lines.slice(1, 2), ["todo create repository demo/upload-app"]);
  assert.match(lines[2] ?? "", /^todo import main demo\/upload-app@main = [0-9a-f]{40}$/);
  assert.equal(
    lines.filter((line) => line.startsWith("todo file issue demo/upload-app#")).length,
    3,
  );
  assert.equal(
    lines.at(-1),
    "note decision upload-size-limit (A, B) is opened by an agent's question, not seeded",
  );
});

test("reset --dry-run names only the demo repository", async () => {
  assert.deepEqual(await run(["reset", "--dry-run", "--source-root", source]), [
    "todo delete repository demo/upload-app",
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
  await assert.rejects(run(["seed", "--dry-run", "--source-root", scratch]), /acceptance checks/);
});

test("bundle writes a clonable main whose head the dry run predicted", async () => {
  const out = join(scratch, "main.bundle");
  const [planned] = await run(["seed", "--dry-run", "--source-root", source]);

  const lines = await run(["bundle", "--out", out, "--source-root", source]);

  assert.equal(lines[0], planned);
  assert.ok(existsSync(out));
  const clone = join(scratch, "clone");
  execFileSync("git", ["clone", "--quiet", out, clone]);
  assert.deepEqual(readdirSync(clone).toSorted(), [".git", "acceptance"]);
});
