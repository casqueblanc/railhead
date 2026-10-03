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
// The remote URLs in a `ClaimView` are left empty here: the port knows neither the origin the
// agent called nor the repository's name. The agent dispatcher fills both from the request.

import type { ClaimResult, ClaimView } from "@railhead/shared/agent-api";
import { isCommitSha, isId, type ClaimId, type IssueId } from "@railhead/shared/events";
import type { ClaimsPort } from "../../contracts/claims";
import type { AgentPrincipal, GrantFor } from "../../contracts/principals";
import { fail, ok, type PortResult } from "../../contracts/result";
import { unavailableClaims } from "../../contracts/unavailable";
import type { RepoContext, RepoPorts } from "../../repo/composeRepo";
import { EventLogError } from "../../repo/eventLog";
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

    // Ready, pins and Git authority belong to the next layers of this module.
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

    workingGeneration(claimId) {
      const row = claimById(context.storage.sql, claimId);
      return row?.state === "working" ? row.generation : null;
    },

    ready: unavailableClaims.ready,
    pin: unavailableClaims.pin,
    authorizeGit: unavailableClaims.authorizeGit,
  };
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
