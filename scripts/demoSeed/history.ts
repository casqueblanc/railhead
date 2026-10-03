// The demo repository's main: the full history of one directory of a source Git repository,
// rewritten so that directory is the root, as `git subtree split` would.
//
// The rewrite is deterministic. Each source commit that changed the directory becomes one commit
// with the directory's tree, the source commit's subject and dates, and a fixed demo author, so the
// same source revision always yields the same head. That is what lets a repeated seed recognise a
// main it already imported, and a reset followed by a seed land on the same base.
//
// Nothing is written to the source repository. The commits are made in a scratch repository that
// borrows the source's objects through `objects/info/alternates`, and leave it only as a bundle.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SeedRefusal } from "./manifest.ts";

/** The author and committer of every imported commit. */
export const DEMO_AUTHOR = { name: "Railhead demo", email: "demo@railhead.dev" } as const;
/** The branch the bundle carries. */
export const MAIN_BRANCH = "main";
/** The most commits an import may hold. The demo history is small; more means the wrong source. */
export const MAX_IMPORT_COMMITS = 500;

/** What an import produced. */
export interface ImportedHistory {
  /** The head of the imported main. */
  readonly head: string;
  /** How many commits it holds, all reachable from `head`. */
  readonly commits: number;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;
// Commit and tree lookups are small; a source this slow is broken, not busy.
const GIT_TIMEOUT_MS = 60_000;

/**
 * Computes the rewritten history of `directory` at `revision` in the repository at `sourceRoot`
 * without writing a bundle, for a dry run.
 */
export function planHistory(
  sourceRoot: string,
  revision: string,
  directory: string,
): ImportedHistory {
  return withScratch(sourceRoot, (scratch) => rewrite(sourceRoot, scratch, revision, directory));
}

/**
 * Rewrites the history of `directory` at `revision` and writes it to `bundlePath` as a Git bundle
 * holding `main`. The owner pushes that bundle to the demo repository's main.
 */
export function writeHistoryBundle(
  sourceRoot: string,
  revision: string,
  directory: string,
  bundlePath: string,
): ImportedHistory {
  return withScratch(sourceRoot, (scratch) => {
    const history = rewrite(sourceRoot, scratch, revision, directory);
    git(scratch, ["update-ref", `refs/heads/${MAIN_BRANCH}`, history.head]);
    git(scratch, ["bundle", "create", bundlePath, `refs/heads/${MAIN_BRANCH}`]);
    return history;
  });
}

function rewrite(
  sourceRoot: string,
  scratch: string,
  revision: string,
  directory: string,
): ImportedHistory {
  if (git(sourceRoot, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    throw new SeedRefusal(
      "The source repository is a shallow clone; the import needs its full history.",
    );
  }
  const tip = resolve(sourceRoot, `${revision}^{commit}`, `${revision} is not a commit.`);
  const sources = git(sourceRoot, ["rev-list", "--reverse", "--topo-order", tip, "--", directory])
    .split("\n")
    .filter((line) => line !== "");
  if (sources.length === 0) {
    throw new SeedRefusal(`No commit up to ${revision} changes ${directory}.`);
  }
  if (sources.length > MAX_IMPORT_COMMITS) {
    throw new SeedRefusal(`${directory} has more than ${MAX_IMPORT_COMMITS} commits to import.`);
  }

  let head: string | null = null;
  let previousTree: string | null = null;
  let commits = 0;
  for (const source of sources) {
    const tree = treeOf(sourceRoot, source, directory);
    // A commit that deleted the directory, or a merge that left it as it was, adds nothing.
    if (tree === null || tree === previousTree) continue;
    const [subject = "", authorDate = "", committerDate = ""] = git(sourceRoot, [
      "show",
      "-s",
      "--format=%s%x00%ad%x00%cd",
      "--date=raw",
      source,
    ])
      .trimEnd()
      .split("\0");
    const parents: string[] = head === null ? [] : ["-p", head];
    const commit: string = git(
      scratch,
      ["commit-tree", "--no-gpg-sign", tree, ...parents, "-m", subject || "Update the demo app"],
      {
        GIT_AUTHOR_NAME: DEMO_AUTHOR.name,
        GIT_AUTHOR_EMAIL: DEMO_AUTHOR.email,
        GIT_AUTHOR_DATE: authorDate,
        GIT_COMMITTER_NAME: DEMO_AUTHOR.name,
        GIT_COMMITTER_EMAIL: DEMO_AUTHOR.email,
        GIT_COMMITTER_DATE: committerDate,
      },
    ).trim();
    head = commit;
    previousTree = tree;
    commits += 1;
  }
  if (head === null || !COMMIT_SHA.test(head)) {
    throw new SeedRefusal(`${directory} does not exist at any commit up to ${revision}.`);
  }
  return { head, commits };
}

function treeOf(root: string, commit: string, directory: string): string | null {
  try {
    const tree = git(root, ["rev-parse", "--verify", "--quiet", `${commit}:${directory}`]).trim();
    return git(root, ["cat-file", "-t", tree]).trim() === "tree" ? tree : null;
  } catch {
    // `--verify --quiet` exits 1 with no output when the path is absent at that commit.
    return null;
  }
}

function resolve(root: string, spec: string, message: string): string {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", spec]).trim();
  } catch (error) {
    throw new SeedRefusal(message, { cause: error });
  }
}

function withScratch<T>(sourceRoot: string, work: (scratch: string) => T): T {
  const objects = git(sourceRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).trim();
  const scratch = mkdtempSync(join(tmpdir(), "railhead-demo-seed-"));
  try {
    git(scratch, ["init", "--quiet", "--bare", "--initial-branch", MAIN_BRANCH]);
    writeFileSync(join(scratch, "objects", "info", "alternates"), `${join(objects, "objects")}\n`);
    return work(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function git(cwd: string, args: readonly string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    // A user's global hooks, templates or signing settings must not change what is written.
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
