import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEMO_AUTHOR, planHistory, writeHistoryBundle } from "./history.ts";
import { SeedRefusal } from "./manifest.ts";

const scratch = mkdtempSync(join(tmpdir(), "railhead-demo-seed-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...env },
  }).trim();
}

let commitCount = 0;
function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, ["add", "--all"]);
  commitCount += 1;
  const date = `${1_700_000_000 + commitCount * 60} +0000`;
  git(repo, ["-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", message], {
    GIT_AUTHOR_NAME: "Someone",
    GIT_AUTHOR_EMAIL: "someone@example.com",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "Someone",
    GIT_COMMITTER_EMAIL: "someone@example.com",
    GIT_COMMITTER_DATE: date,
  });
  return git(repo, ["rev-parse", "HEAD"]);
}

/** A monorepo whose `apps/demo` changed in three commits, with unrelated commits between them. */
function sourceRepo(name: string): string {
  const repo = join(scratch, name);
  mkdirSync(repo);
  git(repo, ["init", "--quiet", "--initial-branch", "main"]);
  commit(repo, { "README.md": "monorepo\n" }, "chore: start");
  commit(repo, { "apps/demo/index.ts": "export const v = 1;\n" }, "feat(demo): add the app");
  commit(repo, { "other/x.ts": "x\n" }, "chore: unrelated");
  commit(repo, { "apps/demo/index.ts": "export const v = 2;\n" }, "fix(demo): bump");
  commit(repo, { "apps/demo/README.md": "demo\n" }, "docs(demo): describe it");
  return repo;
}

test("the import keeps every commit that changed the directory, rooted at it", () => {
  const source = sourceRepo("normal");
  const bundle = join(scratch, "normal.bundle");
  const refsBefore = git(source, ["for-each-ref"]);

  const history = writeHistoryBundle(source, "HEAD", "apps/demo", bundle);

  assert.equal(history.commits, 3);
  // Every Git version checks out a bundle that records HEAD; some check out nothing without it.
  assert.deepEqual(
    execFileSync("git", ["bundle", "list-heads", bundle], { encoding: "utf8" }),
    `${history.head} HEAD\n${history.head} refs/heads/main\n`,
  );
  const clone = join(scratch, "normal-clone");
  execFileSync("git", ["clone", "--quiet", bundle, clone]);
  assert.equal(git(clone, ["rev-parse", "HEAD"]), history.head);
  assert.deepEqual(git(clone, ["log", "--format=%s|%an <%ae>"]).split("\n"), [
    `docs(demo): describe it|${DEMO_AUTHOR.name} <${DEMO_AUTHOR.email}>`,
    `fix(demo): bump|${DEMO_AUTHOR.name} <${DEMO_AUTHOR.email}>`,
    `feat(demo): add the app|${DEMO_AUTHOR.name} <${DEMO_AUTHOR.email}>`,
  ]);
  assert.deepEqual(git(clone, ["ls-tree", "--name-only", "HEAD"]).split("\n"), [
    "README.md",
    "index.ts",
  ]);
  assert.equal(git(clone, ["rev-parse", "--is-shallow-repository"]), "false");
  // The rewritten commits live only in the bundle: the source gained no ref and no commit.
  assert.equal(git(source, ["for-each-ref"]), refsBefore);
  assert.throws(() => git(source, ["cat-file", "-e", history.head]));
});

test("the same revision always yields the same head, and an earlier one a prefix of it", () => {
  const source = sourceRepo("repeat");
  const first = planHistory(source, "HEAD", "apps/demo");
  const second = planHistory(source, "HEAD", "apps/demo");
  const earlier = planHistory(source, "HEAD~1", "apps/demo");

  assert.deepEqual(first, second);
  assert.equal(earlier.commits, 2);
  assert.notEqual(earlier.head, first.head);
  const bundle = join(scratch, "repeat.bundle");
  writeHistoryBundle(source, "HEAD", "apps/demo", bundle);
  const clone = join(scratch, "repeat-clone");
  execFileSync("git", ["clone", "--quiet", bundle, clone]);
  assert.equal(git(clone, ["rev-parse", "HEAD~1"]), earlier.head);
});

test("a revision before the directory existed, or a missing directory, is refused", () => {
  const source = sourceRepo("missing");

  assert.throws(() => planHistory(source, "HEAD~4", "apps/demo"), /No commit up to HEAD~4 changes/);
  assert.throws(() => planHistory(source, "HEAD", "apps/none"), SeedRefusal);
  assert.throws(() => planHistory(source, "no-such-ref", "apps/demo"), /not a commit/);
});

test("a shallow clone is refused rather than imported as a truncated history", () => {
  const source = sourceRepo("deep");
  const shallow = join(scratch, "shallow");
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${source}`, shallow]);

  assert.throws(() => planHistory(shallow, "HEAD", "apps/demo"), /shallow clone/);
});
