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
// A queue entry is keyed by claim and generation, and each call to queue a pin is a new ready episode
// of that claim: a claim reopened after a superseded decision keeps its generation, so its next pin
// reuses the entry. A waiting entry takes the new commit, a settled one is queued again, both as
// fresh work with retries, isolation and drop reason cleared even when the commit is unchanged, and a
// batched one keeps its commit for the active batch and holds the new one in `next_commit` until
// that batch settles. `episode` records the claim's episode of the pin the entry holds, and
// `next_episode` that of `next_commit`; a drive that read an entry settles it only while its
// episode is unchanged, so a ready episode queued during the drive's reads is kept. A batched entry
// also records in `batched_episode` the episode its batch was formed for. A re-ready of the batched
// commit raises `episode` past it, and the batch's result then belongs to the older episode only:
// the entry goes back to the queue as fresh work rather than taking that result. The batch's pins
// carry the same episodes, so its check attempt and merge intent name the episodes they cover, and
// the merge fence refuses to authorize or publish them once a claim is in a later episode.
//
// `train_conflicts` holds one row per conflicting pair the train parked, keyed by the batch whose
// merge found it. While its state is `asking`, the train owes the owner a question about the pair,
// so the row is work it owes a drive, due at `retry_at`; a refusal counts in `failures` and moves
// `retry_at` later, and the question stays owed. Once asked, it waits for the answer, found by its
// `decision_id`. The pair returns to the queue in the transaction that records the answer, when a
// new ready of either claim arrives, when either claim is no longer held before the question is
// asked, or when both are no longer held after it. `checked_at` orders asked pairs for that last
// check, which reads a bounded batch on each wake, those checked longest ago first.
//
// `train_drive` holds at most one row: the generation of the latest drive and when its lease ends.
// Each drive takes the next generation, and every write a drive makes checks it still holds the
// latest one, so a drive that outlived its lease and was taken over cannot change state again.
//
// `merge_attempt` names the merge attempt of a batch's latest compose, recorded before the merge
// port is called, so its candidate prefix is known whatever the compose did. `train_discards` holds
// the attempts whose candidate refs the train still has to delete: a batch's attempt when it
// settles, and an earlier attempt when a new compose of the same batch supersedes it. A batch that
// fails holding one pin, parked for a person's approval, keeps its attempt: the approval revives it
// on the same candidate. Its attempt is queued once the pin can no longer return, superseded by a
// newer ready episode or generation or dropped, or when the revived batch settles. Each row is due
// no earlier than `MERGE_PUSH_WINDOW_MS` after it was queued, so its compose can no longer push.

import type {
  CheckResult,
  CheckRunId,
  ClaimId,
  CommitSha,
  DecisionId,
  DecisionRef,
  HeldExpiryReason,
} from "@railhead/shared/events";
import type { ClaimPin, EpisodePin } from "../../contracts/claims";
import { MERGE_PUSH_WINDOW_MS, type CheckDefinition } from "../../contracts/train";
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
  "ALTER TABLE train_batches ADD COLUMN merge_attempt TEXT",
  `CREATE TABLE train_discards (
    attempt TEXT PRIMARY KEY,
    due_at INTEGER NOT NULL,
    failures INTEGER NOT NULL CHECK (failures >= 0)
  ) STRICT`,
  "ALTER TABLE train_queue ADD COLUMN next_commit TEXT",
  "ALTER TABLE train_queue ADD COLUMN episode INTEGER NOT NULL DEFAULT 0 CHECK (episode >= 0)",
  "ALTER TABLE train_queue ADD COLUMN next_episode INTEGER",
  "ALTER TABLE train_queue ADD COLUMN batched_episode INTEGER",
  "UPDATE train_queue SET batched_episode = episode WHERE state = 'batched'",
  "ALTER TABLE train_queue ADD COLUMN approved_attempt TEXT",
  `CREATE TABLE train_conflicts (
    batch_id INTEGER PRIMARY KEY,
    first_claim TEXT NOT NULL,
    first_generation INTEGER NOT NULL CHECK (first_generation > 0),
    second_claim TEXT NOT NULL,
    second_generation INTEGER NOT NULL CHECK (second_generation > 0),
    path TEXT NOT NULL,
    state TEXT NOT NULL
      CHECK (state IN ('asking', 'asked', 'refused', 'answered', 'redone', 'closed')),
    decision_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (first_claim <> second_claim),
    CHECK (state NOT IN ('asked', 'answered') OR decision_id IS NOT NULL)
  ) STRICT`,
  "CREATE INDEX train_conflicts_by_state ON train_conflicts (state)",
  "CREATE INDEX train_conflicts_by_decision ON train_conflicts (decision_id)",
  "ALTER TABLE train_conflicts ADD COLUMN checked_at INTEGER NOT NULL DEFAULT 0",
  "CREATE INDEX train_conflicts_by_check ON train_conflicts (state, checked_at, batch_id)",
  "ALTER TABLE train_conflicts ADD COLUMN failures INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE train_conflicts ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0",
  // A refused question was once final; it is now owed again, with the backoff every refusal gets.
  "UPDATE train_conflicts SET state = 'asking' WHERE state = 'refused'",
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
   * Out of the queue until something returns it: held with the claim it conflicts with until the
   * owner answers the train's question about the pair, a new ready of either claim arrives, or
   * either claim is no longer held (#118); or waiting for a person to approve the protected check
   * paths it edits, which an approval of its held attempt returns. A new push enqueues the claim's
   * next generation.
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
  | "check_held"
  /** Parked for a person's approval, it waited too long or too many others were parked after it. */
  | "held_expired";

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
  /** The claim's ready episode the entry was last queued for. */
  episode: number;
  /** While batched, the commit of a newer ready episode, queued once the batch settles; or `null`. */
  nextCommit: CommitSha | null;
  /** The ready episode its latest batch was formed for, or `null` before it was first batched. */
  batchedEpisode: number | null;
  /**
   * The approved held attempt it returns to, or `null`. Its next batch is that attempt's own batch,
   * revived on the same candidate rather than composed again.
   */
  approvedAttempt: CheckRunId | null;
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
  /** Its pins, in merge order, each with the ready episode its entry held when it was formed. */
  pins: EpisodePin[];
  /** The decision versions required when it was formed. */
  decisions: DecisionRef[];
  /** The trusted check definition, read from `expectedMain`. */
  definition: CheckDefinition;
  /** The merge attempt of its latest compose, once one was asked for. */
  mergeAttempt: string | null;
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
  episode: number;
  next_commit: string | null;
  batched_episode: number | null;
  approved_attempt: string | null;
};

type BatchRow = {
  batch_id: number;
  state: string;
  expected_main: string;
  pins: string;
  decisions: string;
  definition: string;
  merge_attempt: string | null;
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

const QUEUE_COLUMNS =
  "claim_id, generation, commit_sha, state, isolate, retries, reason, episode, next_commit, batched_episode, approved_attempt";
const BATCH_COLUMNS =
  "batch_id, state, expected_main, pins, decisions, definition, merge_attempt, candidate, attempt_id, attempt_at, check_started, check_held, check_deadline, check_result, log_digest, finished_at, intent_id, failure, created_at, updated_at";

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

/**
 * The place of a waiting entry in the queue, counting from 1 in the order `waitingEntries` takes
 * them, or `null` when the entry is not waiting.
 */
export function queuePosition(sql: SqlStorage, claimId: string, generation: number): number | null {
  const row = sql
    .exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM train_queue q,
         (SELECT position, enqueued_at, claim_id, generation FROM train_queue
            WHERE claim_id = ? AND generation = ? AND state = 'queued') me
       WHERE q.state = 'queued'
         AND (q.position, q.enqueued_at, q.claim_id, q.generation)
           <= (me.position, me.enqueued_at, me.claim_id, me.generation)`,
      claimId,
      generation,
    )
    .toArray()[0];
  return row === undefined || row.n === 0 ? null : row.n;
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

/** Adds a waiting entry for ready episode `episode` at the back of the queue. */
export function insertEntry(sql: SqlStorage, pin: ClaimPin, episode: number, now: number): void {
  sql.exec(
    `INSERT INTO train_queue
       (claim_id, generation, commit_sha, position, state, isolate, retries, reason, episode,
        enqueued_at, updated_at)
     VALUES (?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM train_queue), 'queued', 0, 0, NULL,
       ?, ?, ?)`,
    pin.claimId,
    pin.generation,
    pin.commit,
    episode,
    now,
    now,
  );
}

/**
 * Queues ready episode `episode` of a claim whose entry is waiting or settled: the entry takes the
 * commit and episode as fresh work, with its retries, isolation, drop reason, held commit and
 * approved attempt cleared, even when the commit is the one it already held. A waiting entry keeps
 * its place; a settled one goes to the back.
 */
export function requeueEntry(sql: SqlStorage, pin: ClaimPin, episode: number, now: number): void {
  sql.exec(
    `UPDATE train_queue SET commit_sha = ?, episode = ?, isolate = 0, retries = 0, reason = NULL,
       next_commit = NULL, next_episode = NULL, approved_attempt = NULL, updated_at = ?,
       position = CASE WHEN state = 'queued' THEN position
         ELSE (SELECT COALESCE(MAX(position), 0) + 1 FROM train_queue) END,
       state = 'queued'
     WHERE claim_id = ? AND generation = ? AND state <> 'batched'`,
    pin.commit,
    episode,
    now,
    pin.claimId,
    pin.generation,
  );
}

/**
 * Holds the commit of ready episode `episode` on a batched entry until its batch settles, or, when
 * the episode pinned the batched commit again, clears any held commit and takes the episode, which
 * the batch's result then no longer settles.
 */
export function deferCommit(sql: SqlStorage, pin: ClaimPin, episode: number, now: number): void {
  sql.exec(
    `UPDATE train_queue SET next_commit = CASE WHEN commit_sha = ? THEN NULL ELSE ? END,
       next_episode = CASE WHEN commit_sha = ? THEN NULL ELSE ? END,
       episode = CASE WHEN commit_sha = ? THEN ? ELSE episode END,
       updated_at = ?
     WHERE claim_id = ? AND generation = ? AND state = 'batched'`,
    pin.commit,
    pin.commit,
    pin.commit,
    episode,
    pin.commit,
    episode,
    now,
    pin.claimId,
    pin.generation,
  );
}

/**
 * Queues, at the back with fresh counters, the newer commit and episode each entry held while it
 * was batched. Call it after a batch's entries settle.
 */
export function promoteDeferred(sql: SqlStorage, now: number): void {
  sql.exec(
    `UPDATE train_queue SET commit_sha = next_commit, next_commit = NULL,
       episode = COALESCE(next_episode, episode), next_episode = NULL, state = 'queued',
       isolate = 0, retries = 0, reason = NULL, updated_at = ?,
       position = (SELECT COALESCE(MAX(position), 0) + 1 FROM train_queue)
     WHERE next_commit IS NOT NULL AND state <> 'batched'`,
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
         approved_attempt = NULL, updated_at = ? WHERE claim_id = ? AND generation = ?`,
      start + index,
      entry.isolate ? 1 : 0,
      entry.retries,
      now,
      entry.pin.claimId,
      entry.pin.generation,
    );
  });
}

/**
 * Puts a pin parked for its held attempt back at the front of the queue, alone, to return to
 * `attemptId`'s batch. Returns whether the entry was parked for that reason.
 */
export function requeueApproved(
  sql: SqlStorage,
  pin: ClaimPin,
  attemptId: CheckRunId,
  now: number,
): boolean {
  const front = sql
    .exec<{ position: number | null }>("SELECT MIN(position) AS position FROM train_queue")
    .toArray()[0]?.position;
  const updated = sql.exec(
    `UPDATE train_queue SET state = 'queued', position = ?, isolate = 1, reason = NULL,
       approved_attempt = ?, updated_at = ?
     WHERE claim_id = ? AND generation = ? AND state = 'parked' AND reason = 'check_held'`,
    (front ?? 1) - 1,
    attemptId,
    now,
    pin.claimId,
    pin.generation,
  );
  return updated.rowsWritten > 0;
}

/**
 * Makes the batch of a held attempt that failed for waiting active again, on its same candidate and
 * attempt, and moves its one entry into it. The attempt starts over with no deadline. Returns
 * whether the batch was revived; nothing changes when another batch is active.
 */
export function reviveHeldBatch(
  sql: SqlStorage,
  attemptId: CheckRunId,
  pin: ClaimPin,
  now: number,
): boolean {
  if (activeBatch(sql) !== null) return false;
  const revived = sql.exec(
    `UPDATE train_batches SET active = 1, state = 'checking', failure = NULL, check_held = 0,
       check_started = 0, check_deadline = NULL, updated_at = ?
     WHERE attempt_id = ? AND state = 'failed' AND failure = 'check_held'`,
    now,
    attemptId,
  );
  if (revived.rowsWritten === 0) return false;
  sql.exec(
    `UPDATE train_queue SET state = 'batched', batched_episode = episode, approved_attempt = NULL,
       updated_at = ?
     WHERE claim_id = ? AND generation = ?`,
    now,
    pin.claimId,
    pin.generation,
  );
  return true;
}

/**
 * Whether the train may still run `attemptId`, a held attempt: the active batch has it and no
 * result yet, or the one pin of its batch, failed for waiting, is parked for it or queued to revive
 * it, at the commit and ready episode the batch pinned, and no later generation of its claim was
 * queued since, which would leave it stale. So at most one parked attempt per claim counts.
 */
export function holdsAttempt(sql: SqlStorage, attemptId: CheckRunId): boolean {
  const active = sql
    .exec(
      `SELECT 1 FROM train_batches
       WHERE active = 1 AND state = 'checking' AND attempt_id = ? AND check_result IS NULL`,
      attemptId,
    )
    .toArray();
  if (active.length > 0) return true;
  const batch = batchByAttempt(sql, attemptId);
  if (batch?.state !== "failed" || batch.failure !== "check_held" || batch.pins.length !== 1) {
    return false;
  }
  const [pin] = batch.pins;
  if (pin === undefined) return false;
  const waiting = sql
    .exec(
      `SELECT 1 FROM train_queue AS entry
       WHERE claim_id = ? AND generation = ? AND commit_sha = ? AND episode = ?
         AND ((state = 'parked' AND reason = 'check_held')
           OR (state = 'queued' AND approved_attempt = ?))
         AND NOT EXISTS (SELECT 1 FROM train_queue AS later
           WHERE later.claim_id = entry.claim_id AND later.generation > entry.generation)`,
      pin.claimId,
      pin.generation,
      pin.commit,
      pin.episode,
      attemptId,
    )
    .toArray();
  return waiting.length > 0;
}

// A parked held pin that can still return to its batch: no later generation of its claim was queued.
const RETURNABLE_HELD = `state = 'parked' AND reason = 'check_held'
  AND NOT EXISTS (SELECT 1 FROM train_queue AS later
    WHERE later.claim_id = entry.claim_id AND later.generation > entry.generation)`;

/** A held attempt whose parked pin expired, which the train will no longer run. */
export interface ExpiredHold {
  attemptId: CheckRunId;
  candidate: CommitSha;
  reason: HeldExpiryReason;
}

/**
 * Drops the parked held pins that can still return and were parked at or before `parkedBy`, and
 * beyond the newest `keep` the oldest ones, as `held_expired`, and queues each one's merge attempt
 * for discard. The train then no longer holds their attempts, so an approval of one is stale and
 * the checks module may prune it. Returns the held attempts they were parked for, oldest last.
 */
export function expireHeldPins(
  sql: SqlStorage,
  { parkedBy, keep }: { parkedBy: number; keep: number },
  now: number,
): ExpiredHold[] {
  const returnable = sql
    .exec<{
      claim_id: string;
      generation: number;
      commit_sha: string;
      episode: number;
      updated_at: number;
    }>(
      `SELECT claim_id, generation, commit_sha, episode, updated_at FROM train_queue AS entry
       WHERE ${RETURNABLE_HELD}
       ORDER BY updated_at DESC, claim_id DESC`,
    )
    .toArray();
  return returnable.flatMap((row, index): ExpiredHold[] => {
    const reason = row.updated_at <= parkedBy ? "timed_out" : index >= keep ? "over_limit" : null;
    if (reason === null) return [];
    const pin = { claimId: row.claim_id, generation: row.generation, commit: row.commit_sha };
    const held = heldAttemptOf(sql, { pin, episode: row.episode });
    settleEntry(sql, pin, "dropped", "held_expired", now);
    queueHeldDiscard(sql, { pin, episode: row.episode }, now);
    return held === null ? [] : [{ ...held, reason }];
  });
}

/** The attempt and candidate of the held batch `entry` was parked for, or `null`. */
function heldAttemptOf(
  sql: SqlStorage,
  { pin, episode }: { pin: ClaimPin; episode: number },
): { attemptId: CheckRunId; candidate: CommitSha } | null {
  const row = sql
    .exec<{ attempt_id: string; candidate: string }>(
      `SELECT attempt_id, candidate FROM train_batches
       WHERE state = 'failed' AND failure = 'check_held'
         AND attempt_id IS NOT NULL AND candidate IS NOT NULL
         AND json_array_length(pins) = 1
         AND json_extract(pins, '$[0].claimId') = ? AND json_extract(pins, '$[0].generation') = ?
         AND json_extract(pins, '$[0].commit') = ? AND json_extract(pins, '$[0].episode') = ?
       ORDER BY batch_id DESC LIMIT 1`,
      pin.claimId,
      pin.generation,
      pin.commit,
      episode,
    )
    .toArray()[0];
  return row === undefined ? null : { attemptId: row.attempt_id, candidate: row.candidate };
}

/** When the longest-parked held pin that can still return was parked, or `null`. */
export function oldestHeldParkAt(sql: SqlStorage): number | null {
  return (
    sql
      .exec<{ at: number | null }>(
        `SELECT MIN(updated_at) AS at FROM train_queue AS entry WHERE ${RETURNABLE_HELD}`,
      )
      .toArray()[0]?.at ?? null
  );
}

/**
 * Lets the active batch's held attempt be asked for again, with no deadline, once a person approved
 * it. Returns whether that batch was holding `attemptId`.
 */
export function releaseActiveHold(sql: SqlStorage, attemptId: CheckRunId, now: number): boolean {
  const released = sql.exec(
    `UPDATE train_batches SET check_held = 0, check_deadline = NULL, updated_at = ?
     WHERE active = 1 AND state = 'checking' AND attempt_id = ? AND check_held = 1
       AND check_result IS NULL`,
    now,
    attemptId,
  );
  return released.rowsWritten > 0;
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

/**
 * Records a new active batch over `pins` and marks their entries batched for the episode each
 * holds. Returns its id.
 */
export function insertBatch(
  sql: SqlStorage,
  batch: {
    expectedMain: CommitSha;
    pins: EpisodePin[];
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
      `UPDATE train_queue SET state = 'batched', batched_episode = ?, updated_at = ?
       WHERE claim_id = ? AND generation = ?`,
      pin.episode,
      now,
      pin.claimId,
      pin.generation,
    );
  }
  return row.batch_id;
}

/**
 * Records `attempt` as the batch's merge attempt, before the merge port is asked to compose under
 * it. An earlier attempt it supersedes is queued for discard.
 */
export function recordMergeAttempt(
  sql: SqlStorage,
  batchId: number,
  attempt: string,
  now: number,
): void {
  queueDiscard(sql, batchId, now);
  sql.exec(
    "UPDATE train_batches SET merge_attempt = ?, updated_at = ? WHERE batch_id = ?",
    attempt,
    now,
    batchId,
  );
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

/** Settles the active batch and queues its merge attempt for discard. */
export function settleBatch(
  sql: SqlStorage,
  batchId: number,
  outcome: { state: "landed" } | { state: "failed"; failure: BatchFailure },
  now: number,
): void {
  queueDiscard(sql, batchId, now);
  sql.exec(
    "UPDATE train_batches SET active = NULL, state = ?, failure = ?, updated_at = ? WHERE batch_id = ?",
    outcome.state,
    outcome.state === "failed" ? outcome.failure : null,
    now,
    batchId,
  );
}

/**
 * Settles the active batch of a pin held alone past its deadline, keeping its merge attempt: an
 * approval may revive the batch on the same candidate. `queueHeldDiscard` queues the attempt once
 * the pin can no longer return to it.
 */
export function settleHeldBatch(sql: SqlStorage, batchId: number, now: number): void {
  sql.exec(
    `UPDATE train_batches SET active = NULL, state = 'failed', failure = 'check_held', updated_at = ?
     WHERE batch_id = ?`,
    now,
    batchId,
  );
}

/**
 * Queues for discard the merge attempt of the held batch `entry` was parked for at its commit and
 * ready episode, once the entry can no longer return to it: a newer episode or generation
 * superseded it, or it was dropped on its way back.
 */
export function queueHeldDiscard(
  sql: SqlStorage,
  { pin, episode }: { pin: ClaimPin; episode: number },
  now: number,
): void {
  sql.exec(
    `INSERT INTO train_discards (attempt, due_at, failures)
       SELECT merge_attempt, ?, 0 FROM train_batches
       WHERE state = 'failed' AND failure = 'check_held' AND merge_attempt IS NOT NULL
         AND json_array_length(pins) = 1
         AND json_extract(pins, '$[0].claimId') = ? AND json_extract(pins, '$[0].generation') = ?
         AND json_extract(pins, '$[0].commit') = ? AND json_extract(pins, '$[0].episode') = ?
     ON CONFLICT (attempt) DO NOTHING`,
    now + MERGE_PUSH_WINDOW_MS,
    pin.claimId,
    pin.generation,
    pin.commit,
    episode,
  );
}

/** Queues the batch's current merge attempt, if any, for discard once its compose cannot push. */
function queueDiscard(sql: SqlStorage, batchId: number, now: number): void {
  sql.exec(
    `INSERT INTO train_discards (attempt, due_at, failures)
       SELECT merge_attempt, ?, 0 FROM train_batches
       WHERE batch_id = ? AND merge_attempt IS NOT NULL
     ON CONFLICT (attempt) DO NOTHING`,
    now + MERGE_PUSH_WINDOW_MS,
    batchId,
  );
}

/** A merge attempt whose candidate refs the train still has to delete. */
export interface PendingDiscard {
  /** The merge attempt. */
  attempt: string;
  /** When the next discard is due, in milliseconds since the Unix epoch. */
  dueAt: number;
  /** How many discards of it failed in a row. */
  failures: number;
}

/** Up to `limit` discards due at `now`, earliest first. */
export function dueDiscards(sql: SqlStorage, now: number, limit: number): PendingDiscard[] {
  return sql
    .exec<{ attempt: string; due_at: number; failures: number }>(
      `SELECT attempt, due_at, failures FROM train_discards WHERE due_at <= ?
       ORDER BY due_at, attempt LIMIT ?`,
      now,
      limit,
    )
    .toArray()
    .map((row) => ({ attempt: row.attempt, dueAt: row.due_at, failures: row.failures }));
}

/** When the earliest pending discard is due, or `null` when none is pending. */
export function nextDiscardAt(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ due_at: number | null }>("SELECT MIN(due_at) AS due_at FROM train_discards")
    .toArray()[0];
  return row?.due_at ?? null;
}

/** Records that the attempt's candidate refs are gone. */
export function completeDiscard(sql: SqlStorage, attempt: string): void {
  sql.exec("DELETE FROM train_discards WHERE attempt = ?", attempt);
}

/** Records a failed discard of the attempt and when to try it again. */
export function retryDiscard(sql: SqlStorage, discard: PendingDiscard): void {
  sql.exec(
    "UPDATE train_discards SET due_at = ?, failures = ? WHERE attempt = ?",
    discard.dueAt,
    discard.failures,
    discard.attempt,
  );
}

/** Where one parked pair stands. */
export type ConflictState =
  /** The train owes the owner a question about the pair. */
  | "asking"
  /** The question is asked; the pair waits for its answer. */
  | "asked"
  /**
   * The decisions module refused the question as invalid, which no retry changes; the pair returned
   * to the queue unasked, each entry to be merged alone.
   */
  | "refused"
  /** The owner answered, and the pair returned to the queue. */
  | "answered"
  /** A new ready of one claim arrived, and the pair returned to the queue. */
  | "redone"
  /** A claim was no longer held before the question was asked; the pair returned to the queue. */
  | "closed";

/** One parked pair. */
export interface ConflictRecord {
  /** The batch whose merge found the conflict. */
  batchId: number;
  /** The two parked entries, as the merge named them. */
  pins: [ConflictPin, ConflictPin];
  /** The first conflicting path. */
  path: string;
  /** Where it stands. */
  state: ConflictState;
  /** The decision the question opened, once asked. */
  decisionId: DecisionId | null;
  /** When it was recorded. */
  createdAt: number;
  /** When it last changed. */
  updatedAt: number;
  /** The refusals of its question in a row. */
  failures: number;
  /** While asking, when the question is next due, in milliseconds since the Unix epoch. */
  retryAt: number;
}

/** The queue entry a parked pair holds: a claim at one generation. */
export interface ConflictPin {
  /** The claim. */
  claimId: ClaimId;
  /** The generation of its parked entry. */
  generation: number;
}

/** States in which a pair is still parked. */
const OPEN_CONFLICT = "('asking', 'asked')";

type ConflictRow = {
  batch_id: number;
  first_claim: string;
  first_generation: number;
  second_claim: string;
  second_generation: number;
  path: string;
  state: string;
  decision_id: string | null;
  created_at: number;
  updated_at: number;
  failures: number;
  retry_at: number;
};

const CONFLICT_COLUMNS =
  "batch_id, first_claim, first_generation, second_claim, second_generation, path, state, decision_id, created_at, updated_at, failures, retry_at";

/** Records a pair the batch's merge found conflicting, owing the owner a question about it. */
export function insertConflict(
  sql: SqlStorage,
  batchId: number,
  pins: readonly [ConflictPin, ConflictPin],
  path: string,
  now: number,
): void {
  const [first, second] = pins;
  sql.exec(
    `INSERT INTO train_conflicts (batch_id, first_claim, first_generation, second_claim,
       second_generation, path, state, decision_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'asking', NULL, ?, ?)`,
    batchId,
    first.claimId,
    first.generation,
    second.claimId,
    second.generation,
    path,
    now,
    now,
  );
}

/** The pair recorded for `batchId`, or `null`. */
export function readConflict(sql: SqlStorage, batchId: number): ConflictRecord | null {
  const row = sql
    .exec<ConflictRow>(
      `SELECT ${CONFLICT_COLUMNS} FROM train_conflicts WHERE batch_id = ?`,
      batchId,
    )
    .toArray()[0];
  return row === undefined ? null : toConflict(row);
}

/** The oldest pair whose question is due at `now`, or `null`. */
export function dueQuestion(sql: SqlStorage, now: number): ConflictRecord | null {
  const row = sql
    .exec<ConflictRow>(
      `SELECT ${CONFLICT_COLUMNS} FROM train_conflicts WHERE state = 'asking' AND retry_at <= ?
       ORDER BY batch_id LIMIT 1`,
      now,
    )
    .toArray()[0];
  return row === undefined ? null : toConflict(row);
}

/** When the earliest owed question is due, or `null` when none is owed. */
export function nextQuestionAt(sql: SqlStorage): number | null {
  const row = sql
    .exec<{ due: number | null }>(
      "SELECT MIN(retry_at) AS due FROM train_conflicts WHERE state = 'asking'",
    )
    .toArray()[0];
  return row?.due ?? null;
}

/** Records a refusal of the pair's question, which stays owed and is next due at `retryAt`. */
export function deferQuestion(
  sql: SqlStorage,
  batchId: number,
  failures: number,
  retryAt: number,
  now: number,
): void {
  sql.exec(
    `UPDATE train_conflicts SET failures = ?, retry_at = ?, updated_at = ?
     WHERE batch_id = ? AND state = 'asking'`,
    failures,
    retryAt,
    now,
    batchId,
  );
}

/** The asked pair whose question opened `decisionId`, or `null`. */
export function askedConflictOf(sql: SqlStorage, decisionId: DecisionId): ConflictRecord | null {
  const row = sql
    .exec<ConflictRow>(
      `SELECT ${CONFLICT_COLUMNS} FROM train_conflicts WHERE decision_id = ? AND state = 'asked'`,
      decisionId,
    )
    .toArray()[0];
  return row === undefined ? null : toConflict(row);
}

/**
 * Up to `limit` asked pairs, those checked longest ago first, each stamped as checked at `now`. A
 * caller reading a bounded batch on each call so reaches every asked pair in turn.
 */
export function nextAskedToCheck(sql: SqlStorage, limit: number, now: number): ConflictRecord[] {
  const conflicts = sql
    .exec<ConflictRow>(
      `SELECT ${CONFLICT_COLUMNS} FROM train_conflicts WHERE state = 'asked'
       ORDER BY checked_at, batch_id LIMIT ?`,
      limit,
    )
    .toArray()
    .map(toConflict);
  for (const conflict of conflicts) {
    sql.exec("UPDATE train_conflicts SET checked_at = ? WHERE batch_id = ?", now, conflict.batchId);
  }
  return conflicts;
}

/** The still-parked pair holding the claim's entry at `generation`, or `null`. */
export function openConflictOf(
  sql: SqlStorage,
  claimId: ClaimId,
  generation: number,
): ConflictRecord | null {
  const row = sql
    .exec<ConflictRow>(
      `SELECT ${CONFLICT_COLUMNS} FROM train_conflicts WHERE state IN ${OPEN_CONFLICT}
         AND ((first_claim = ? AND first_generation = ?) OR (second_claim = ? AND second_generation = ?))
       ORDER BY batch_id DESC LIMIT 1`,
      claimId,
      generation,
      claimId,
      generation,
    )
    .toArray()[0];
  return row === undefined ? null : toConflict(row);
}

/** Up to `limit` pairs, newest first. */
export function recentConflicts(sql: SqlStorage, limit: number): ConflictRecord[] {
  return sql
    .exec<ConflictRow>(
      `SELECT ${CONFLICT_COLUMNS} FROM train_conflicts ORDER BY batch_id DESC LIMIT ?`,
      limit,
    )
    .toArray()
    .map(toConflict);
}

/** Moves a pair to `state`, recording the decision its question opened when there is one. */
export function settleConflict(
  sql: SqlStorage,
  batchId: number,
  state: Exclude<ConflictState, "asking">,
  decisionId: DecisionId | null,
  now: number,
): void {
  sql.exec(
    `UPDATE train_conflicts SET state = ?, decision_id = COALESCE(?, decision_id), updated_at = ?
     WHERE batch_id = ?`,
    state,
    decisionId,
    now,
    batchId,
  );
}

/**
 * Returns a parked entry to the back of the queue with fresh counters, to be merged alone when
 * `isolate` is set; any other entry stays.
 */
export function unparkEntry(
  sql: SqlStorage,
  pin: ConflictPin,
  isolate: boolean,
  now: number,
): void {
  sql.exec(
    `UPDATE train_queue SET state = 'queued', isolate = ?, retries = 0, reason = NULL,
       position = (SELECT COALESCE(MAX(position), 0) + 1 FROM train_queue), updated_at = ?
     WHERE claim_id = ? AND generation = ? AND state = 'parked'`,
    isolate ? 1 : 0,
    now,
    pin.claimId,
    pin.generation,
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

/**
 * Whether storage holds work the train owes a drive: an active batch, a queued pin or a question
 * about a parked pair.
 */
export function owesWork(sql: SqlStorage): boolean {
  const row = sql
    .exec<{ owes: number }>(
      `SELECT EXISTS (SELECT 1 FROM train_batches WHERE active = 1)
         OR EXISTS (SELECT 1 FROM train_queue WHERE state = 'queued')
         OR EXISTS (SELECT 1 FROM train_conflicts WHERE state = 'asking') AS owes`,
    )
    .toArray()[0];
  return row?.owes === 1;
}

/**
 * Whether storage holds work a drive could move at `now`: a question about a parked pair due by
 * then, an active batch that is not waiting for a runner's report, or a waiting pin with no batch
 * active.
 */
export function hasMovableWork(sql: SqlStorage, now: number): boolean {
  const row = sql
    .exec<{ movable: number }>(
      `SELECT CASE
         WHEN EXISTS (SELECT 1 FROM train_conflicts WHERE state = 'asking' AND retry_at <= ?)
           THEN 1
         WHEN EXISTS (SELECT 1 FROM train_batches WHERE active = 1)
           THEN EXISTS (SELECT 1 FROM train_batches WHERE active = 1
             AND (state IN ('composing', 'passed')
               OR (state = 'checking' AND check_started = 0 AND check_held = 0)))
         ELSE EXISTS (SELECT 1 FROM train_queue WHERE state = 'queued')
       END AS movable`,
      now,
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
    episode: row.episode,
    nextCommit: row.next_commit,
    batchedEpisode: row.batched_episode,
    approvedAttempt: row.approved_attempt,
  };
}

// Rows are written only by this module, so the JSON columns hold what it serialized.
function toBatch(row: BatchRow): BatchRecord {
  // A batch formed before pins carried their episode has none. Episodes start at 1, so 0 matches
  // no claim and the fence refuses the batch, which goes back to the queue.
  const stored: (ClaimPin & { episode?: number })[] = JSON.parse(row.pins);
  const pins = stored.map((pin) => ({ ...pin, episode: pin.episode ?? 0 }));
  const decisions: DecisionRef[] = JSON.parse(row.decisions);
  const definition: CheckDefinition = JSON.parse(row.definition);
  return {
    batchId: row.batch_id,
    state: parseBatchState(row.state),
    expectedMain: row.expected_main,
    pins,
    decisions,
    definition,
    mergeAttempt: row.merge_attempt,
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

function toConflict(row: ConflictRow): ConflictRecord {
  return {
    batchId: row.batch_id,
    pins: [
      { claimId: row.first_claim, generation: row.first_generation },
      { claimId: row.second_claim, generation: row.second_generation },
    ],
    path: row.path,
    state: member(CONFLICT_STATES, row.state, "conflict state"),
    decisionId: row.decision_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    failures: row.failures,
    retryAt: row.retry_at,
  };
}

const CONFLICT_STATES = ["asking", "asked", "refused", "answered", "redone", "closed"] as const;
const ENTRY_STATES = ["queued", "batched", "landed", "dropped", "parked"] as const;
const DROP_REASONS = [
  "pin_changed",
  "requirements_refused",
  "check_failed",
  "compose_failed",
  "retries_exhausted",
  "conflict",
  "check_held",
  "held_expired",
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
