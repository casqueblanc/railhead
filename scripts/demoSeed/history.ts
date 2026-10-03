// The demo repository's main: the full history of one directory of a source Git repository,
// rewritten so that directory is the root, as `git subtree split` would, followed by one commit
// that applies an overlay of files the directory needs to stand alone.
//
// The rewrite is deterministic. Each source commit that changed the directory becomes one commit
// with the directory's tree, the source commit's subject and dates, and a fixed demo author, so the
// same source revision always yields the same head. That is what lets a repeated seed recognise a
// main it already imported, and a reset followed by a seed land on the same base. A commit that
// deleted the directory becomes a commit with an empty tree, so a later re-addition is kept too.
//
// Nothing is written to the source repository. The commits are made in a scratch repository that
// borrows the source's objects through `objects/info/alternates`, and leave it only as a bundle.
// Every file is read from the source commit, never from a working tree.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { SeedRefusal } from "./manifest.ts";

/** The author and committer of every imported commit. */
export const DEMO_AUTHOR = { name: "Railhead demo", email: "demo@railhead.dev" } as const;
/** The branch the bundle carries. */
export const MAIN_BRANCH = "main";
/** The most commits an import may hold. The demo history is small; more means the wrong source. */
export const MAX_IMPORT_COMMITS = 500;
/**
 * The largest bundle the seed sends. It restates the backend's `MAX_DEMO_BUNDLE_BYTES` (#149),
 * which refuses a larger one; the scripts do not depend on `@railhead/shared`.
 */
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;

/** One file of the overlay applied on top of the imported directory. */
export interface OverlayEntry {
  /** The path in the imported repository. */
  readonly path: string;
  /** The source repository path whose content it takes at the same commit, or `null` to delete it. */
  readonly from: string | null;
}

/** What to import: the history of `directory` up to `commit`, then `overlay` as one more commit. */
export interface ImportRequest {
  readonly sourceRoot: string;
  /** A full commit SHA, from `resolveCommit`. */
  readonly commit: string;
  readonly directory: string;
  readonly overlay: readonly OverlayEntry[];
  /** The subject of the overlay commit. */
  readonly overlaySubject: string;
}

/** What an import produced. */
export interface ImportedHistory {
  /** The head of the imported main. */
  readonly head: string;
  /** How many commits it holds, all reachable from `head`. */
  readonly commits: number;
}

/**
 * The imported main as the seed sends it: a v2 Git bundle whose only ref is `refs/heads/main` at
 * `head`, with no prerequisites, so it carries every object main reaches. This is the input the
 * backend's `demo.seed` takes (#149): the bundle bytes and the head the owner approved.
 */
export interface MainBundle extends ImportedHistory {
  readonly bytes: Uint8Array;
}

const BUNDLE_SIGNATURE = "# v2 git bundle\n";
const BUNDLE_REF = `refs/heads/${MAIN_BRANCH}`;
/** The longest bundle header read before giving up on finding its end, as the backend does. */
const MAX_BUNDLE_HEADER_BYTES = 4096;

const COMMIT_SHA = /^[0-9a-f]{40}$/;
// `ls-tree -z` prints `<mode> <type> <object>\t<path>\0`.
const TREE_ENTRY = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40})\t/;
// Commit and tree lookups are small; a source this slow is broken, not busy.
const GIT_TIMEOUT_MS = 60_000;

/** Resolves `revision` in the repository at `sourceRoot` to a full commit SHA, once. */
export function resolveCommit(sourceRoot: string, revision: string): string {
  // Git would read a leading `-` as an option.
  if (revision === "" || revision.startsWith("-")) {
    throw new SeedRefusal(`${revision} is not a commit.`);
  }
  let commit: string;
  try {
    commit = git(sourceRoot, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`]).trim();
  } catch (error) {
    throw new SeedRefusal(`${revision} is not a commit.`, { cause: error });
  }
  if (!COMMIT_SHA.test(commit)) throw new SeedRefusal(`${revision} is not a commit.`);
  return commit;
}

/** Reads the file at `path` as it is in `commit`, refusing when that commit has no such file. */
export function readFileAt(sourceRoot: string, commit: string, path: string): string {
  const entry = entryAt(sourceRoot, commit, path);
  if (entry?.type !== "blob") throw new SeedRefusal(`${commit} has no file ${path}.`);
  return git(sourceRoot, ["cat-file", "blob", entry.object]);
}

/** Computes the rewritten history without writing a bundle, for a dry run. */
export function planHistory(request: ImportRequest): ImportedHistory {
  return withScratch(request.sourceRoot, (scratch) => rewrite(request, scratch));
}

/**
 * Rewrites the history into a `MainBundle`, refusing one above `maxBytes`. Its only ref is
 * `refs/heads/main`, so a clone of it needs `--branch main` to check anything out.
 */
export function buildMainBundle(
  request: ImportRequest,
  maxBytes: number = MAX_BUNDLE_BYTES,
): MainBundle {
  return withScratch(request.sourceRoot, (scratch) => {
    const history = rewrite(request, scratch);
    git(scratch, ["update-ref", BUNDLE_REF, history.head]);
    const path = join(scratch, "main.bundle");
    // The backend accepts exactly one ref, so no `HEAD` beside main.
    git(scratch, ["bundle", "create", path, BUNDLE_REF]);
    const bytes = new Uint8Array(readFileSync(path));
    if (bytes.length > maxBytes) {
      throw new SeedRefusal(
        `The bundle is ${bytes.length} bytes; the seed accepts at most ${maxBytes}.`,
      );
    }
    if (bundleHead(bytes) !== history.head) {
      throw new Error(`git bundle create did not write main at ${history.head} alone.`);
    }
    return { ...history, bytes };
  });
}

/** Writes `buildMainBundle`'s bundle to `bundlePath` for the owner to send to the seed. */
export function writeHistoryBundle(request: ImportRequest, bundlePath: string): ImportedHistory {
  const { head, commits, bytes } = buildMainBundle(request);
  writeFileSync(bundlePath, bytes);
  return { head, commits };
}

/**
 * The head of a v2 Git bundle whose only ref is `refs/heads/main` and that has no prerequisites,
 * or `null` for any other input. The backend reads a bundle by the same rules before importing it.
 */
export function bundleHead(bytes: Uint8Array): string | null {
  const limit = Math.min(bytes.length, MAX_BUNDLE_HEADER_BYTES);
  let end = -1;
  for (let i = 1; i < limit; i += 1) {
    if (bytes[i] === 0x0a && bytes[i - 1] === 0x0a) {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  const header = new TextDecoder().decode(bytes.subarray(0, end));
  if (!header.startsWith(BUNDLE_SIGNATURE)) return null;
  const lines = header.slice(BUNDLE_SIGNATURE.length, -1).split("\n");
  const [only, ...rest] = lines;
  if (only === undefined || rest.length > 0) return null;
  const [sha = "", ref, ...extra] = only.split(" ");
  return COMMIT_SHA.test(sha) && ref === BUNDLE_REF && extra.length === 0 ? sha : null;
}

function rewrite(request: ImportRequest, scratch: string): ImportedHistory {
  const { sourceRoot, commit: tip, directory } = request;
  if (git(sourceRoot, ["rev-parse", "--is-shallow-repository"]).trim() !== "false") {
    throw new SeedRefusal(
      "The source repository is a shallow clone; the import needs its full history.",
    );
  }
  const sources = git(sourceRoot, ["rev-list", "--reverse", "--topo-order", tip, "--", directory])
    .split("\n")
    .filter((line) => line !== "");
  if (sources.length === 0) {
    throw new SeedRefusal(`No commit up to ${tip} changes ${directory}.`);
  }
  if (sources.length > MAX_IMPORT_COMMITS) {
    throw new SeedRefusal(`${directory} has more than ${MAX_IMPORT_COMMITS} commits to import.`);
  }

  const emptyTree = git(scratch, ["mktree"], {}, "").trim();
  let head: string | null = null;
  let previousTree: string | null = null;
  let commits = 0;
  for (const source of sources) {
    // A commit that deleted the directory imports as an empty tree, once there is history to
    // delete from. A merge that left the directory as it was adds nothing.
    const tree = treeOf(sourceRoot, source, directory) ?? (head === null ? null : emptyTree);
    if (tree === null || tree === previousTree) continue;
    head = commitTree(scratch, tree, head, metadataOf(sourceRoot, source));
    previousTree = tree;
    commits += 1;
  }
  if (head === null || previousTree === null || previousTree === emptyTree) {
    throw new SeedRefusal(`${directory} does not exist at ${tip}.`);
  }
  if (request.overlay.length > 0) {
    const tree = overlayTree(request, scratch, previousTree);
    const { authorDate, committerDate } = metadataOf(sourceRoot, tip);
    head = commitTree(scratch, tree, head, {
      subject: request.overlaySubject,
      authorDate,
      committerDate,
    });
    commits += 1;
  }
  if (!COMMIT_SHA.test(head)) throw new Error(`git commit-tree printed no commit for ${tip}.`);
  return { head, commits };
}

interface CommitMetadata {
  readonly subject: string;
  readonly authorDate: string;
  readonly committerDate: string;
}

function metadataOf(root: string, commit: string): CommitMetadata {
  const [subject = "", authorDate = "", committerDate = ""] = git(root, [
    "show",
    "-s",
    // The source's own config still applies, so override what it could change in this output.
    "--no-show-signature",
    "--encoding=UTF-8",
    "--format=%s%x00%ad%x00%cd",
    "--date=raw",
    commit,
  ])
    .trimEnd()
    .split("\0");
  return { subject: subject || "Update the demo app", authorDate, committerDate };
}

function commitTree(
  scratch: string,
  tree: string,
  parent: string | null,
  metadata: CommitMetadata,
): string {
  const parents = parent === null ? [] : ["-p", parent];
  return git(scratch, ["commit-tree", "--no-gpg-sign", tree, ...parents, "-m", metadata.subject], {
    GIT_AUTHOR_NAME: DEMO_AUTHOR.name,
    GIT_AUTHOR_EMAIL: DEMO_AUTHOR.email,
    GIT_AUTHOR_DATE: metadata.authorDate,
    GIT_COMMITTER_NAME: DEMO_AUTHOR.name,
    GIT_COMMITTER_EMAIL: DEMO_AUTHOR.email,
    GIT_COMMITTER_DATE: metadata.committerDate,
  }).trim();
}

/** `tree` with the overlay applied, every added file taken from the source at the import's tip. */
function overlayTree(request: ImportRequest, scratch: string, tree: string): string {
  // A private index in the bare scratch repository; the source's index is never touched.
  const env = { GIT_INDEX_FILE: join(scratch, "overlay-index") };
  git(scratch, ["read-tree", tree], env);
  const lines = request.overlay.map(({ path, from }) => {
    if (from === null) {
      if (git(scratch, ["ls-files", "--", path], env).trim() === "") {
        throw new SeedRefusal(`The overlay removes ${path}, which ${request.directory} lacks.`);
      }
      // Mode 0 removes the entry.
      return `0 ${"0".repeat(40)}\t${path}\n`;
    }
    const entry = entryAt(request.sourceRoot, request.commit, from);
    if (entry?.type !== "blob") {
      throw new SeedRefusal(`The overlay needs ${from}, which ${request.commit} lacks.`);
    }
    return `${entry.mode} ${entry.object}\t${path}\n`;
  });
  git(scratch, ["update-index", "--index-info"], env, lines.join(""));
  return git(scratch, ["write-tree"], env).trim();
}

/** The tree of `directory` at `commit`, or `null` when that commit has no such directory. */
function treeOf(root: string, commit: string, directory: string): string | null {
  const entry = entryAt(root, commit, directory);
  return entry?.type === "tree" ? entry.object : null;
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly object: string;
}

/**
 * The entry at `path` in `commit`, or `null` when the path is absent. `ls-tree` prints nothing for
 * an absent path, so any failure to read the commit or its trees throws instead.
 */
function entryAt(root: string, commit: string, path: string): TreeEntry | null {
  const output = git(root, ["ls-tree", "-z", "--full-tree", commit, "--", path]);
  if (output === "") return null;
  const match = TREE_ENTRY.exec(output);
  if (match === null) throw new Error(`Unexpected git ls-tree output for ${path}.`);
  const [, mode = "", type = "", object = ""] = match;
  return { mode, type, object };
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

function git(
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = {},
  input?: string,
): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: { ...isolatedEnv(), ...env },
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(input === undefined ? {} : { input }),
  });
}

/**
 * The caller's environment without its Git settings. A user's global or system config, a `git -c`
 * passed down from a parent Git process, or a hook's `GIT_DIR` must not change what is read or
 * written, so the same revision yields the same head on every machine.
 */
function isolatedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("GIT_")) env[name] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}
