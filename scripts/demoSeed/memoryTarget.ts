// An in-memory `SeedTarget`: the stand-in for a Railhead instance in the seed's tests, and the empty
// instance a dry run plans against while no live target exists.

import type { ImportedHistory } from "./history.ts";
import type { RepoRef, RepoState, SeedTarget } from "./reconcile.ts";

/** A `SeedTarget` method name. */
export type TargetMethod = Exclude<keyof SeedTarget, "read">;

interface StoredRepo {
  main: string | null;
  issues: { title: string; body: string }[];
}

/** Repositories held in a map keyed `org/repo`. */
export class MemoryTarget implements SeedTarget {
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
    return repo === undefined
      ? null
      : { main: repo.main, issues: repo.issues.map((i) => ({ ...i })) };
  }

  async createRepo(ref: RepoRef): Promise<void> {
    this.#before("createRepo");
    if (this.#repos.has(key(ref))) throw new Error(`${key(ref)} already exists`);
    this.#repos.set(key(ref), { main: null, issues: [] });
    this.#after("createRepo");
  }

  async importMain(ref: RepoRef, history: ImportedHistory): Promise<void> {
    this.#before("importMain");
    const repo = this.#existing(ref);
    if (repo.main !== null) throw new Error(`${key(ref)} already has a main`);
    repo.main = history.head;
    this.#after("importMain");
  }

  async fileIssue(ref: RepoRef, issue: { title: string; body: string }): Promise<void> {
    this.#before("fileIssue");
    this.#existing(ref).issues.push({ title: issue.title, body: issue.body });
    this.#after("fileIssue");
  }

  async deleteRepo(ref: RepoRef): Promise<void> {
    this.#before("deleteRepo");
    if (!this.#repos.delete(key(ref))) throw new Error(`${key(ref)} does not exist`);
    this.#after("deleteRepo");
  }

  #existing(ref: RepoRef): StoredRepo {
    const repo = this.#repos.get(key(ref));
    if (repo === undefined) throw new Error(`${key(ref)} does not exist`);
    return repo;
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
