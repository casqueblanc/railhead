// The Artifacts boundary. Tokens minted here never leave the Worker: they are not returned to a
// client, written to the event log or logged.

import type { ClaimId, CommitSha } from "@railhead/shared/events";
import type { PortResult } from "./result";

/** An Artifacts repository name, derived by the backend from the repository and claim. */
export type ArtifactsRepoName = string;

/** A short-lived Artifacts token. Its `value` is a secret. */
export interface ArtifactsToken {
  /** The bearer value. */
  value: string;
  /** What it allows. */
  scope: "read" | "write";
  /** The repository it is for. */
  repo: ArtifactsRepoName;
  /** When it stops working. */
  expiresAt: number;
}

/** Fork, read and token operations. There is no main-write token here; see `MainRefPort`. */
export interface ArtifactsPort {
  /**
   * Forks main at `base` for a claim. A repeat for the same claim returns the same fork, after
   * reconciling a fork whose creation response was lost. The initial token Artifacts returns with
   * a new fork is revoked, never kept.
   */
  forkForClaim(
    claimId: ClaimId,
    base: CommitSha,
  ): Promise<PortResult<{ repo: ArtifactsRepoName; head: CommitSha }>>;
  /** Whether `commit` exists in `repo`. */
  commitExists(repo: ArtifactsRepoName, commit: CommitSha): Promise<PortResult<boolean>>;
  /**
   * Mints a token. `write` is refused for the main repository; only `MainRefPort` moves main.
   */
  token(
    repo: ArtifactsRepoName,
    scope: "read" | "write",
    ttlMs: number,
  ): Promise<PortResult<ArtifactsToken>>;
  /** Revokes every token for `repo`, as `ready` and lease expiry require. */
  revokeTokens(repo: ArtifactsRepoName): Promise<PortResult<void>>;
}
