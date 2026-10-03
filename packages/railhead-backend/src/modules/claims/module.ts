// Claims: thin issues, one active claim per agent, and allocation of a fork for each claim.
//
// Allocation has two steps. The first is synchronous, inside one Repo transaction: it chooses the
// issue, checks the agent's and the owner's limits and records the claim as a fork intent. Nothing
// can run between the choice and the record, so two requests never get the same issue. The second
// step awaits other ports: it reads main through the main writer, records that commit as the fork's requested base, forks,
// and opens the claim with the fork's head as its immutable base. If a response is lost, the
// intent stays; the agent's next `work`, `claim` or status call finishes the same claim, and the
// Artifacts adapter reconciles a fork that was created without its response.
//
// `ready` pins an exact commit. The commit's existence in the fork is checked first, since that
// awaits Artifacts; then one transaction checks that the agent still holds the claim at the
// generation it sent, that the inbox gate is clear and that the decision versions are known, and
// records the pin with those versions and that the fork's tokens are owed a revocation, and queues
// it on the train as that transaction's last write, so the pin reaches the train exactly once. Only
// then are the tokens revoked. Until a revocation reports `revoked`, `ready` answers `busy`, the
// Repo's alarm retries it and `pin` refuses with `busy`, since a partial token listing may hide a
// live token. A repeat of the same pin passes the same gate and returns it, revoking again while
// the revocation is owed, so a lost response is answered by retrying; if the train holds no entry
// for the pin, the repeat queues it in that transaction. `pin`, the train's read, answers only
// while those versions are still the current ones and the inbox gate is still clear. From the pin
// on, `authorizeGit` refuses every push to the fork; a push already granted may still move the
// fork's branch, but never the pin, which names a commit rather than a ref. Each pin and each
// reopening raises the claim's episode, and a push is fenced to the episode it was granted in, so a
// push granted before ready is never recorded after a reopening.
//
// A decision version recorded after ready supersedes the pin: the train must not take it, and the
// holder must adapt. The first claims call that reads such a claim, whether a `ready`, the holder's
// push, the train's `pin` or a status read, returns it to working, clears the pin and appends
// `claim.reopened`. The holder then pushes and marks the work ready again under the new versions,
// once it has acknowledged them. While the versions are unknown, the pin stays and is refused.
//
// A refusal the agent sees is recorded as `claim.refused` only when it differs from the claim's
// last recorded refusal, so an agent that repeats a refused `ready` does not grow the log.
//
// An allocating or working claim is a lease of `CLAIM_LEASE_MS`, renewed by every call of its
// holder that reaches this module: status, `work`, `claim`, `ready`, an `ask` (which reads the
// active claim) and Git authorization. `work` and `claim` renew it before they await another
// fork's revocation, so a slow revocation never lapses a lease its holder called inside. Each awaits
// at most one due revocation, the oldest issue's; the Repo's alarm revokes the rest a few at a time
// and fires again at once while more are due, so a backlog delays neither a request nor the alarm's
// later modules. A thrown revocation is retried like a failed one. A ready claim does not lapse,
// since the train holds its pin; a reopened claim starts a new lease. The lapse is checked at the
// time of use: a holder call after it, the Repo's alarm or another agent's `work` or
// `claim` expires the claim and appends `claim.expired`. Both fence readers, `currentGeneration`
// and `workingGeneration`, read a lapsed working claim as unknown even before that, so no push is
// recorded past the deadline. From the expiry on, the former holder is refused and the fork's tokens
// are owed a revocation. A lease is renewed only before it lapses: a lapsed allocation is no longer
// its holder's, which sees no active claim and is answered `busy` by `work` and `claim` until
// another agent takes the allocation over. It no longer counts toward its owner's limit, and a fork
// whose response arrives after the lapse opens nothing and answers `busy`. The claim stays expired until that revocation is
// settled; a failed revocation, or one Artifacts reports as `pending_debt`, is retried by the
// Repo's alarm, and meanwhile nobody gets a write grant on the fork.
//
// Takeover gives a settled expired claim, before any new issue, to the next agent other than its
// former holder that asks for work or names its issue. It keeps the claim, its issue's text and
// its fork, raises the generation, appends `claim.reassigned`, and moves the claim's decisions to
// the successor, which queues it the current version of each, in one transaction. The fork's head
// is whatever its last push left; edits the former holder never pushed are not recovered. A push
// the former holder had in flight can still move the fork's branch, but the successor's pin names
// its own commit. An allocation whose holder's lease lapsed before the fork opened passes to the
// successor at the next generation with no event, and the successor finishes the same fork intent.
// While an expired claim's revocation is pending, no agent, its former holder included, is given a
// newer issue by `work` or `claim`, and no claim on a newer issue is taken over: each answers
// `busy` until every older revocation is settled, so the expired claim stays first in line.
//
// Every await here (main's head, a fork, a commit lookup, a fork's name, a revocation sweep) lets
// other calls change the claim, so nothing read before one is acted on after it. A sweep starts
// only if the claim still has the generation, state and due revocation its caller read, so a pin
// reopened since then is never swept and its holder's new tokens stay valid. A started sweep raises
// a revocation barrier in storage in the same transaction, and until its attempt records an
// outcome nobody gets a write grant on the fork, even from a Repo restarted mid-sweep whose memory
// holds no running sweep. A barrier that outlives `REVOCATION_BARRIER_MS` keeps refusing grants;
// the Repo's alarm treats its sweep as lost and sweeps again under a new barrier, and only that
// sweep's outcome lowers it. Each attempt also captures a mint cutoff as it begins, and its sweep
// revokes no token minted after that, so a lost sweep that resumes after a newer one lowered the
// barrier and a push was granted leaves the new token alone. The alarm reads each claim of its batch
// again just before that claim's sweep. `ready` answers from the stored claim after its sweep:
// a pin a newer decision superseded meanwhile is reopened and refused, never reported as pinned.
//
// The remote URLs in a `ClaimView` are left empty here: the port knows neither the origin the
// agent called nor the repository's name. The agent dispatcher fills both from the request.

import type { ClaimResult, ClaimView, ReadyRequest, ReadyResult } from "@railhead/shared/agent-api";
import {
  isCommitSha,
  isId,
  type Actor,
  type AgentId,
  type ClaimId,
  type DecisionRef,
  type IssueId,
  type RefusalReason,
} from "@railhead/shared/events";
import { ARTIFACTS_LIMITS, forkRepoName, mainRepoName, mintCutoff } from "../../artifacts/adapter";
import type { MintCutoff, TokenRevocation } from "../../contracts/artifacts";
import type { ClaimPin, ClaimsPort, GitAccess, GitGrant } from "../../contracts/claims";
import type { AgentPrincipal, GrantFor } from "../../contracts/principals";
import { fail, ok, unavailable, type PortFailure, type PortResult } from "../../contracts/result";
import { UnavailableError } from "../../contracts/unavailable";
import type { RepoContext, RepoPorts } from "../../repo/composeRepo";
import { EventLogError, type EventTransaction } from "../../repo/eventLog";
import {
  activeClaimOf,
  activeClaimsOfOwner,
  backfillLeases,
  barrierStands,
  beginRevocation,
  claimById,
  claimOfIssue,
  dueRevocations,
  expireClaim,
  insertIntent,
  insertIssue,
  issueByGrant,
  issueStatus,
  lapsedClaims,
  lostBarriers,
  migrateClaims,
  nextClaimsDeadline,
  nextOpenIssue,
  nextTakeover,
  noteRefusal,
  openClaim,
  pinReady,
  reassignClaim,
  recordForkBase,
  recordRevocation,
  releasePendingBefore,
  renewLease,
  reopenReady,
  replaceLostBarrier,
  type ClaimRow,
  type RevocationOutcome,
} from "./store";

/** Limits a test may tighten. */
export interface ClaimsLimits {
  /** Most active claims all of one person's agents may hold together. */
  readonly maxActiveClaimsPerOwner: number;
}

/** The production limits. */
export const CLAIMS_LIMITS: ClaimsLimits = { maxActiveClaimsPerOwner: 16 };

/**
 * How long a claim's lease lasts after its holder's last call. This is a design value, not a
 * measured one, and the owner may change it.
 */
export const CLAIM_LEASE_MS = 30 * 60_000;

/** How long after a failed or pending revocation the Repo's alarm tries it again. */
export const REVOKE_RETRY_MS = 60_000;

/**
 * How long a sweep's revocation barrier stands before its sweep is presumed lost: one Artifacts
 * call to open the fork and the adapter's sweep deadline, plus a minute's margin. A design value,
 * not a measured bound on how late Artifacts may apply a call.
 */
export const REVOCATION_BARRIER_MS =
  ARTIFACTS_LIMITS.callTimeoutMs + ARTIFACTS_LIMITS.sweepDeadlineMs + 60_000;

/** Most lapsed leases one call or alarm expires, so each stays bounded. */
export const RELEASE_BATCH = 16;

/**
 * Most due revocations a `work` or `claim` call awaits before it chooses, so an agent waits on at
 * most one other fork's sweep. The alarm revokes the rest.
 */
const REVOKE_PER_REQUEST = 1;

/**
 * Most due revocations one alarm awaits, so the modules after claims are reached within a few
 * sweeps. While more are due, the claims deadline is already past and the alarm fires again at once.
 */
const REVOKE_PER_ALARM = 4;

/** Builds the claims port of one repository and migrates its tables. */
export function createClaims(
  context: RepoContext,
  ports: () => RepoPorts,
  limits: ClaimsLimits = CLAIMS_LIMITS,
): ClaimsPort {
  migrateClaims(context.storage);
  const { log, repoId, clock } = context;

  /** Asks the Repo's alarm for the next lapse or revocation, if any waits. */
  const wakeForDeadline = (sql: SqlStorage): void => {
    const at = nextClaimsDeadline(sql);
    if (at !== null) context.wake(at);
  };

  backfillLeases(context.storage.sql, clock() + CLAIM_LEASE_MS);
  // A claim recorded before leases, or one opened before an alarm was asked for, lapses unwatched
  // unless the alarm is asked for now.
  wakeForDeadline(context.storage.sql);

  /** A step of allocation that either found the claim to finish or refused. */
  type Chosen = PortResult<{ row: ClaimRow; resumed: boolean }>;

  const refuseForeign = (agent: AgentPrincipal): PortResult<never> | null =>
    agent.repoId === repoId
      ? null
      : fail("unauthenticated", "The session is not for this repository.");

  /**
   * Records a new claim on `issueId` for `agent`, after the per-owner limit. Every allocation of a
   * new issue passes here, so an older expired claim still owed a revocation keeps every agent,
   * its former holder included, off a newer issue. Runs in a transaction.
   */
  const intend = (sql: SqlStorage, agent: AgentPrincipal, issueId: IssueId): Chosen => {
    if (releasePendingBefore(sql, issueId, clock())) {
      return fail("busy", "An older expired claim is still being released; repeat later.");
    }
    if (activeClaimsOfOwner(sql, agent.ownerId, clock()) >= limits.maxActiveClaimsPerOwner) {
      return fail("quota_exceeded", "This person's agents hold as many claims as allowed.");
    }
    const claimId: ClaimId = `clm_${crypto.randomUUID().replaceAll("-", "")}`;
    const lease = clock() + CLAIM_LEASE_MS;
    insertIntent(sql, { claimId, issueId, agentId: agent.agentId, ownerId: agent.ownerId }, lease);
    const row = activeClaimOf(sql, agent.agentId);
    if (row === null) throw new Error("a recorded claim intent cannot be read back");
    return ok({ row, resumed: false });
  };

  /**
   * A call of the claim's holder: expires a working claim whose lease lapsed, leaves a lapsed
   * allocation to a successor, and otherwise renews an allocating or working claim's lease. Answers
   * the claim as it now stands. Runs in the caller's transaction.
   */
  const hold = (tx: EventTransaction, row: ClaimRow): ClaimRow => {
    const now = clock();
    switch (row.state) {
      case "working":
        if (row.leaseUntil !== null && row.leaseUntil <= now) {
          expire(tx, row, now);
          break;
        }
        renewLease(tx.sql, row.claimId, row.generation, now + CLAIM_LEASE_MS);
        break;
      case "allocating":
        if (lapsedAllocation(row, now)) return row;
        renewLease(tx.sql, row.claimId, row.generation, now + CLAIM_LEASE_MS);
        break;
      case "ready":
      case "merged":
      case "expired":
        return row;
      default:
        return row.state satisfies never;
    }
    wakeForDeadline(tx.sql);
    const held = claimById(tx.sql, row.claimId);
    if (held === null) throw new Error("a held claim cannot be read back");
    return held;
  };

  /** `hold` on the agent's active claim, in a transaction of its own; `null` without one. */
  const holdActive = (agentId: AgentId): ClaimRow | null =>
    log.transaction((tx) => {
      const row = activeClaimOf(tx.sql, agentId);
      return row === null ? null : hold(tx, row);
    }).value;

  /** Expires every claim whose lease lapsed, up to a batch, in one transaction. */
  const expireLapsed = (): void => {
    log.transaction((tx) => {
      const now = clock();
      for (const row of lapsedClaims(tx.sql, now, RELEASE_BATCH)) expire(tx, row, now);
      wakeForDeadline(tx.sql);
    });
  };

  /** A revocation that is not settled, due again after `REVOKE_RETRY_MS`. */
  const owed = (): RevocationOutcome => ({ kind: "owed", retryAt: clock() + REVOKE_RETRY_MS });

  /** The revocation sweep running for each claim, which a second caller joins. */
  const revoking = new Map<ClaimId, Promise<Sweep>>();

  /**
   * Revokes the fork tokens of `claimId` under the attempt `begin` starts, and records the outcome,
   * joining the sweep already running for the claim rather than starting another. A revocation
   * that fails, or that Artifacts reports as `pending_debt`, is not settled and is due again after
   * `REVOKE_RETRY_MS`. Answers `stale`, having called nothing, when `begin` starts no attempt.
   */
  const revoke = (claimId: ClaimId, begin: BeginSweep): Promise<Sweep> => {
    const running = revoking.get(claimId);
    if (running !== undefined) return running;
    const sweep = sweepTokens(claimId, begin).finally(() => revoking.delete(claimId));
    revoking.set(claimId, sweep);
    return sweep;
  };

  /**
   * Starts the revocation `row`, an expired or ready claim as the caller read it, owes, only while
   * the claim still stands as `row`, so a claim reopened since the caller read it is never swept.
   */
  const owedBy =
    (row: ClaimRow): BeginSweep =>
    (sql, cutoff) => {
      const attempt = beginRevocation(sql, row, clock() + REVOCATION_BARRIER_MS, cutoff);
      return attempt === "stale" ? attempt : { attempt, generation: row.generation };
    };

  /** Starts a sweep in place of the one whose barrier at attempt `lostAttempt` expired. */
  const replacing =
    (claimId: ClaimId, lostAttempt: number): BeginSweep =>
    (sql, cutoff) => {
      const row = claimById(sql, claimId);
      if (row === null) return "stale";
      const now = clock();
      const attempt = replaceLostBarrier(
        sql,
        claimId,
        lostAttempt,
        now,
        now + REVOCATION_BARRIER_MS,
        cutoff,
      );
      return attempt === "stale" ? attempt : { attempt, generation: row.generation };
    };

  /**
   * One revocation sweep under a new attempt. The attempt starts after the fork's name is derived,
   * the sweep's last await before Artifacts, and is stored with its barrier and mint cutoff before
   * Artifacts is called, so a sweep this one overlaps, after an eviction lost the running one,
   * cannot settle the claim, no write is granted on the fork until this sweep records its outcome,
   * and the sweep never revokes a token minted after it began, however late it runs.
   */
  const sweepTokens = async (claimId: ClaimId, begin: BeginSweep): Promise<Sweep> => {
    const repo = await forkRepoName(repoId, claimId);
    const started = log.transaction((tx) => {
      const cutoff = mintCutoff(context.storage, clock());
      const begun = begin(tx.sql, cutoff);
      return begun === "stale" ? begun : { ...begun, cutoff };
    }).value;
    if (started === "stale") return { kind: "stale" };
    const { attempt, generation, cutoff } = started;
    let revoked: PortResult<TokenRevocation>;
    try {
      revoked = await ports().artifacts.revokeTokens(repo, cutoff);
    } catch (error) {
      // A revocation that throws is retried like a failed one, rather than at once by every wake.
      log.transaction((tx) => {
        recordRevocation(tx.sql, claimId, generation, attempt, owed());
        wakeForDeadline(tx.sql);
      });
      throw error;
    }
    log.transaction((tx) => {
      const outcome: RevocationOutcome = revocationSettled(revoked) ? { kind: "settled" } : owed();
      recordRevocation(tx.sql, claimId, generation, attempt, outcome);
      wakeForDeadline(tx.sql);
    });
    return { kind: "swept", result: revoked };
  };

  /**
   * Sweeps again, up to `limit`, the forks whose barrier outlived its sweep: that sweep is presumed
   * lost, and whether it revoked everything is unknown, so its barrier stands until a new sweep
   * records an outcome.
   */
  const resweepLost = async (limit: number): Promise<void> => {
    for (const { claimId, attempt } of lostBarriers(context.storage.sql, clock(), limit)) {
      await revoke(claimId, replacing(claimId, attempt));
    }
  };

  /**
   * Revokes the fork tokens of expired and ready claims whose revocation is due, up to `limit`.
   * Each sweep awaits Artifacts, during which a later claim of the batch may be reopened, so each
   * claim is read again just before its own sweep and skipped once it no longer owes one.
   */
  const releaseDue = async (limit: number): Promise<void> => {
    for (const due of dueRevocations(context.storage.sql, clock(), limit)) {
      const row = claimById(context.storage.sql, due.claimId);
      if (row === null || row.revokeDue === null || row.revokeDue > clock()) continue;
      await revoke(row.claimId, owedBy(row));
    }
  };

  /**
   * Gives `row`, a settled expired claim or a lapsed allocation, to `agent` at the next generation,
   * after the per-owner limit. An expired claim's takeover appends `claim.reassigned` and moves its
   * decisions to `agent`. Runs in a transaction.
   */
  const takeOver = (tx: EventTransaction, agent: AgentPrincipal, row: ClaimRow): Chosen => {
    const now = clock();
    // A lapsed allocation is not counted, so its own transfer never trips the limit.
    if (activeClaimsOfOwner(tx.sql, agent.ownerId, now) >= limits.maxActiveClaimsPerOwner) {
      return fail("quota_exceeded", "This person's agents hold as many claims as allowed.");
    }
    if (!reassignClaim(tx.sql, row.claimId, row.generation, agent, now, now + CLAIM_LEASE_MS)) {
      throw new Error("a claim read in this transaction could not be reassigned");
    }
    const generation = row.generation + 1;
    if (row.state === "expired") {
      tx.append(CLAIMS_ACTOR, {
        type: "claim.reassigned",
        data: { claimId: row.claimId, from: row.agentId, to: agent.agentId, generation },
      });
      ports().decisions.transfer(tx, { agentId: agent.agentId, claimId: row.claimId, generation });
    }
    wakeForDeadline(tx.sql);
    const taken = activeClaimOf(tx.sql, agent.agentId);
    if (taken?.claimId !== row.claimId) throw new Error("a reassigned claim cannot be read back");
    return ok({ row: taken, resumed: false });
  };

  /**
   * Expires lapsed claims, sweeps up to `limit` forks whose barrier outlived its sweep and revokes
   * up to `limit` due revocations, so a takeover sees them settled. Whatever throws, it asks for
   * the next deadline, so a revocation still owed and a barrier still standing keep a wake.
   */
  const release = async (limit: number): Promise<void> => {
    try {
      expireLapsed();
      await resweepLost(limit);
      await releaseDue(limit);
    } finally {
      wakeForDeadline(context.storage.sql);
    }
  };

  /** Opens an allocating claim's fork, or returns an opened claim as it is. */
  const finish = async (chosen: Chosen): Promise<PortResult<ClaimResult>> => {
    if (!chosen.ok) return chosen;
    const { row, resumed } = chosen.value;
    if (row.state === "ready") {
      const settled = settleNow(row.claimId);
      return settled === null ? lost() : ok({ claim: view(settled), resumed });
    }
    if (row.state !== "allocating") return ok({ claim: view(row), resumed });
    let forkBase = row.forkBase;
    if (forkBase === null) {
      const head = await ports().mainWriter.head();
      if (!head.ok) return head;
      // The base is written once, so a malformed answer must not become a claim's permanent base.
      if (!isCommitSha(head.value)) return fail("internal", "Main's head is not a commit id.");
      log.transaction((tx) => recordForkBase(tx.sql, row.claimId, head.value));
      forkBase = current(row)?.forkBase ?? null;
      if (forkBase === null) return lost();
    }
    const fork = await ports().artifacts.forkForClaim(row.claimId, forkBase);
    if (!fork.ok) return fork;
    // A fork answered after the lease lapsed opens nothing: the intent waits for a successor.
    const opened = log.transaction((tx) => {
      if (openClaim(tx.sql, row.claimId, row.generation, fork.value.head, clock())) {
        tx.append(
          { kind: "agent", id: row.agentId },
          {
            type: "claim.opened",
            data: {
              claimId: row.claimId,
              issueId: row.issueId,
              agentId: row.agentId,
              generation: row.generation,
              base: fork.value.head,
            },
          },
        );
        // The opened lease must lapse even if its holder never calls again.
        wakeForDeadline(tx.sql);
      }
      return activeClaimOf(tx.sql, row.agentId);
    }).value;
    // A concurrent request may have opened it first; either way the stored claim is the answer.
    if (opened === null || opened.claimId !== row.claimId) return lost();
    if (opened.state === "allocating") {
      return lapsedAllocation(opened, clock()) ? lapsedHold() : lost();
    }
    return ok({ claim: view(opened), resumed });
  };

  /**
   * Returns a ready claim whose pin a newer decision version superseded to working, appending
   * `claim.reopened`, and answers the claim as it now stands. A pin under the current versions, or
   * under versions that are unknown, is left as it is. Runs in the caller's transaction.
   */
  const settle = (tx: EventTransaction, row: ClaimRow): ClaimRow => {
    if (row.state !== "ready") return row;
    const decisions = ports().decisions.currentVersions(row.claimId);
    if (decisions === null) return row;
    if (row.readyDecisions !== null && sameVersions(row.readyDecisions, decisions)) return row;
    if (!reopenReady(tx.sql, row.claimId, row.generation, clock() + CLAIM_LEASE_MS)) {
      throw new Error("a ready claim read in this transaction could not be reopened");
    }
    tx.append(CLAIMS_ACTOR, {
      type: "claim.reopened",
      data: {
        claimId: row.claimId,
        generation: row.generation,
        decisions: decisions.map(({ decisionId, version }) => ({ decisionId, version })),
      },
    });
    wakeForDeadline(tx.sql);
    const reopened = claimById(tx.sql, row.claimId);
    if (reopened === null) throw new Error("a reopened claim cannot be read back");
    return reopened;
  };

  /** `settle` on the stored claim, in a transaction of its own; `null` for an unknown claim. */
  const settleNow = (claimId: ClaimId): ClaimRow | null =>
    log.transaction((tx) => {
      const row = claimById(tx.sql, claimId);
      return row === null ? null : settle(tx, row);
    }).value;

  /**
   * The answer to a `ready` whose pin was recorded before an awaited revocation, read from the
   * stored claim. A pin still current with its revocation settled is the success. A claim closed or
   * taken over meanwhile is refused as `standing` refuses it, and a pin another `ready` replaced
   * answers `after_ready`. A pin a newer decision superseded is reopened, as `settle` does, and
   * answers `unacked_decision` while the holder has the new version to acknowledge, or `busy` once
   * it has, so a repeat pins the work under the new versions. Runs in the caller's transaction.
   */
  const answerPinned = (
    tx: EventTransaction,
    agent: AgentPrincipal,
    claimId: ClaimId,
    request: ReadyRequest,
    repeated: boolean,
  ): PortResult<ReadyResult> => {
    const held = standing(claimById(tx.sql, claimId), agent, request);
    if (held.kind === "refused") return refuse(tx, held);
    if (ports().decisions.currentVersions(held.row.claimId) === null) {
      return fail("unavailable", "The claim's decision versions are unknown.");
    }
    const row = settle(tx, held.row);
    if (row.state === "working") {
      const gate = ports().inbox.readyGateNow(row.claimId, row.generation);
      if (gate === null) return fail("unavailable", "The inbox cannot confirm acknowledgements.");
      if (gate.kind === "blocked") {
        return refuse(tx, { kind: "refused", reason: "unacked_decision", row });
      }
      return fail("busy", "A newer decision reopened the claim; repeat the request.");
    }
    if (row.readyCommit !== request.commit) {
      return refuse(tx, { kind: "refused", reason: "after_ready", row });
    }
    return row.revokeDue === null
      ? ok({ claim: view(row), repeated })
      : fail("busy", "The fork's tokens are not yet revoked; repeat the request.");
  };

  /**
   * Runs `body` in a transaction. A `RolledBack` it throws, or a missing module's
   * `UnavailableError`, undoes its writes and is answered as a failure.
   */
  const rollingBack = <T>(body: (tx: EventTransaction) => PortResult<T>): PortResult<T> => {
    try {
      return log.transaction(body).value;
    } catch (error) {
      if (error instanceof RolledBack) return error.failure;
      if (error instanceof UnavailableError) return unavailable(error.port);
      throw error;
    }
  };

  const current = (row: ClaimRow): ClaimRow | null => {
    const now = activeClaimOf(context.storage.sql, row.agentId);
    return now?.claimId === row.claimId ? now : null;
  };

  return {
    async activeClaim(agent) {
      const foreign = refuseForeign(agent);
      if (foreign !== null) return foreign;
      const row = holdActive(agent.agentId);
      if (row === null || row.state === "expired" || lapsedAllocation(row, clock())) {
        return ok(null);
      }
      const finished = await finish(ok({ row, resumed: true }));
      return finished.ok ? ok(finished.value.claim) : finished;
    },

    async work(agent) {
      const foreign = refuseForeign(agent);
      if (foreign !== null) return foreign;
      holdActive(agent.agentId);
      await release(REVOKE_PER_REQUEST);
      const chosen = log.transaction((tx): Chosen => {
        const { sql } = tx;
        const active = activeClaimOf(sql, agent.agentId);
        const held = active === null ? null : hold(tx, active);
        if (held !== null && lapsedAllocation(held, clock())) return lapsedHold();
        if (held !== null && held.state !== "expired") return ok({ row: held, resumed: true });
        const now = clock();
        const takeover = nextTakeover(sql, agent.agentId, now);
        if (takeover !== null) {
          // A lapsed claim that `release` left for a later batch enters revocation before any
          // newer one is handed over.
          if (takeover.state === "working") {
            expire(tx, takeover, now);
            wakeForDeadline(sql);
            return fail("busy", "An expired claim is still being released; repeat the request.");
          }
          // An expired claim still being released stays ahead of every newer claim and issue.
          if (takeover.revokeDue !== null || releasePendingBefore(sql, takeover.issueId, now)) {
            return fail("busy", "An expired claim is still being released; repeat the request.");
          }
          return takeOver(tx, agent, takeover);
        }
        const issueId = nextOpenIssue(sql);
        if (issueId !== null) return intend(sql, agent, issueId);
        return fail("no_work", "No issue is ready to claim.");
      }).value;
      return finish(chosen);
    },

    async claim(agent, issueId) {
      const foreign = refuseForeign(agent);
      if (foreign !== null) return foreign;
      if (!isId("issue", issueId)) return fail("invalid_request", "The issue id is malformed.");
      holdActive(agent.agentId);
      await release(REVOKE_PER_REQUEST);
      const chosen = log.transaction((tx): Chosen => {
        const { sql } = tx;
        const active = activeClaimOf(sql, agent.agentId);
        const held = active === null ? null : hold(tx, active);
        if (held !== null && lapsedAllocation(held, clock())) return lapsedHold();
        if (held !== null && held.state !== "expired") {
          return held.issueId === issueId
            ? ok({ row: held, resumed: true })
            : fail("claim_exists", "This agent already holds a claim on another issue.");
        }
        const existing = claimOfIssue(sql, issueId);
        if (existing === null) {
          return issueStatus(sql, issueId) === "open"
            ? intend(sql, agent, issueId)
            : fail("issue_unavailable", "The issue does not exist or is already claimed.");
        }
        if (existing.agentId !== agent.agentId) {
          if (takeable(existing, clock())) {
            // An older expired claim still being released is handed over first.
            if (releasePendingBefore(sql, issueId, clock())) {
              return fail("busy", "An older expired claim is still being released; repeat later.");
            }
            return takeOver(tx, agent, existing);
          }
          if (existing.state === "expired") {
            return fail("busy", "The expired claim is still being released; repeat the request.");
          }
        }
        return fail("issue_unavailable", "The issue does not exist or is already claimed.");
      }).value;
      return finish(chosen);
    },

    async fileIssue(grant: GrantFor<"issue.file">) {
      if (grant.repoId !== repoId) {
        return fail("unauthenticated", "The approval is not for this repository.");
      }
      const { title, body } = grant.action;
      try {
        const issueId = log.transaction((tx) => {
          // A repeat of the same approval, after a lost response, returns the issue it filed.
          const filed = issueByGrant(tx.sql, grant.grantId);
          if (filed !== null) return filed;
          const id: IssueId = `iss_${crypto.randomUUID().replaceAll("-", "")}`;
          const event = tx.append(
            { kind: "human", id: grant.userId },
            { type: "issue.filed", data: { issueId: id, title, body } },
          );
          insertIssue(tx.sql, {
            issueId: id,
            filedSeq: event.seq,
            grantId: grant.grantId,
            title,
            body,
          });
          return id;
        }).value;
        return ok({ issueId });
      } catch (error) {
        if (error instanceof EventLogError && error.code === "invalid_event") {
          return fail("invalid_request", "The issue's title or body is empty or too long.");
        }
        throw error;
      }
    },

    currentGeneration(claimId) {
      // Only an opened claim that is still held has a current generation. An allocating claim has
      // no fork yet, and a merged or expired one has no owner, so each reads as unknown.
      const row = claimById(context.storage.sql, claimId);
      if (row === null) return null;
      switch (row.state) {
        case "working":
          return heldWorking(row, clock()) ? row.generation : null;
        case "ready":
          return row.generation;
        case "allocating":
        case "merged":
        case "expired":
          return null;
        default:
          return row.state satisfies never;
      }
    },

    workingGeneration(claimId) {
      const row = claimById(context.storage.sql, claimId);
      return row !== null && heldWorking(row, clock()) ? row.generation : null;
    },

    workingEpisode(claimId) {
      const row = claimById(context.storage.sql, claimId);
      return row !== null && heldWorking(row, clock()) ? row.episode : null;
    },

    async ready(agent, claimId, request) {
      const foreign = refuseForeign(agent);
      if (foreign !== null) return foreign;
      const invalid = invalidReady(claimId, request);
      if (invalid !== null) return invalid;

      // Refuse what current state already refuses before any call leaves the Repo.
      const before = standing(claimById(context.storage.sql, claimId), agent, request);
      if (before.kind === "refused") return log.transaction((tx) => refuse(tx, before)).value;

      // A ready claim may be reopened in the transaction below, so the commit is looked up for a
      // repeat too.
      const repo = await forkRepoName(repoId, claimId);
      const exists = await ports().artifacts.commitExists(repo, request.commit);
      if (!exists.ok) return exists;
      if (!exists.value) return fail("commit_not_found", "The commit is not in the claim's fork.");

      // Ownership, the inbox gate and the decision versions are read in the transaction that
      // records the pin, so a decision recorded or a takeover made during the commit lookup is
      // seen here and nothing else can run between these reads and the write.
      const decided = rollingBack((tx): PortResult<ReadyResult> => {
        const held = standing(claimById(tx.sql, claimId), agent, request);
        if (held.kind === "refused") return refuse(tx, held);
        const leased = hold(tx, held.row);
        if (leased.state === "expired") return fail("claim_closed", "The claim's lease expired.");
        const row = settle(tx, leased);
        const { generation, commit } = request;
        const gate = ports().inbox.readyGateNow(claimId, generation);
        if (gate === null) return fail("unavailable", "The inbox cannot confirm acknowledgements.");
        if (gate.kind === "blocked") {
          return refuse(tx, { kind: "refused", reason: "unacked_decision", row });
        }
        const decisions = ports().decisions.currentVersions(claimId);
        if (decisions === null) {
          return fail("unavailable", "The claim's decision versions are unknown.");
        }
        // `settle` left this claim ready, so its pin is under the current versions.
        if (row.state === "ready") {
          if (row.readyCommit !== commit) {
            return refuse(tx, { kind: "refused", reason: "after_ready", row });
          }
          // A pin the train no longer holds, because it never reached the train or its entry was
          // dropped, is queued now, under the same gate and versions. A train that cannot say
          // whether it holds the pin refuses the repeat, so the agent retries.
          const entered = ports().train.holdsLiveEntry(claimId, generation);
          if (entered === null) return unavailable("train");
          if (!entered) {
            const queued = ports().train.queue(tx, { claimId, generation, commit }, row.episode);
            if (!queued.ok) throw new RolledBack(queued);
          }
          return ok({ claim: view(row), repeated: true });
        }
        if (!pinReady(tx.sql, claimId, generation, commit, decisions, clock())) {
          throw new Error("a working claim read in this transaction could not be pinned");
        }
        tx.append(
          { kind: "agent", id: agent.agentId },
          { type: "claim.ready", data: { claimId, generation, commit, decisions } },
        );
        // The owed revocation is retried by the alarm if this request ends before it settles.
        wakeForDeadline(tx.sql);
        const pinned = claimById(tx.sql, claimId);
        if (pinned === null) throw new Error("a pinned claim cannot be read back");
        // Last, since it asks for the train's wake. A refusal rolls the pin back.
        const queued = ports().train.queue(tx, { claimId, generation, commit }, pinned.episode);
        if (!queued.ok) throw new RolledBack(queued);
        return ok({ claim: view(pinned), repeated: false });
      });
      if (!decided.ok) return decided;

      // The fork is read only from the pin on, since `authorizeGit` refuses every later push;
      // revoking its tokens ends a write already granted. Nothing awaits since the transaction, so
      // this read sees the pin it recorded. A repeat while the revocation is owed revokes again.
      const pinned = claimById(context.storage.sql, claimId);
      const revoked =
        pinned === null || pinned.revokeDue === null ? null : await revoke(claimId, owedBy(pinned));
      // The pin is committed, so the wake is asked for whatever the revocation answered. Its alarm
      // write in the transaction may have failed, and a ready answered with success must leave a
      // drive scheduled, so a failed write refuses it. A repeat, finding the entry live, asks again.
      const armed = await ports().train.armWake();
      if (!armed) return unavailable("train");
      if (revoked === null) return decided;
      if (revoked.kind === "swept" && !revoked.result.ok) return revoked.result;
      // A decision, a reopen or another `ready` may have run during the sweep, so the answer comes
      // from the stored claim, not from `decided`.
      return log.transaction((tx) =>
        answerPinned(tx, agent, claimId, request, decided.value.repeated),
      ).value;
    },

    async pin(claimId) {
      if (!isId("claim", claimId)) return fail("invalid_request", "The claim id is malformed.");
      // Every read below is synchronous, so they see one state of the Repo.
      const row = claimById(context.storage.sql, claimId);
      if (row === null || row.state !== "ready" || row.readyCommit === null) {
        return fail("claim_closed", "The claim is not ready, so it has no pin.");
      }
      const gate = ports().inbox.readyGateNow(claimId, row.generation);
      if (gate === null) return fail("unavailable", "The inbox cannot confirm acknowledgements.");
      const decisions = ports().decisions.currentVersions(claimId);
      if (decisions === null) {
        return fail("unavailable", "The claim's decision versions are unknown.");
      }
      if (row.readyDecisions === null || !sameVersions(row.readyDecisions, decisions)) {
        // The holder must adapt, so the claim goes back to working.
        settleNow(claimId);
        return fail("decision_superseded", "A decision changed after the claim was marked ready.");
      }
      if (gate.kind === "blocked") {
        return fail("unacked_decision", "An inbox item affecting the claim is not acknowledged.");
      }
      // A token the revocation has not reached could still move the fork after the pin.
      if (row.revokeDue !== null) {
        return fail("busy", "The claim's fork tokens are not yet revoked.");
      }
      const pin: ClaimPin = { claimId, generation: row.generation, commit: row.readyCommit };
      return ok(pin);
    },

    readyPin(claimId) {
      const row = claimById(context.storage.sql, claimId);
      if (row?.state !== "ready" || row.readyCommit === null || row.readyDecisions === null) {
        return null;
      }
      return {
        pin: { claimId, generation: row.generation, commit: row.readyCommit },
        episode: row.episode,
        decisions: row.readyDecisions,
      };
    },

    async authorizeGit(access) {
      return decideGit(context.storage.sql, repoId, access, {
        holdActive,
        holderRead: (claimId, agentId, reopen) =>
          log.transaction((tx) => {
            const row = claimById(tx.sql, claimId);
            if (row?.agentId !== agentId) return row;
            const leased = hold(tx, row);
            return reopen ? settle(tx, leased) : leased;
          }).value,
      });
    },

    async resume() {
      await release(REVOKE_PER_ALARM);
    },
  };
}

/** Expires a working claim and appends `claim.expired`. Runs in the caller's transaction. */
function expire(tx: EventTransaction, row: ClaimRow, now: number): void {
  if (!expireClaim(tx.sql, row.claimId, row.generation, now)) {
    throw new Error("a working claim read in this transaction could not be expired");
  }
  tx.append(CLAIMS_ACTOR, {
    type: "claim.expired",
    data: { claimId: row.claimId, generation: row.generation },
  });
}

/**
 * Whether `row` is a working claim whose lease has not lapsed by `now`. A lapsed lease is no longer
 * held, even before anything records the expiry, so neither fence reader answers it.
 */
function heldWorking(row: ClaimRow, now: number): boolean {
  return row.state === "working" && (row.leaseUntil === null || row.leaseUntil > now);
}

/** Whether `row` is an allocation whose lease lapsed at or before `now`, held by nobody. */
function lapsedAllocation(row: ClaimRow, now: number): boolean {
  return row.state === "allocating" && row.leaseUntil !== null && row.leaseUntil <= now;
}

/** The answer to the former holder of a lapsed allocation, which only another agent may take. */
function lapsedHold(): PortFailure {
  return fail(
    "busy",
    "This agent's claim lapsed before its fork opened; repeat the request later.",
  );
}

/** Whether another agent may take `row` over now: a settled expired claim or a lapsed allocation. */
function takeable(row: ClaimRow, now: number): boolean {
  switch (row.state) {
    case "expired":
      return row.revokeDue === null;
    case "allocating":
      return lapsedAllocation(row, now);
    case "working":
    case "ready":
    case "merged":
      return false;
    default:
      return row.state satisfies never;
  }
}

/**
 * Whether a revocation is settled: only an explicit `revoked`. A failure is not, and neither is
 * `pending_debt`, which means a partial token listing may still hide a live token.
 */
function revocationSettled(result: PortResult<TokenRevocation>): boolean {
  if (!result.ok) return false;
  switch (result.value) {
    case "revoked":
      return true;
    case "pending_debt":
      return false;
    default:
      return result.value satisfies never;
  }
}

/**
 * Starts a sweep's attempt and raises its barrier under `cutoff`, in the caller's transaction,
 * answering the attempt and the claim's generation, or `"stale"` when no sweep is owed any more.
 */
type BeginSweep = (
  sql: SqlStorage,
  cutoff: MintCutoff,
) => { attempt: number; generation: number } | "stale";

/** How one call to revoke a claim's fork tokens ended. */
type Sweep =
  /** The claim no longer owed the revocation it was read with, so Artifacts was not called. */
  | { kind: "stale" }
  /** Artifacts was called; its answer is recorded. */
  | { kind: "swept"; result: PortResult<TokenRevocation> };

/** Thrown inside a transaction to roll it back and answer with `failure`. */
class RolledBack extends Error {
  readonly failure: PortFailure;

  constructor(failure: PortFailure) {
    super("the transaction was refused");
    this.name = "RolledBack";
    this.failure = failure;
  }
}

/** Who records a refusal: the claims module, never the agent it refuses. */
const CLAIMS_ACTOR: Actor = { kind: "system", id: "sys_claims" };

/** Where a ready request stands against one read of the claim. */
type Standing =
  /** The caller holds the claim, working or ready, at its current generation. */
  | { kind: "held"; row: ClaimRow }
  | { kind: "refused"; failure: PortFailure; reason: null }
  /** A refusal the claim's own agent sees, recorded as `claim.refused`. */
  | { kind: "refused"; reason: RefusalReason; row: ClaimRow };

function standing(row: ClaimRow | null, agent: AgentPrincipal, request: ReadyRequest): Standing {
  if (row === null) {
    return refused(fail("claim_closed", "The claim does not exist."));
  }
  switch (row.state) {
    case "allocating":
      return refused(fail("busy", "The claim is still being allocated; repeat the request."));
    case "merged":
    case "expired":
      return refused(fail("claim_closed", "The claim is closed."));
    case "working":
    case "ready":
      break;
    default:
      return row.state satisfies never;
  }
  if (row.agentId !== agent.agentId) {
    return refused(fail("stale_generation", "This agent does not hold the claim."));
  }
  if (row.generation !== request.generation) {
    return { kind: "refused", reason: "stale_generation", row };
  }
  return { kind: "held", row };
}

function refused(failure: PortFailure): Standing {
  return { kind: "refused", failure, reason: null };
}

/**
 * The failure of a refused standing, after recording `claim.refused` for the claim's agent unless
 * the claim's last recorded refusal had the same reason at the same generation, state and pin.
 * Pinning or reopening the claim forgets that refusal, so a refusal in a new episode is recorded.
 */
function refuse(
  tx: EventTransaction,
  refusal: Extract<Standing, { kind: "refused" }>,
): PortFailure {
  if (refusal.reason === null) return refusal.failure;
  const { row, reason } = refusal;
  const key = JSON.stringify([row.generation, row.state, row.readyCommit, reason]);
  if (noteRefusal(tx.sql, row.claimId, key)) {
    tx.append(CLAIMS_ACTOR, {
      type: "claim.refused",
      data: { claimId: row.claimId, generation: row.generation, reason },
    });
  }
  switch (reason) {
    case "stale_generation":
      return fail("stale_generation", "The claim's ownership generation has changed.");
    case "after_ready":
      return fail("after_ready", "The claim is already ready with another commit.");
    case "unacked_decision":
      return fail("unacked_decision", "An inbox item affecting the claim is not acknowledged.");
    default:
      return reason satisfies never;
  }
}

function invalidReady(claimId: ClaimId, request: ReadyRequest): PortFailure | null {
  if (!isId("claim", claimId)) return fail("invalid_request", "The claim id is malformed.");
  if (!Number.isSafeInteger(request.generation) || request.generation < 1) {
    return fail("invalid_request", "The generation must be a whole number from 1.");
  }
  if (!isCommitSha(request.commit)) {
    return fail("invalid_request", "The commit must be a full lowercase commit id.");
  }
  return null;
}

/** What `decideGit` may change: the holder's lease, and a ready claim a newer decision superseded. */
interface GitHolder {
  /** Renews or expires the agent's active claim; see `hold`. */
  holdActive(agentId: AgentId): ClaimRow | null;
  /**
   * Reads the claim and, when `agentId` holds it, renews or expires its lease and, with `reopen`,
   * returns it to working if a newer decision superseded its pin.
   */
  holderRead(claimId: ClaimId, agentId: AgentId, reopen: boolean): ClaimRow | null;
}

/**
 * Decides one Git request against current state. Every remote needs an agent of this repository.
 * A fetch may read main or any opened claim's fork; a push may write only the fork of a claim the
 * agent holds while it is working, fenced to its current generation. Main takes no push here.
 * A request of the claim's holder renews its lease, or expires it once lapsed; a push of the
 * holder of a ready claim whose pin a newer decision superseded reopens it, so the holder can push
 * the adapted work.
 */
async function decideGit(
  sql: SqlStorage,
  repoId: string,
  access: GitAccess,
  holder: GitHolder,
): Promise<PortResult<GitGrant>> {
  const { principal, target, operation } = access;
  if (principal === null || principal.repoId !== repoId) {
    return fail("unauthenticated", "A Git request needs a session for this repository.");
  }
  if (target.kind === "main") {
    if (operation === "push") {
      return fail("invalid_request", "Main is written only by the train.");
    }
    const repo = await mainRepoName(repoId);
    holder.holdActive(principal.agentId);
    return ok({ repo, scope: "read", fence: null });
  }
  const { claimId } = target;
  if (!isId("claim", claimId)) return fail("invalid_request", "The claim id is malformed.");
  const repo = await forkRepoName(repoId, claimId);
  // Nothing below awaits, so the grant is decided on the claim as it stands now.
  const row = holder.holderRead(claimId, principal.agentId, operation === "push");
  if (row === null || row.state === "allocating") {
    return fail("not_found", "The claim has no fork.");
  }
  switch (operation) {
    case "fetch":
      return ok({ repo, scope: "read", fence: null });
    case "push":
      // A sweep that started before a newer decision reopened the claim may still reach a token
      // minted now, so the holder waits until every started sweep has recorded its outcome.
      if (row.state === "working" && barrierStands(sql, claimId)) {
        return fail("busy", "The fork's earlier tokens are still being revoked; repeat the push.");
      }
      return pushGrant(row, principal, repo);
    default:
      return operation satisfies never;
  }
}

function pushGrant(row: ClaimRow, principal: AgentPrincipal, repo: string): PortResult<GitGrant> {
  if (row.agentId !== principal.agentId) {
    return fail("stale_generation", "This agent does not hold the claim.");
  }
  switch (row.state) {
    case "working":
      return ok({
        repo,
        scope: "write",
        fence: { claimId: row.claimId, generation: row.generation, episode: row.episode },
      });
    case "ready":
      return fail("after_ready", "The claim is ready, so its fork takes no more pushes.");
    case "allocating":
    case "merged":
    case "expired":
      return fail("claim_closed", "The claim is closed.");
    default:
      return row.state satisfies never;
  }
}

/** True when both lists name the same version of the same decisions, in any order. */
export function sameVersions(left: readonly DecisionRef[], right: readonly DecisionRef[]): boolean {
  if (left.length !== right.length) return false;
  const versions = new Map(left.map((ref) => [ref.decisionId, ref.version]));
  return (
    versions.size === left.length &&
    right.every((ref) => versions.get(ref.decisionId) === ref.version)
  );
}

function lost(): PortResult<never> {
  return fail("busy", "The claim changed while it was being allocated; repeat the request.");
}

function view(row: ClaimRow): ClaimView {
  if (row.base === null || row.state === "allocating") {
    throw new Error("only an opened claim has a view");
  }
  return {
    claimId: row.claimId,
    issueId: row.issueId,
    generation: row.generation,
    base: row.base,
    state: row.state,
    readyCommit: row.readyCommit,
    originUrl: "",
    upstreamUrl: "",
    task: { title: row.title, body: row.body },
  };
}
