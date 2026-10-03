import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  buildMainBundle,
  bundleHead,
  DEMO_AUTHOR,
  planHistory,
  readFileAt,
  resolveCommit,
  writeHistoryBundle,
  type ImportRequest,
  type OverlayEntry,
} from "./history.ts";
import { SeedRefusal } from "./manifest.ts";

const scratch = mkdtempSync(join(tmpdir(), "railhead-demo-seed-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...env },
  }).trim();
}

/** The history of `apps/demo` at `revision`, with no overlay unless one is given. */
function request(
  source: string,
  revision: string,
  overlay: readonly OverlayEntry[] = [],
  directory = "apps/demo",
): ImportRequest {
  return {
    sourceRoot: source,
    commit: resolveCommit(source, revision),
    directory,
    overlay,
    overlaySubject: "chore: stand alone",
  };
}

function cloneOf(bundle: string, name: string): string {
  const clone = join(scratch, name);
  execFileSync("git", ["clone", "--quiet", "--branch", "main", bundle, clone]);
  return clone;
}

let commitCount = 0;
/** Commits `files`; a `null` content deletes that path, file or directory. */
function commit(repo: string, files: Record<string, string | null>, message: string): string {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      rmSync(join(repo, path), { recursive: true });
      continue;
    }
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

  const history = writeHistoryBundle(request(source, "HEAD"), bundle);

  assert.equal(history.commits, 3);
  // Main alone, as the backend's seed requires; a clone names the branch to check it out.
  assert.deepEqual(
    execFileSync("git", ["bundle", "list-heads", bundle], { encoding: "utf8" }),
    `${history.head} refs/heads/main\n`,
  );
  const clone = join(scratch, "normal-clone");
  execFileSync("git", ["clone", "--quiet", "--branch", "main", bundle, clone]);
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
  const first = planHistory(request(source, "HEAD"));
  const second = planHistory(request(source, "HEAD"));
  const earlier = planHistory(request(source, "HEAD~1"));

  assert.deepEqual(first, second);
  assert.equal(earlier.commits, 2);
  assert.notEqual(earlier.head, first.head);
  const bundle = join(scratch, "repeat.bundle");
  writeHistoryBundle(request(source, "HEAD"), bundle);
  const clone = join(scratch, "repeat-clone");
  execFileSync("git", ["clone", "--quiet", "--branch", "main", bundle, clone]);
  assert.equal(git(clone, ["rev-parse", "HEAD~1"]), earlier.head);
});

test("the seed's bundle is main alone at the head, holding its whole history", () => {
  const source = sourceRepo("seed-bundle");
  const expected = planHistory(request(source, "HEAD"));

  const bundle = buildMainBundle(request(source, "HEAD"));

  assert.equal(bundle.head, expected.head);
  assert.equal(bundle.commits, expected.commits);
  assert.equal(bundleHead(bundle.bytes), expected.head);
  const path = join(scratch, "seed-bundle.bundle");
  writeFileSync(path, bundle.bytes);
  // No prerequisites: an empty repository can take it, as an empty main does.
  const empty = join(scratch, "seed-bundle-empty");
  git(scratch, ["init", "--quiet", "--bare", empty]);
  git(empty, ["fetch", "--quiet", path, "refs/heads/main:refs/heads/main"]);
  assert.equal(git(empty, ["rev-parse", "refs/heads/main"]), expected.head);
  assert.equal(git(empty, ["rev-list", "--count", "refs/heads/main"]), String(expected.commits));
});

test("a bundle above the size limit is refused, and one at the limit is not", () => {
  const source = sourceRepo("bundle-limit");
  const { bytes } = buildMainBundle(request(source, "HEAD"));

  assert.equal(buildMainBundle(request(source, "HEAD"), bytes.length).bytes.length, bytes.length);
  assert.throws(
    () => buildMainBundle(request(source, "HEAD"), bytes.length - 1),
    (error) =>
      error instanceof SeedRefusal &&
      error.message ===
        `The bundle is ${bytes.length} bytes; the seed accepts at most ${bytes.length - 1}.`,
  );
});

function header(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

test("a bundle header names main alone or yields no head", () => {
  const a = "a".repeat(40);

  assert.equal(bundleHead(header(`# v2 git bundle\n${a} refs/heads/main\n\nPACK`)), a);
  for (const text of [
    "",
    `# v2 git bundle\n${a} refs/heads/main\n`,
    `# v3 git bundle\n@object-format=sha1\n${a} refs/heads/main\n\nPACK`,
    `# v2 git bundle\n${a} HEAD\n${a} refs/heads/main\n\nPACK`,
    `# v2 git bundle\n-${a}\n${a} refs/heads/main\n\nPACK`,
    `# v2 git bundle\n${a} refs/heads/main extra\n\nPACK`,
    `# v2 git bundle\n${a.toUpperCase()} refs/heads/main\n\nPACK`,
  ]) {
    assert.equal(bundleHead(header(text)), null, JSON.stringify(text));
  }
  // A header that does not end within the bytes read is not a bundle.
  assert.equal(
    bundleHead(header(`# v2 git bundle\n${a} refs/heads/main\n${"x".repeat(5000)}\n\n`)),
    null,
  );
});

test("a revision before the directory existed, or a missing directory, is refused", () => {
  const source = sourceRepo("missing");

  assert.throws(() => planHistory(request(source, "HEAD~4")), /No commit up to [0-9a-f]+ changes/);
  assert.throws(() => planHistory(request(source, "HEAD", [], "apps/none")), SeedRefusal);
  assert.throws(() => resolveCommit(source, "no-such-ref"), /not a commit/);
  assert.throws(() => resolveCommit(source, "--all"), /--all is not a commit/);
  assert.throws(() => resolveCommit(source, ""), /is not a commit/);
});

test("a shallow clone is refused rather than imported as a truncated history", () => {
  const source = sourceRepo("deep");
  const shallow = join(scratch, "shallow");
  execFileSync("git", ["clone", "--quiet", "--depth", "1", `file://${source}`, shallow]);

  assert.throws(() => planHistory(request(shallow, "HEAD")), /shallow clone/);
});

test("a deleted directory imports as an empty tree, and an identical re-addition is kept", () => {
  const source = sourceRepo("readd");
  const appTree = git(source, ["rev-parse", "HEAD:apps/demo"]);
  commit(source, { "apps/demo": null }, "chore(demo): remove the app");
  commit(source, { "apps/demo/index.ts": "export const v = 2;\n" }, "feat(demo): bring it back");
  commit(source, { "apps/demo/README.md": "demo\n" }, "docs(demo): describe it again");
  assert.equal(git(source, ["rev-parse", "HEAD:apps/demo"]), appTree);
  const bundle = join(scratch, "readd.bundle");

  const history = writeHistoryBundle(request(source, "HEAD"), bundle);

  assert.equal(history.commits, 6);
  const clone = cloneOf(bundle, "readd-clone");
  assert.deepEqual(git(clone, ["log", "--format=%s"]).split("\n"), [
    "docs(demo): describe it again",
    "feat(demo): bring it back",
    "chore(demo): remove the app",
    "docs(demo): describe it",
    "fix(demo): bump",
    "feat(demo): add the app",
  ]);
  assert.equal(git(clone, ["ls-tree", "HEAD~2"]), "");
  assert.equal(git(clone, ["rev-parse", "HEAD^{tree}"]), appTree);
});

test("a revision at which the directory was deleted is refused, not imported as its past", () => {
  const source = sourceRepo("deleted");
  commit(source, { "apps/demo": null }, "chore(demo): remove the app");
  const bundle = join(scratch, "deleted.bundle");

  assert.throws(
    () => writeHistoryBundle(request(source, "HEAD"), bundle),
    /apps\/demo does not exist at [0-9a-f]{40}/,
  );
  assert.equal(existsSync(bundle), false);
  // The revision before the deletion still imports.
  assert.equal(planHistory(request(source, "HEAD~1")).commits, 3);
});

test("an unreadable tree fails the import and writes no bundle", () => {
  const source = sourceRepo("corrupt");
  // The app's tree at "fix(demo): bump", stored loose because the repository was never packed.
  const tree = git(source, ["rev-parse", "HEAD~1:apps/demo"]);
  rmSync(join(source, ".git", "objects", tree.slice(0, 2), tree.slice(2)));
  const bundle = join(scratch, "corrupt.bundle");

  assert.throws(
    () => writeHistoryBundle(request(source, "HEAD"), bundle),
    (error) => error instanceof Error && !(error instanceof SeedRefusal),
  );
  assert.equal(existsSync(bundle), false);
});

test("the overlay adds, replaces and removes files from the tip commit in one last commit", () => {
  const source = sourceRepo("overlay");
  commit(
    source,
    { "tooling/package.json": "{}\n", "apps/demo/vite.config.ts": "monorepo\n" },
    "chore: add tooling",
  );
  const overlay: OverlayEntry[] = [
    { path: "package.json", from: "tooling/package.json" },
    { path: "README.md", from: "README.md" },
    { path: "vite.config.ts", from: null },
  ];
  const bundle = join(scratch, "overlay.bundle");

  const history = writeHistoryBundle(request(source, "HEAD", overlay), bundle);

  assert.equal(history.commits, 5);
  const clone = cloneOf(bundle, "overlay-clone");
  assert.deepEqual(git(clone, ["log", "-2", "--format=%s|%an|%ad", "--date=raw"]).split("\n"), [
    `chore: stand alone|${DEMO_AUTHOR.name}|${git(source, ["log", "-1", "--format=%ad", "--date=raw"])}`,
    `chore: add tooling|${DEMO_AUTHOR.name}|${git(source, ["log", "-1", "--format=%ad", "--date=raw"])}`,
  ]);
  assert.deepEqual(git(clone, ["ls-tree", "--name-only", "HEAD"]).split("\n"), [
    "README.md",
    "index.ts",
    "package.json",
  ]);
  assert.equal(git(clone, ["show", "HEAD:README.md"]), "monorepo");
  assert.equal(git(clone, ["show", "HEAD~1:vite.config.ts"]), "monorepo");
  assert.deepEqual(planHistory(request(source, "HEAD", overlay)), history);
});

test("the overlay commit is dated by its inputs, so an unrelated commit keeps the head", () => {
  const source = sourceRepo("overlay-stable");
  commit(source, { "tooling/package.json": "{}\n" }, "chore: add tooling");
  const overlay: OverlayEntry[] = [{ path: "package.json", from: "tooling/package.json" }];
  const inputs = git(source, ["log", "-1", "--format=%ad", "--date=raw"]);
  const before = planHistory(request(source, "HEAD", overlay));

  commit(source, { "other/y.ts": "y\n" }, "chore: unrelated after");
  assert.deepEqual(planHistory(request(source, "HEAD", overlay)), before);
  const bundle = join(scratch, "overlay-stable.bundle");
  writeHistoryBundle(request(source, "HEAD", overlay), bundle);
  assert.equal(
    git(cloneOf(bundle, "overlay-stable-clone"), ["log", "-1", "--format=%ad", "--date=raw"]),
    inputs,
  );

  // A change to an overlay source is an input: it moves the head.
  commit(source, { "tooling/package.json": '{ "name": "demo" }\n' }, "chore: name the package");
  const moved = planHistory(request(source, "HEAD", overlay));
  assert.notEqual(moved.head, before.head);
  assert.equal(moved.commits, before.commits);
});

test("an overlay whose source or removed file is missing is refused", () => {
  const source = sourceRepo("overlay-missing");

  assert.throws(
    () => planHistory(request(source, "HEAD", [{ path: "package.json", from: "tooling/none" }])),
    /overlay needs tooling\/none/,
  );
  assert.throws(
    () => planHistory(request(source, "HEAD", [{ path: "package.json", from: "other" }])),
    /overlay needs other/,
  );
  assert.throws(
    () => planHistory(request(source, "HEAD", [{ path: "vite.config.ts", from: null }])),
    /removes vite.config.ts/,
  );
});

test("a file is read from the commit, not from the working tree", () => {
  const source = sourceRepo("read");
  const head = resolveCommit(source, "HEAD");
  writeFileSync(join(source, "apps", "demo", "index.ts"), "dirty\n");

  assert.equal(readFileAt(source, head, "apps/demo/index.ts"), "export const v = 2;\n");
  assert.equal(
    readFileAt(source, resolveCommit(source, "HEAD~2"), "apps/demo/index.ts"),
    "export const v = 1;\n",
  );
  assert.throws(() => readFileAt(source, head, "apps/demo/none.ts"), /has no file/);
  assert.throws(() => readFileAt(source, head, "apps/demo"), /has no file/);
});

test("a failed directory lookup fails the import instead of skipping that commit", () => {
  const source = sourceRepo("lookup");
  const failing = git(source, ["rev-parse", "HEAD~1"]);
  // A git that fails every path lookup in one commit, while the walk over history still works.
  const bin = join(scratch, "lookup-bin");
  mkdirSync(bin);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "git"),
    [
      "#!/bin/sh",
      'case " $* " in',
      `  *" ls-tree "*" ${failing} "*|*" ${failing}:"*) echo "fatal: lookup failed" >&2; exit 128 ;;`,
      "esac",
      `exec ${realGit} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "git"), 0o755);
  const bundle = join(scratch, "lookup.bundle");
  const lookup = request(source, "HEAD");
  const path = process.env["PATH"];
  process.env["PATH"] = `${bin}:${path ?? ""}`;
  try {
    assert.throws(
      () => writeHistoryBundle(lookup, bundle),
      (error) => error instanceof Error && /lookup failed/.test(String(error)),
    );
  } finally {
    process.env["PATH"] = path;
  }
  assert.equal(existsSync(bundle), false);
  assert.equal(planHistory(request(source, "HEAD")).commits, 3);
});

test("the caller's Git config cannot change the imported history", () => {
  const source = sourceRepo("config");
  // A signed commit with a non-ASCII subject, signed by a stub gpg that also "verifies" noisily.
  const bin = join(scratch, "config-bin");
  mkdirSync(bin);
  const gpg = join(bin, "gpg");
  writeFileSync(
    gpg,
    [
      "#!/bin/sh",
      'for arg; do [ "$arg" = --verify ] && { echo "gpg: Signature made by a stub" >&2; exit 1; }; done',
      "cat >/dev/null",
      'printf "\\n[GNUPG:] SIG_CREATED D 1 8 00 1700000000 STUB\\n" >&2',
      'printf -- "-----BEGIN PGP SIGNATURE-----\\n\\nstub\\n-----END PGP SIGNATURE-----\\n"',
      "",
    ].join("\n"),
  );
  chmodSync(gpg, 0o755);
  writeFileSync(join(source, "apps", "demo", "index.ts"), "export const v = 3;\n");
  git(source, ["add", "--all"]);
  git(
    source,
    ["-c", `gpg.program=${gpg}`, "commit", "--quiet", "-S", "-m", "feat(demo): accept café"],
    {
      GIT_AUTHOR_NAME: "Someone",
      GIT_AUTHOR_EMAIL: "someone@example.com",
      GIT_AUTHOR_DATE: "1700100000 +0000",
      GIT_COMMITTER_NAME: "Someone",
      GIT_COMMITTER_EMAIL: "someone@example.com",
      GIT_COMMITTER_DATE: "1700100000 +0000",
    },
  );
  const expected = planHistory(request(source, "HEAD"));

  const globalConfig = join(scratch, "config-gitconfig");
  writeFileSync(
    globalConfig,
    [
      "[log]",
      "\tshowSignature = true",
      "[i18n]",
      "\tlogOutputEncoding = ISO-8859-1",
      "[gpg]",
      `\tprogram = ${gpg}`,
      "",
    ].join("\n"),
  );
  const saved = Object.entries(process.env).filter(([name]) => name.startsWith("GIT_CONFIG"));
  const configEnv = {
    GIT_CONFIG_GLOBAL: globalConfig,
    // `git -c` from a parent Git process arrives this way.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "log.showSignature",
    GIT_CONFIG_VALUE_0: "true",
  };
  Object.assign(process.env, configEnv);
  const bundle = join(scratch, "config.bundle");
  try {
    // The config does reach a plain Git call made with this environment.
    assert.match(
      execFileSync("git", ["-C", source, "show", "-s", "--format=%s", "HEAD"], {
        encoding: "utf8",
      }),
      /Signature made by a stub/,
    );
    assert.deepEqual(writeHistoryBundle(request(source, "HEAD"), bundle), expected);
  } finally {
    for (const name of Object.keys(configEnv)) delete process.env[name];
    Object.assign(process.env, Object.fromEntries(saved));
  }
  const clone = cloneOf(bundle, "config-clone");
  assert.equal(git(clone, ["log", "-1", "--format=%s"]), "feat(demo): accept café");
});
