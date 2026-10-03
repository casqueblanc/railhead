// Runs the backend's merge commands (`packages/railhead-backend/src/train/merge/script.ts`) with
// real Git against local repositories, as the merge sandbox would. The backend's own tests run in
// workerd, which cannot start a process, so this suite lives with the other `node --test` suites.
//
// Every repository and the merge's working directory live under one temporary directory, Git reads
// no global or system configuration, and remotes are `file://` URLs, so nothing depends on the
// machine's state or the network. Faults Git cannot be made to produce on demand are injected by
// a `git` wrapper on `PATH` that fails one subcommand and runs real Git for every other.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  CONFLICT_EXIT,
  FETCH_FAILED_EXIT,
  NO_MERGE_BASE_EXIT,
  binaryCommand,
  fetchCommand,
  initCommand,
  mergeCommand,
  parseBinary,
  parseCommit,
  parsePartner,
  partnerCommand,
  pushCommand,
  type FetchTarget,
} from "../packages/railhead-backend/src/train/merge/script.ts";

const SECONDS = 60;
const REF = "refs/heads/candidate/mrg_test/merge";
const ABSENT = "f".repeat(40);

let root = "";
let env: NodeJS.ProcessEnv = {};
let realGit = "";

/** Runs Git in `cwd` for building fixtures, and returns what it printed, trimmed. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
}

/** Writes `files` in the work repository, commits them on the current branch and returns the commit. */
function commit(files: Record<string, string | Buffer>, message: string): string {
  const work = join(root, "work");
  for (const [path, content] of Object.entries(files)) writeFileSync(join(work, path), content);
  git(work, "add", "--all");
  git(work, "commit", "-q", "-m", message);
  return git(work, "rev-parse", "HEAD");
}

/** A bare repository holding exactly `branch` of the work repository, and its `file://` URL. */
function publish(name: string, branch: string): string {
  const path = join(root, `${name}.git`);
  rmSync(path, { recursive: true, force: true });
  git(root, "init", "-q", "--bare", path);
  git(join(root, "work"), "push", "-q", path, `${branch}:refs/heads/${branch}`);
  return `file://${path}`;
}

/** A fork holding only `branch`, as a fetch target of the branch's commit. */
function pin(branch: string): FetchTarget {
  return {
    url: publish(`fork-${branch}`, branch),
    commit: git(join(root, "work"), "rev-parse", branch),
  };
}

/** Runs one merge command the way the sandbox does, optionally with a faulty `git` first on `PATH`. */
function run(command: string, fault?: string): { status: number | null; stdout: string } {
  const path = fault === undefined ? env.PATH : `${faultBin(fault)}:${env.PATH ?? ""}`;
  const result = spawnSync("sh", ["-c", command], {
    env: { ...env, PATH: path },
    encoding: "utf8",
    timeout: 120_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout };
}

/** A directory holding a `git` that exits 128 for `subcommand` and runs real Git otherwise. */
function faultBin(subcommand: string): string {
  const dir = join(root, `fault-${subcommand}`);
  mkdirSync(dir, { recursive: true });
  const wrapper = join(dir, "git");
  writeFileSync(
    wrapper,
    `#!/bin/sh\n[ "$1" = ${subcommand} ] && { echo "fatal: injected" >&2; exit 128; }\nexec '${realGit}' "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  return dir;
}

/**
 * A `timeout` for machines without GNU coreutils: `timeout [-k grace] seconds command...`, exiting
 * 124 when the command outlived its seconds. The watcher's streams are closed so a lingering
 * `sleep` cannot hold the command's output open.
 */
function timeoutShim(): string {
  const dir = join(root, "timeout-shim");
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "timeout");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      '[ "$1" = "-k" ] && shift 2',
      'secs=$1; shift; "$@" & child=$!',
      '( sleep "$secs"; kill -TERM "$child" ) >/dev/null 2>&1 & watcher=$!',
      'wait "$child"; status=$?',
      'if kill "$watcher" 2>/dev/null; then exit "$status"; fi',
      "exit 124",
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
  return dir;
}

function hasGnuTimeout(): boolean {
  const probe = spawnSync("timeout", ["--version"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.includes("GNU coreutils");
}

/** Starts a fresh merge working directory, as each compose does. */
function init(): void {
  assert.equal(run(initCommand(SECONDS)).status, 0);
}

before(() => {
  root = mkdtempSync(join(tmpdir(), "railhead-merge-git-"));
  const basePath = process.env.PATH ?? "";
  env = {
    PATH: hasGnuTimeout() ? basePath : `${timeoutShim()}:${basePath}`,
    HOME: root,
    // macOS's Git launcher caches its tool lookup here; without it every call takes ~200 ms.
    TMPDIR: process.env.TMPDIR,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@railhead.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@railhead.invalid",
    RAILHEAD_MERGE_DIR: join(root, "merge"),
  };
  realGit = execFileSync("sh", ["-c", "command -v git"], { env, encoding: "utf8" }).trim();
  git(root, "init", "-q", "-b", "main", "work");
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("merge commands with real Git", () => {
  let base = "";
  let mainUrl = "";
  let main = "";

  before(() => {
    const work = join(root, "work");
    base = commit(
      { "shared.txt": "one\ntwo\nthree\n", "logo.bin": Buffer.from([0, 1, 2]) },
      "base",
    );
    main = commit({ "main.txt": "main\n" }, "main");
    mainUrl = publish("main", "main");
    git(work, "checkout", "-q", "-b", "a", main);
    commit(
      { "a.txt": "a\n", "shared.txt": "one\nA\nthree\n", "logo.bin": Buffer.from([0, 5, 5]) },
      "a",
    );
    git(work, "checkout", "-q", "-b", "b", main);
    commit({ "b.txt": "b\n" }, "b");
    git(work, "checkout", "-q", "-b", "c", main);
    commit({ "shared.txt": "one\nC\nthree\n", "logo.bin": Buffer.from([0, 9, 9]) }, "c");
    git(work, "checkout", "-q", "main");
  });

  test("composes clean pins and pushes the result to the candidate ref only", () => {
    const [a, b] = [pin("a"), pin("b")];
    init();
    assert.equal(run(fetchCommand([{ url: mainUrl, commit: main }, a, b], 16, SECONDS)).status, 0);

    const merged = run(mergeCommand(main, [a.commit, b.commit], SECONDS));
    assert.equal(merged.status, 0);
    const candidate = parseCommit(merged.stdout);
    assert.ok(candidate !== null);
    assert.equal(run(pushCommand(mainUrl, candidate, REF, SECONDS)).status, 0);

    const remote = join(root, "main.git");
    assert.equal(git(remote, "rev-parse", REF), candidate);
    assert.equal(git(remote, "rev-parse", "refs/heads/main"), main);
    assert.equal(git(remote, "show", `${candidate}:a.txt`), "a");
    assert.equal(git(remote, "show", `${candidate}:b.txt`), "b");
    // Pins merge in order, each with its own merge commit on main.
    assert.equal(git(remote, "rev-list", "--count", `${main}..${candidate}`), "4");
  });

  test("reports the conflicting pin, its partner and the text paths", () => {
    const [b, a, c] = [pin("b"), pin("a"), pin("c")];
    init();
    assert.equal(
      run(fetchCommand([{ url: mainUrl, commit: main }, b, a, c], 16, SECONDS)).status,
      0,
    );

    // Pin 3 (c) conflicts; b and a merged cleanly before it.
    assert.equal(
      run(mergeCommand(main, [b.commit, a.commit, c.commit], SECONDS)).status,
      CONFLICT_EXIT + 3,
    );

    const partner = run(partnerCommand(c.commit, [main, b.commit, a.commit], SECONDS));
    assert.equal(partner.status, 0);
    const found = parsePartner(partner.stdout);
    assert.ok(found !== null && found.kind === "partner");
    // Partner 2 is a, the second earlier pin after main.
    assert.equal(found.index, 2);
    const paths = [...new Set(found.entries.map((entry) => entry.path))].toSorted();
    assert.deepEqual(paths, ["logo.bin", "shared.txt"]);

    const pairs = paths.map((path) => {
      const ours = found.entries.find((entry) => entry.path === path && entry.stage === 2);
      const theirs = found.entries.find((entry) => entry.path === path && entry.stage === 3);
      assert.ok(ours !== undefined && theirs !== undefined);
      return [ours.object, theirs.object] as const;
    });
    const binary = run(binaryCommand(pairs, SECONDS));
    assert.equal(binary.status, 0);
    // logo.bin is binary; shared.txt is text.
    assert.deepEqual(parseBinary(binary.stdout, pairs.length), new Set([0]));
  });

  test("reports partner none when no single earlier commit conflicts", () => {
    const [a, b] = [pin("a"), pin("b")];
    init();
    assert.equal(run(fetchCommand([{ url: mainUrl, commit: main }, a, b], 16, SECONDS)).status, 0);

    const partner = run(partnerCommand(b.commit, [main, a.commit], SECONDS));
    assert.equal(partner.status, 0);
    assert.deepEqual(parsePartner(partner.stdout), { kind: "none" });
  });

  test("reports no merge base within a shallow depth, and finds it deeper", () => {
    const work = join(root, "work");
    git(work, "checkout", "-q", "-b", "deep", main);
    for (let n = 0; n < 20; n += 1) commit({ "main.txt": `main ${n}\n` }, `deep ${n}`);
    const deep = git(work, "rev-parse", "HEAD");
    git(work, "checkout", "-q", "-b", "old", base);
    const old = commit({ "old.txt": "old\n" }, "old");
    git(work, "checkout", "-q", "main");
    const deepUrl = publish("deep", "deep");
    const target = { url: publish("fork-old", "old"), commit: old };

    init();
    const targets = [{ url: deepUrl, commit: deep }, target];
    assert.equal(run(fetchCommand(targets, 16, SECONDS)).status, NO_MERGE_BASE_EXIT);
    assert.equal(run(fetchCommand(targets, 128, SECONDS)).status, 0);
  });

  test("reports which target could not be fetched", () => {
    const a = pin("a");
    init();
    assert.equal(
      run(fetchCommand([{ url: mainUrl, commit: main }, a, { ...a, commit: ABSENT }], 16, SECONDS))
        .status,
      FETCH_FAILED_EXIT + 2,
    );
    init();
    assert.equal(
      run(fetchCommand([{ url: mainUrl, commit: ABSENT }, a], 16, SECONDS)).status,
      FETCH_FAILED_EXIT,
    );
  });

  test("reports a failing git merge-base as an error, never as a missing merge base", () => {
    const a = pin("a");
    init();
    const fetched = run(
      fetchCommand([{ url: mainUrl, commit: main }, a], 16, SECONDS),
      "merge-base",
    );
    assert.equal(fetched.status, 2);
  });

  test("reports a merge that fails without unmerged entries as an error, never a conflict", () => {
    const [a, b] = [pin("a"), pin("b")];
    init();
    assert.equal(run(fetchCommand([{ url: mainUrl, commit: main }, a, b], 16, SECONDS)).status, 0);

    assert.equal(run(mergeCommand(main, [a.commit, b.commit], SECONDS), "merge").status, 2);
    assert.equal(run(partnerCommand(b.commit, [main, a.commit], SECONDS), "merge").status, 2);
  });

  test("reports a push that fails as an error", () => {
    const a = pin("a");
    init();
    assert.equal(run(fetchCommand([{ url: mainUrl, commit: main }, a], 16, SECONDS)).status, 0);
    const candidate = parseCommit(run(mergeCommand(main, [a.commit], SECONDS)).stdout);
    assert.ok(candidate !== null);

    const nowhere = `file://${join(root, "absent.git")}`;
    assert.equal(run(pushCommand(nowhere, candidate, REF, SECONDS)).status, 2);
    assert.equal(run(pushCommand(mainUrl, candidate, REF, SECONDS), "push").status, 2);
  });

  test("ends a step cut by its deadline with the timeout's status", () => {
    const a = pin("a");
    init();
    // A one-second budget for a fetch whose Git first sleeps longer than that.
    const slow = join(root, "slow");
    mkdirSync(slow, { recursive: true });
    writeFileSync(join(slow, "git"), `#!/bin/sh\nsleep 5\nexec '${realGit}' "$@"\n`);
    chmodSync(join(slow, "git"), 0o755);
    const result = spawnSync(
      "sh",
      ["-c", fetchCommand([{ url: mainUrl, commit: main }, a], 16, 1)],
      {
        env: { ...env, PATH: `${slow}:${env.PATH ?? ""}` },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    assert.ok(result.status === 124 || result.status === 137, `status ${String(result.status)}`);
  });
});
