// Who is calling, as the backend established it. A principal is built only by the module that
// authenticated it: `sessions` builds an `AgentPrincipal` from a verified, current session, and
// `owner` builds a `HumanGrant` after consuming one passkey proof. No principal is ever read from a
// request body, and holding one does not replace the check, at the time of use, that the identity
// and its claim are still current.

import type { OwnerAction } from "@railhead/shared/board-api";
import type { AgentId, RepoId, SystemId, UserId } from "@railhead/shared/events";

/** An agent authenticated by a session that was valid when the call arrived. */
export interface AgentPrincipal {
  /** Always `agent`. */
  kind: "agent";
  /** The agent. */
  agentId: AgentId;
  /** The person who owns it. */
  ownerId: UserId;
  /** The repository its session is bound to. */
  repoId: RepoId;
}

/**
 * One consumed passkey proof: the owner approved exactly `action`, once. A port that performs a
 * human-only action takes the grant for that action kind and checks the action's fields again.
 */
export interface HumanGrant<A extends OwnerAction = OwnerAction> {
  /** Always `human`. */
  kind: "human";
  /** The person who approved. */
  userId: UserId;
  /** The repository the action applies to. */
  repoId: RepoId;
  /** The consumed challenge; a second use of it is refused. */
  grantId: string;
  /** The action the proof was bound to. */
  action: A;
}

/** A grant for one kind of owner action. */
export type GrantFor<K extends OwnerAction["kind"]> = HumanGrant<Extract<OwnerAction, { kind: K }>>;

/** A system component, such as the train or a check runner, acting inside the backend. */
export interface SystemPrincipal {
  /** Always `system`. */
  kind: "system";
  /** The component. */
  id: SystemId;
}

/**
 * The claims of a session token, signed by the backend. It names the agent, its owner and the
 * repository; the claim and its generation travel with each call instead, because ownership can
 * change while the token is still valid.
 */
export interface SessionClaims {
  /** The token layout version, 1. */
  v: 1;
  /** The agent. */
  sub: AgentId;
  /** The person who owns it. */
  owner: UserId;
  /** The repository the session is bound to. */
  repo: RepoId;
  /** When it was issued, in milliseconds since the Unix epoch. */
  iat: number;
  /** When it expires, `iat + SESSION_TTL_MS`. */
  exp: number;
  /** The token's unique id. */
  jti: string;
}
