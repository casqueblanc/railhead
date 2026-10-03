// Decisions: questions, versioned decisions and the claims that depend on them.

import type { DecisionsPort } from "../../contracts/decisions";
import type { ModuleFactory } from "../../repo/composeRepo";
import { createDecisions } from "./decisions";

/** Builds the decisions module of one repository. */
export const decisions: ModuleFactory<DecisionsPort> = (context, ports) =>
  createDecisions(context, ports);
