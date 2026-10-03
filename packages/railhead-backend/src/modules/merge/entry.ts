// Merge: composing exact pins into a candidate with real Git in a sandbox (see
// `src/train/merge/compose.ts`). It publishes only candidate refs and never writes main.

import { forkRepoName, mainRepoName } from "../../artifacts/adapter";
import type { MergePort } from "../../contracts/train";
import type { ModuleFactory } from "../../repo/composeRepo";
import { createMerge } from "../../train/merge/compose";
import { parseRemote, type RemoteLocation } from "../../train/merge/script";

/** Builds the merge module of one repository. */
export const merge: ModuleFactory<MergePort> = (context, ports) => {
  // The host and namespace never change for a repository, so one successful lookup is kept.
  let location: RemoteLocation | null = null;
  return createMerge({
    sandbox: () => ports().sandbox,
    locate: async () => {
      location ??= await locateRemote(context.env.ARTIFACTS, await mainRepoName(context.repoId));
      return location;
    },
    mainRepo: () => mainRepoName(context.repoId),
    forkRepo: (claimId) => forkRepoName(context.repoId, claimId),
    commitExists: (repo, commit) => ports().artifacts.commitExists(repo, commit),
    clock: context.clock,
  });
};

/** Reads the main repository's Git remote through the binding, outside any sandbox. */
async function locateRemote(artifacts: Artifacts, name: string): Promise<RemoteLocation | null> {
  using repo = await artifacts.get(name);
  return parseRemote((await repo.info()).remote, name);
}
