// An in-memory `SeedTarget` and `BoardIssues`: the stand-in for a Railhead instance in the seed's
// tests, and the empty instance a dry run plans against without `--target`. It follows
// the backend's `demo.seed` and `demo.reset` rules (#149).

import { bundleHead, type MainBundle } from "./history.ts";
import {
  ActionStale,
  type BoardIssue,
  type BoardIssues,
  type BoardScan,
  type RepoRef,
  type RepoState,
  type SeedTarget,
} from "./reconcile.ts";

/** A `SeedTarget` write method name. */
export type TargetMethod = Exclude<keyof SeedTarget, "read">;

interface StoredRepo {
  main: string | null;
  /** Whether the repository is visible to `read`; a seed sets it last, after importing main. */
  initialized: boolean;
  issues: BoardIssue[];
  /** The board history; a repository created again after a reset gets another. */
  history: string;
}

/** Repositories held in a map keyed `org/repo`. */
export class MemoryTarget implements SeedTarget, BoardIssues {
  readonly #repos = new Map<string, StoredRepo>();
  /** How many repositories this target has created, which names each one's history. */
  #created = 0;
  /** A method that throws after doing its write, as a write whose response was lost would. */
  #lostAfterWrite: TargetMethod | null = null;
  /** A method that throws before writing anything. */
  #failing: TargetMethod | null = null;
  /** Whether the next seed imports main and then throws before initializing the repository. */
  #failingAfterImport = false;

  /** Makes the next call of `method` write and then throw, once. */
  loseResponseOf(method: TargetMethod): void {
    this.#lostAfterWrite = method;
  }

  /** Makes the next call of `method` throw without writing, once. */
  fail(method: TargetMethod): void {
    this.#failing = method;
  }

  /**
   * Makes the next seed import main and then throw before initializing the repository, once, as a
   * backend seed whose token sweep or initialization failed: main stays while `read` sees nothing.
   */
  failAfterImport(): void {
    this.#failingAfterImport = true;
  }

  /** Every repository name held, initialized or not, sorted. */
  names(): string[] {
    return [...this.#repos.keys()].toSorted();
  }

  async read(ref: RepoRef): Promise<RepoState | null> {
    const repo = this.#repos.get(key(ref));
    return repo === undefined || !repo.initialized ? null : { main: repo.main };
  }

  async scan(ref: RepoRef, titles: ReadonlySet<string>): Promise<BoardScan> {
    return { issues: await this.issues(ref, titles), history: await this.history(ref) };
  }

  async history(ref: RepoRef): Promise<string | null> {
    const repo = this.#repos.get(key(ref));
    return repo === undefined || !repo.initialized ? null : repo.history;
  }

  /**
   * The repository's issues titled one of `titles`, or every issue without `titles`; not part of
   * the port.
   */
  async issues(ref: RepoRef, titles?: ReadonlySet<string>): Promise<readonly BoardIssue[]> {
    const repo = this.#repos.get(key(ref));
    return repo === undefined || !repo.initialized
      ? []
      : repo.issues
          .filter((issue) => titles === undefined || titles.has(issue.title))
          .map((issue) => ({ ...issue }));
  }

  /**
   * Imports main from the bundle's own header, then initializes the repository, as the backend
   * does: a bundle that is not main alone at the approved head is refused, a repeat with the same
   * head succeeds and initializes a repository a failed seed left hidden, and a main at another
   * head, hidden or not, or an initialized repository without a main is `ActionStale`.
   */
  async seed(ref: RepoRef, bundle: MainBundle): Promise<void> {
    this.#before("seed");
    const head = bundleHead(bundle.bytes);
    if (head === null || head !== bundle.head) {
      throw new Error(`The bundle is not main alone at ${bundle.head}`);
    }
    const repo = this.#repos.get(key(ref)) ?? this.#newRepo(false);
    if (repo.main !== head && (repo.main !== null || repo.initialized)) {
      throw new ActionStale(`${key(ref)} has main at ${repo.main ?? "nothing"}, not ${head}`);
    }
    repo.main = head;
    this.#repos.set(key(ref), repo);
    if (this.#failingAfterImport) {
      this.#failingAfterImport = false;
      throw new Error("seed failed after importing main");
    }
    repo.initialized = true;
    this.#after("seed");
  }

  /** Deletes the repository whether or not it was initialized, as the backend deletes by name. */
  async reset(ref: RepoRef): Promise<boolean> {
    this.#before("reset");
    const deleted = this.#repos.delete(key(ref));
    this.#after("reset");
    return deleted;
  }

  /** Leaves `ref` existing without a main, as a reset that did not finish would; not part of the port. */
  leaveWithoutMain(ref: RepoRef): void {
    this.#repos.set(key(ref), this.#newRepo(true));
  }

  /** Files an issue as the owner does on the board; not part of the port. */
  fileAsOwner(ref: RepoRef, issue: BoardIssue): void {
    const repo = this.#repos.get(key(ref));
    if (repo?.initialized !== true) throw new Error(`${key(ref)} does not exist`);
    repo.issues.push({ title: issue.title, body: issue.body });
  }

  #newRepo(initialized: boolean): StoredRepo {
    this.#created += 1;
    return { main: null, initialized, issues: [], history: `history-${this.#created}` };
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
