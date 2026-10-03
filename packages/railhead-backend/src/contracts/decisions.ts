// Questions and versioned decisions.

import type { AskRequest, QuestionResult } from "@railhead/shared/agent-api";
import type { ClaimId, DecisionId, DecisionRef, QuestionId } from "@railhead/shared/events";
import type { AgentPrincipal, GrantFor } from "./principals";
import type { PortResult } from "./result";

/**
 * Questions and decisions. Only a human grant records a decision version.
 *
 * `currentVersions` is a fence reader: it is synchronous and reads only the Repo's storage, so a
 * caller calls it inside its own `log.transaction` or `atomically` body, and what it returns holds
 * until that transaction commits. Read outside a transaction, the result may already be stale.
 */
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
  /**
   * The current version of every decision the claim's work must satisfy, as `requirements` returns
   * them, or `null` when they are unknown, such as for an unknown claim or a missing module. `[]`
   * means the claim genuinely requires no decision. Call it only inside the caller's transaction; a
   * recorded decision version is current only if it appears here, and `null` is a refusal.
   */
  currentVersions(claimId: ClaimId): DecisionRef[] | null;
}
