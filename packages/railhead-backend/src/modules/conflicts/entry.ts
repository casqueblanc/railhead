// Conflicts: classifying a merge conflict as overlap or disagreement. No adapter or module calls it yet; its task defines the port's methods here and replaces the
// factory.

import type { ModuleFactory } from "../../repo/composeRepo";

/** The conflicts module's port. It has no methods until its task adds them. */
export type ConflictsPort = Readonly<Record<never, never>>;

/** Builds the conflicts module of one repository. */
export const conflicts: ModuleFactory<ConflictsPort> = () => ({});
