// Admission: the bound on how many sandboxes one repository runs at once, and the record of each.
//
// The platform offers no cap on Durable Object-managed containers and stops an idle one only after
// its object has gone uncontacted for a while (#12), so the backend counts sandboxes itself and
// tears each one down explicitly. Every sandbox holds a slot from admission until a teardown is
// confirmed. A start, command or teardown whose outcome is unknown leaves the slot `uncertain`: it
// still counts against the bound, so an unconfirmed sandbox is never forgotten while it may run.
//
// Slot changes are written before the I/O they describe, so a request interleaved at an `await`
// sees the slot already taken.

import { fail, ok, type PortResult } from "../contracts/result";
import { atomically, migrate, type RepoStorage } from "../repo/storage";
import { parseSandboxPolicy, type SandboxPolicy } from "./policy";

/** Sandboxes one repository may hold at once, uncertain ones included. */
export const MAX_ACTIVE_SANDBOXES = 4;

/** Attempts that may wait for a slot. Beyond this, admission is refused with `busy`. */
export const MAX_QUEUED_ATTEMPTS = 16;

/**
 * How long a queued attempt keeps its place without asking again. A waiting attempt asks again
 * more often than this; one that stopped asking is dropped so it cannot block the queue.
 */
export const QUEUED_ATTEMPT_TTL_MS = 2 * 60_000;

/** The longest lifetime a sandbox may be admitted for. */
export const MAX_SANDBOX_LIFETIME_MS = 30 * 60_000;

/** The shortest lifetime a sandbox may be admitted for. */
export const MIN_SANDBOX_LIFETIME_MS = 10_000;

/** An attempt that asks for a sandbox: a prefixed identifier such as a check run's `chk_…`. */
export type SandboxAttemptId = string;

const ATTEMPT_ID = /^[a-z]{3}_[A-Za-z0-9]{6,64}$/;

/** Where a slot stands. */
export type SlotState =
  /** Waiting for a free slot. Holds no sandbox. */
  | "queued"
  /** Admitted; its sandbox is starting. */
  | "starting"
  /** Its sandbox is running and accepts commands until `deadline`. */
  | "running"
  /** Its sandbox is being destroyed. */
  | "releasing"
  /** A start, command or teardown did not confirm. The sandbox may still run; release it again. */
  | "uncertain";

/** Why a slot became uncertain. */
export type UncertainReason = "start_failed" | "command_timeout" | "destroy_failed";

/** One attempt's slot. */
export interface SlotRecord {
  /** The attempt. */
  attemptId: SandboxAttemptId;
  /** The sandbox's Durable Object name. */
  sandbox: string;
  /** Where it stands. */
  state: SlotState;
  /** Why it is uncertain, or `null`. */
  reason: UncertainReason | null;
  /** The network policy its sandbox runs under. */
  policy: SandboxPolicy;
  /** How long its sandbox may live once running. */
  lifetimeMs: number;
  /** When it was requested. */
  requestedAt: number;
  /** When its sandbox must be gone, or `null` while it is queued. */
  deadline: number | null;
}

/** The result of asking for a slot. */
export type Admission =
  /** The attempt holds a slot; its sandbox must be started. */
  | { kind: "admitted"; slot: SlotRecord }
  /** The attempt already held a running sandbox. */
  | { kind: "running"; slot: SlotRecord }
  /** Every slot is taken; the attempt waits at `position` (1 is next). Ask again later. */
  | { kind: "queued"; position: number };

const OWNER = "sandbox";

/** Released schema steps of the sandbox module's table. Append a step to change it. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE sandbox_slots (
    attempt_id TEXT PRIMARY KEY,
    sandbox TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'releasing', 'uncertain')),
    reason TEXT CHECK (reason IN ('start_failed', 'command_timeout', 'destroy_failed')),
    policy TEXT NOT NULL,
    lifetime_ms INTEGER NOT NULL,
    requested_at INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    deadline INTEGER
  ) STRICT`,
];

interface SlotRow extends Record<string, SqlStorageValue> {
  attempt_id: string;
  sandbox: string;
  state: string;
  reason: string | null;
  policy: string;
  lifetime_ms: number;
  requested_at: number;
  deadline: number | null;
}

/** The slots of one repository, in its storage. */
export class SlotTable {
  readonly #storage: RepoStorage;
  readonly #repoId: string;

  constructor(storage: RepoStorage, repoId: string) {
    migrate(storage, OWNER, MIGRATIONS);
    this.#storage = storage;
    this.#repoId = repoId;
  }

  /** Every slot, oldest request first. */
  list(): SlotRecord[] {
    return this.#rows("SELECT * FROM sandbox_slots ORDER BY seq");
  }

  /** The attempt's slot, or `null`. */
  get(attemptId: string): SlotRecord | null {
    return this.#rows("SELECT * FROM sandbox_slots WHERE attempt_id = ?", attemptId)[0] ?? null;
  }

  /**
   * Admits an attempt, queues it, or refuses it. A repeat for an attempt already admitted or
   * queued keeps its place; a repeat with another policy or lifetime is refused.
   */
  admit(
    attemptId: string,
    policyInput: unknown,
    lifetimeMs: number,
    now: number,
  ): PortResult<Admission> {
    if (!ATTEMPT_ID.test(attemptId)) {
      return fail("invalid_request", "The attempt must be a prefixed identifier.");
    }
    const policy = parseSandboxPolicy(policyInput);
    if (policy === null) return fail("invalid_request", "The sandbox policy is not valid.");
    if (
      !Number.isSafeInteger(lifetimeMs) ||
      lifetimeMs < MIN_SANDBOX_LIFETIME_MS ||
      lifetimeMs > MAX_SANDBOX_LIFETIME_MS
    ) {
      return fail(
        "invalid_request",
        `The lifetime must be from ${MIN_SANDBOX_LIFETIME_MS} to ${MAX_SANDBOX_LIFETIME_MS} ms.`,
      );
    }
    return atomically(this.#storage, () => {
      this.#storage.sql.exec(
        "DELETE FROM sandbox_slots WHERE state = 'queued' AND seen_at <= ?",
        now - QUEUED_ATTEMPT_TTL_MS,
      );
      this.#storage.sql.exec(
        "UPDATE sandbox_slots SET seen_at = ? WHERE attempt_id = ?",
        now,
        attemptId,
      );
      const existing = this.get(attemptId);
      if (existing !== null) {
        if (
          existing.lifetimeMs !== lifetimeMs ||
          JSON.stringify(existing.policy) !== JSON.stringify(policy)
        ) {
          return fail("invalid_request", "This attempt was admitted with another policy.");
        }
        switch (existing.state) {
          case "queued":
            return this.#promote(existing, now);
          case "running":
            return ok({ kind: "running", slot: existing });
          case "starting":
          case "releasing":
          case "uncertain":
            return fail("busy", "This attempt's sandbox is changing state or unconfirmed.");
          default:
            return unreachable(existing.state);
        }
      }
      const queued = this.#count("state = 'queued'");
      if (queued >= MAX_QUEUED_ATTEMPTS) {
        return fail("busy", "Every sandbox slot is taken and the queue is full.");
      }
      const seq = this.#nextSeq();
      this.#storage.sql.exec(
        `INSERT INTO sandbox_slots
           (attempt_id, sandbox, state, reason, policy, lifetime_ms, requested_at, seq, seen_at, deadline)
         VALUES (?, ?, 'queued', NULL, ?, ?, ?, ?, ?, NULL)`,
        attemptId,
        `${this.#repoId}.${attemptId}`.toLowerCase(),
        JSON.stringify(policy),
        lifetimeMs,
        now,
        seq,
        now,
      );
      const slot = this.get(attemptId);
      if (slot === null) throw new Error("inserted slot is missing");
      return this.#promote(slot, now);
    });
  }

  /** Marks a starting sandbox running until its deadline. */
  started(attemptId: string, now: number): SlotRecord | null {
    return this.#move(attemptId, ["starting"], "running", null, (slot) => now + slot.lifetimeMs);
  }

  /** Marks a sandbox whose start, command or teardown did not confirm. Its slot stays held. */
  uncertain(attemptId: string, reason: UncertainReason): SlotRecord | null {
    return this.#move(attemptId, ["starting", "running", "releasing"], "uncertain", reason);
  }

  /**
   * Begins a teardown: a queued attempt is removed at once (it holds no sandbox) and `null` is
   * returned; any other slot moves to `releasing` and is returned for its sandbox to be destroyed.
   */
  beginRelease(attemptId: string): SlotRecord | null {
    return atomically(this.#storage, () => {
      const slot = this.get(attemptId);
      if (slot === null) return null;
      if (slot.state === "queued") {
        this.#storage.sql.exec("DELETE FROM sandbox_slots WHERE attempt_id = ?", attemptId);
        return null;
      }
      return this.#move(attemptId, ["starting", "running", "releasing", "uncertain"], "releasing");
    });
  }

  /** Frees a slot once its sandbox is confirmed destroyed. */
  released(attemptId: string): void {
    this.#storage.sql.exec(
      "DELETE FROM sandbox_slots WHERE attempt_id = ? AND state = 'releasing'",
      attemptId,
    );
  }

  /** Running sandboxes past their deadline, which must be torn down. */
  expired(now: number): SlotRecord[] {
    return this.#rows(
      "SELECT * FROM sandbox_slots WHERE state = 'running' AND deadline <= ? ORDER BY seq",
      now,
    );
  }

  // Admits `slot` if a slot is free and nothing queued before it; otherwise reports its position.
  #promote(slot: SlotRecord, now: number): PortResult<Admission> {
    const ahead = this.#rows(
      "SELECT * FROM sandbox_slots WHERE state = 'queued' AND seq < (SELECT seq FROM sandbox_slots WHERE attempt_id = ?)",
      slot.attemptId,
    ).length;
    const active = this.#count("state != 'queued'");
    if (ahead > 0 || active >= MAX_ACTIVE_SANDBOXES) {
      return ok({ kind: "queued", position: ahead + 1 });
    }
    const admitted = this.#move(
      slot.attemptId,
      ["queued"],
      "starting",
      null,
      () => now + slot.lifetimeMs,
    );
    if (admitted === null) throw new Error("queued slot vanished during admission");
    return ok({ kind: "admitted", slot: admitted });
  }

  #move(
    attemptId: string,
    from: readonly SlotState[],
    to: SlotState,
    reason: UncertainReason | null = null,
    deadline?: (slot: SlotRecord) => number,
  ): SlotRecord | null {
    const slot = this.get(attemptId);
    if (slot === null || !from.includes(slot.state)) return null;
    this.#storage.sql.exec(
      "UPDATE sandbox_slots SET state = ?, reason = ?, deadline = ? WHERE attempt_id = ?",
      to,
      reason,
      deadline === undefined ? slot.deadline : deadline(slot),
      attemptId,
    );
    return this.get(attemptId);
  }

  #count(where: string): number {
    const row = this.#storage.sql
      .exec<{ n: number }>(`SELECT COUNT(*) AS n FROM sandbox_slots WHERE ${where}`)
      .one();
    return row.n;
  }

  #nextSeq(): number {
    const row = this.#storage.sql
      .exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM sandbox_slots")
      .one();
    return (row.seq ?? 0) + 1;
  }

  #rows(query: string, ...bindings: SqlStorageValue[]): SlotRecord[] {
    return this.#storage.sql
      .exec<SlotRow>(query, ...bindings)
      .toArray()
      .map(toRecord);
  }
}

function toRecord(row: SlotRow): SlotRecord {
  const policy = parseSandboxPolicy(JSON.parse(row.policy));
  if (policy === null) throw new Error("stored sandbox policy is not valid");
  return {
    attemptId: row.attempt_id,
    sandbox: row.sandbox,
    state: parseState(row.state),
    reason: parseReason(row.reason),
    policy,
    lifetimeMs: row.lifetime_ms,
    requestedAt: row.requested_at,
    deadline: row.deadline,
  };
}

function parseState(value: string): SlotState {
  switch (value) {
    case "queued":
    case "starting":
    case "running":
    case "releasing":
    case "uncertain":
      return value;
    default:
      throw new Error("stored slot state is not valid");
  }
}

function parseReason(value: string | null): UncertainReason | null {
  switch (value) {
    case null:
    case "start_failed":
    case "command_timeout":
    case "destroy_failed":
      return value;
    default:
      throw new Error("stored slot reason is not valid");
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled slot state: ${String(value)}`);
}
