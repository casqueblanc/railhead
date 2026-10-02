// Sessions: login challenges and session tokens. While missing, no caller authenticates. Until its task installs the module, every call refuses with `unavailable` and has no effect.

import type { SessionsPort } from "../../contracts/identity";
import { unavailableSessions } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the sessions module of one repository. */
export const sessions: ModuleFactory<SessionsPort> = () => unavailableSessions;
