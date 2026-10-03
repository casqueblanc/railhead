// Seed and reset as reconciliation against a `SeedTarget`.
//
// The port mirrors the backend's `DemoSeedApi` (#149): `read` returns the repository and its main,
// `seed` creates the repository and imports main in one action, and `reset` deletes it. A plan
// compares what the manifest wants with what the target reports and lists each step with whether
// it is already in place, so a repeat after success writes nothing. A step whose write failed is
// not retried here: the next seed reads the target again first, so an uncertain seed is reconciled
// before anything is written a second time. Reset reads nothing first (see below), so an uncertain
// reset is the owner's to inspect before approving another.
//
// Each backend write needs its own owner passkey assertion. The live adapter, `liveTarget.ts`,
// holds it; the port does not carry one.
//
// Issues are read through `BoardIssues`, a separate port: `DemoSeedApi` has no issue read. Filing an
// issue is an owner action on the board, so neither port can file one. The plan lists each seeded
// issue and whether the board already shows it; the owner files the missing ones. A seeded title
// whose body differs is a step for the owner too, editing the body, never a reason to refuse the run
// or reset: the repository and the other issues are still right. A seeded title the board shows
// more than once, such as an issue filed again after its response was lost, is an owner step as
// well: the demo needs each task exactly once, so the plan names the count and the owner closes the
// extra copies. `describeIssues` prints each payload as plain text, so the owner can copy it exactly.
//
// Reset deletes the demo repository by name and nothing else. It never lists the target to choose
// what to delete, so another repository cannot be swept up with it. It always calls the target,
// even when `read` finds nothing: a seed that failed after importing main leaves that main in
// place behind a repository `read` does not report, and only the target's reset clears it.
//
// `liveTarget.ts` implements both ports against a deployed Railhead, and `docs/demo-seed.md`
// gives the owner's steps.

import {
  assertDemoTarget,
  DEMO_ORG,
  DEMO_REPO,
  SeedRefusal,
  type SeedIssue,
  type SeedManifest,
} from "./manifest.ts";
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

/** What one read of the board found. */
export interface BoardScan {
  /** The repository's issues titled one of the titles asked for, in filing order. */
  readonly issues: readonly BoardIssue[];
  /**
   * The board history the issues were read from, or `null` when the repository does not exist. A
   * reset starts a new history, so a repository reset and seeded again at the same main has another.
   */
  readonly history: string | null;
}

/** The board's issues for one repository: the read `DemoSeedApi` does not offer. */
export interface BoardIssues {
  /**
   * The repository's open issues titled one of `titles`, all read from one history; no issues and
   * no history when it does not exist.
   */
  scan(ref: RepoRef, titles: ReadonlySet<string>): Promise<BoardScan>;
  /** The board's current history for the repository, or `null` when it does not exist. */
  history(ref: RepoRef): Promise<string | null>;
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

/**
 * Whether the target already reflects a step: `differs` when an issue with the seeded title is on
 * the board with another body, `duplicate` when the board shows the seeded title more than once.
 */
export type StepStatus = "done" | "missing" | "differs" | "duplicate";

/** A step and whether the target already reflects it. */
export interface PlannedStep {
  readonly step: SeedStep;
  readonly status: StepStatus;
  /** For an issue, how many the board shows with its title. */
  readonly filed?: number;
}

/** The only repository the seed and reset touch. */
export const DEMO_REF: RepoRef = { org: DEMO_ORG, repo: DEMO_REPO };

/** `ref` after checking it is the demo repository. */
export function demoRef(ref: RepoRef): RepoRef {
  assertDemoTarget(ref.org, ref.repo);
  return { org: ref.org, repo: ref.repo };
}

/**
 * Plans a seed of `manifest` with `history` as main against what `target` and `board` hold now. It
 * reads `target` before and after scanning `board`, then the board's history, and refuses when the
 * two target reads differ or the board's history is no longer the one its issues came from.
 */
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
  const titles = new Set(manifest.issues.map((issue) => issue.title));
  const scanned = await board.scan(ref, titles);
  const filed = Map.groupBy(scanned.issues, (issue) => issue.title);
  // Another operator may reset and seed the repository while this plans: at another head the plan
  // would mark a main done that is not this one, and at the same head the issues read may belong
  // to the deleted board. Each shows as a changed main or a new history. This narrows the window
  // but does not close it: the plan is several calls, not one snapshot.
  const again = await target.read(ref);
  const boardHistory = await board.history(ref);
  if (
    (again === null) !== (state === null) ||
    again?.main !== state?.main ||
    boardHistory !== scanned.history
  ) {
    throw new SeedRefusal(`The repository ${name} changed during planning; run again.`);
  }

  return [
    {
      step: { action: "repo.seed", target: `${name}@main`, head: history.head },
      status: state === null ? "missing" : "done",
    },
    ...manifest.issues.map((issue, index): PlannedStep => {
      const copies = filed.get(issue.title) ?? [];
      return {
        step: { action: "issue.file", target: `${name}#seed-${index + 1}`, issue },
        status: issueStatus(copies, issue.body),
        filed: copies.length,
      };
    }),
  ];
}

/**
 * Seeds the repository with main from `bundle`, the bytes the target receives, when a fresh plan
 * finds it missing, and returns the plan with the steps it applied marked done. Missing and
 * differing issues stay as planned: the owner files or edits them.
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
    if (status !== "missing") {
      applied.push(planned);
      continue;
    }
    switch (step.action) {
      case "repo.seed":
        try {
          await target.seed(ref, bundle);
        } catch (error) {
          // A main the read could not see, such as one a failed seed imported at another head.
          if (!(error instanceof ActionStale)) throw error;
          throw new SeedRefusal(`${step.target} holds another main. Reset it first.`, {
            cause: error,
          });
        }
        applied.push({ step, status: "done" });
        break;
      case "issue.file":
        // The owner's step; the seed holds no authority to file or edit an issue.
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
export function planReset(target: RepoRef): PlannedStep[] {
  const ref = demoRef(target);
  return [{ step: { action: "repo.delete", target: `${ref.org}/${ref.repo}` }, status: "missing" }];
}

/** Deletes the demo repository; `false` when the target held nothing to delete. */
export async function reset(ref: RepoRef, target: SeedTarget): Promise<boolean> {
  return target.reset(demoRef(ref));
}

/** One line per step, naming its target, for a dry run. */
export function describePlan(plan: readonly PlannedStep[]): string[] {
  return plan.map(({ step, status, filed }) => {
    const mark = statusMark(status);
    switch (step.action) {
      case "repo.seed":
        return `${mark} seed repository ${step.target} = ${step.head}`;
      case "issue.file":
        return `${mark} ${issueAction(status, step.target, filed)}: ${JSON.stringify(step.issue.title)}`;
      case "repo.delete":
        return `${mark} delete repository ${step.target}`;
      default:
        return unreachable(step);
    }
  });
}

/**
 * The exact title and body of each issue the owner still has to file or edit, as plain text
 * between marker lines, so it can be copied onto the board without unescaping. The manifest
 * refuses control characters other than a body's line breaks, so the text is inert in a terminal.
 */
export function describeIssues(plan: readonly PlannedStep[]): string[] {
  return plan.flatMap(({ step, status }) => {
    if (step.action !== "issue.file" || status === "done") return [];
    return [
      `--- issue ${step.target} title`,
      step.issue.title,
      `--- issue ${step.target} body`,
      ...step.issue.body.split("\n"),
      `--- end issue ${step.target}`,
    ];
  });
}

function issueStatus(copies: readonly BoardIssue[], seeded: string): StepStatus {
  const [only, ...more] = copies;
  if (only === undefined) return "missing";
  if (more.length > 0) return "duplicate";
  return only.body === seeded ? "done" : "differs";
}

function issueAction(status: StepStatus, target: string, filed = 0): string {
  switch (status) {
    case "done":
      return `issue ${target} is filed`;
    case "missing":
      return `owner files issue ${target}`;
    case "differs":
      return `owner edits issue ${target} to the seeded body`;
    case "duplicate":
      return `owner keeps one issue ${target} with the seeded body and closes the other ${filed - 1} of ${filed}`;
    default:
      return unreachable(status);
  }
}

function statusMark(status: StepStatus): string {
  switch (status) {
    case "done":
      return "ok  ";
    case "missing":
      return "todo";
    case "differs":
      return "edit";
    case "duplicate":
      return "dup ";
    default:
      return unreachable(status);
  }
}

function unreachable(value: never): never {
  throw new Error(`Unhandled seed step ${JSON.stringify(value)}`);
}
