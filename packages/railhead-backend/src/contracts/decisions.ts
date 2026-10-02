// Questions and versioned decisions.

import type { AskRequest, QuestionResult } from "@railhead/shared/agent-api";
import type { ClaimId, DecisionId, DecisionRef, QuestionId } from "@railhead/shared/events";
import type { AgentPrincipal, GrantFor } from "./principals";
import type { PortResult } from "./result";

/** Questions and decisions. Only a human grant records a decision version. */
export interface DecisionsPort {
  /** Asks a question about the agent's claim. A repeat with the same `requestId` returns it again. */
  ask(
    agent: AgentPrincipal,
    claimId: ClaimId,
    request: AskRequest,
  ): Promise<PortResult<QuestionResult>>;
  /** Reads a question the agent asked, waiting up to `waitMs` for an answer. */
  question(
    agent: AgentPrincipal,
    questionId: QuestionId,
    waitMs: number,
  ): Promise<PortResult<QuestionResult>>;
  /** Records a version, if the grant's `expectedVersion` is still the current one. */
  record(
    grant: GrantFor<"decision.record">,
  ): Promise<PortResult<{ decisionId: DecisionId; version: number }>>;
  /** The current version of every decision the claim's work must satisfy. */
  requirements(claimId: ClaimId): Promise<PortResult<DecisionRef[]>>;
}
