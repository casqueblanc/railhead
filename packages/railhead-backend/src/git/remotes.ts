// Where each Artifacts repository is served, read from the binding's repository info. A remote does
// not change for the life of a repository, so answers are kept, up to a bound.
//
// The binding's calls cannot be cancelled. A lookup that outlives its time limit answers `busy` and
// releases its handle, but it still counts as outstanding until its call returns: requests for the
// same repository share it rather than starting another, and once `maxPending` lookups are
// outstanding a new miss is answered `busy` without calling the binding.

import type { ArtifactsRepoName } from "../contracts/artifacts";
import { fail, ok, type PortResult } from "../contracts/result";
import type { RemoteResolver } from "./gateway";

/** The part of the Artifacts binding the resolver calls. The `ARTIFACTS` binding satisfies it. */
export interface ArtifactsInfoNamespace {
  /** Opens a repository; throws an `ArtifactsError` such as `NOT_FOUND`. */
  get(name: string): Promise<RepoHandle>;
}

type RepoHandle = Disposable & { info(): Promise<{ remote: string }> };

/** How long one lookup may take, how many may be outstanding, and how many remotes are kept. */
export interface RemoteLimits {
  readonly timeoutMs: number;
  readonly maxPending: number;
  readonly maxCached: number;
}

/** The production bounds. */
export const REMOTE_LIMITS: RemoteLimits = { timeoutMs: 10_000, maxPending: 32, maxCached: 256 };

/** Resolves remotes through `namespace`. */
export function artifactsRemotes(
  namespace: ArtifactsInfoNamespace,
  limits: RemoteLimits = REMOTE_LIMITS,
): RemoteResolver {
  const cache = new Map<ArtifactsRepoName, string>();
  // The answer of each lookup whose binding call has not returned, timed out or not.
  const pending = new Map<ArtifactsRepoName, Promise<PortResult<string>>>();
  return async (repo) => {
    const cached = cache.get(repo);
    if (cached !== undefined) return ok(cached);
    const shared = pending.get(repo);
    if (shared !== undefined) return shared;
    if (pending.size >= limits.maxPending) return slow();
    const lookup = lookUp(namespace, repo, limits.timeoutMs);
    pending.set(repo, lookup.answer);
    void lookup.settled.then(
      (result) => {
        pending.delete(repo);
        if (!result.ok) return;
        if (cache.size >= limits.maxCached) {
          const oldest = cache.keys().next();
          if (oldest.done !== true) cache.delete(oldest.value);
        }
        cache.set(repo, result.value);
      },
      // Only a failing disposal rejects; `answer` carries that error to its callers.
      () => {
        pending.delete(repo);
      },
    );
    return lookup.answer;
  };
}

/**
 * Reads `repo`'s remote. `answer` settles within `timeoutMs`, as `busy` if the binding has not
 * answered by then; `settled` once the binding call returns. The handle is disposed at whichever
 * comes first, and never used after.
 */
function lookUp(
  namespace: ArtifactsInfoNamespace,
  repo: ArtifactsRepoName,
  timeoutMs: number,
): { readonly answer: Promise<PortResult<string>>; readonly settled: Promise<PortResult<string>> } {
  let handle: RepoHandle | null = null;
  let expired = false;
  const release = (): void => {
    const held = handle;
    handle = null;
    held?.[Symbol.dispose]();
  };
  const settled = (async (): Promise<PortResult<string>> => {
    try {
      handle = await namespace.get(repo);
      if (expired) return slow();
      const info = await handle.info();
      return ok(info.remote);
    } catch (error) {
      // Only the code is read: a binding error's message may name the repository.
      return errorCode(error) === "NOT_FOUND"
        ? fail("not_found", "The repository is not in the store.")
        : fail("internal", "The repository store could not be read.");
    } finally {
      release();
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<PortResult<string>>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      release();
      resolve(slow());
    }, timeoutMs);
  });
  const stop = (): void => {
    clearTimeout(timer);
  };
  void settled.then(stop, stop);
  return { answer: Promise.race([settled, timedOut]), settled };
}

function slow(): PortResult<string> {
  return fail("busy", "The repository store is slow to answer.");
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
