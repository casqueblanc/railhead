// Decisions: questions and versioned decisions. Until its task installs the module, every call refuses with `unavailable` and has no effect.

import type { DecisionsPort } from "../../contracts/decisions";
import { unavailableDecisions } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the decisions module of one repository. */
export const decisions: ModuleFactory<DecisionsPort> = () => unavailableDecisions;
