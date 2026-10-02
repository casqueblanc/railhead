// Agent inboxes: durable items, delivery facts and acknowledgements, and the read the ready gate
// relies on.

import type { AckResult, InboxDigest, InboxResult } from "@railhead/shared/agent-api";
import type { ClaimId } from "@railhead/shared/events";
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

/** One agent's inbox. Returning an item to the agent records it as delivered, never as acknowledged. */
export interface InboxPort {
  /** Unacknowledged items, oldest first, at most `limit`. */
  pending(agent: AgentPrincipal, limit: number): Promise<PortResult<InboxResult>>;
  /** The items piggybacked on a command result. */
  digest(agent: AgentPrincipal): Promise<PortResult<InboxDigest>>;
  /** Acknowledges the agent's own item. A repeat returns the first acknowledgement. */
  ack(agent: AgentPrincipal, item: number, plan: string): Promise<PortResult<AckResult>>;
  /** The ready gate for a claim at a generation. */
  readyGate(claimId: ClaimId, generation: number): Promise<PortResult<ReadyGate>>;
}
