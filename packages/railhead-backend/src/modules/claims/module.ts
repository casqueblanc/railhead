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
// same pin returns it, so a lost response is answered by retrying. `pin`, the train's read, answers
// only while those versions are still the current ones and the inbox gate is still clear, so a
// decision superseded after ready never lets the train take the pin. From the pin on, `authorizeGit`
// refuses every push to the fork; a push already granted may still move the fork's branch, but
// never the pin, which names a commit rather than a ref.
//
// The remote URLs in a `ClaimView` are left empty here: the port knows neither the origin the
// agent called nor the repository's name. The agent dispatcher fills both from the request.

import type { ClaimResult, ClaimView, ReadyRequest, ReadyResult } from "@railhead/shared/agent-api";
import {
  isCommitSha,
  isId,
  type Actor,
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
  claimById,
  insertIntent,
  insertIssue,
  issueByGrant,
  issueStatus,
  migrateClaims,
  nextOpenIssue,
  openClaim,
  pinReady,
  recordForkBase,
  type ClaimRow,
} from "./store";

/** Limits a test may tighten. */
export interface ClaimsLimits {
  /** Most active claims all of one person's agents may hold together. */
  readonly maxActiveClaimsPerOwner: number;
}

/** The production limits. */
export const CLAIMS_LIMITS: ClaimsLimits = { maxActiveClaimsPerOwner: 16 };

/** Builds the claims port of one repository and migrates its tables. */
export function createClaims(
  context: RepoContext,
  ports: () => RepoPorts,
  limits: ClaimsLimits = CLAIMS_LIMITS,
): ClaimsPort {
  migrateClaims(context.storage);
  const { log, repoId } = context;

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
    insertIntent(sql, { claimId, issueId, agentId: agent.agentId, ownerId: agent.ownerId });
    const row = activeClaimOf(sql, agent.agentId);
    if (row === null) throw new Error("a recorded claim intent cannot be read back");
    return ok({ row, resumed: false });
  };

  /** Opens an allocating claim's fork, or returns an opened claim as it is. */
  const finish = async (chosen: Chosen): Promise<PortResult<ClaimResult>> => {
    if (!chosen.ok) return chosen;
    const { row, resumed } = chosen.value;
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
      }
      return activeClaimOf(tx.sql, row.agentId);
    }).value;
    // A concurrent request may have opened it first; either way the stored claim is the answer.
    if (opened === null || opened.claimId !== row.claimId || opened.state === "allocating") {
      return lost();
    }
    return ok({ claim: view(opened), resumed });
  };

  const current = (row: ClaimRow): ClaimRow | null => {
    const now = activeClaimOf(context.storage.sql, row.agentId);
    return now?.claimId === row.claimId ? now : null;
  };

  return {
    async activeClaim(agent) {
      const foreign = refuseForeign(agent);
      if (foreign !== null) return foreign;
      const row = activeClaimOf(context.storage.sql, agent.agentId);
      if (row === null) return ok(null);
      const finished = await finish(ok({ row, resumed: true }));
      return finished.ok ? ok(finished.value.claim) : finished;
    },

    async work(agent) {
      const foreign = refuseForeign(agent);
      if (foreign !== null) return foreign;
      const chosen = log.transaction(({ sql }): Chosen => {
        const active = activeClaimOf(sql, agent.agentId);
        if (active !== null) return ok({ row: active, resumed: true });
        const issueId = nextOpenIssue(sql);
        if (issueId === null) return fail("no_work", "No issue is ready to claim.");
        return intend(sql, agent, issueId);
      }).value;
      return finish(chosen);
    },

    async claim(agent, issueId) {
      const foreign = refuseForeign(agent);
      if (foreign !== null) return foreign;
      if (!isId("issue", issueId)) return fail("invalid_request", "The issue id is malformed.");
      const chosen = log.transaction(({ sql }): Chosen => {
        const active = activeClaimOf(sql, agent.agentId);
        if (active !== null) {
          return active.issueId === issueId
            ? ok({ row: active, resumed: true })
            : fail("claim_exists", "This agent already holds a claim on another issue.");
        }
        if (issueStatus(sql, issueId) !== "open") {
          return fail("issue_unavailable", "The issue does not exist or is already claimed.");
        }
        return intend(sql, agent, issueId);
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

      const repo = await forkRepoName(repoId, claimId);
      if (before.kind === "working") {
        const exists = await ports().artifacts.commitExists(repo, request.commit);
        if (!exists.ok) return exists;
        if (!exists.value) {
          return fail("commit_not_found", "The commit is not in the claim's fork.");
        }
      }

      // Ownership, the inbox gate and the decision versions are read in the transaction that
      // records the pin, so a decision recorded or a takeover made during the commit lookup is
      // seen here and nothing else can run between these reads and the write.
      const decided = log.transaction((tx): PortResult<ReadyResult> => {
        const now = standing(claimById(tx.sql, claimId), agent, request);
        switch (now.kind) {
          case "refused":
            return refuse(tx, now);
          case "repeat":
            return ok({ claim: view(now.row), repeated: true });
          case "working":
            break;
          default:
            return now satisfies never;
        }
        const { generation, commit } = request;
        const gate = ports().inbox.readyGateNow(claimId, generation);
        if (gate === null) return fail("unavailable", "The inbox cannot confirm acknowledgements.");
        if (gate.kind === "blocked") {
          return refuse(tx, { kind: "refused", reason: "unacked_decision", row: now.row });
        }
        const decisions = ports().decisions.currentVersions(claimId);
        if (decisions === null) {
          return fail("unavailable", "The claim's decision versions are unknown.");
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
      if (gate.kind === "blocked") {
        return fail("unacked_decision", "An inbox item affecting the claim is not acknowledged.");
      }
      const decisions = ports().decisions.currentVersions(claimId);
      if (decisions === null) {
        return fail("unavailable", "The claim's decision versions are unknown.");
      }
      if (row.readyDecisions === null || !sameVersions(row.readyDecisions, decisions)) {
        return fail("decision_superseded", "A decision changed after the claim was marked ready.");
      }
      const pin: ClaimPin = { claimId, generation: row.generation, commit: row.readyCommit };
      return ok(pin);
    },

    async authorizeGit(access) {
      return decideGit(context.storage.sql, repoId, access);
    },
  };
}

/** Who records a refusal: the claims module, never the agent it refuses. */
const CLAIMS_ACTOR: Actor = { kind: "system", id: "sys_claims" };

/** Where a ready request stands against one read of the claim. */
type Standing =
  /** The claim is working at the caller's generation: pin, if the gate is clear. */
  | { kind: "working"; row: ClaimRow }
  /** This exact pin is already recorded. */
  | { kind: "repeat"; row: ClaimRow }
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
  if (row.state === "working") return { kind: "working", row };
  return row.readyCommit === request.commit
    ? { kind: "repeat", row }
    : { kind: "refused", reason: "after_ready", row };
}

function refused(failure: PortFailure): Standing {
  return { kind: "refused", failure, reason: null };
}

/** The failure of a refused standing, after recording `claim.refused` for the claim's agent. */
function refuse(
  tx: EventTransaction,
  refusal: Extract<Standing, { kind: "refused" }>,
): PortFailure {
  if (refusal.reason === null) return refusal.failure;
  const { row, reason } = refusal;
  tx.append(CLAIMS_ACTOR, {
    type: "claim.refused",
    data: { claimId: row.claimId, generation: row.generation, reason },
  });
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

/**
 * Decides one Git request against current state. Every remote needs an agent of this repository.
 * A fetch may read main or any opened claim's fork; a push may write only the fork of a claim the
 * agent holds while it is working, fenced to its current generation. Main takes no push here.
 */
async function decideGit(
  sql: SqlStorage,
  repoId: string,
  access: GitAccess,
): Promise<PortResult<GitGrant>> {
  const { principal, target, operation } = access;
  if (principal === null || principal.repoId !== repoId) {
    return fail("unauthenticated", "A Git request needs a session for this repository.");
  }
  if (target.kind === "main") {
    if (operation === "push") {
      return fail("invalid_request", "Main is written only by the train.");
    }
    return ok({ repo: await mainRepoName(repoId), scope: "read", fence: null });
  }
  const { claimId } = target;
  if (!isId("claim", claimId)) return fail("invalid_request", "The claim id is malformed.");
  const row = claimById(sql, claimId);
  if (row === null || row.state === "allocating") {
    return fail("not_found", "The claim has no fork.");
  }
  const repo = await forkRepoName(repoId, claimId);
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
