// Git: the smart-HTTP gateway between agents' Git clients and Artifacts, implemented by
// `createGitGateway` in `src/git/`. It streams to Artifacts remotes, and the Worker has no
// `ARTIFACTS` binding yet, so this slot still answers every request 503 without reading its body or
// reaching Artifacts. Once the binding is declared, the factory becomes:
//
//   (context, ports) => createGitGateway({
//     log: context.log,
//     ports,
//     remote: artifactsRemotes(context.env.ARTIFACTS),
//     upstream: (request) => fetch(request),
//   })

import type { GitAccess } from "../../contracts/claims";
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
}

/** Builds the Git module of one repository. */
export const git: ModuleFactory<GitPort> = () => ({
  serve: async () =>
    new Response("The git module is not available.\n", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
});
