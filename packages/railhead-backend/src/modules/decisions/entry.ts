// Decisions: questions and versioned decisions. Until its task installs the module, every asynchronous call refuses with `unavailable`, the synchronous fence reader `currentVersions` returns `null` (unknown, so callers refuse), and no call has an effect.

import type { DecisionsPort } from "../../contracts/decisions";
import { unavailableDecisions } from "../../contracts/unavailable";
import type { ModuleFactory } from "../../repo/composeRepo";

/** Builds the decisions module of one repository. */
export const decisions: ModuleFactory<DecisionsPort> = () => unavailableDecisions;
