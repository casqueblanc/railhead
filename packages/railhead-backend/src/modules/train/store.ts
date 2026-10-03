// The train's tables: the queue of ready pins and the batches composed from it.
//
// At most one batch is active at a time. The `active` column holds 1 for the active batch and NULL
// for every settled one, and its UNIQUE constraint refuses a second active row, so even a bug in
// the scheduler cannot start two batches at once.
//
// `train_wake` holds at most one row: the drive the train owes and when it is due. A call that
// accepts work writes it in the same transaction, so the debt survives a restart even when the
// Repo's alarm was never set. While the active batch waits for a runner's report, the row is due at
// the attempt's deadline. Once the scheduler's retries run out, the row stays with its failures
// marked exhausted, so work in storage always has a row.
//
// `train_drive` holds at most one row: the generation of the latest drive and when its lease ends.
// Each drive takes the next generation, and every write a drive makes checks it still holds the
// latest one, so a drive that outlived its lease and was taken over cannot change state again.

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
  "ALTER TABLE train_batches ADD COLUMN finished_at INTEGER",
  `CREATE TABLE train_wake (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    due_at INTEGER NOT NULL,
    failures INTEGER NOT NULL CHECK (failures >= 0)
  ) STRICT`,
  "ALTER TABLE train_batches ADD COLUMN check_deadline INTEGER",
  `CREATE TABLE train_drive (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL CHECK (generation > 0),
    lease_until INTEGER NOT NULL
  ) STRICT`,
  "ALTER TABLE train_batches ADD COLUMN check_held INTEGER NOT NULL DEFAULT 0 CHECK (check_held IN (0, 1))",
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
  /**
   * Out of the queue until something returns it: held with the claim it conflicts with (#118), or
   * waiting for a person to approve the protected check paths it edits (#174). Neither returns it
   * yet; a new push enqueues the claim's next generation.
   */
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
  /** The pin conflicts with another claim in its batch. */
  | "conflict"
  /** Checked alone, the pin's candidate edits protected check paths and waits for a person. */
  | "check_held";

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
  /** Two pins conflict; both are parked and `train.conflict` records the pair. */
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
  /** The runner did not report before the attempt's deadline. Never a pass. */
  | "check_timeout"
  /** The candidate edits protected check paths and waited for a person past its deadline. */
  | "check_held"
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
  /** Whether the check port held the attempt for a person: it will not run, and is not an outage. */
  checkHeld: boolean;
  /** Once the attempt's start was requested, when it expires unless the runner has reported. */
  checkDeadline: number | null;
  /** The runner's result, once reported. */
  checkResult: CheckResult | null;
  /** SHA-256 of the check log, as reported. */
  logDigest: string | null;
  /** When the reported run finished, as reported. */
  finishedAt: number | null;
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
  check_held: number;
  check_deadline: number | null;
  check_result: string | null;
  log_digest: string | null;
  finished_at: number | null;
  intent_id: string | null;
  failure: string | null;
  created_at: number;
  updated_at: number;
};

const QUEUE_COLUMNS = "claim_id, generation, commit_sha, state, isolate, retries, reason";
const BATCH_COLUMNS =
  "batch_id, state, expected_main, pins, decisions, definition, candidate, attempt_id, attempt_at, check_started, check_held, check_deadline, check_result, log_digest, finished_at, intent_id, failure, created_at, updated_at";

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

/**
 * Records, before the check port is asked to start the attempt, when the attempt expires without a
 * report. A deadline already recorded is kept, so asking again never extends it.
 */
export function requestCheck(
  sql: SqlStorage,
  batchId: number,
  deadline: number,
  now: number,
): void {
  sql.exec(
    `UPDATE train_batches SET check_deadline = ?, updated_at = ?
       WHERE batch_id = ? AND state = 'checking' AND check_deadline IS NULL`,
    deadline,
    now,
    batchId,
  );
}

/** Records that the check port held the attempt for a person. */
export function markCheckHeld(sql: SqlStorage, batchId: number, now: number): void {
  sql.exec(
    "UPDATE train_batches SET check_held = 1, updated_at = ? WHERE batch_id = ?",
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
  finishedAt: number,
  now: number,
): void {
  sql.exec(
    `UPDATE train_batches SET check_result = ?, log_digest = ?, finished_at = ?, updated_at = ?
       WHERE batch_id = ?`,
    result,
    logDigest,
    finishedAt,
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

/** A drive the train owes. */
export interface PendingWake {
  /** When it is due, in milliseconds since the Unix epoch. */
  dueAt: number;
  /** How many drives in a row stopped on a port or threw. */
  failures: number;
}

/** The drive the train owes, or `null`. */
export function readWake(sql: SqlStorage): PendingWake | null {
  const row = sql
    .exec<{ due_at: number; failures: number }>("SELECT due_at, failures FROM train_wake")
    .toArray()[0];
  return row === undefined ? null : { dueAt: row.due_at, failures: row.failures };
}

/** Records the drive the train owes. */
export function writeWake(sql: SqlStorage, wake: PendingWake): void {
  sql.exec(
    `INSERT INTO train_wake (id, due_at, failures) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET due_at = excluded.due_at, failures = excluded.failures`,
    wake.dueAt,
    wake.failures,
  );
}

/** Records that the train owes nothing. */
export function clearWake(sql: SqlStorage): void {
  sql.exec("DELETE FROM train_wake");
}

/** The latest drive's generation and when its lease ends. */
export interface DriveLease {
  /** Increases by one with each drive. */
  generation: number;
  /** When the alarm may take over from the drive, in milliseconds since the Unix epoch. */
  leaseUntil: number;
}

/** The latest drive's lease, or `null` before the first drive. */
export function readDrive(sql: SqlStorage): DriveLease | null {
  const row = sql
    .exec<{
      generation: number;
      lease_until: number;
    }>("SELECT generation, lease_until FROM train_drive")
    .toArray()[0];
  return row === undefined ? null : { generation: row.generation, leaseUntil: row.lease_until };
}

/** Records the latest drive's lease. */
export function writeDrive(sql: SqlStorage, lease: DriveLease): void {
  sql.exec(
    `INSERT INTO train_drive (id, generation, lease_until) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET generation = excluded.generation,
       lease_until = excluded.lease_until`,
    lease.generation,
    lease.leaseUntil,
  );
}

/** Whether storage holds work the train owes a drive: an active batch or a queued pin. */
export function owesWork(sql: SqlStorage): boolean {
  const row = sql
    .exec<{ owes: number }>(
      `SELECT EXISTS (SELECT 1 FROM train_batches WHERE active = 1)
         OR EXISTS (SELECT 1 FROM train_queue WHERE state = 'queued') AS owes`,
    )
    .toArray()[0];
  return row?.owes === 1;
}

/**
 * Whether storage holds work a drive could move now: an active batch that is not waiting for a
 * runner's report, or a waiting pin with no batch active.
 */
export function hasMovableWork(sql: SqlStorage): boolean {
  const row = sql
    .exec<{ movable: number }>(
      `SELECT CASE
         WHEN EXISTS (SELECT 1 FROM train_batches WHERE active = 1)
           THEN EXISTS (SELECT 1 FROM train_batches WHERE active = 1
             AND (state IN ('composing', 'passed')
               OR (state = 'checking' AND check_started = 0 AND check_held = 0)))
         ELSE EXISTS (SELECT 1 FROM train_queue WHERE state = 'queued')
       END AS movable`,
    )
    .toArray()[0];
  return row?.movable === 1;
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
    checkHeld: row.check_held === 1,
    // A started attempt always has a deadline; one recorded without it has already expired.
    checkDeadline: row.check_deadline ?? (row.check_started === 1 ? row.updated_at : null),
    checkResult: row.check_result === null ? null : parseCheckResult(row.check_result),
    logDigest: row.log_digest,
    finishedAt: row.finished_at,
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
  "check_held",
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
  "check_timeout",
  "check_held",
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
