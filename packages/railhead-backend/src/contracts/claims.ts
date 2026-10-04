// Issues, claims and the Git gateway's authority. Every claim call carries the claim and the
// generation the agent last saw; the port compares them with current state inside the Repo
// transaction, so a stale owner is refused at the time of use.

import type {
  ClaimResult,
  ClaimView,
  ClosedClaimView,
  ReadyRequest,
  ReadyResult,
} from "@railhead/shared/agent-api";
import type {
  ClaimId,
  CommitSha,
  DecisionRef,
  IssueId,
  ReopenReason,
} from "@railhead/shared/events";
import type { EventTransaction } from "../repo/eventLog";
import type { ArtifactsRepoName } from "./artifacts";
import type { InboxTarget } from "./inbox";
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

/**
 * A pin with the ready episode it was batched in: what a check attempt and a merge intent rest on.
 * A claim reopened and readied again with the same commit is a new episode, which a check of the
 * earlier one does not cover.
 */
export interface EpisodePin extends ClaimPin {
  /** The claim's ready episode the pin was batched in. */
  episode: number;
}

/** A ready claim's stored pin, as `ClaimsPort.readyPin` reads it. */
export interface ReadyPin {
  /** The pin at the claim's current generation. */
  pin: ClaimPin;
  /** The ready episode the pin was recorded in. */
  episode: number;
  /** The decision versions the pin was recorded under. */
  decisions: DecisionRef[];
}

/**
 * A reason another module may reopen a ready claim for. A superseded decision is not one: the
 * claims module itself reopens a pin the decisions it was recorded under no longer match.
 */
export type ReworkReason = Exclude<ReopenReason, "decision_superseded">;

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
  /**
   * For a push, the claim, generation and working episode the push is fenced to; `null` for a
   * fetch. The episode tells a push granted before the claim went ready from one granted after it
   * was reopened at the same generation.
   */
  fence: { claimId: ClaimId; generation: number; episode: number } | null;
}

/**
 * Issues and claims.
 *
 * `currentGeneration`, `workingGeneration`, `workingEpisode` and `readyPin` are fence readers: each is synchronous and reads only
 * the Repo's storage, so a caller calls it inside its own `log.transaction` or `atomically` body,
 * and what it returns holds until that transaction commits. Read outside a transaction, the result may already be stale.
 */
export interface ClaimsPort {
  /** The agent's active claim, or `null`. */
  activeClaim(agent: AgentPrincipal): Promise<PortResult<ClaimView | null>>;
  /** The agent's most recently closed claim and why it closed, or `null` when none has. */
  lastClosed(agent: AgentPrincipal): Promise<PortResult<ClosedClaimView | null>>;
  /** Claims the next ready issue, or returns the agent's active claim. */
  work(agent: AgentPrincipal): Promise<PortResult<ClaimResult>>;
  /** Claims a named issue, or returns the agent's active claim on it. */
  claim(agent: AgentPrincipal, issueId: IssueId): Promise<PortResult<ClaimResult>>;
  /**
   * Pins a commit at the agent's current generation. Refuses a stale generation, an unacknowledged
   * affecting decision, an unknown commit or a different commit after ready. If the train's alarm
   * write fails after the pin commits, it fails with `unavailable` and the repeat asks again.
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
   * or expired claim, a lapsed lease or a missing module. A merged claim keeps its generation, so a
   * later decision version still reaches its holder; it has no pin, so `readyPin` refuses it. Call it
   * only inside the caller's transaction; a pin is current only if its generation equals this one,
   * and `null` is a refusal.
   */
  currentGeneration(claimId: ClaimId): number | null;
  /**
   * The claim's ownership generation while it is working, or `null` once it is anything else, such
   * as ready, expired or unknown, or once its lease lapsed. A fence reader like `currentGeneration`:
   * call it inside the caller's transaction. A push is recorded only while this equals the push's
   * fence generation.
   */
  workingGeneration(claimId: ClaimId): number | null;
  /**
   * The claim's episode while it is working, or `null` once it is anything else. The episode rises
   * each time the claim is pinned or reopened, so a push is recorded only while this also equals
   * the push's fence episode. A fence reader like `workingGeneration`.
   */
  workingEpisode(claimId: ClaimId): number | null;
  /**
   * The ready claim's pin, episode and recorded decision versions, or `null` once the claim is
   * anything but ready, such as working, closed or unknown, or for a missing module. A fence reader
   * like `currentGeneration`: call it inside the caller's transaction. It only reads, so it never
   * reopens a superseded pin; the caller compares `decisions` with the current versions, and a pin is
   * mergeable only while they are equal.
   */
  readyPin(claimId: ClaimId): ReadyPin | null;
  /**
   * Merges the claim of each landed pin that is still ready with that pin in that episode, appends
   * `claim.merged` for it and records `main`, the commit the landing published, as each holder's
   * closed claim. A pin whose claim was reopened, re-pinned or taken over is left as it is. A merged
   * claim no longer counts as its holder's, so the holder may reopen a merged claim waiting for
   * rework, as `reopenMerged` does. Writes inside `tx`, the transaction that settles the landing, after
   * anything that reads the claims as held. Throws when the module is missing, so the landing rolls
   * back rather than leaving its claims ready.
   */
  merged(tx: EventTransaction, landed: readonly EpisodePin[], main: CommitSha): void;
  /**
   * Called inside `tx`, the transaction that queued a decision item to the holder of the claim.
   * When a newer decision version superseded the pin of a merged claim, the claim reopens to working
   * and `claim.reopened` is appended, provided its holder holds no other active claim; otherwise it
   * waits, and reopens in the transaction that closes that claim. Any other claim is left as it is.
   * A missing module does nothing: with no claims module, no claim has a current generation, so no
   * item is queued to one.
   */
  reopenMerged(tx: EventTransaction, claimId: ClaimId): void;
  /**
   * The agent holding the claim and its current generation, or `null` whenever `currentGeneration`
   * is `null` or the claim merged. A fence reader like `currentGeneration`: call it inside the caller's transaction.
   */
  holder(claimId: ClaimId): InboxTarget | null;
  /**
   * Returns the claim to working because its pinned work must be redone for `reason`, inside the
   * caller's transaction, and appends `claim.reopened` with the claim's current decision versions.
   * The holder pushes the reworked commit and marks it ready again, which queues it on the train as
   * a new episode. Reopens only while the claim is ready with exactly `pin` in `episode`, so a
   * decision that reopened it first, a newer pin or a takeover is never undone; otherwise it
   * answers `false` and writes nothing. Throws `UnavailableError` while the claim's decision
   * versions are unknown or the module is missing, so the caller's transaction rolls back.
   */
  reopen(tx: EventTransaction, pin: ClaimPin, episode: number, reason: ReworkReason): boolean;
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
