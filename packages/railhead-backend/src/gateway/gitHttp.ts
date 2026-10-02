// The Git smart-HTTP adapter in the Worker: parses which remote a `/git/...` path names and hands
// the request, unread, to that repository's `Repo`, whose Git module authenticates and serves it.
//
//   /git/{org}/{repo}.git/...                    main
//   /git/{org}/{repo}/claims/{claimId}.git/...   a claim's fork

import { isRepoSegment } from "@railhead/shared/agent-api";
import { isId } from "@railhead/shared/events";
import type { GitTarget } from "../modules/git/entry";
import { repoObjectName } from "../repo/RepoObject";

/** The path prefix of every Git remote on the Railhead origin. */
export const GIT_PATH_PREFIX = "/git/";

const MAIN = /^\/git\/([^/]+)\/([^/]+)\.git(\/.*)?$/;
const FORK = /^\/git\/([^/]+)\/([^/]+)\/claims\/([^/]+)\.git(\/.*)?$/;

/** Answers one request under `GIT_PATH_PREFIX`. */
export async function serveGit(request: Request, env: Env): Promise<Response> {
  const remote = parseRemote(new URL(request.url).pathname);
  if (remote === null) return new Response("Not found.\n", { status: 404 });
  const repo = env.REPO.getByName(repoObjectName(remote.org, remote.repo));
  return repo.git(request, remote.target, remote.path);
}

interface Remote {
  org: string;
  repo: string;
  target: GitTarget;
  path: string;
}

function parseRemote(pathname: string): Remote | null {
  const fork = FORK.exec(pathname);
  if (fork !== null) {
    const [, org = "", repo = "", claimId = "", path = "/"] = fork;
    if (!isRepoSegment(org) || !isRepoSegment(repo) || !isId("claim", claimId)) return null;
    return { org, repo, target: { kind: "fork", claimId }, path };
  }
  const main = MAIN.exec(pathname);
  if (main !== null) {
    const [, org = "", repo = "", path = "/"] = main;
    if (!isRepoSegment(org) || !isRepoSegment(repo)) return null;
    return { org, repo, target: { kind: "main" }, path };
  }
  return null;
}
