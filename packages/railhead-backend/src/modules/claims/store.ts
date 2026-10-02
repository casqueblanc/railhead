// The claims module's tables: thin issues and their claims, in the Repo's SQLite storage.
//
// An issue has at most one claim, ever: a claim that expires waits for a replacement agent rather
// than releasing the issue. An agent holds at most one active claim. Both rules are unique indexes,
// so even a bug in the allocation code cannot record a double assignment.
//
// A claim is recorded in `allocating` before its fork exists: that row is the fork intent. It
// reserves the issue for the agent, and a repeat request finishes it instead of forking again. The
// base is written once, when the fork opens, and never changed.

import type { ClaimState } from "@railhead/shared/agent-api";
import type { AgentId, ClaimId, CommitSha, IssueId, UserId } from "@railhead/shared/events";
import { migrate, type RepoStorage } from "../../repo/storage";

/** Released schema steps. Append a step to change the schema; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE claims_issues (
    issue_id TEXT PRIMARY KEY,
    filed_seq INTEGER NOT NULL UNIQUE,
    grant_id TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    body TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE claims_claims (
    claim_id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL UNIQUE REFERENCES claims_issues (issue_id),
    agent_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    state TEXT NOT NULL
      CHECK (state IN ('allocating', 'working', 'ready', 'merged', 'expired')),
    fork_base TEXT,
    base TEXT,
    ready_commit TEXT,
    CHECK ((state = 'allocating') = (base IS NULL))
  ) STRICT`,
  `CREATE UNIQUE INDEX claims_one_active_per_agent ON claims_claims (agent_id)
    WHERE state IN ('allocating', 'working', 'ready')`,
  `CREATE INDEX claims_active_by_owner ON claims_claims (owner_id)
    WHERE state IN ('allocating', 'working', 'ready')`,
];

/** The states in which a claim counts against its agent and its owner. */
const ACTIVE = "('allocating', 'working', 'ready')";

/** Where a stored claim stands: the wire states, plus the fork intent before the fork opens. */
export type StoredState = "allocating" | ClaimState;

/** One claim with its issue's text. */
export interface ClaimRow {
  claimId: ClaimId;
  issueId: IssueId;
  agentId: AgentId;
  ownerId: UserId;
  generation: number;
  state: StoredState;
  /** The main commit requested for the fork, written once before the fork call. */
  forkBase: CommitSha | null;
  /** The fork's head when it opened; `null` exactly while allocating. */
  base: CommitSha | null;
  readyCommit: CommitSha | null;
  title: string;
  body: string;
}

interface RawClaim extends Record<string, SqlStorageValue> {
  claim_id: string;
  issue_id: string;
  agent_id: string;
  owner_id: string;
  generation: number;
  state: string;
  fork_base: string | null;
  base: string | null;
  ready_commit: string | null;
  title: string;
  body: string;
}

const SELECT_CLAIM = `SELECT c.claim_id, c.issue_id, c.agent_id, c.owner_id, c.generation, c.state,
    c.fork_base, c.base, c.ready_commit, i.title, i.body
  FROM claims_claims c JOIN claims_issues i ON i.issue_id = c.issue_id`;

/** Creates or migrates the claims tables. */
export function migrateClaims(storage: RepoStorage): void {
  migrate(storage, "claims", MIGRATIONS);
}

/** The agent's active claim, or `null`. */
export function activeClaimOf(sql: SqlStorage, agentId: AgentId): ClaimRow | null {
  return first(
    sql.exec<RawClaim>(`${SELECT_CLAIM} WHERE c.agent_id = ? AND c.state IN ${ACTIVE}`, agentId),
  );
}

/** How many active claims the owner's agents hold. */
export function activeClaimsOfOwner(sql: SqlStorage, ownerId: UserId): number {
  const [row] = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM claims_claims WHERE owner_id = ? AND state IN ${ACTIVE}`,
      ownerId,
    )
    .toArray();
  return row?.n ?? 0;
}

/** The oldest filed issue that has no claim, or `null`. */
export function nextOpenIssue(sql: SqlStorage): IssueId | null {
  const [row] = sql
    .exec<{ issue_id: string }>(
      `SELECT i.issue_id FROM claims_issues i
       WHERE NOT EXISTS (SELECT 1 FROM claims_claims c WHERE c.issue_id = i.issue_id)
       ORDER BY i.filed_seq LIMIT 1`,
    )
    .toArray();
  return row?.issue_id ?? null;
}

/** Where the issue stands for a new claim. */
export function issueStatus(sql: SqlStorage, issueId: IssueId): "open" | "claimed" | "missing" {
  const [row] = sql
    .exec<{ claimed: number }>(
      `SELECT EXISTS (SELECT 1 FROM claims_claims c WHERE c.issue_id = i.issue_id) AS claimed
       FROM claims_issues i WHERE i.issue_id = ?`,
      issueId,
    )
    .toArray();
  if (row === undefined) return "missing";
  return row.claimed === 0 ? "open" : "claimed";
}

/** Records the fork intent: a claim at generation 1 with no fork yet. */
export function insertIntent(
  sql: SqlStorage,
  claim: { claimId: ClaimId; issueId: IssueId; agentId: AgentId; ownerId: UserId },
): void {
  sql.exec(
    `INSERT INTO claims_claims (claim_id, issue_id, agent_id, owner_id, generation, state)
     VALUES (?, ?, ?, ?, 1, 'allocating')`,
    claim.claimId,
    claim.issueId,
    claim.agentId,
    claim.ownerId,
  );
}

/** Records the main commit the fork is requested at, unless one is already recorded. */
export function recordForkBase(sql: SqlStorage, claimId: ClaimId, base: CommitSha): void {
  sql.exec(
    "UPDATE claims_claims SET fork_base = ? WHERE claim_id = ? AND fork_base IS NULL",
    base,
    claimId,
  );
}

/**
 * Opens an allocating claim at `generation` on a fork whose head is `base`. Returns `false`, and
 * writes nothing, when the claim is no longer that allocation.
 */
export function openClaim(
  sql: SqlStorage,
  claimId: ClaimId,
  generation: number,
  base: CommitSha,
): boolean {
  // `rowsWritten` also counts index entries, so the updated rows are counted by `RETURNING`.
  const updated = sql
    .exec(
      `UPDATE claims_claims SET state = 'working', base = ?
       WHERE claim_id = ? AND generation = ? AND state = 'allocating'
       RETURNING claim_id`,
      base,
      claimId,
      generation,
    )
    .toArray();
  return updated.length === 1;
}

/** The issue filed with `grantId`, or `null`. */
export function issueByGrant(sql: SqlStorage, grantId: string): IssueId | null {
  const [row] = sql
    .exec<{ issue_id: string }>("SELECT issue_id FROM claims_issues WHERE grant_id = ?", grantId)
    .toArray();
  return row?.issue_id ?? null;
}

/** Records a filed issue at the sequence number of its `issue.filed` event. */
export function insertIssue(
  sql: SqlStorage,
  issue: { issueId: IssueId; filedSeq: number; grantId: string; title: string; body: string },
): void {
  sql.exec(
    `INSERT INTO claims_issues (issue_id, filed_seq, grant_id, title, body)
     VALUES (?, ?, ?, ?, ?)`,
    issue.issueId,
    issue.filedSeq,
    issue.grantId,
    issue.title,
    issue.body,
  );
}

function first(cursor: SqlStorageCursor<RawClaim>): ClaimRow | null {
  const [raw] = cursor.toArray();
  if (raw === undefined) return null;
  return {
    claimId: raw.claim_id,
    issueId: raw.issue_id,
    agentId: raw.agent_id,
    ownerId: raw.owner_id,
    generation: raw.generation,
    state: storedState(raw.state),
    forkBase: raw.fork_base,
    base: raw.base,
    readyCommit: raw.ready_commit,
    title: raw.title,
    body: raw.body,
  };
}

function storedState(value: string): StoredState {
  switch (value) {
    case "allocating":
    case "working":
    case "ready":
    case "merged":
    case "expired":
      return value;
    default:
      throw new Error("claims_claims holds an unknown state");
  }
}
