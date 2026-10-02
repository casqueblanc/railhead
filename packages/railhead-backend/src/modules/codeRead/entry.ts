// Code read: bounded reads of repository files and history for the board. No adapter or module calls it yet; its task defines the port's methods here and replaces the
// factory.

import type { ModuleFactory } from "../../repo/composeRepo";

/** The codeRead module's port. It has no methods until its task adds them. */
export type CodeReadPort = Readonly<Record<never, never>>;

/** Builds the codeRead module of one repository. */
export const codeRead: ModuleFactory<CodeReadPort> = () => ({});
