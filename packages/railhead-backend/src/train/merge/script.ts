// The shell commands a merge runs in its sandbox, and the parsers for what they print.
//
// Every value placed in a command is checked here first: commit and object IDs are 40 lowercase hex
// digits, and remote URLs come from a host, namespace and repository name that match the sandbox
// policy's own patterns. Nothing from a repository or a client reaches a command line. Each command
// runs under one deadline computed inside the sandbox, so its steps together never outlast its
// budget, and a step cut by that deadline exits with `TIMEOUT_EXIT`.
//
// Output is untrusted: conflicted paths are repository content. Each command prints its own status
// lines before any repository text, and paths arrive NUL-terminated from `git ls-files -z`, so a
// path cannot pose as a status line.

/** The exit status of a command whose deadline passed: `timeout`'s own, or its kill after grace. */
export const TIMEOUT_EXITS: readonly number[] = [124, 137];

/** A fetch step that could not fetch repository `index` exits with `FETCH_FAILED_EXIT + index`. */
export const FETCH_FAILED_EXIT = 10;

/**
 * A fetch step whose pins have no merge base with main within the fetched depth exits with this.
 * Only `git merge-base`'s own status 1, which means no common ancestor, maps here; any other failure
 * of it is an error and exits 2.
 */
export const NO_MERGE_BASE_EXIT = 30;

/**
 * A merge step that conflicted on pin `index` (1-based) exits with `CONFLICT_EXIT + index`: its merge
 * stopped with unmerged entries. A merge that failed with none exits 2.
 */
export const CONFLICT_EXIT = 40;

/**
 * Where the merge works inside the sandbox. `RAILHEAD_MERGE_DIR` moves it only for the real-Git
 * tests, which run the commands on a shared host; the sandbox never sets it.
 */
const WORKDIR = '"${RAILHEAD_MERGE_DIR:-/tmp/railhead-merge}"';

const SHA = /^[0-9a-f]{40}$/;
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const REF = /^refs\/heads\/candidate\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/[a-z]+$/;

/** Where a repository's Git remote lives: the Artifacts host and namespace. */
export interface RemoteLocation {
  /** The Artifacts Git host. */
  host: string;
  /** The Artifacts namespace. */
  namespace: string;
}

/** The HTTPS remote of `repo`. Throws for a host, namespace or name the policy would refuse. */
export function remoteUrl(location: RemoteLocation, repo: string): string {
  if (!HOST.test(location.host)) throw new Error("invalid Artifacts host");
  if (!NAME.test(location.namespace) || !NAME.test(repo)) throw new Error("invalid repository");
  return `https://${location.host}/git/${location.namespace}/${repo}.git`;
}

/**
 * Reads the host and namespace from an Artifacts remote URL of `repo`, as `ArtifactsRepoInfo`
 * reports it, or `null` when the URL is not exactly that repository's HTTPS remote.
 */
export function parseRemote(remote: string, repo: string): RemoteLocation | null {
  const match = /^https:\/\/([^/:@]+)\/git\/([^/]+)\/([^/]+)\.git$/.exec(remote);
  if (match === null) return null;
  const [, host = "", namespace = "", name = ""] = match;
  if (!HOST.test(host) || !NAME.test(namespace) || name !== repo) return null;
  return { host, namespace };
}

/** One repository to fetch and the exact commit to fetch from it. */
export interface FetchTarget {
  /** The remote URL, from `remoteUrl`. */
  url: string;
  /** The commit. Fetched by ID, never by branch, so a fork head that moved is not merged. */
  commit: string;
}

/**
 * Creates an empty repository with no hooks, a fixed identity and diff3 conflict markers, in a
 * working directory emptied first.
 */
export function initCommand(seconds: number): string {
  return script(seconds, [
    `cd / && rm -rf ${WORKDIR} && mkdir -p ${WORKDIR} && cd ${WORKDIR} || exit 2`,
    "step git init -q || fail 2",
    "git config core.hooksPath /dev/null &&",
    "  git config advice.detachedHead false &&",
    "  git config merge.conflictStyle diff3 &&",
    "  git config user.name 'Railhead train' &&",
    "  git config user.email train@railhead.invalid || exit 2",
  ]);
}

/**
 * Fetches main's commit (the first target) and each pin at `depth`, then checks that every pin
 * shares a merge base with main. An explicit depth is required: a full fetch from a repository
 * imported shallow fails (#13), and fetching again with a larger depth deepens what is held.
 * Exits `FETCH_FAILED_EXIT + i` when target `i` cannot be fetched, `NO_MERGE_BASE_EXIT` when a
 * pin's history does not reach main's within `depth`, and 2 when `git merge-base` fails otherwise.
 */
export function fetchCommand(
  targets: readonly FetchTarget[],
  depth: number,
  seconds: number,
): string {
  if (!Number.isSafeInteger(depth) || depth < 1) throw new Error("invalid fetch depth");
  const [main, ...pins] = targets;
  if (main === undefined || pins.length === 0) throw new Error("nothing to merge");
  const lines = targets.map(
    (target, index) =>
      `step git fetch -q --no-tags --depth=${depth} ${quote(target.url)} ${sha(target.commit)} || fail ${FETCH_FAILED_EXIT + index}`,
  );
  const bases = pins.map(
    (pin) =>
      `step git merge-base ${sha(main.commit)} ${sha(pin.commit)} >/dev/null 2>&1 || no_base`,
  );
  return script(seconds, [
    // Status 1 is Git's answer that there is no common ancestor; anything else is an error.
    `no_base() { r=$?; if [ "$r" -eq 124 ] || [ "$r" -eq 137 ]; then exit "$r"; fi; [ "$r" -eq 1 ] && exit ${NO_MERGE_BASE_EXIT}; exit 2; }`,
    ...lines,
    ...bases,
  ]);
}

/**
 * Checks out `main` and merges each pin in order with `--no-ff`. Prints the resulting commit on a
 * clean merge; exits `CONFLICT_EXIT + i` when pin `i` (1-based) conflicts, and 2 when a step fails
 * in any other way, including a merge that stops with no unmerged entry.
 */
export function mergeCommand(main: string, pins: readonly string[], seconds: number): string {
  const merges = pins.map(
    (pin, index) =>
      `step git merge -q --no-ff --no-edit -m ${quote(`Compose pin ${index + 1} of ${pins.length}`)} ${sha(pin)} >/dev/null 2>&1 || conflict ${CONFLICT_EXIT + index + 1}`,
  );
  return script(seconds, [
    // A merge that stopped with no unmerged entry failed for another reason, not a conflict.
    'conflict() { r=$?; if [ "$r" -eq 124 ] || [ "$r" -eq 137 ]; then exit "$r"; fi; [ -n "$(git ls-files -u)" ] || exit 2; exit "$1"; }',
    `step git checkout -q --detach ${sha(main)} || fail 2`,
    ...merges,
    "git rev-parse HEAD",
  ]);
}

/**
 * Finds which earlier commit `pin` conflicts with: each of `partners` in order, from a clean
 * checkout, merged with `pin` without committing. Prints `partner <index>` for the first that
 * conflicts, followed by `git ls-files -u -z`, or `partner none` when every merge is clean. Exits
 * 2 when a step fails in any other way, including a merge that stops with no unmerged entry.
 */
export function partnerCommand(pin: string, partners: readonly string[], seconds: number): string {
  const tries = partners.map(
    (partner, index) => `try_partner ${index} ${sha(partner)} ${sha(pin)}`,
  );
  return script(seconds, [
    "try_partner() {",
    "  git merge --abort >/dev/null 2>&1",
    '  step git checkout -q -f --detach "$2" || exit 2',
    '  step git merge -q --no-ff --no-commit "$3" >/dev/null 2>&1',
    "  r=$?",
    '  if [ "$r" -eq 124 ] || [ "$r" -eq 137 ]; then exit "$r"; fi',
    // A merge that stopped with no unmerged entry failed for another reason, not a conflict.
    '  if [ "$r" -ne 0 ]; then',
    '    [ -n "$(git ls-files -u)" ] || exit 2',
    '    echo "partner $1"; git ls-files -u -z || exit 2; exit 0',
    "  fi",
    "}",
    ...tries,
    "echo 'partner none'",
  ]);
}

/**
 * For each pair of object IDs, prints one line: its index and `git diff --numstat` of the two
 * blobs, which shows `-` for added and deleted lines when either is binary.
 */
export function binaryCommand(
  pairs: readonly (readonly [string, string])[],
  seconds: number,
): string {
  return script(
    seconds,
    pairs.map(
      ([ours, theirs], index) =>
        `o=$(step git diff --numstat ${sha(ours)} ${sha(theirs)}) || fail 2; printf '%s\\t%s\\n' ${index} "$o"`,
    ),
  );
}

/** Pushes `commit` to `ref` under the attempt's candidate prefix of `url`. */
export function pushCommand(url: string, commit: string, ref: string, seconds: number): string {
  if (!REF.test(ref)) throw new Error("invalid candidate ref");
  return script(seconds, [`step git push -q ${quote(url)} ${sha(commit)}:${ref} || fail 2`]);
}

/**
 * A command body under one deadline. `step` runs a command cut to the time left; `fail` exits with
 * the timeout's status when the step was cut, else with its own code.
 */
function script(seconds: number, lines: readonly string[]): string {
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error("invalid command budget");
  return [
    `mkdir -p ${WORKDIR} && cd ${WORKDIR} || exit 2`,
    "export GIT_TERMINAL_PROMPT=0",
    `end=$(( $(date +%s) + ${seconds} ))`,
    'step() { left=$(( end - $(date +%s) )); [ "$left" -gt 0 ] || return 124; timeout -k 1 "$left" "$@"; }',
    'fail() { r=$?; if [ "$r" -eq 124 ] || [ "$r" -eq 137 ]; then exit "$r"; fi; exit "$1"; }',
    ...lines,
  ].join("\n");
}

function sha(value: string): string {
  if (!SHA.test(value)) throw new Error("invalid object ID");
  return value;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** One unmerged index entry. */
export interface UnmergedEntry {
  /** The file mode, such as `100644`. */
  mode: string;
  /** The blob's object ID. */
  object: string;
  /** 1 for the merge base, 2 for ours, 3 for theirs. */
  stage: 1 | 2 | 3;
  /** The path. Repository content: untrusted. */
  path: string;
}

/** What `partnerCommand` printed. */
export type PartnerOutput =
  | { kind: "none" }
  | { kind: "partner"; index: number; entries: UnmergedEntry[] };

const ENTRY = /^([0-7]{6}) ([0-9a-f]{40}) ([123])\t([^\0]+)$/s;

/** Parses `partnerCommand`'s output, or returns `null` when it is not what the command prints. */
export function parsePartner(stdout: string): PartnerOutput | null {
  if (stdout === "partner none\n") return { kind: "none" };
  const newline = stdout.indexOf("\n");
  const head = /^partner (0|[1-9][0-9]?)$/.exec(stdout.slice(0, newline));
  if (newline < 0 || head === null) return null;
  const records = stdout.slice(newline + 1);
  if (records !== "" && !records.endsWith("\0")) return null;
  const entries: UnmergedEntry[] = [];
  for (const record of records.split("\0").slice(0, -1)) {
    const match = ENTRY.exec(record);
    if (match === null) return null;
    const [, mode = "", object = "", stage = "", path = ""] = match;
    entries.push({ mode, object, stage: stage === "1" ? 1 : stage === "2" ? 2 : 3, path });
  }
  return { kind: "partner", index: Number(head[1]), entries };
}

/**
 * Reads `binaryCommand`'s output for `count` pairs: the indexes of pairs where either blob is
 * binary, or `null` when the output does not hold exactly one line per pair, in order.
 */
export function parseBinary(stdout: string, count: number): Set<number> | null {
  const lines = stdout.split("\n");
  if (lines.pop() !== "" || lines.length !== count) return null;
  const binary = new Set<number>();
  for (const [index, line] of lines.entries()) {
    // Identical blobs print no numstat line, which leaves only the index.
    const match = /^([0-9]+)\t(?:(-|[0-9]+)\t(-|[0-9]+)\t[0-9a-f]{40} => [0-9a-f]{40})?$/.exec(
      line,
    );
    if (match === null || Number(match[1]) !== index) return null;
    if (match[2] === "-" || match[3] === "-") binary.add(index);
  }
  return binary;
}

/** Reads the commit `mergeCommand` printed, or `null`. */
export function parseCommit(stdout: string): string | null {
  const match = /^([0-9a-f]{40})\n$/.exec(stdout);
  return match?.[1] ?? null;
}
