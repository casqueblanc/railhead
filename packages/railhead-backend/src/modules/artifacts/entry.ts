// Artifacts: forks, reads and short-lived tokens, implemented by `createArtifactsAdapter` in
// `src/artifacts/` over the Worker's `ARTIFACTS` binding.

import { createArtifactsAdapter } from "../../artifacts/adapter";
import type { ArtifactsPort } from "../../contracts/artifacts";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the artifacts module of one repository. */
export const artifacts: ModuleFactory<ArtifactsPort> = (context) =>
  createArtifactsAdapter({
    repoId: context.repoId,
    storage: context.storage,
    clock: context.clock,
    namespace: context.env.ARTIFACTS,
  });
