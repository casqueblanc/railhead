// Agent inboxes: durable items, delivery facts and acknowledgements, and the read the ready gate
// relies on.

import type { AckResult, DecisionView, InboxDigest, InboxResult } from "@railhead/shared/agent-api";
import type { AgentId, ClaimId, InboxEntry } from "@railhead/shared/events";
import type { EventTransaction } from "../repo/eventLog";
import type { AgentPrincipal } from "./principals";
import type { PortResult } from "./result";

/**
 * Whether a claim may become ready, as far as its inbox is concerned. There is no default: a port
 * that cannot decide fails, and a failure blocks `ready`.
 */
export type ReadyGate =
  /** Every item affecting the claim at this generation is acknowledged. */
  | { kind: "clear" }
  /** These items are not acknowledged. */
  | { kind: "blocked"; items: number[] };

/** Whose inbox an item goes to: the agent holding `claimId` at `generation`. */
export interface InboxTarget {
  /** The agent. */
  agentId: AgentId;
  /** The claim the item concerns. */
  claimId: ClaimId;
  /** The claim's ownership generation the agent holds it at; the ready gate reads it. */
  generation: number;
}

/**
 * What to queue. A `decision` or `rework` entry carries the decision version as the agent will read
 * it, whose `decisionId` and `version` must match `entry.decision`; a `conflict` entry carries none.
 */
export type QueuedItem =
  | { entry: Extract<InboxEntry, { kind: "decision" | "rework" }>; decision: DecisionView }
  | { entry: Extract<InboxEntry, { kind: "conflict" }>; decision: null };

/** One agent's inbox. Returning an item to the agent records it as delivered, never as acknowledged. */
export interface InboxPort {
  /** Unacknowledged items, oldest first, at most `limit`. */
  pending(agent: AgentPrincipal, limit: number): Promise<PortResult<InboxResult>>;
  /** The items piggybacked on a command result. */
  digest(agent: AgentPrincipal): Promise<PortResult<InboxDigest>>;
  /** Acknowledges the agent's own item. A repeat returns the first acknowledgement. */
  ack(agent: AgentPrincipal, item: number, plan: string): Promise<PortResult<AckResult>>;
  /**
   * Queues one item inside the caller's transaction, which also records the change that caused it,
   * and returns its item number. The caller has checked, in the same transaction, that the target
   * agent holds the claim at that generation. Throws on an invalid target or item, so the whole
   * transaction rolls back; nothing is queued by default.
   */
  queue(tx: EventTransaction, target: InboxTarget, item: QueuedItem): number;
  /** The ready gate for a claim at a generation. */
  readyGate(claimId: ClaimId, generation: number): Promise<PortResult<ReadyGate>>;
}
