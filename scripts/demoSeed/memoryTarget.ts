// An in-memory `SeedTarget`: the stand-in for a Railhead instance in the seed's tests, and the empty
// instance a dry run plans against while no live target exists.

import { bundleHead, type MainBundle } from "./history.ts";
import { ActionStale, type RepoRef, type RepoState, type SeedTarget } from "./reconcile.ts";

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

  /**
   * Imports main from the bundle's own header, as the backend does: a bundle that is not main
   * alone at the approved head is refused, a repeat with the same head succeeds, and a main at
   * another head is `ActionStale`.
   */
  async importMain(ref: RepoRef, bundle: MainBundle): Promise<void> {
    this.#before("importMain");
    const repo = this.#existing(ref);
    const head = bundleHead(bundle.bytes);
    if (head === null || head !== bundle.head) {
      throw new Error(`The bundle is not main alone at ${bundle.head}`);
    }
    if (repo.main !== null && repo.main !== head) {
      throw new ActionStale(`${key(ref)} has main at ${repo.main}, not ${head}`);
    }
    repo.main = head;
    this.#after("importMain");
  }

  /** Files an issue as the owner does on the board; not part of the port. */
  fileAsOwner(ref: RepoRef, issue: { title: string; body: string }): void {
    this.#existing(ref).issues.push({ title: issue.title, body: issue.body });
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
