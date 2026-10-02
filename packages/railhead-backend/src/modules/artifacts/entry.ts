// Artifacts: forks, reads and short-lived tokens. Until its task installs the module, every call refuses with `unavailable` and has no effect.

import type { ArtifactsPort } from "../../contracts/artifacts";
import { unavailableArtifacts } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the artifacts module of one repository. */
export const artifacts: ModuleFactory<ArtifactsPort> = () => unavailableArtifacts;
