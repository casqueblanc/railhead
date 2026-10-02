// Sandbox: the isolated environment merges and checks run in, with bounded lifetime and concurrency.
// No adapter calls it directly; the merge and checks modules reach it through `ports().sandbox`.
// Its task defines the port's methods here and replaces the factory.

import type { ModuleFactory } from "../repo/composeRepo";

/** The sandbox's port. It has no methods until its task adds them. */
export type SandboxPort = Readonly<Record<never, never>>;

/** Builds the sandbox access of one repository. */
export const sandbox: ModuleFactory<SandboxPort> = () => ({});
