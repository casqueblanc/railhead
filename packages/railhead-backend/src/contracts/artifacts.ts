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

/** The outcome of `ArtifactsPort.revokeTokens`; only `revoked` ends a holder's access. */
export type TokenRevocation = "revoked" | "pending_debt";

/**
 * Which tokens one revocation attempt may revoke, captured when the attempt begins: those of mints
 * recorded at or before `seq`, and those of no recorded mint created before `startedAt` less the
 * clock skew. A token minted after the attempt began is never among them.
 */
export interface MintCutoff {
  /** The latest mint record when the attempt began; later records are never swept by it. */
  readonly seq: number;
  /** When the attempt began, in milliseconds since the Unix epoch. */
  readonly startedAt: number;
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
  /**
   * Revokes the tokens for `repo` that `cutoff` covers, as `ready` and lease expiry require, and
   * never a token minted after the attempt began, so a late sweep cannot end a newer holder's
   * access. `revoked` means no covered token can still be used: the listing covered every token and
   * each covered live one was revoked, or every token the fork may hold has expired.
   *
   * `pending_debt` means a covered token may still be live: the listing could not cover every
   * token, or a token of no recorded mint is too recent to place before the cutoff while a later
   * mint has not answered. It is not a revocation: a caller must not grant a new holder write access
   * to `repo` until a later call returns `revoked`. After a partial listing `token` refuses `repo`,
   * and that debt ends by itself at most `MAX_TOKEN_TTL_MS` plus clock skew after it was recorded.
   */
  revokeTokens(repo: ArtifactsRepoName, cutoff: MintCutoff): Promise<PortResult<TokenRevocation>>;
}
