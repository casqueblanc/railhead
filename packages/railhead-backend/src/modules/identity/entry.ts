// Identity: invites, enrollment and confirmation. Until its task installs the module, every call refuses with `unavailable` and has no effect.

import type { IdentityPort } from "../../contracts/identity";
import { unavailableIdentity } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the identity module of one repository. */
export const identity: ModuleFactory<IdentityPort> = () => unavailableIdentity;
