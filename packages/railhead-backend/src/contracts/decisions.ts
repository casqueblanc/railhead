// Questions and versioned decisions.

import type { AskRequest, QuestionResult } from "@railhead/shared/agent-api";
import type { ClaimId, DecisionId, DecisionRef, QuestionId } from "@railhead/shared/events";
import type { EventTransaction } from "../repo/eventLog";
import type { InboxTarget } from "./inbox";
import type { AgentPrincipal, GrantFor } from "./principals";
import type { PortResult } from "./result";

/**
 * What a decision version asks of one claim's work. Every version records one for each claim that
 * depends on the decision, and one is never recorded twice for the same claim, version and kind.
 */
export interface DecisionObligation {
  /** The claim whose work must take the version up. */
  claimId: ClaimId;
  /** The version. */
  decision: DecisionRef;
  /**
   * `decision` when the claim must follow the version before its work is authorized; `rework`
   * when work already authorized or merged relied on an older version and must be redone.
   */
  kind: "decision" | "rework";
  /**
   * The inbox item it was delivered as, or `null` while no holder could receive it: the claim was
   * merged, expired, unknown, or held by an owner its dependency has not been transferred to.
   */
  item: number | null;
  /** When it was recorded. */
  recordedAt: number;
}

/**
 * Questions and decisions. Only a human grant records a decision version.
 *
 * `currentVersions` and `obligations` are fence readers: they are synchronous and read only the
 * Repo's storage, so a caller calls them inside its own `log.transaction` or `atomically` body, and
 * what they return holds until that transaction commits. Read outside a transaction, the result may
 * already be stale. `transfer` and `relied` write inside the caller's transaction and throw on
 * anything they refuse, so the caller's whole change rolls back.
 *
 * A version is delivered only to the agent a dependency names, at the generation it names, and only
 * while the claims module reports that generation as current. Any other dependency keeps a pending
 * obligation; nothing is sent to a former owner.
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
  /**
   * Moves the claim's dependencies to its new holder inside the caller's transaction, which also
   * records the takeover, and queues to it the current version of each recorded decision: `rework`
   * when the claim's work relied on an older version or a rework obligation is pending, otherwise
   * `decision`. Pending obligations of those decisions are recorded as delivered by that item. A
   * repeat for the same holder queues nothing. Throws unless `target.generation` is the claim's
   * current generation.
   */
  transfer(tx: EventTransaction, target: InboxTarget): void;
  /**
   * Records, inside the caller's transaction, the decision versions the claim's work was authorized
   * or merged under at `generation`. `refs` may name decisions other claims depend on; only the
   * claim's own dependencies are recorded. A relied version older than the current one is a
   * `rework` obligation at once, and a later version of a relied decision is one too. A repeat
   * records nothing more. Throws on an invalid argument or a version that was never recorded.
   */
  relied(tx: EventTransaction, claimId: ClaimId, generation: number, refs: DecisionRef[]): void;
  /**
   * The claim's latest obligation of each kind for each decision it depends on, oldest first,
   * including those of a merged or expired claim; a later version's obligation replaces an older
   * one's. `null` when `claimId` is not a claim identifier or the module is missing. Call it only
   * inside the caller's transaction.
   */
  obligations(claimId: ClaimId): DecisionObligation[] | null;
}
