// Identity and sessions: who an agent is, and how it proves it on each call.

import type {
  AgentView,
  ChallengeRequest,
  EnrollmentState,
  ChallengeResult,
  JoinRequest,
  JoinResult,
  SessionRequest,
  SessionResult,
} from "@railhead/shared/agent-api";
import type { PendingJoin } from "@railhead/shared/board-api";
import type { AgentId, InviteId, UserId } from "@railhead/shared/events";
import type { AgentPrincipal, GrantFor } from "./principals";
import type { PortResult } from "./result";

/** Invites and enrollment. Every write here needs an invite secret or a human grant. */
export interface IdentityPort {
  /**
   * Registers the request's key with its invite, or resumes the enrollment that key already holds.
   * A consumed invite never enrolls a second key. Every refusal stores nothing: a bad invite,
   * secret, key or proof is `join_refused`, too many refused proofs for one invite in a short time
   * make that invite `rate_limited`, and the key of a revoked agent is `identity_revoked`.
   */
  join(request: JoinRequest): Promise<PortResult<JoinResult>>;
  /** Creates a single-use invite. The returned URL carries the secret; only its hash is stored. */
  createInvite(
    grant: GrantFor<"invite.create">,
  ): Promise<PortResult<{ inviteId: InviteId; inviteUrl: string; expiresAt: number }>>;
  /** Confirms a pending agent whose code matches the grant's. */
  confirm(grant: GrantFor<"agent.confirm">): Promise<PortResult<{ agentId: AgentId }>>;
  /** Revokes an agent. Its sessions fail at their next call. */
  revoke(grant: GrantFor<"agent.revoke">): Promise<PortResult<{ agentId: AgentId }>>;
  /** The joins waiting for the owner, oldest first. */
  pendingJoins(): Promise<PortResult<PendingJoin[]>>;
  /**
   * The authenticated agent as it sees itself. Fails with `identity_revoked` once it is revoked,
   * and with `unauthenticated` when the principal names no agent of this repository.
   */
  view(agent: AgentPrincipal): Promise<PortResult<AgentView>>;
  /**
   * The key and standing of `agentId`, read now, for the sessions module to verify a login and to
   * check a session at the time of use. `null` when no such agent joined this repository.
   */
  credential(agentId: AgentId): Promise<PortResult<AgentCredential | null>>;
}

/** Where an agent stands, including revocation, which the agent's own view never shows. */
export type AgentStanding = EnrollmentState | "revoked";

/** What the sessions module needs to authenticate an agent. */
export interface AgentCredential {
  /** The agent. */
  agentId: AgentId;
  /** Its OpenSSH public key line, `ssh-ed25519 <base64 blob>`. */
  publicKey: string;
  /** The person who owns it. */
  ownerId: UserId;
  /** Only a `confirmed` agent may log in or keep a session. */
  standing: AgentStanding;
}

/** Login challenges and session tokens. */
export interface SessionsPort {
  /** Issues a single-use challenge. It creates no state an unauthenticated caller can grow. */
  issueChallenge(request: ChallengeRequest): Promise<PortResult<ChallengeResult>>;
  /** Redeems a signed challenge once, for a confirmed and unrevoked agent. */
  redeem(request: SessionRequest): Promise<PortResult<SessionResult>>;
  /**
   * Verifies a bearer token and checks, now, that its agent is confirmed and not revoked and that
   * it is bound to this repository. Fails with `unauthenticated`, `identity_pending` or
   * `identity_revoked`.
   */
  authenticate(token: string): Promise<PortResult<AgentPrincipal>>;
}
