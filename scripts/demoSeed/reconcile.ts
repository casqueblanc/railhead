// Seed and reset as reconciliation against a `SeedTarget`.
//
// A plan compares what the manifest wants with what the target reports, and lists one step per
// target with whether it is already in place. Seeding applies only the missing steps, so a repeat
// after success changes nothing and a repeat after a partial failure finishes the job. A step whose
// write failed is not retried here: the next run reads the target again first, so an uncertain
// write is reconciled before anything is written a second time.
//
// Filing an issue is an owner action that needs the owner's passkey assertion, so the port has no
// way to file one. The plan lists each seeded issue and whether the board already shows it; the
// owner files the missing ones on the board.
//
// Reset deletes the demo repository by name and nothing else. It never lists the target to choose
// what to delete, so another repository cannot be swept up with it.
//
// The live target, a Railhead backend entry that initializes the repository and imports its main,
// does not exist yet; until it does the commands only plan, and `docs/demo-seed.md` gives the
// owner's steps.

import { assertDemoTarget, SeedRefusal, type SeedIssue, type SeedManifest } from "./manifest.ts";
import type { ImportedHistory } from "./history.ts";

/** A Railhead repository, `org/repo`. */
export interface RepoRef {
  readonly org: string;
  readonly repo: string;
}

/** What the target holds for one repository. */
export interface RepoState {
  /** The head of its main, or `null` before the history is imported. */
  readonly main: string | null;
  /** Its issues, in filing order. */
  readonly issues: readonly { readonly title: string; readonly body: string }[];
}

/** Where the seed writes. Each method touches only the repository it is given. */
export interface SeedTarget {
  /** The repository's state, or `null` when it does not exist. */
  read(ref: RepoRef): Promise<RepoState | null>;
  /** Creates the repository with an empty main. */
  createRepo(ref: RepoRef): Promise<void>;
  /** Sets the empty main to the imported history's head. */
  importMain(ref: RepoRef, history: ImportedHistory): Promise<void>;
  /** Deletes the repository and everything in it. */
  deleteRepo(ref: RepoRef): Promise<void>;
}

/** One step of a plan. */
export type SeedStep =
  | { readonly action: "repo.create"; readonly target: string }
  | { readonly action: "main.import"; readonly target: string; readonly head: string }
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

/** Plans a seed of `manifest` with `history` as main against what `target` holds now. */
export async function planSeed(
  manifest: SeedManifest,
  history: ImportedHistory,
  target: SeedTarget,
): Promise<PlannedStep[]> {
  const ref = demoRef(manifest);
  const name = `${ref.org}/${ref.repo}`;
  const state = await target.read(ref);

  if (state !== null && state.main !== null && state.main !== history.head) {
    throw new SeedRefusal(
      `${name} already has main at ${state.main}, not the import's ${history.head}. Reset it first.`,
    );
  }
  const filed = new Map((state?.issues ?? []).map((issue) => [issue.title, issue.body]));
  for (const issue of manifest.issues) {
    const body = filed.get(issue.title);
    if (body !== undefined && body !== issue.body) {
      throw new SeedRefusal(
        `${name} has an issue titled like a seeded one with another body. Reset it first.`,
      );
    }
  }

  return [
    { step: { action: "repo.create", target: name }, status: state === null ? "missing" : "done" },
    {
      step: { action: "main.import", target: `${name}@main`, head: history.head },
      status: state?.main === history.head ? "done" : "missing",
    },
    ...manifest.issues.map((issue, index): PlannedStep => ({
      step: { action: "issue.file", target: `${name}#seed-${index + 1}`, issue },
      status: filed.has(issue.title) ? "done" : "missing",
    })),
  ];
}

/**
 * Applies the missing repository and main steps of a fresh seed plan, in order, and returns the
 * plan. Missing issues stay missing: the owner files them on the board.
 */
export async function seed(
  manifest: SeedManifest,
  history: ImportedHistory,
  target: SeedTarget,
): Promise<PlannedStep[]> {
  const ref = demoRef(manifest);
  const plan = await planSeed(manifest, history, target);
  for (const { step, status } of plan) {
    if (status === "done") continue;
    switch (step.action) {
      case "repo.create":
        await target.createRepo(ref);
        break;
      case "main.import":
        await target.importMain(ref, history);
        break;
      case "issue.file":
        // The owner's step; the seed holds no authority to file an issue.
        break;
      case "repo.delete":
        throw new SeedRefusal("A seed plan never deletes.");
      default:
        return unreachable(step);
    }
  }
  return plan;
}

/** Plans a reset: one deletion of the demo repository, done when it is already absent. */
export async function planReset(
  manifest: SeedManifest,
  target: SeedTarget,
): Promise<PlannedStep[]> {
  const ref = demoRef(manifest);
  const state = await target.read(ref);
  return [
    {
      step: { action: "repo.delete", target: `${ref.org}/${ref.repo}` },
      status: state === null ? "done" : "missing",
    },
  ];
}

/** Deletes the demo repository if it exists, and returns the plan it applied. */
export async function reset(manifest: SeedManifest, target: SeedTarget): Promise<PlannedStep[]> {
  const ref = demoRef(manifest);
  const plan = await planReset(manifest, target);
  if (plan.some((planned) => planned.status === "missing")) await target.deleteRepo(ref);
  return plan;
}

/** One line per step, naming its target, for a dry run. */
export function describePlan(plan: readonly PlannedStep[]): string[] {
  return plan.map(({ step, status }) => {
    const mark = status === "done" ? "ok  " : "todo";
    switch (step.action) {
      case "repo.create":
        return `${mark} create repository ${step.target}`;
      case "main.import":
        return `${mark} import main ${step.target} = ${step.head}`;
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
