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
// records the pin with those versions. Only then are the fork's tokens revoked. A repeat of the
// same pin passes the same gate and returns it, so a lost response is answered by retrying. `pin`,
// the train's read, answers only while those versions are still the current ones and the inbox
// gate is still clear. From the pin on, `authorizeGit` refuses every push to the fork; a push
// already granted may still move the fork's branch, but never the pin, which names a commit rather
// than a ref.
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
// active claim) and Git authorization. A ready claim does not lapse, since the train holds its pin;
// a reopened claim starts a new lease. The lapse is checked at the time of use: a holder call after
// it, the Repo's alarm or another agent's `work` or `claim` expires the claim and appends
// `claim.expired`. From then on the former holder is refused, `currentGeneration` reads it as
// unknown, and the fork's tokens are owed a revocation. The claim stays expired until that
// revocation is settled; a failed revocation, or one Artifacts reports as `pending_debt`, is
// retried by the Repo's alarm, and meanwhile nobody gets a write grant on the fork.
//
// Takeover gives a settled expired claim, before any new issue, to the next agent other than its
// former holder that asks for work or names its issue. It keeps the claim, its issue's text and
// its fork, raises the generation, appends `claim.reassigned`, and moves the claim's decisions to
// the successor, which queues it the current version of each, in one transaction. The fork's head
// is whatever its last push left; edits the former holder never pushed are not recovered. A push
// the former holder had in flight can still move the fork's branch, but the successor's pin names
// its own commit. An allocation whose holder's lease lapsed before the fork opened passes to the
// successor at the next generation with no event, and the successor finishes the same fork intent.
// While an expired claim's revocation is pending, `work` answers `busy` to every agent but its
// former holder rather than hand out a newer issue, so the claim stays first in line.
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
import { forkRepoName, mainRepoName } from "../../artifacts/adapter";
import type { ClaimPin, ClaimsPort, GitAccess, GitGrant } from "../../contracts/claims";
import type { AgentPrincipal, GrantFor } from "../../contracts/principals";
import { fail, ok, type PortFailure, type PortResult } from "../../contracts/result";
import type { RepoContext, RepoPorts } from "../../repo/composeRepo";
import { EventLogError, type EventTransaction } from "../../repo/eventLog";
import {
  activeClaimOf,
  activeClaimsOfOwner,
  backfillLeases,
  claimById,
  claimOfIssue,
  dueRevocations,
  expireClaim,
  insertIntent,
  insertIssue,
  issueByGrant,
  issueStatus,
  lapsedClaims,
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
  releasePending,
  renewLease,
  reopenReady,
  type ClaimRow,
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

/** Most lapsed leases, or revocations, one call or alarm handles, so each stays bounded. */
const RELEASE_BATCH = 16;

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

  /** Records a new claim on `issueId` for `agent`, after the per-owner limit. Runs in a transaction. */
  const intend = (sql: SqlStorage, agent: AgentPrincipal, issueId: IssueId): Chosen => {
    if (activeClaimsOfOwner(sql, agent.ownerId) >= limits.maxActiveClaimsPerOwner) {
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
   * A call of the claim's holder: expires a working claim whose lease lapsed, and otherwise renews
   * an allocating or working claim's lease. Answers the claim as it now stands. Runs in the caller's
   * transaction.
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

  /**
   * Revokes the fork tokens of expired claims whose revocation is due, up to a batch. A revocation
   * that fails, or that Artifacts reports as `pending_debt`, is not settled and is due again after
   * `REVOKE_RETRY_MS`.
   */
  const releaseDue = async (): Promise<void> => {
    for (const row of dueRevocations(context.storage.sql, clock(), RELEASE_BATCH)) {
      const revoked = await ports().artifacts.revokeTokens(await forkRepoName(repoId, row.claimId));
      log.transaction((tx) => {
        const next = revocationSettled(revoked) ? null : clock() + REVOKE_RETRY_MS;
        recordRevocation(tx.sql, row.claimId, row.generation, next);
        wakeForDeadline(tx.sql);
      });
    }
  };

  /**
   * Gives `row`, a settled expired claim or a lapsed allocation, to `agent` at the next generation,
   * after the per-owner limit. An expired claim's takeover appends `claim.reassigned` and moves its
   * decisions to `agent`. Runs in a transaction.
   */
  const takeOver = (tx: EventTransaction, agent: AgentPrincipal, row: ClaimRow): Chosen => {
    if (activeClaimsOfOwner(tx.sql, agent.ownerId) >= limits.maxActiveClaimsPerOwner) {
      return fail("quota_exceeded", "This person's agents hold as many claims as allowed.");
    }
    const now = clock();
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

  /** Expires lapsed claims and revokes what is due, so a takeover sees them settled. */
  const release = async (): Promise<void> => {
    expireLapsed();
    await releaseDue();
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
    const opened = log.transaction((tx) => {
      if (openClaim(tx.sql, row.claimId, row.generation, fork.value.head)) {
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
    if (opened === null || opened.claimId !== row.claimId || opened.state === "allocating") {
      return lost();
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

  const current = (row: ClaimRow): ClaimRow | null => {
    const now = activeClaimOf(context.storage.sql, row.agentId);
    return now?.claimId === row.claimId ? now : null;
  };

  return {
    async activeClaim(agent) {
      const foreign = refuseForeign(agent);
      if (foreign !== null) return foreign;
      const row = holdActive(agent.agentId);
      if (row === null || row.state === "expired") return ok(null);
      const finished = await finish(ok({ row, resumed: true }));
      return finished.ok ? ok(finished.value.claim) : finished;
    },

    async work(agent) {
      const foreign = refuseForeign(agent);
      if (foreign !== null) return foreign;
      await release();
      const chosen = log.transaction((tx): Chosen => {
        const { sql } = tx;
        const active = activeClaimOf(sql, agent.agentId);
        const held = active === null ? null : hold(tx, active);
        if (held !== null && held.state !== "expired") return ok({ row: held, resumed: true });
        const takeover = nextTakeover(sql, agent.agentId, clock());
        if (takeover !== null) return takeOver(tx, agent, takeover);
        // An expired claim still being released stays ahead of every new issue.
        if (releasePending(sql, agent.agentId)) {
          return fail("busy", "An expired claim is still being released; repeat the request.");
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
      await release();
      const chosen = log.transaction((tx): Chosen => {
        const { sql } = tx;
        const active = activeClaimOf(sql, agent.agentId);
        const held = active === null ? null : hold(tx, active);
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
          if (takeable(existing, clock())) return takeOver(tx, agent, existing);
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
          // A lapsed lease is no longer held, even before anything records the expiry.
          return row.leaseUntil !== null && row.leaseUntil <= clock() ? null : row.generation;
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
      const decided = log.transaction((tx): PortResult<ReadyResult> => {
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
          return row.readyCommit === commit
            ? ok({ claim: view(row), repeated: true })
            : refuse(tx, { kind: "refused", reason: "after_ready", row });
        }
        if (!pinReady(tx.sql, claimId, generation, commit, decisions)) {
          throw new Error("a working claim read in this transaction could not be pinned");
        }
        tx.append(
          { kind: "agent", id: agent.agentId },
          { type: "claim.ready", data: { claimId, generation, commit, decisions } },
        );
        const pinned = claimById(tx.sql, claimId);
        if (pinned === null) throw new Error("a pinned claim cannot be read back");
        return ok({ claim: view(pinned), repeated: false });
      }).value;
      if (!decided.ok) return decided;

      // The fork is read only from the pin on, since `authorizeGit` refuses every later push;
      // revoking its tokens ends a write already granted. A repeat after a failed revocation
      // returns the same pin and revokes again.
      const revoked = await ports().artifacts.revokeTokens(repo);
      return revoked.ok ? decided : revoked;
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
      const pin: ClaimPin = { claimId, generation: row.generation, commit: row.readyCommit };
      return ok(pin);
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
      await release();
      wakeForDeadline(context.storage.sql);
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

/** Whether another agent may take `row` over now: a settled expired claim or a lapsed allocation. */
function takeable(row: ClaimRow, now: number): boolean {
  switch (row.state) {
    case "expired":
      return row.revokeDue === null;
    case "allocating":
      return row.leaseUntil !== null && row.leaseUntil <= now;
    case "working":
    case "ready":
    case "merged":
      return false;
    default:
      return row.state satisfies never;
  }
}

/**
 * Whether a revocation is settled. A failure is not, and neither is the adapter's `pending_debt`,
 * which means a partial token listing may still hide a live token.
 */
function revocationSettled(result: PortResult<unknown>): boolean {
  return result.ok && result.value !== "pending_debt";
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
        fence: { claimId: row.claimId, generation: row.generation },
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
function sameVersions(left: readonly DecisionRef[], right: readonly DecisionRef[]): boolean {
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
