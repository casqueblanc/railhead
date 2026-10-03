// Artifacts: forks, reads and short-lived tokens, implemented by `createArtifactsAdapter` in
// `src/artifacts/`. The Worker has no `ARTIFACTS` binding yet, so this slot still refuses every call
// with `unavailable` and has no effect. Once the binding is declared, the factory becomes
// `(context) => createArtifactsAdapter({ ...context, namespace: context.env.ARTIFACTS })`.

import type { ArtifactsPort } from "../../contracts/artifacts";
import { unavailableArtifacts } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the artifacts module of one repository. */
export const artifacts: ModuleFactory<ArtifactsPort> = () => unavailableArtifacts;
