// An in-memory `SeedTarget` and `BoardIssues`: the stand-in for a Railhead instance in the seed's
// tests, and the empty instance a dry run plans against while no live target exists. It follows
// the backend's `demo.seed` and `demo.reset` rules (#149).

import { bundleHead, type MainBundle } from "./history.ts";
import {
  ActionStale,
  type BoardIssue,
  type BoardIssues,
  type RepoRef,
  type RepoState,
  type SeedTarget,
} from "./reconcile.ts";

/** A `SeedTarget` write method name. */
export type TargetMethod = Exclude<keyof SeedTarget, "read">;

interface StoredRepo {
  main: string | null;
  issues: BoardIssue[];
}

/** Repositories held in a map keyed `org/repo`. */
export class MemoryTarget implements SeedTarget, BoardIssues {
  readonly #repos = new Map<string, StoredRepo>();
  /** A method that throws after doing its write, as a write whose response was lost would. */
  #lostAfterWrite: TargetMethod | null = null;
  /** A method that throws before writing anything. */
  #failing: TargetMethod | null = null;

  /** Makes the next call of `method` write and then throw, once. */
  loseResponseOf(method: TargetMethod): void {
    this.#lostAfterWrite = method;
  }

  /** Makes the next call of `method` throw without writing, once. */
  fail(method: TargetMethod): void {
    this.#failing = method;
  }

  /** Every repository name held, sorted. */
  names(): string[] {
    return [...this.#repos.keys()].toSorted();
  }

  async read(ref: RepoRef): Promise<RepoState | null> {
    const repo = this.#repos.get(key(ref));
    return repo === undefined ? null : { main: repo.main };
  }

  async issues(ref: RepoRef): Promise<readonly BoardIssue[]> {
    return (this.#repos.get(key(ref))?.issues ?? []).map((issue) => ({ ...issue }));
  }

  /**
   * Creates the repository and imports main from the bundle's own header in one step, as the
   * backend does: a bundle that is not main alone at the approved head is refused, a repeat with
   * the same head succeeds, and a main at another head or a repository without a main is
   * `ActionStale`.
   */
  async seed(ref: RepoRef, bundle: MainBundle): Promise<void> {
    this.#before("seed");
    const head = bundleHead(bundle.bytes);
    if (head === null || head !== bundle.head) {
      throw new Error(`The bundle is not main alone at ${bundle.head}`);
    }
    const repo = this.#repos.get(key(ref));
    if (repo === undefined) {
      this.#repos.set(key(ref), { main: head, issues: [] });
    } else if (repo.main !== head) {
      throw new ActionStale(`${key(ref)} has main at ${repo.main ?? "nothing"}, not ${head}`);
    }
    this.#after("seed");
  }

  async reset(ref: RepoRef): Promise<boolean> {
    this.#before("reset");
    const deleted = this.#repos.delete(key(ref));
    this.#after("reset");
    return deleted;
  }

  /** Leaves `ref` existing without a main, as a reset that did not finish would; not part of the port. */
  leaveWithoutMain(ref: RepoRef): void {
    this.#repos.set(key(ref), { main: null, issues: [] });
  }

  /** Files an issue as the owner does on the board; not part of the port. */
  fileAsOwner(ref: RepoRef, issue: BoardIssue): void {
    const repo = this.#repos.get(key(ref));
    if (repo === undefined) throw new Error(`${key(ref)} does not exist`);
    repo.issues.push({ title: issue.title, body: issue.body });
  }

  #before(method: TargetMethod): void {
    if (this.#failing !== method) return;
    this.#failing = null;
    throw new Error(`${method} failed`);
  }

  #after(method: TargetMethod): void {
    if (this.#lostAfterWrite !== method) return;
    this.#lostAfterWrite = null;
    throw new Error(`${method} response lost`);
  }
}

function key(ref: RepoRef): string {
  return `${ref.org}/${ref.repo}`;
}
