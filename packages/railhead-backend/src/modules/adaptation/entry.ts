// Adaptation: recording landed work's adaptation to a newer decision version. No adapter or module calls it yet; its task defines the port's methods here and replaces the
// factory.

import type { ModuleFactory } from "../../repo/composeRepo";

/** The adaptation module's port. It has no methods until its task adds them. */
export type AdaptationPort = Readonly<Record<never, never>>;

/** Builds the adaptation module of one repository. */
export const adaptation: ModuleFactory<AdaptationPort> = () => ({});
