// The claims module's tables: thin issues and their claims, in the Repo's SQLite storage.
//
// An issue has at most one claim, ever: a claim that expires waits for a replacement agent rather
// than releasing the issue. An agent holds at most one active claim. Both rules are unique indexes,
// so even a bug in the allocation code cannot record a double assignment.
//
// A claim is recorded in `allocating` before its fork exists: that row is the fork intent. It
// reserves the issue for the agent, and a repeat request finishes it instead of forking again. The
// base is written once, when the fork opens, and never changed.
//
// A ready claim keeps the decision versions its pin was recorded under, as JSON, so the train's
// read of the pin can compare them with the current versions. A claim also keeps the last refusal
// it recorded, so a repeated refusal is not recorded again.
//
// An allocating or working claim holds a lease until `lease_until`. A working claim whose lease
// lapsed expires; the expiry owes a revocation of its fork's tokens, due at `revoke_due`, and the
// claim is reassigned only once that revocation is settled and `revoke_due` is cleared. A pin owes
// the same revocation, and a ready claim keeps `revoke_due` until it is settled.
//
// `revoke_attempt` counts the revocation sweeps started for a claim and each new obligation to
// revoke. Only a `revoked` answer from the latest sweep clears `revoke_due`, so an earlier sweep
// that answers late cannot settle a debt a later sweep or obligation still owes.

import type { ClaimState } from "@railhead/shared/agent-api";
import {
  isId,
  type AgentId,
  type ClaimId,
  type CommitSha,
  type DecisionRef,
  type IssueId,
  type UserId,
} from "@railhead/shared/events";
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
  "ALTER TABLE claims_claims ADD COLUMN ready_decisions TEXT",
  "ALTER TABLE claims_claims ADD COLUMN last_refusal TEXT",
  "ALTER TABLE claims_claims ADD COLUMN lease_until INTEGER",
  "ALTER TABLE claims_claims ADD COLUMN revoke_due INTEGER",
  `CREATE INDEX claims_by_lease ON claims_claims (lease_until)
    WHERE state IN ('allocating', 'working')`,
  "CREATE INDEX claims_by_revocation ON claims_claims (revoke_due) WHERE revoke_due IS NOT NULL",
  "ALTER TABLE claims_claims ADD COLUMN revoke_attempt INTEGER NOT NULL DEFAULT 0",
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
  /**
   * The decision versions the pin was recorded under. `null` before ready, and for a stored list
   * that cannot be read, which no pin is trusted with.
   */
  readyDecisions: DecisionRef[] | null;
  /**
   * When the lease of an allocating or working claim lapses, in milliseconds since the Unix epoch;
   * `null` for a claim in another state. A claim recorded before leases is given one when the
   * module starts.
   */
  leaseUntil: number | null;
  /**
   * When the fork tokens of an expired or ready claim are next revoked; `null` when nothing is
   * owed.
   */
  revokeDue: number | null;
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
  ready_decisions: string | null;
  lease_until: number | null;
  revoke_due: number | null;
  title: string;
  body: string;
}

const SELECT_CLAIM = `SELECT c.claim_id, c.issue_id, c.agent_id, c.owner_id, c.generation, c.state,
    c.fork_base, c.base, c.ready_commit, c.ready_decisions, c.lease_until, c.revoke_due, i.title,
    i.body
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

/** The claim, or `null`. */
export function claimById(sql: SqlStorage, claimId: ClaimId): ClaimRow | null {
  return first(sql.exec<RawClaim>(`${SELECT_CLAIM} WHERE c.claim_id = ?`, claimId));
}

/**
 * How many active claims the owner's agents hold at `now`. An allocation whose lease lapsed at or
 * before `now` is held by nobody and is not counted, so a successor of the same owner can take it.
 */
export function activeClaimsOfOwner(sql: SqlStorage, ownerId: UserId, now: number): number {
  const [row] = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM claims_claims WHERE owner_id = ? AND state IN ${ACTIVE}
         AND NOT (state = 'allocating' AND lease_until IS NOT NULL AND lease_until <= ?)`,
      ownerId,
      now,
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

/** Records the fork intent: a claim at generation 1 with no fork yet, leased until `leaseUntil`. */
export function insertIntent(
  sql: SqlStorage,
  claim: { claimId: ClaimId; issueId: IssueId; agentId: AgentId; ownerId: UserId },
  leaseUntil: number,
): void {
  sql.exec(
    `INSERT INTO claims_claims
       (claim_id, issue_id, agent_id, owner_id, generation, state, lease_until)
     VALUES (?, ?, ?, ?, 1, 'allocating', ?)`,
    claim.claimId,
    claim.issueId,
    claim.agentId,
    claim.ownerId,
    leaseUntil,
  );
}

/**
 * Gives every allocating or working claim recorded before leases a lease until `leaseUntil`, so a
 * holder that never calls again still lapses.
 */
export function backfillLeases(sql: SqlStorage, leaseUntil: number): void {
  sql.exec(
    `UPDATE claims_claims SET lease_until = ?
     WHERE state IN ('allocating', 'working') AND lease_until IS NULL`,
    leaseUntil,
  );
}

/** Extends the lease of an allocating or working claim at `generation` to `leaseUntil`. */
export function renewLease(
  sql: SqlStorage,
  claimId: ClaimId,
  generation: number,
  leaseUntil: number,
): void {
  sql.exec(
    `UPDATE claims_claims SET lease_until = ?
     WHERE claim_id = ? AND generation = ? AND state IN ('allocating', 'working')`,
    leaseUntil,
    claimId,
    generation,
  );
}

/** Working claims whose lease lapsed at or before `now`, oldest lease first, at most `limit`. */
export function lapsedClaims(sql: SqlStorage, now: number, limit: number): ClaimRow[] {
  return rows(
    sql.exec<RawClaim>(
      `${SELECT_CLAIM} WHERE c.state = 'working' AND c.lease_until <= ?
       ORDER BY c.lease_until, c.claim_id LIMIT ?`,
      now,
      limit,
    ),
  );
}

/**
 * Expires a working claim at `generation` and records that its fork's tokens are owed a revocation
 * due at `now`. Returns `false`, and writes nothing, when the claim is no longer working at that
 * generation.
 */
export function expireClaim(
  sql: SqlStorage,
  claimId: ClaimId,
  generation: number,
  now: number,
): boolean {
  const updated = sql
    .exec(
      `UPDATE claims_claims SET state = 'expired', lease_until = NULL, revoke_due = ?,
         revoke_attempt = revoke_attempt + 1
       WHERE claim_id = ? AND generation = ? AND state = 'working'
       RETURNING claim_id`,
      now,
      claimId,
      generation,
    )
    .toArray();
  return updated.length === 1;
}

/**
 * Claims whose revocation is due at or before `now`, oldest issue first, at most `limit`. The
 * oldest is first in line for takeover, so revoking it first is what lets a takeover proceed.
 */
export function dueRevocations(sql: SqlStorage, now: number, limit: number): ClaimRow[] {
  return rows(
    sql.exec<RawClaim>(
      `${SELECT_CLAIM} WHERE c.revoke_due <= ? ORDER BY i.filed_seq, c.claim_id LIMIT ?`,
      now,
      limit,
    ),
  );
}

/**
 * Starts a revocation sweep of the claim's fork tokens and returns its attempt, which
 * `recordRevocation` needs to settle it. Returns `null`, and writes nothing, for an unknown claim.
 */
export function beginRevocation(sql: SqlStorage, claimId: ClaimId): number | null {
  const [row] = sql
    .exec<{ revoke_attempt: number }>(
      `UPDATE claims_claims SET revoke_attempt = revoke_attempt + 1
       WHERE claim_id = ?
       RETURNING revoke_attempt`,
      claimId,
    )
    .toArray();
  return row?.revoke_attempt ?? null;
}

/** How a revocation sweep of a claim's fork tokens ended. */
export type RevocationOutcome =
  /** Artifacts reported every token revoked. */
  | { kind: "settled"; attempt: number }
  /** The sweep failed, threw or reported a debt; the revocation is due again at `retryAt`. */
  | { kind: "owed"; retryAt: number };

/**
 * Records the outcome of a revocation of an expired or ready claim at `generation`. A settled
 * sweep clears `revoke_due` only when it is the latest attempt and nothing newer is owed. An owed
 * one always keeps the revocation due, even after another sweep cleared it, so a late partial
 * listing is never lost.
 */
export function recordRevocation(
  sql: SqlStorage,
  claimId: ClaimId,
  generation: number,
  outcome: RevocationOutcome,
): void {
  switch (outcome.kind) {
    case "settled":
      sql.exec(
        `UPDATE claims_claims SET revoke_due = NULL
         WHERE claim_id = ? AND generation = ? AND state IN ('expired', 'ready')
           AND revoke_attempt = ?`,
        claimId,
        generation,
        outcome.attempt,
      );
      return;
    case "owed":
      sql.exec(
        `UPDATE claims_claims SET revoke_due = ?
         WHERE claim_id = ? AND generation = ? AND state IN ('expired', 'ready')`,
        outcome.retryAt,
        claimId,
        generation,
      );
      return;
    default:
      outcome satisfies never;
  }
}

/** The earliest time a lease lapses or a revocation is due, or `null` when nothing waits. */
export function nextClaimsDeadline(sql: SqlStorage): number | null {
  const [row] = sql
    .exec<{ at: number | null }>(
      `SELECT MIN(at) AS at FROM (
         SELECT MIN(lease_until) AS at FROM claims_claims WHERE state = 'working'
         UNION ALL
         SELECT MIN(revoke_due) AS at FROM claims_claims WHERE revoke_due IS NOT NULL
       )`,
    )
    .toArray();
  return row?.at ?? null;
}

/**
 * The claim first in line for the agent: the claim of the oldest issue that is expired, whether or
 * not its revocation is settled, or working with a lease that lapsed at or before `now` and no
 * expiry recorded yet; then the oldest-leased allocation whose lease lapsed at or before `now`. The
 * caller expires a lapsed working claim before anything else, and takes a claim over only once its
 * revocation, and every older one, is settled. A claim the agent itself held last is never offered
 * back to it.
 */
export function nextTakeover(sql: SqlStorage, agentId: AgentId, now: number): ClaimRow | null {
  const lapsed = first(
    sql.exec<RawClaim>(
      `${SELECT_CLAIM} WHERE c.agent_id != ?
         AND (c.state = 'expired' OR (c.state = 'working' AND c.lease_until <= ?))
       ORDER BY i.filed_seq LIMIT 1`,
      agentId,
      now,
    ),
  );
  if (lapsed !== null) return lapsed;
  return first(
    sql.exec<RawClaim>(
      `${SELECT_CLAIM} WHERE c.state = 'allocating' AND c.lease_until <= ? AND c.agent_id != ?
       ORDER BY c.lease_until, c.claim_id LIMIT 1`,
      now,
      agentId,
    ),
  );
}

/**
 * Whether a claim on an issue filed before `issueId` still owes the revocation of its fork's
 * tokens: an expired claim whose revocation is not settled, or a working claim whose lease lapsed
 * at or before `now` and whose expiry is not recorded yet.
 */
export function releasePendingBefore(sql: SqlStorage, issueId: IssueId, now: number): boolean {
  const [row] = sql
    .exec<{ pending: number }>(
      `SELECT EXISTS (SELECT 1 FROM claims_claims c JOIN claims_issues i ON i.issue_id = c.issue_id
         WHERE ((c.state = 'expired' AND c.revoke_due IS NOT NULL)
             OR (c.state = 'working' AND c.lease_until <= ?))
           AND i.filed_seq < (SELECT filed_seq FROM claims_issues WHERE issue_id = ?)) AS pending`,
      now,
      issueId,
    )
    .toArray();
  return row?.pending === 1;
}

/** The claim on the issue, or `null`. */
export function claimOfIssue(sql: SqlStorage, issueId: IssueId): ClaimRow | null {
  return first(sql.exec<RawClaim>(`${SELECT_CLAIM} WHERE c.issue_id = ?`, issueId));
}

/**
 * Gives an expired claim whose revocation is settled, or an allocation whose lease lapsed at or
 * before `now`, to `agent` at the next generation, leased until `leaseUntil`, and forgets its last
 * refusal. An expired claim becomes working. Returns `false`, and writes nothing, when the claim
 * is no longer that claim at `generation`.
 */
export function reassignClaim(
  sql: SqlStorage,
  claimId: ClaimId,
  generation: number,
  agent: { agentId: AgentId; ownerId: UserId },
  now: number,
  leaseUntil: number,
): boolean {
  const updated = sql
    .exec(
      `UPDATE claims_claims SET agent_id = ?, owner_id = ?, generation = generation + 1,
         state = CASE state WHEN 'expired' THEN 'working' ELSE state END,
         lease_until = ?, last_refusal = NULL
       WHERE claim_id = ? AND generation = ? AND agent_id != ? AND (
         (state = 'expired' AND revoke_due IS NULL)
         OR (state = 'allocating' AND lease_until <= ?))
       RETURNING claim_id`,
      agent.agentId,
      agent.ownerId,
      leaseUntil,
      claimId,
      generation,
      agent.agentId,
      now,
    )
    .toArray();
  return updated.length === 1;
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
 * writes nothing, when the claim is no longer that allocation or its lease lapsed at or before
 * `now`.
 */
export function openClaim(
  sql: SqlStorage,
  claimId: ClaimId,
  generation: number,
  base: CommitSha,
  now: number,
): boolean {
  // `rowsWritten` also counts index entries, so the updated rows are counted by `RETURNING`.
  const updated = sql
    .exec(
      `UPDATE claims_claims SET state = 'working', base = ?
       WHERE claim_id = ? AND generation = ? AND state = 'allocating'
         AND (lease_until IS NULL OR lease_until > ?)
       RETURNING claim_id`,
      base,
      claimId,
      generation,
      now,
    )
    .toArray();
  return updated.length === 1;
}

/**
 * Pins `commit` on a working claim at `generation` under the decision versions `decisions`, which
 * makes the claim ready, records that its fork's tokens are owed a revocation due at `now`, and
 * forgets its last refusal. Returns `false`, and writes nothing, when the claim is no longer working
 * at that generation.
 */
export function pinReady(
  sql: SqlStorage,
  claimId: ClaimId,
  generation: number,
  commit: CommitSha,
  decisions: readonly DecisionRef[],
  now: number,
): boolean {
  const updated = sql
    .exec(
      `UPDATE claims_claims SET state = 'ready', ready_commit = ?, ready_decisions = ?,
         last_refusal = NULL, revoke_due = ?, revoke_attempt = revoke_attempt + 1
       WHERE claim_id = ? AND generation = ? AND state = 'working'
       RETURNING claim_id`,
      commit,
      JSON.stringify(decisions.map(({ decisionId, version }) => ({ decisionId, version }))),
      now,
      claimId,
      generation,
    )
    .toArray();
  return updated.length === 1;
}

/**
 * Returns a ready claim at `generation` to working with a lease until `leaseUntil`, clears its pin
 * and the revocation the pin owed, since its holder may push again, and forgets its last refusal. Returns `false`, and writes nothing, when the claim is no longer
 * ready at that generation.
 */
export function reopenReady(
  sql: SqlStorage,
  claimId: ClaimId,
  generation: number,
  leaseUntil: number,
): boolean {
  const updated = sql
    .exec(
      `UPDATE claims_claims SET state = 'working', ready_commit = NULL, ready_decisions = NULL,
         last_refusal = NULL, lease_until = ?, revoke_due = NULL
       WHERE claim_id = ? AND generation = ? AND state = 'ready'
       RETURNING claim_id`,
      leaseUntil,
      claimId,
      generation,
    )
    .toArray();
  return updated.length === 1;
}

/**
 * Records `refusal` as the claim's last refusal. Returns `false`, and writes nothing, when it is
 * already the last one recorded.
 */
export function noteRefusal(sql: SqlStorage, claimId: ClaimId, refusal: string): boolean {
  const updated = sql
    .exec(
      `UPDATE claims_claims SET last_refusal = ?
       WHERE claim_id = ? AND last_refusal IS NOT ?
       RETURNING claim_id`,
      refusal,
      claimId,
      refusal,
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
  return rows(cursor)[0] ?? null;
}

function rows(cursor: SqlStorageCursor<RawClaim>): ClaimRow[] {
  return cursor.toArray().map(claimRow);
}

function claimRow(raw: RawClaim): ClaimRow {
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
    readyDecisions: raw.ready_decisions === null ? null : decisionList(raw.ready_decisions),
    leaseUntil: raw.lease_until,
    revokeDue: raw.revoke_due,
    title: raw.title,
    body: raw.body,
  };
}

function decisionList(json: string): DecisionRef[] | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const refs: DecisionRef[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const { decisionId, version }: { decisionId?: unknown; version?: unknown } = item;
    if (typeof decisionId !== "string" || !isId("decision", decisionId)) return null;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return null;
    refs.push({ decisionId, version });
  }
  return refs;
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
