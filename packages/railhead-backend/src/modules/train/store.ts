// The train's tables: the queue of ready pins and the batches composed from it.
//
// At most one batch is active at a time. The `active` column holds 1 for the active batch and NULL
// for every settled one, and its UNIQUE constraint refuses a second active row, so even a bug in
// the scheduler cannot start two batches at once.

import type { CheckResult, CheckRunId, CommitSha, DecisionRef } from "@railhead/shared/events";
import type { ClaimPin } from "../../contracts/claims";
import type { CheckDefinition } from "../../contracts/train";
import type { RepoStorage } from "../../repo/storage";
import { migrate } from "../../repo/storage";

/** The migration owner name of the train's tables. */
export const TRAIN_OWNER = "train";

/** Released schema steps of the train. Append a step to change the schema; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE train_queue (
    claim_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    commit_sha TEXT NOT NULL,
    position INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'batched', 'landed', 'dropped', 'parked')),
    isolate INTEGER NOT NULL CHECK (isolate IN (0, 1)),
    retries INTEGER NOT NULL CHECK (retries >= 0),
    reason TEXT,
    enqueued_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (claim_id, generation)
  ) STRICT`,
  "CREATE INDEX train_queue_by_state ON train_queue (state, position)",
  `CREATE TABLE train_batches (
    batch_id INTEGER PRIMARY KEY,
    active INTEGER UNIQUE CHECK (active = 1),
    state TEXT NOT NULL CHECK (state IN ('composing', 'checking', 'passed', 'landed', 'failed')),
    expected_main TEXT NOT NULL,
    pins TEXT NOT NULL,
    decisions TEXT NOT NULL,
    definition TEXT NOT NULL,
    candidate TEXT,
    attempt_id TEXT UNIQUE,
    attempt_at INTEGER,
    check_started INTEGER NOT NULL CHECK (check_started IN (0, 1)),
    check_result TEXT CHECK (check_result IN ('pass', 'fail', 'error')),
    log_digest TEXT,
    intent_id TEXT,
    failure TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((active IS NOT NULL) = (state IN ('composing', 'checking', 'passed')))
  ) STRICT`,
];

/** Creates or migrates the train's tables. */
export function migrateTrain(storage: RepoStorage): void {
  migrate(storage, TRAIN_OWNER, MIGRATIONS);
}

/** Where one queued pin stands. */
export type EntryState =
  /** Waiting for a batch. */
  | "queued"
  /** In the active batch. */
  | "batched"
  /** Merged to main. */
  | "landed"
  /** Removed from the train; `reason` says why. */
  | "dropped"
  /** Held with the claim it conflicts with until a person decides. */
  | "parked";

/** Why a pin left the queue without landing. */
export type DropReason =
  /** The claim's current pin is no longer this generation and commit. */
  | "pin_changed"
  /** The decisions module refused to list the claim's requirements. */
  | "requirements_refused"
  /** The pin's change failed its check when composed alone. */
  | "check_failed"
  /** The pin could not be composed alone: a missing commit or an unsupported merge. */
  | "compose_failed"
  /** The pin's batches failed for reasons outside it too many times. */
  | "retries_exhausted"
  /** The pin conflicts with another claim; a person is asked. */
  | "conflict";

/** One pin in the train's queue. */
export interface QueueEntry {
  /** The pin, exactly as it was enqueued. */
  pin: ClaimPin;
  /** Where it stands. */
  state: EntryState;
  /** Whether its next batch holds it alone, after a shared batch failed. */
  isolate: boolean;
  /** How many of its batches failed for reasons outside it. */
  retries: number;
  /** Why it left the queue, or `null`. */
  reason: DropReason | null;
}

/** Where one batch stands. */
export type BatchState = "composing" | "checking" | "passed" | "landed" | "failed";

/** Why a batch failed. */
export type BatchFailure =
  /** Two pins conflict; both are parked and the conflict is routed to a question. */
  | "conflict"
  /** The merge named a commit that does not exist. */
  | "compose_missing_commit"
  /** The merge timed out. */
  | "compose_timeout"
  /** The merge met a case it does not support, or reported a conflict it could not name. */
  | "compose_unsupported"
  /** The merge's infrastructure failed. */
  | "compose_infrastructure"
  /** The check ran and failed on the candidate. */
  | "check_fail"
  /** The check could not run. Never a pass. */
  | "check_error"
  /** Authorization refused the passed attempt, such as a changed generation or decision. */
  | "authorization_refused"
  /** Main was not at the expected commit when the writer tried to move it. */
  | "main_rejected"
  /** The main writer refused the intent. */
  | "publish_refused";

/** One batch with its diagnostics. */
export interface BatchRecord {
  /** The batch, numbered from 1 in the order batches were formed. */
  batchId: number;
  /** Where it stands. */
  state: BatchState;
  /** The main commit it is composed on. */
  expectedMain: CommitSha;
  /** Its pins, in merge order. */
  pins: ClaimPin[];
  /** The decision versions required when it was formed. */
  decisions: DecisionRef[];
  /** The trusted check definition, read from `expectedMain`. */
  definition: CheckDefinition;
  /** The composed commit, once the merge was clean. */
  candidate: CommitSha | null;
  /** The check attempt on `candidate`, once recorded. */
  attemptId: CheckRunId | null;
  /** When the attempt was recorded. */
  attemptAt: number | null;
  /** Whether the check port accepted the attempt. */
  checkStarted: boolean;
  /** The runner's result, once reported. */
  checkResult: CheckResult | null;
  /** SHA-256 of the check log, as reported. */
  logDigest: string | null;
  /** The merge intent, once authorized. */
  intentId: string | null;
  /** Why it failed, or `null`. */
  failure: BatchFailure | null;
  /** When it was formed. */
  createdAt: number;
  /** When it last changed. */
  updatedAt: number;
}

type QueueRow = {
  claim_id: string;
  generation: number;
  commit_sha: string;
  state: string;
  isolate: number;
  retries: number;
  reason: string | null;
};

type BatchRow = {
  batch_id: number;
  state: string;
  expected_main: string;
  pins: string;
  decisions: string;
  definition: string;
  candidate: string | null;
  attempt_id: string | null;
  attempt_at: number | null;
  check_started: number;
  check_result: string | null;
  log_digest: string | null;
  intent_id: string | null;
  failure: string | null;
  created_at: number;
  updated_at: number;
};

const QUEUE_COLUMNS = "claim_id, generation, commit_sha, state, isolate, retries, reason";
const BATCH_COLUMNS =
  "batch_id, state, expected_main, pins, decisions, definition, candidate, attempt_id, attempt_at, check_started, check_result, log_digest, intent_id, failure, created_at, updated_at";

/** The queue entry of `claimId` at `generation`, or `null`. */
export function readEntry(sql: SqlStorage, claimId: string, generation: number): QueueEntry | null {
  const row = sql
    .exec<QueueRow>(
      `SELECT ${QUEUE_COLUMNS} FROM train_queue WHERE claim_id = ? AND generation = ?`,
      claimId,
      generation,
    )
    .toArray()[0];
  return row === undefined ? null : toEntry(row);
}

/** The highest generation the queue holds for `claimId`, or 0. */
export function highestGeneration(sql: SqlStorage, claimId: string): number {
  const row = sql
    .exec<{ generation: number | null }>(
      "SELECT MAX(generation) AS generation FROM train_queue WHERE claim_id = ?",
      claimId,
    )
    .toArray()[0];
  return row?.generation ?? 0;
}

/** How many entries are waiting or batched. */
export function countPending(sql: SqlStorage): number {
  const row = sql
    .exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM train_queue WHERE state IN ('queued', 'batched')",
    )
    .toArray()[0];
  return row?.n ?? 0;
}

/** Up to `limit` waiting entries, front first. */
export function waitingEntries(sql: SqlStorage, limit: number): QueueEntry[] {
  return sql
    .exec<QueueRow>(
      `SELECT ${QUEUE_COLUMNS} FROM train_queue WHERE state = 'queued'
       ORDER BY position, enqueued_at, claim_id LIMIT ?`,
      limit,
    )
    .toArray()
    .map(toEntry);
}

/** Every entry of the active batch. */
export function batchedEntries(sql: SqlStorage): QueueEntry[] {
  return sql
    .exec<QueueRow>(`SELECT ${QUEUE_COLUMNS} FROM train_queue WHERE state = 'batched'`)
    .toArray()
    .map(toEntry);
}

/** Up to `limit` entries in any state, most recently changed first. */
export function recentEntries(sql: SqlStorage, limit: number): QueueEntry[] {
  return sql
    .exec<QueueRow>(
      `SELECT ${QUEUE_COLUMNS} FROM train_queue ORDER BY updated_at DESC, claim_id LIMIT ?`,
      limit,
    )
    .toArray()
    .map(toEntry);
}

/** Adds a waiting entry at the back of the queue. */
export function insertEntry(sql: SqlStorage, pin: ClaimPin, now: number): void {
  sql.exec(
    `INSERT INTO train_queue
       (claim_id, generation, commit_sha, position, state, isolate, retries, reason, enqueued_at, updated_at)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM train_queue), 'queued', 0, 0, NULL, ?, ?)`,
    pin.claimId,
    pin.generation,
    pin.commit,
    now,
    now,
  );
}

/** Moves an entry to a settled state. */
export function settleEntry(
  sql: SqlStorage,
  pin: ClaimPin,
  state: "landed" | "dropped" | "parked",
  reason: DropReason | null,
  now: number,
): void {
  sql.exec(
    "UPDATE train_queue SET state = ?, reason = ?, updated_at = ? WHERE claim_id = ? AND generation = ?",
    state,
    reason,
    now,
    pin.claimId,
    pin.generation,
  );
}

/** Puts entries back at the front of the queue, in the given order. */
export function requeueFront(
  sql: SqlStorage,
  entries: readonly { pin: ClaimPin; isolate: boolean; retries: number }[],
  now: number,
): void {
  const front = sql
    .exec<{ position: number | null }>("SELECT MIN(position) AS position FROM train_queue")
    .toArray()[0]?.position;
  const start = (front ?? 1) - entries.length;
  entries.forEach((entry, index) => {
    sql.exec(
      `UPDATE train_queue SET state = 'queued', position = ?, isolate = ?, retries = ?, reason = NULL,
         updated_at = ? WHERE claim_id = ? AND generation = ?`,
      start + index,
      entry.isolate ? 1 : 0,
      entry.retries,
      now,
      entry.pin.claimId,
      entry.pin.generation,
    );
  });
}

/** The active batch, or `null`. */
export function activeBatch(sql: SqlStorage): BatchRecord | null {
  const row = sql
    .exec<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM train_batches WHERE active = 1`)
    .toArray()[0];
  return row === undefined ? null : toBatch(row);
}

/** The batch holding `attemptId`, or `null`. */
export function batchByAttempt(sql: SqlStorage, attemptId: string): BatchRecord | null {
  const row = sql
    .exec<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM train_batches WHERE attempt_id = ?`, attemptId)
    .toArray()[0];
  return row === undefined ? null : toBatch(row);
}

/** Up to `limit` batches, newest first. */
export function recentBatches(sql: SqlStorage, limit: number): BatchRecord[] {
  return sql
    .exec<BatchRow>(
      `SELECT ${BATCH_COLUMNS} FROM train_batches ORDER BY batch_id DESC LIMIT ?`,
      limit,
    )
    .toArray()
    .map(toBatch);
}

/** Records a new active batch over `pins` and marks their entries batched. Returns its id. */
export function insertBatch(
  sql: SqlStorage,
  batch: {
    expectedMain: CommitSha;
    pins: ClaimPin[];
    decisions: DecisionRef[];
    definition: CheckDefinition;
  },
  now: number,
): number {
  const row = sql
    .exec<{ batch_id: number }>(
      `INSERT INTO train_batches
         (active, state, expected_main, pins, decisions, definition, check_started, created_at, updated_at)
       VALUES (1, 'composing', ?, ?, ?, ?, 0, ?, ?) RETURNING batch_id`,
      batch.expectedMain,
      JSON.stringify(batch.pins),
      JSON.stringify(batch.decisions),
      JSON.stringify(batch.definition),
      now,
      now,
    )
    .toArray()[0];
  if (row === undefined) throw new Error("the batch insert returned no row");
  for (const pin of batch.pins) {
    sql.exec(
      "UPDATE train_queue SET state = 'batched', updated_at = ? WHERE claim_id = ? AND generation = ?",
      now,
      pin.claimId,
      pin.generation,
    );
  }
  return row.batch_id;
}

/** Records the clean merge and the check attempt on its candidate. */
export function recordCandidate(
  sql: SqlStorage,
  batchId: number,
  candidate: CommitSha,
  attemptId: CheckRunId,
  now: number,
): void {
  sql.exec(
    `UPDATE train_batches SET state = 'checking', candidate = ?, attempt_id = ?, attempt_at = ?,
       updated_at = ? WHERE batch_id = ? AND state = 'composing'`,
    candidate,
    attemptId,
    now,
    now,
    batchId,
  );
}

/** Records that the check port accepted the attempt. */
export function markCheckStarted(sql: SqlStorage, batchId: number, now: number): void {
  sql.exec(
    "UPDATE train_batches SET check_started = 1, updated_at = ? WHERE batch_id = ?",
    now,
    batchId,
  );
}

/** Records the runner's report. A pass moves the batch to `passed`; anything else fails it. */
export function recordCheckResult(
  sql: SqlStorage,
  batchId: number,
  result: CheckResult,
  logDigest: string | null,
  now: number,
): void {
  sql.exec(
    `UPDATE train_batches SET check_result = ?, log_digest = ?, updated_at = ? WHERE batch_id = ?`,
    result,
    logDigest,
    now,
    batchId,
  );
  if (result === "pass") {
    sql.exec(
      "UPDATE train_batches SET state = 'passed' WHERE batch_id = ? AND state = 'checking'",
      batchId,
    );
  }
}

/** Records the merge intent authorized for the batch. */
export function recordIntent(
  sql: SqlStorage,
  batchId: number,
  intentId: string,
  now: number,
): void {
  sql.exec(
    "UPDATE train_batches SET intent_id = ?, updated_at = ? WHERE batch_id = ?",
    intentId,
    now,
    batchId,
  );
}

/** Settles the active batch. */
export function settleBatch(
  sql: SqlStorage,
  batchId: number,
  outcome: { state: "landed" } | { state: "failed"; failure: BatchFailure },
  now: number,
): void {
  sql.exec(
    "UPDATE train_batches SET active = NULL, state = ?, failure = ?, updated_at = ? WHERE batch_id = ?",
    outcome.state,
    outcome.state === "failed" ? outcome.failure : null,
    now,
    batchId,
  );
}

function toEntry(row: QueueRow): QueueEntry {
  return {
    pin: { claimId: row.claim_id, generation: row.generation, commit: row.commit_sha },
    state: parseEntryState(row.state),
    isolate: row.isolate === 1,
    retries: row.retries,
    reason: row.reason === null ? null : parseDropReason(row.reason),
  };
}

// Rows are written only by this module, so the JSON columns hold what it serialized.
function toBatch(row: BatchRow): BatchRecord {
  const pins: ClaimPin[] = JSON.parse(row.pins);
  const decisions: DecisionRef[] = JSON.parse(row.decisions);
  const definition: CheckDefinition = JSON.parse(row.definition);
  return {
    batchId: row.batch_id,
    state: parseBatchState(row.state),
    expectedMain: row.expected_main,
    pins,
    decisions,
    definition,
    candidate: row.candidate,
    attemptId: row.attempt_id,
    attemptAt: row.attempt_at,
    checkStarted: row.check_started === 1,
    checkResult: row.check_result === null ? null : parseCheckResult(row.check_result),
    logDigest: row.log_digest,
    intentId: row.intent_id,
    failure: row.failure === null ? null : parseBatchFailure(row.failure),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ENTRY_STATES = ["queued", "batched", "landed", "dropped", "parked"] as const;
const DROP_REASONS = [
  "pin_changed",
  "requirements_refused",
  "check_failed",
  "compose_failed",
  "retries_exhausted",
  "conflict",
] as const;
const BATCH_STATES = ["composing", "checking", "passed", "landed", "failed"] as const;
const BATCH_FAILURES = [
  "conflict",
  "compose_missing_commit",
  "compose_timeout",
  "compose_unsupported",
  "compose_infrastructure",
  "check_fail",
  "check_error",
  "authorization_refused",
  "main_rejected",
  "publish_refused",
] as const;
const CHECK_RESULTS = ["pass", "fail", "error"] as const;

function parseEntryState(value: string): EntryState {
  return member(ENTRY_STATES, value, "entry state");
}

function parseDropReason(value: string): DropReason {
  return member(DROP_REASONS, value, "drop reason");
}

function parseBatchState(value: string): BatchState {
  return member(BATCH_STATES, value, "batch state");
}

function parseBatchFailure(value: string): BatchFailure {
  return member(BATCH_FAILURES, value, "batch failure");
}

function parseCheckResult(value: string): CheckResult {
  return member(CHECK_RESULTS, value, "check result");
}

function member<T extends string>(values: readonly T[], value: string, what: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`the train's storage holds an unknown ${what}`);
  return found;
}
