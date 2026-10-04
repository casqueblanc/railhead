// Git: the smart-HTTP gateway between agents' Git clients and Artifacts, implemented by
// `createGitGateway` in `src/git/`. It streams each request to the Artifacts remote the binding
// names for the repository.

import type { GitAccess } from "../../contracts/claims";
import { createGitGateway } from "../../git/gateway";
import { artifactsRemotes } from "../../git/remotes";
import type { ModuleFactory } from "../../repo/composeRepo";

/** The remote a Git request names, parsed from its path by the gateway. */
export type GitTarget = GitAccess["target"];

/** Serves Git requests for one repository. */
export interface GitPort {
  /**
   * Answers one smart-HTTP request. `path` is what follows the remote's `.git`, such as
   * `/info/refs`; the caller is authenticated from the request's own credentials.
   */
  serve(request: Request, target: GitTarget, path: string): Promise<Response>;
  /**
   * Called by the Repo's alarm. Records the pushes Artifacts may have applied whose report never
   * settled them, and asks for the next wake they need.
   */
  resume(): Promise<void>;
}

/** Builds the Git module of one repository. */
export const git: ModuleFactory<GitPort> = (context, ports) =>
  createGitGateway({
    log: context.log,
    storage: context.storage,
    clock: context.clock,
    // The Repo's wake resolves whether its alarm write succeeded, which the gateway needs before it
    // releases a push.
    wake: context.wake,
    ports,
    remote: artifactsRemotes(context.env.ARTIFACTS),
    upstream: (request) => fetch(request),
  });
