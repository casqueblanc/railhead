// Questions and versioned decisions.

import type { AskRequest, QuestionResult } from "@railhead/shared/agent-api";
import type {
  AgentId,
  ClaimId,
  DecisionId,
  DecisionRef,
  QuestionId,
  QuestionOption,
  SystemId,
} from "@railhead/shared/events";
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
   * Its latest delivery: the agent and that agent's inbox item, since item numbers are per agent.
   * `null` while no holder could receive it: the claim was merged, expired, unknown, or held by an
   * owner its dependency has not been transferred to. `transfer` replaces a former holder's
   * delivery with the new holder's; the event log keeps the former one.
   */
  delivery: { agentId: AgentId; item: number } | null;
  /** When it was recorded. */
  recordedAt: number;
}

/** A question a system module asks the owner on its own authority, about claims it holds pins of. */
export interface SystemQuestion {
  /** The module asking, recorded as the system actor of `question.asked`. */
  asker: SystemId;
  /**
   * The asker's idempotency key, at most `MAX_SYSTEM_QUESTION_KEY_LENGTH` characters: a repeat
   * with the same key returns the question it asked and records nothing.
   */
  key: string;
  /**
   * The claims whose work depends on the answer, each at the generation the asker read it at, all
   * different. The first is the question's claim in `question.asked`.
   */
  claims: { claimId: ClaimId; generation: number }[];
  /** The question, as an agent's question is bounded. */
  text: string;
  /** The answers the owner chooses from. */
  options: QuestionOption[];
  /** The repository paths the answer covers. */
  scope: string[];
}

/** Longest `SystemQuestion.key`. */
export const MAX_SYSTEM_QUESTION_KEY_LENGTH = 128;

/**
 * Questions and decisions. Only a human grant records a decision version.
 *
 * `currentVersions`, `currentDecision` and `obligations` are fence readers: they are synchronous and read only the
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
  /**
   * Asks the owner a system question inside the caller's transaction, which also records the change
   * that raised it, and appends `question.asked` with the asker as actor. Each claim becomes a
   * dependency of the question's decision, held by the agent holding the claim at its generation, so
   * the answer reaches each holder's inbox and supersedes each claim's ready pin. Recording a version
   * of a system question also asks for the Repo's alarm, so the asker's `resume` sees the answer. A
   * repeat of the asker's `key` returns the question it asked and records nothing. Refuses without
   * writing anything: `invalid_request` for an invalid question or a key used for another question,
   * `claim_closed` for a claim not held at its generation, `quota_exceeded` for a claim that already
   * depends on `MAX_LIST_LENGTH` decisions, and `unavailable` while the module is missing.
   */
  askSystem(
    tx: EventTransaction,
    question: SystemQuestion,
  ): PortResult<{ questionId: QuestionId; decisionId: DecisionId }>;
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
   * The decision's current version and the key of the option it chose, or `null` when the decision
   * is unknown, still open, or the module is missing; `null` is a refusal. It reads the decision,
   * not a claim, so it answers for decisions whose claims have merged. Call it only inside the
   * caller's transaction.
   */
  currentDecision(decisionId: DecisionId): { version: number; option: string } | null;
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
   * `rework` obligation at once, and a later version of a relied decision is one too. Rework is
   * queued to the dependency's current holder, so work done before a takeover reaches the
   * successor, never the former owner. A repeat records nothing more. Throws on an invalid
   * argument, a `generation` newer than the claim's current one, or a version that was never
   * recorded.
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
