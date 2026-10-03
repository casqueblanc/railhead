// The checks module's record of each attempt, in the Repo's storage.
//
// An attempt's identity (its candidate, the main it was composed on and the digest of the trusted
// definition) is written once and never changed: a later call naming the same attempt with anything
// else is a mismatch, never an update. A row only moves forward, from `held` (a protected path was
// edited, so nothing runs) or `started` (a sandbox slot was admitted and the run was asked for) to
// `reported` (the run's result, with its output cut to `MAX_CHECK_LOG_BYTES` and the SHA-256 of what
// was kept). The output is untrusted text: it is stored for a reader, never logged. The table keeps
// at most `MAX_STORED_ATTEMPTS` rows, the oldest settled ones going first. A started attempt counts
// as settled once its sandbox's deadline is `REPORT_GRACE_MS` behind: its run cannot still be
// running, and the train no longer accepts its report. A report for an attempt removed this way
// finds no row and is refused, so an abandoned run can neither grow the table nor pass late.

import type { CheckResult, CheckRunId, CommitSha } from "@railhead/shared/events";
import { CHECK_DEADLINE_MS } from "../modules/train/scheduler";
import { atomically, migrate, type RepoStorage } from "../repo/storage";

/** The most bytes of a run's output kept, from its end. */
export const MAX_CHECK_LOG_BYTES = 64 * 1024;

/** The most attempts kept. Writing one more removes the oldest settled one. */
export const MAX_STORED_ATTEMPTS = 512;

/**
 * How long after its sandbox's deadline a started attempt is kept as if its report could still
 * arrive. The train waits `CHECK_DEADLINE_MS` from when it asked for the run, which was before the
 * sandbox was admitted, so by then it refuses the report anyway.
 */
export const REPORT_GRACE_MS = CHECK_DEADLINE_MS;

const OWNER = "checks";

/** Released schema steps of the checks module's table. Append a step to change it. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE check_attempts (
    attempt_id TEXT PRIMARY KEY,
    candidate TEXT NOT NULL,
    expected_main TEXT NOT NULL,
    digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('held', 'started', 'reported')),
    held_paths TEXT,
    sandbox TEXT,
    deadline INTEGER,
    result TEXT CHECK (result IN ('pass', 'fail', 'error')),
    log TEXT,
    log_digest TEXT,
    finished_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
];

/** What identifies an attempt: fixed when it is first written. */
export interface AttemptIdentity {
  /** The attempt. */
  attemptId: CheckRunId;
  /** The exact commit checked. */
  candidate: CommitSha;
  /** The main commit the candidate was composed on, which the definition was read from. */
  expectedMain: CommitSha;
  /** SHA-256 of the trusted definition's bytes. */
  digest: string;
}

/** Where an attempt stands. */
export type AttemptState =
  /** A protected path was edited; no run was started and none will be. */
  | { kind: "held"; paths: string[] }
  /** A slot was admitted and the run asked for. */
  | { kind: "started"; sandbox: string; deadline: number }
  /** The run reported. `log` is untrusted output. */
  | {
      kind: "reported";
      result: CheckResult;
      log: string;
      logDigest: string;
      finishedAt: number;
    };

/** One stored attempt. */
export interface AttemptRecord extends AttemptIdentity {
  /** Where it stands. */
  state: AttemptState;
}

interface AttemptRow extends Record<string, SqlStorageValue> {
  attempt_id: string;
  candidate: string;
  expected_main: string;
  digest: string;
  state: string;
  held_paths: string | null;
  sandbox: string | null;
  deadline: number | null;
  result: string | null;
  log: string | null;
  log_digest: string | null;
  finished_at: number | null;
}

/** The attempts of one repository, in its storage. */
export class AttemptTable {
  readonly #storage: RepoStorage;

  constructor(storage: RepoStorage) {
    migrate(storage, OWNER, MIGRATIONS);
    this.#storage = storage;
  }

  /** The attempt, or `null`. */
  get(attemptId: string): AttemptRecord | null {
    const row = this.#storage.sql
      .exec<AttemptRow>("SELECT * FROM check_attempts WHERE attempt_id = ?", attemptId)
      .toArray()[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Records a held attempt, unless the attempt is already stored. Returns the stored attempt, which
   * may be another state or identity if one was recorded first.
   */
  hold(identity: AttemptIdentity, paths: string[], now: number): AttemptRecord {
    return this.#insert(identity, now, "held", JSON.stringify(paths), null, null);
  }

  /** Records a started attempt in `sandbox` until `deadline`, unless the attempt is already stored. */
  start(identity: AttemptIdentity, sandbox: string, deadline: number, now: number): AttemptRecord {
    return this.#insert(identity, now, "started", null, sandbox, deadline);
  }

  /**
   * Records the report of a started attempt and returns it, or returns the stored attempt unchanged
   * when it is not started. `log` is cut to its last `MAX_CHECK_LOG_BYTES` before it is stored and
   * `logDigest` must be the SHA-256 of what is kept.
   */
  report(
    attemptId: string,
    result: CheckResult,
    log: string,
    logDigest: string,
    finishedAt: number,
    now: number,
  ): AttemptRecord | null {
    return atomically(this.#storage, () => {
      this.#storage.sql.exec(
        `UPDATE check_attempts
           SET state = 'reported', result = ?, log = ?, log_digest = ?, finished_at = ?,
               updated_at = ?
         WHERE attempt_id = ? AND state = 'started'`,
        result,
        log,
        logDigest,
        finishedAt,
        now,
        attemptId,
      );
      return this.get(attemptId);
    });
  }

  #insert(
    identity: AttemptIdentity,
    now: number,
    state: "held" | "started",
    heldPaths: string | null,
    sandbox: string | null,
    deadline: number | null,
  ): AttemptRecord {
    return atomically(this.#storage, () => {
      const existing = this.get(identity.attemptId);
      if (existing !== null) return existing;
      this.#prune(now);
      this.#storage.sql.exec(
        `INSERT INTO check_attempts
           (attempt_id, candidate, expected_main, digest, state, held_paths, sandbox, deadline,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        identity.attemptId,
        identity.candidate,
        identity.expectedMain,
        identity.digest,
        state,
        heldPaths,
        sandbox,
        deadline,
        now,
        now,
      );
      const inserted = this.get(identity.attemptId);
      if (inserted === null) throw new Error("inserted check attempt is missing");
      return inserted;
    });
  }

  // Makes room for one more row: removes the oldest settled attempts beyond the bound. A started
  // attempt whose report could still arrive is never removed, so that report finds it.
  #prune(now: number): void {
    const row = this.#storage.sql
      .exec<{ n: number }>("SELECT COUNT(*) AS n FROM check_attempts")
      .one();
    const excess = row.n - MAX_STORED_ATTEMPTS + 1;
    if (excess <= 0) return;
    this.#storage.sql.exec(
      `DELETE FROM check_attempts WHERE attempt_id IN (
         SELECT attempt_id FROM check_attempts
         WHERE state != 'started' OR deadline <= ?
         ORDER BY updated_at, attempt_id LIMIT ?)`,
      now - REPORT_GRACE_MS,
      excess,
    );
  }
}

/**
 * `log` cut to at most its last `MAX_CHECK_LOG_BYTES` bytes of UTF-8. A character split at the cut
 * is left out whole, so the result never grows past the cap by decoding its remains.
 */
export function boundedLog(log: string): string {
  const bytes = new TextEncoder().encode(log);
  if (bytes.byteLength <= MAX_CHECK_LOG_BYTES) return log;
  let start = bytes.byteLength - MAX_CHECK_LOG_BYTES;
  // Continuation bytes (0b10xxxxxx) at the cut belong to a character that starts before it.
  while (((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

function toRecord(row: AttemptRow): AttemptRecord {
  return {
    attemptId: row.attempt_id,
    candidate: row.candidate,
    expectedMain: row.expected_main,
    digest: row.digest,
    state: toState(row),
  };
}

function toState(row: AttemptRow): AttemptState {
  switch (row.state) {
    case "held":
      return { kind: "held", paths: parsePaths(row.held_paths) };
    case "started":
      if (row.sandbox === null || row.deadline === null) break;
      return { kind: "started", sandbox: row.sandbox, deadline: row.deadline };
    case "reported": {
      const result = parseResult(row.result);
      if (result === null || row.log === null || row.log_digest === null) break;
      if (row.finished_at === null) break;
      return {
        kind: "reported",
        result,
        log: row.log,
        logDigest: row.log_digest,
        finishedAt: row.finished_at,
      };
    }
    default:
      break;
  }
  throw new Error("stored check attempt is not valid");
}

function parsePaths(value: string | null): string[] {
  const parsed: unknown = value === null ? null : JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((path) => typeof path === "string")) {
    throw new Error("stored held paths are not valid");
  }
  return parsed;
}

function parseResult(value: string | null): CheckResult | null {
  switch (value) {
    case "pass":
    case "fail":
    case "error":
      return value;
    default:
      return null;
  }
}
