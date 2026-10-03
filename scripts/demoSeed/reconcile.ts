// Seed and reset as reconciliation against a `SeedTarget`.
//
// The port mirrors the backend's `DemoSeedApi` (#149): `read` returns the repository and its main,
// `seed` creates the repository and imports main in one action, and `reset` deletes it. A plan
// compares what the manifest wants with what the target reports and lists each step with whether
// it is already in place, so a repeat after success writes nothing. A step whose write failed is
// not retried here: the next run reads the target again first, so an uncertain write is reconciled
// before anything is written a second time.
//
// Each backend write needs its own owner passkey assertion. The live adapter obtains it (#148); the
// port does not carry one.
//
// Issues are read through `BoardIssues`, a separate port: `DemoSeedApi` has no issue read. Filing an
// issue is an owner action on the board, so neither port can file one. The plan lists each seeded
// issue and whether the board already shows it; the owner files the missing ones.
//
// Reset deletes the demo repository by name and nothing else. It never lists the target to choose
// what to delete, so another repository cannot be swept up with it. It always calls the target,
// even when `read` finds nothing: a seed that failed after importing main leaves that main in
// place behind a repository `read` does not report, and only the target's reset clears it.
//
// The live target does not exist yet; until it does the commands only plan, and
// `docs/demo-seed.md` gives the owner's steps.

import { assertDemoTarget, SeedRefusal, type SeedIssue, type SeedManifest } from "./manifest.ts";
import type { ImportedHistory, MainBundle } from "./history.ts";

/** A Railhead repository, `org/repo`. */
export interface RepoRef {
  readonly org: string;
  readonly repo: string;
}

/** What the target holds for one repository, as `DemoSeedState` (#149). */
export interface RepoState {
  /** The head of its main, or `null` when a reset did not finish. */
  readonly main: string | null;
}

/** Where the seed writes, as `DemoSeedApi` (#149). Each method touches only the repository given. */
export interface SeedTarget {
  /**
   * The repository's state, or `null` when it is not initialized. A seed initializes it last, so
   * `null` does not mean the target holds nothing: a main imported by a failed seed may remain.
   */
  read(ref: RepoRef): Promise<RepoState | null>;
  /**
   * Creates the repository if it is missing and imports `bundle` as its main, as `demo.seed`. Main
   * is only ever created, never moved: when it is already `bundle.head` this succeeds without
   * writing, and when it holds another head, or the repository exists without a main, it throws
   * `ActionStale`. The repository is initialized only after main is in place, so a failure can
   * leave main imported while `read` still returns `null`; a repeat at the same head completes it,
   * and a seed at another head is `ActionStale` until a reset.
   */
  seed(ref: RepoRef, bundle: MainBundle): Promise<void>;
  /**
   * Deletes the repository and everything in it, including a main `read` does not report, as
   * `demo.reset`; `false` when nothing was there.
   */
  reset(ref: RepoRef): Promise<boolean>;
}

/** An issue as the board shows it. */
export interface BoardIssue {
  readonly title: string;
  readonly body: string;
}

/** The board's issues for one repository: the read `DemoSeedApi` does not offer. */
export interface BoardIssues {
  /** The repository's issues in filing order, empty when it does not exist. */
  issues(ref: RepoRef): Promise<readonly BoardIssue[]>;
}

/** The target refused a write because it holds something else, as the backend's `action_stale`. */
export class ActionStale extends Error {
  override readonly name = "ActionStale";
}

/** One step of a plan. */
export type SeedStep =
  | { readonly action: "repo.seed"; readonly target: string; readonly head: string }
  | { readonly action: "issue.file"; readonly target: string; readonly issue: SeedIssue }
  | { readonly action: "repo.delete"; readonly target: string };

/** A step and whether the target already reflects it. */
export interface PlannedStep {
  readonly step: SeedStep;
  readonly status: "done" | "missing";
}

/** The demo repository as a `RepoRef`, after checking it is the demo repository. */
export function demoRef(manifest: SeedManifest): RepoRef {
  assertDemoTarget(manifest.org, manifest.repo);
  return { org: manifest.org, repo: manifest.repo };
}

/** Plans a seed of `manifest` with `history` as main against what `target` and `board` hold now. */
export async function planSeed(
  manifest: SeedManifest,
  history: ImportedHistory,
  target: SeedTarget,
  board: BoardIssues,
): Promise<PlannedStep[]> {
  const ref = demoRef(manifest);
  const name = `${ref.org}/${ref.repo}`;
  const state = await target.read(ref);

  if (state !== null && state.main === null) {
    throw new SeedRefusal(`${name} exists without a main: a reset did not finish. Reset it first.`);
  }
  if (state !== null && state.main !== history.head) {
    throw new SeedRefusal(
      `${name} already has main at ${state.main}, not the import's ${history.head}. Reset it first.`,
    );
  }
  const filed = new Map((await board.issues(ref)).map((issue) => [issue.title, issue.body]));
  for (const issue of manifest.issues) {
    const body = filed.get(issue.title);
    if (body !== undefined && body !== issue.body) {
      throw new SeedRefusal(
        `${name} has an issue titled like a seeded one with another body. Reset it first.`,
      );
    }
  }

  return [
    {
      step: { action: "repo.seed", target: `${name}@main`, head: history.head },
      status: state === null ? "missing" : "done",
    },
    ...manifest.issues.map((issue, index): PlannedStep => ({
      step: { action: "issue.file", target: `${name}#seed-${index + 1}`, issue },
      status: filed.has(issue.title) ? "done" : "missing",
    })),
  ];
}

/**
 * Seeds the repository with main from `bundle`, the bytes the target receives, when a fresh plan
 * finds it missing, and returns the plan with the steps it applied marked done. Missing issues
 * stay missing: the owner files them.
 */
export async function seed(
  manifest: SeedManifest,
  bundle: MainBundle,
  target: SeedTarget,
  board: BoardIssues,
): Promise<PlannedStep[]> {
  const ref = demoRef(manifest);
  const plan = await planSeed(manifest, bundle, target, board);
  const applied: PlannedStep[] = [];
  for (const planned of plan) {
    const { step, status } = planned;
    if (status === "done") {
      applied.push(planned);
      continue;
    }
    switch (step.action) {
      case "repo.seed":
        await target.seed(ref, bundle);
        applied.push({ step, status: "done" });
        break;
      case "issue.file":
        // The owner's step; the seed holds no authority to file an issue.
        applied.push(planned);
        break;
      case "repo.delete":
        throw new SeedRefusal("A seed plan never deletes.");
      default:
        return unreachable(step);
    }
  }
  return applied;
}

/**
 * Plans a reset: one deletion of the demo repository, always to do. `read` cannot see a main left
 * by a failed seed, so no read can show the deletion already done.
 */
export function planReset(manifest: SeedManifest): PlannedStep[] {
  const ref = demoRef(manifest);
  return [{ step: { action: "repo.delete", target: `${ref.org}/${ref.repo}` }, status: "missing" }];
}

/** Deletes the demo repository; `false` when the target held nothing to delete. */
export async function reset(manifest: SeedManifest, target: SeedTarget): Promise<boolean> {
  return target.reset(demoRef(manifest));
}

/** One line per step, naming its target, for a dry run. */
export function describePlan(plan: readonly PlannedStep[]): string[] {
  return plan.map(({ step, status }) => {
    const mark = status === "done" ? "ok  " : "todo";
    switch (step.action) {
      case "repo.seed":
        return `${mark} seed repository ${step.target} = ${step.head}`;
      case "issue.file":
        return `${mark} owner files issue ${step.target}: ${JSON.stringify(step.issue.title)}`;
      case "repo.delete":
        return `${mark} delete repository ${step.target}`;
      default:
        return unreachable(step);
    }
  });
}

function unreachable(value: never): never {
  throw new Error(`Unhandled seed step ${JSON.stringify(value)}`);
}
