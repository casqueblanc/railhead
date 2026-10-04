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
   * each covered live one was revoked.
   *
   * `pending_debt` means a covered token may still be live: a token of no recorded mint is too
   * recent to place before the cutoff while a later mint has not answered. It is not a revocation:
   * a caller must not grant a new holder write access to `repo` until a later call returns
   * `revoked`. A listing that cannot cover every live token is an `internal` failure, not a
   * `pending_debt`: the adapter keeps a fork below one page of tokens, so it means Artifacts changed
   * its listing, and `token` refuses `repo` while it lasts.
   */
  revokeTokens(repo: ArtifactsRepoName, cutoff: MintCutoff): Promise<PortResult<TokenRevocation>>;
}
