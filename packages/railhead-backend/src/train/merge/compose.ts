// Composing exact pins on main with real Git in a sandbox, and publishing a clean result as a
// candidate. Nothing here can write main: the sandbox's policy grants one write, to refs under the
// attempt's own candidate prefix of the main repository, and the gateway refuses every other ref.
//
// Each compose admits a fresh sandbox, fetches main's commit and each pin's commit by ID (never a
// fork's branch, which may have moved since the pin), merges the pins in order onto main and pushes
// the result to `refs/heads/candidate/<attempt>/merge`. Fetches always name a depth, deepened in
// steps until every pin shares a merge base with main, because a full fetch from a repository
// imported shallow fails (#13). When a pin conflicts, the runner finds the earlier commit it
// conflicts with and reports the pair with the conflicted paths if the conflict is one the train can
// classify: text edits on both sides of every path. Any other conflict is `unsupported`.
//
// `missing_commit`, `unsupported` and a conflict drop pins for good, so each is returned only for a
// condition Git or Artifacts proved: a pin Artifacts says its fork does not hold, no merge base
// within the deepest fetch, or a merge that stopped with unmerged entries. Every other failure of
// a Git step, including one of `git merge-base`, a fetch of main or a push, is `infrastructure`,
// which the train retries.
//
// The whole compose, release included, runs within `MERGE_TIMEOUT_MS`, under the train's own bound
// on a port call, so a slow merge is reported as `timeout` rather than lost. Every sandbox and
// Artifacts call is raced against one deadline, which stops `RELEASE_WAIT_MS` short of the budget
// so the release still fits: the sandbox port's own limits allow a command a grace period past its
// timeout, and an Artifacts lookup has its own longer bound. Work still pending at the deadline is
// abandoned and its answer ignored; releasing the sandbox destroys it, so no command keeps running.
// A teardown that has not confirmed within `RELEASE_WAIT_MS` is still finished, and its slot freed,
// by the sandbox module.

import { isCommitSha, isId, type ClaimId, type CommitSha } from "@railhead/shared/events";
import type { ClaimPin } from "../../contracts/claims";
import { fail, ok, type PortResult } from "../../contracts/result";
import type { MergeOutcome, MergePort } from "../../contracts/train";
import { MAX_COMMAND_TIMEOUT_MS, type SandboxExec, type SandboxPort } from "../../sandbox/entry";
import { CANDIDATE_REF_PREFIX, MAX_POLICY_REPOS, parseSandboxPolicy } from "../../sandbox/policy";
import {
  CONFLICT_EXIT,
  FETCH_FAILED_EXIT,
  NO_MERGE_BASE_EXIT,
  TIMEOUT_EXITS,
  binaryCommand,
  fetchCommand,
  initCommand,
  mergeCommand,
  parseBinary,
  parseCommit,
  parsePartner,
  partnerCommand,
  pushCommand,
  remoteUrl,
  type RemoteLocation,
  type UnmergedEntry,
} from "./script";

/** The longest one compose may take, within the train's 20-second bound on a port call. */
export const MERGE_TIMEOUT_MS = 15_000;

/** How long a merge sandbox may live. Its fence retires it then, whatever else happens. */
export const MERGE_SANDBOX_LIFETIME_MS = 60_000;

/** How long a compose waits for its sandbox's teardown before it returns anyway. */
export const RELEASE_WAIT_MS = 2_000;

/** The depths a fetch tries, in order, until every pin shares a merge base with main. */
export const FETCH_DEPTHS: readonly number[] = [16, 128, 1024];

/** Most pins one compose merges: the policy names main and one fork per pin. */
export const MAX_COMPOSE_PINS = MAX_POLICY_REPOS - 1;

/** Most conflicted paths the runner classifies; a larger conflict is `unsupported`. */
export const MAX_CONFLICT_PATHS = 64;

/** The ref, under the attempt's candidate prefix, a clean candidate is pushed to. */
const CANDIDATE_LEAF = "merge";

/** File modes a classifiable conflict may have on every side: regular and executable files. */
const TEXT_MODES = new Set(["100644", "100755"]);

/** What the merge module needs. */
export interface MergeDeps {
  /** The repository's sandbox port. */
  sandbox: () => SandboxPort;
  /** The Artifacts host and namespace of the repository's Git remotes, or `null` if unknown. */
  locate: () => Promise<RemoteLocation | null>;
  /** The Artifacts name of the main repository. */
  mainRepo: () => Promise<string>;
  /** The Artifacts name of a claim's fork. */
  forkRepo: (claimId: ClaimId) => Promise<string>;
  /** Whether `commit` exists in `repo`, asked only after a fetch of it failed. */
  commitExists: (repo: string, commit: CommitSha) => Promise<PortResult<boolean>>;
  /** The current time, in milliseconds since the Unix epoch. */
  clock: () => number;
  /** A fresh sandbox attempt ID for each compose. */
  attemptId: () => string;
  /** Limits a test may tighten: `MERGE_TIMEOUT_MS` and `RELEASE_WAIT_MS`. */
  limits?: { timeoutMs: number; releaseWaitMs: number };
}

/** A fresh merge attempt ID, which also names its candidate prefix. */
export function mergeAttemptId(): string {
  return `mrg_${crypto.randomUUID().replaceAll("-", "")}`;
}

/** Builds the merge port over `deps`. */
export function createMerge(deps: MergeDeps): MergePort {
  const { timeoutMs, releaseWaitMs } = deps.limits ?? {
    timeoutMs: MERGE_TIMEOUT_MS,
    releaseWaitMs: RELEASE_WAIT_MS,
  };
  return {
    async compose(expectedMain, pins) {
      if (!isCommitSha(expectedMain)) {
        return fail("invalid_request", "The expected main commit is not a full commit SHA.");
      }
      if (pins.length === 0 || pins.length > MAX_COMPOSE_PINS) {
        return fail("invalid_request", `A compose merges from 1 to ${MAX_COMPOSE_PINS} pins.`);
      }
      if (!pins.every((pin) => isId("claim", pin.claimId) && isCommitSha(pin.commit))) {
        return fail("invalid_request", "Every pin needs a claim and a full commit SHA.");
      }
      const deadline = deps.clock() + timeoutMs;
      // Work stops early enough that releasing the sandbox still fits within the budget.
      const until = new Deadline(deadline - releaseWaitMs, deps.clock);
      const located = await until.race(
        Promise.all([
          deps.locate().catch(() => null),
          deps.mainRepo(),
          Promise.all(pins.map((pin) => deps.forkRepo(pin.claimId))),
        ]),
      );
      if (located.kind !== "done" || located.value[0] === null) {
        return fail("unavailable", "The repository's Git remote could not be found.");
      }
      const [location, main, forks] = located.value;
      const attemptId = deps.attemptId();
      const prefix = `${CANDIDATE_REF_PREFIX}${attemptId}/`;
      const policy = parseSandboxPolicy({
        host: location.host,
        namespace: location.namespace,
        read: [...new Set(forks)],
        write: { repo: main, refPrefix: prefix },
      });
      if (policy === null) throw new Error("the merge built an invalid sandbox policy");

      const sandbox = deps.sandbox();
      // Releases the attempt, waiting for its teardown no longer than the budget allows.
      const release = () =>
        within(sandbox.release(attemptId), Math.min(releaseWaitMs, deadline - deps.clock()));
      const admitting = sandbox.admit(attemptId, policy, MERGE_SANDBOX_LIFETIME_MS);
      const admitted = await until.race(admitting);
      if (admitted.kind !== "done") {
        // Whatever the admission did, release it once it settles.
        void admitting.finally(() => sandbox.release(attemptId)).catch(() => undefined);
        if (admitted.kind === "timeout") return ok(failure("timeout"));
        return fail("unavailable", "The sandbox could not be admitted.");
      }
      if (!admitted.value.ok) {
        // A start that did not confirm leaves its slot uncertain; releasing it retries the teardown.
        await release();
        return admitted.value;
      }
      if (admitted.value.value.kind === "queued") {
        await release();
        return fail("busy", "Every sandbox is taken; the compose can be tried again later.");
      }

      const run = new Run(sandbox, attemptId, until, deps);
      try {
        return ok(
          await run.compose({
            location,
            main,
            expectedMain,
            pins,
            forks,
            ref: `${prefix}${CANDIDATE_LEAF}`,
          }),
        );
      } finally {
        await release();
      }
    },
  };
}

interface ComposeInput {
  location: RemoteLocation;
  main: string;
  expectedMain: CommitSha;
  pins: readonly ClaimPin[];
  forks: readonly string[];
  ref: string;
}

/** A command's outcome: its result, or the merge outcome that ends the compose. */
type Step = { kind: "ran"; exec: SandboxExec } | { kind: "ended"; outcome: MergeOutcome };

/** One compose in one admitted sandbox, under one deadline. */
class Run {
  readonly #sandbox: SandboxPort;
  readonly #attemptId: string;
  readonly #deadline: Deadline;
  readonly #deps: MergeDeps;

  constructor(sandbox: SandboxPort, attemptId: string, deadline: Deadline, deps: MergeDeps) {
    this.#sandbox = sandbox;
    this.#attemptId = attemptId;
    this.#deadline = deadline;
    this.#deps = deps;
  }

  async compose(input: ComposeInput): Promise<MergeOutcome> {
    const { location, main, expectedMain, pins, forks, ref } = input;
    const init = await this.#exec((seconds) => initCommand(seconds));
    if (init.kind === "ended") return init.outcome;
    if (init.exec.exitCode !== 0) return failure("infrastructure");

    const targets = [
      { repo: main, url: remoteUrl(location, main), commit: expectedMain },
      ...pins.map((pin, index) => {
        const repo = forks[index] ?? "";
        return { repo, url: remoteUrl(location, repo), commit: pin.commit };
      }),
    ];
    const fetched = await this.#fetch(targets);
    if (fetched !== null) return fetched;

    const commits = pins.map((pin) => pin.commit);
    const merged = await this.#exec((seconds) => mergeCommand(expectedMain, commits, seconds));
    if (merged.kind === "ended") return merged.outcome;
    const { exitCode, stdout } = merged.exec;
    const conflicted = exitCode - CONFLICT_EXIT;
    if (conflicted >= 1 && conflicted <= pins.length) {
      return this.#conflict(expectedMain, pins, conflicted - 1);
    }
    const candidate = exitCode === 0 ? parseCommit(stdout) : null;
    if (candidate === null) return failure("infrastructure");

    const url = remoteUrl(location, main);
    const pushed = await this.#exec((seconds) => pushCommand(url, candidate, ref, seconds));
    if (pushed.kind === "ended") return pushed.outcome;
    return pushed.exec.exitCode === 0 ? { kind: "clean", candidate } : failure("infrastructure");
  }

  /** Fetches every target at each depth in turn; `null` once every pin reaches main's history. */
  async #fetch(
    targets: readonly { repo: string; url: string; commit: CommitSha }[],
  ): Promise<MergeOutcome | null> {
    for (const depth of FETCH_DEPTHS) {
      const step = await this.#exec((seconds) => fetchCommand(targets, depth, seconds));
      if (step.kind === "ended") return step.outcome;
      const { exitCode } = step.exec;
      if (exitCode === 0) return null;
      if (exitCode === NO_MERGE_BASE_EXIT) continue;
      // Target 0 is main's own commit: a failed fetch of it says nothing about the pins.
      const target = targets[exitCode - FETCH_FAILED_EXIT];
      if (exitCode <= FETCH_FAILED_EXIT || target === undefined) return failure("infrastructure");
      // A pin its fork does not hold is missing; any other fetch failure is Railhead's.
      const exists = await this.#deadline.race(this.#deps.commitExists(target.repo, target.commit));
      if (exists.kind === "timeout" || this.#deadline.passed()) return failure("timeout");
      return exists.kind === "done" && exists.value.ok && !exists.value.value
        ? failure("missing_commit")
        : failure("infrastructure");
    }
    // A pin whose history does not reach main's within the deepest fetch has a missing parent.
    return failure("missing_commit");
  }

  /** Finds which earlier commit pin `index` conflicts with, and whether the conflict is supported. */
  async #conflict(
    expectedMain: CommitSha,
    pins: readonly ClaimPin[],
    index: number,
  ): Promise<MergeOutcome> {
    const pin = pins[index];
    if (pin === undefined) return failure("infrastructure");
    const earlier = pins.slice(0, index);
    const partners = [expectedMain, ...earlier.map((member) => member.commit)];
    const step = await this.#exec((seconds) => partnerCommand(pin.commit, partners, seconds));
    if (step.kind === "ended") return step.outcome;
    if (step.exec.exitCode !== 0) return failure("infrastructure");
    // A list cut short cannot be classified whole.
    if (step.exec.truncated) return failure("unsupported");
    const found = parsePartner(step.exec.stdout);
    if (found === null) return failure("infrastructure");
    // A partner whose merge left no unmerged entry did not conflict.
    if (found.kind === "partner" && found.entries.length === 0) return failure("infrastructure");
    // No single earlier pin conflicts with it, or it conflicts with main itself: neither is a pair
    // of pins the train can route.
    if (found.kind === "none" || found.index === 0) return failure("unsupported");
    const partner = earlier[found.index - 1];
    if (partner === undefined) return failure("infrastructure");

    const paths = textConflicts(found.entries);
    if (paths === null) return failure("unsupported");
    const pairs = paths.map(({ ours, theirs }) => [ours, theirs] as const);
    const binary = await this.#exec((seconds) => binaryCommand(pairs, seconds));
    if (binary.kind === "ended") return binary.outcome;
    if (binary.exec.exitCode !== 0) return failure("infrastructure");
    const flagged = parseBinary(binary.exec.stdout, pairs.length);
    if (flagged === null) return failure("infrastructure");
    if (flagged.size > 0) return failure("unsupported");
    return { kind: "conflict", pins: [partner, pin], paths: paths.map(({ path }) => path) };
  }

  /**
   * Runs one command built for the seconds left, or ends the compose: `timeout` when the deadline
   * passed before the command answered or cut it, `infrastructure` when the sandbox did not run it.
   * An answer that arrives after the deadline, even a success, is a timeout.
   */
  async #exec(build: (seconds: number) => string): Promise<Step> {
    const left = this.#deadline.left();
    const seconds = Math.floor(left / 1000);
    if (seconds < 1) return { kind: "ended", outcome: failure("timeout") };
    const answer = await this.#deadline.race(
      this.#sandbox.exec(this.#attemptId, {
        command: build(seconds),
        timeoutMs: Math.min(left, MAX_COMMAND_TIMEOUT_MS),
      }),
    );
    if (answer.kind === "timeout" || this.#deadline.passed()) {
      return { kind: "ended", outcome: failure("timeout") };
    }
    if (answer.kind === "failed") return { kind: "ended", outcome: failure("infrastructure") };
    const result = answer.value;
    if (!result.ok) return { kind: "ended", outcome: failure("infrastructure") };
    if (TIMEOUT_EXITS.includes(result.value.exitCode)) {
      return { kind: "ended", outcome: failure("timeout") };
    }
    return { kind: "ran", exec: result.value };
  }
}

interface TextConflict {
  path: string;
  ours: string;
  theirs: string;
}

/**
 * The conflicted paths, in index order, when every one has a base, ours and theirs that are
 * regular files; otherwise `null`. A missing stage is a delete, rename or add on one side, and
 * another mode is a symlink or submodule: none of them has text regions to classify.
 */
function textConflicts(entries: readonly UnmergedEntry[]): TextConflict[] | null {
  const byPath = new Map<string, Map<number, UnmergedEntry>>();
  for (const entry of entries) {
    const stages = byPath.get(entry.path) ?? new Map<number, UnmergedEntry>();
    if (stages.has(entry.stage) || !TEXT_MODES.has(entry.mode)) return null;
    stages.set(entry.stage, entry);
    byPath.set(entry.path, stages);
  }
  if (byPath.size === 0 || byPath.size > MAX_CONFLICT_PATHS) return null;
  const conflicts: TextConflict[] = [];
  for (const [path, stages] of byPath) {
    const ours = stages.get(2);
    const theirs = stages.get(3);
    if (!stages.has(1) || ours === undefined || theirs === undefined) return null;
    conflicts.push({ path, ours: ours.object, theirs: theirs.object });
  }
  return conflicts;
}

function failure(
  reason: Extract<MergeOutcome, { kind: "error" }>["reason"],
): Extract<MergeOutcome, { kind: "error" }> {
  return { kind: "error", reason };
}

/** The point by which a compose's work must answer, read from the injected clock. */
class Deadline {
  readonly #at: number;
  readonly #clock: () => number;

  constructor(at: number, clock: () => number) {
    this.#at = at;
    this.#clock = clock;
  }

  left(): number {
    return this.#at - this.#clock();
  }

  passed(): boolean {
    return this.left() <= 0;
  }

  /** Waits for `work` until the deadline; work still pending then is abandoned. */
  race<T>(work: Promise<T>): Promise<Within<T>> {
    return within(work, this.left());
  }
}

type Within<T> = { kind: "done"; value: T } | { kind: "failed" } | { kind: "timeout" };

// Waits for `work` up to `ms`. Neither a failure nor a timeout is thrown.
async function within<T>(work: Promise<T>, ms: number): Promise<Within<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Within<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, ms));
  });
  try {
    return await Promise.race([
      work.then(
        (value): Within<T> => ({ kind: "done", value }),
        (): Within<T> => ({ kind: "failed" }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
