// Where each Artifacts repository is served, read from the binding's repository info. A remote does
// not change for the life of a repository, so answers are kept, up to a bound.

import type { ArtifactsRepoName } from "../contracts/artifacts";
import { fail, ok, type PortResult } from "../contracts/result";
import type { RemoteResolver } from "./gateway";

/** The part of the Artifacts binding the resolver calls. The `ARTIFACTS` binding satisfies it. */
export interface ArtifactsInfoNamespace {
  /** Opens a repository; throws an `ArtifactsError` such as `NOT_FOUND`. */
  get(name: string): Promise<Disposable & { info(): Promise<{ remote: string }> }>;
}

/** How long one lookup may take, and how many remotes are kept. */
export interface RemoteLimits {
  readonly timeoutMs: number;
  readonly maxCached: number;
}

/** The production bounds. */
export const REMOTE_LIMITS: RemoteLimits = { timeoutMs: 10_000, maxCached: 256 };

/** Resolves remotes through `namespace`. */
export function artifactsRemotes(
  namespace: ArtifactsInfoNamespace,
  limits: RemoteLimits = REMOTE_LIMITS,
): RemoteResolver {
  const cache = new Map<ArtifactsRepoName, string>();
  return async (repo) => {
    const cached = cache.get(repo);
    if (cached !== undefined) return ok(cached);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        resolve("timeout");
      }, limits.timeoutMs);
    });
    const lookup = (async (): Promise<PortResult<string>> => {
      try {
        using handle = await namespace.get(repo);
        const info = await handle.info();
        return ok(info.remote);
      } catch (error) {
        // Only the code is read: a binding error's message may name the repository.
        return errorCode(error) === "NOT_FOUND"
          ? fail("not_found", "The repository is not in the store.")
          : fail("internal", "The repository store could not be read.");
      }
    })();
    const result = await Promise.race([lookup, timedOut]);
    clearTimeout(timer);
    if (result === "timeout") return fail("busy", "The repository store is slow to answer.");
    if (result.ok) {
      if (cache.size >= limits.maxCached) {
        const oldest = cache.keys().next();
        if (oldest.done !== true) cache.delete(oldest.value);
      }
      cache.set(repo, result.value);
    }
    return result;
  };
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
