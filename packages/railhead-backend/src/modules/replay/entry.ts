// Replay: capturing a real event log and replaying it offline. No adapter or module calls it yet; its task defines the port's methods here and replaces the
// factory.

import type { ModuleFactory } from "../../repo/composeRepo";

/** The replay module's port. It has no methods until its task adds them. */
export type ReplayPort = Readonly<Record<never, never>>;

/** Builds the replay module of one repository. */
export const replay: ModuleFactory<ReplayPort> = () => ({});
