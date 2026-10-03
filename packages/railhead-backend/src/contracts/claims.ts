// Issues, claims and the Git gateway's authority. Every claim call carries the claim and the
// generation the agent last saw; the port compares them with current state inside the Repo
// transaction, so a stale owner is refused at the time of use.

import type { ClaimResult, ClaimView, ReadyRequest, ReadyResult } from "@railhead/shared/agent-api";
import type { ClaimId, CommitSha, IssueId } from "@railhead/shared/events";
import type { ArtifactsRepoName } from "./artifacts";
import type { AgentPrincipal, GrantFor } from "./principals";
import type { PortResult } from "./result";

/** A claim's pinned commit at one ownership generation: exactly what the train may merge. */
export interface ClaimPin {
  /** The claim. */
  claimId: ClaimId;
  /** The ownership generation the pin was recorded under. */
  generation: number;
  /** The pinned commit. */
  commit: CommitSha;
}

/** What a Git request asks to do. */
export interface GitAccess {
  /** The authenticated agent, or `null` for an anonymous request. */
  principal: AgentPrincipal | null;
  /** The remote: a claim's fork, or main. */
  target: { kind: "fork"; claimId: ClaimId } | { kind: "main" };
  /** `fetch` for upload-pack and its advertisement, `push` for receive-pack and its advertisement. */
  operation: "fetch" | "push";
}

/** The gateway's permission for one Git request, decided against current state. */
export interface GitGrant {
  /** The Artifacts repository the request is streamed to. Never chosen by the client. */
  repo: ArtifactsRepoName;
  /** The token scope the gateway mints internally for this request. */
  scope: "read" | "write";
  /** For a push, the claim and generation the push is fenced to; `null` for a fetch. */
  fence: { claimId: ClaimId; generation: number } | null;
}

/**
 * Issues and claims.
 *
 * `currentGeneration` and `workingGeneration` are fence readers: each is synchronous and reads only
 * the Repo's storage, so a caller calls it inside its own `log.transaction` or `atomically` body,
 * and what it returns holds until that transaction commits. Read outside a transaction, the result may already be stale.
 */
export interface ClaimsPort {
  /** The agent's active claim, or `null`. */
  activeClaim(agent: AgentPrincipal): Promise<PortResult<ClaimView | null>>;
  /** Claims the next ready issue, or returns the agent's active claim. */
  work(agent: AgentPrincipal): Promise<PortResult<ClaimResult>>;
  /** Claims a named issue, or returns the agent's active claim on it. */
  claim(agent: AgentPrincipal, issueId: IssueId): Promise<PortResult<ClaimResult>>;
  /**
   * Pins a commit at the agent's current generation. Refuses a stale generation, an unacknowledged
   * affecting decision, an unknown commit or a different commit after ready.
   */
  ready(
    agent: AgentPrincipal,
    claimId: ClaimId,
    request: ReadyRequest,
  ): Promise<PortResult<ReadyResult>>;
  /**
   * The claim's current pin, for the train. Fails unless the claim is ready at its recorded decision
   * versions with a clear inbox gate; a superseded pin reopens the claim and fails with
   * `decision_superseded`.
   */
  pin(claimId: ClaimId): Promise<PortResult<ClaimPin>>;
  /**
   * The claim's current ownership generation, or `null` when it is unknown, such as for an unknown
   * or released claim or a missing module. Call it only inside the caller's transaction; a pin is
   * current only if its generation equals this one, and `null` is a refusal.
   */
  currentGeneration(claimId: ClaimId): number | null;
  /**
   * The claim's ownership generation while it is working, or `null` once it is anything else, such
   * as ready, expired or unknown, or once its lease lapsed. A fence reader like `currentGeneration`:
   * call it inside the caller's transaction. A push is recorded only while this equals the push's
   * fence generation.
   */
  workingGeneration(claimId: ClaimId): number | null;
  /** Decides one Git request. A push needs the current owner of a working claim. */
  authorizeGit(access: GitAccess): Promise<PortResult<GitGrant>>;
  /** Files an issue. */
  fileIssue(grant: GrantFor<"issue.file">): Promise<PortResult<{ issueId: IssueId }>>;
  /**
   * Called by the Repo's alarm. Expires claims whose lease lapsed, retries the fork-token
   * revocations expired claims still owe, and asks for the alarm again at the next deadline.
   */
  resume(): Promise<void>;
}
