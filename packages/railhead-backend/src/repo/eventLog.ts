// A repository's append-only event log, kept in its `Repo` Durable Object's SQLite storage.
//
// Every event is appended inside a transaction together with the state change it records, so the
// two commit or roll back as one: a rolled-back transaction leaves no event, consumes no sequence
// number and returns nothing to publish. Sequence numbers start at 1 and have no gaps, because each
// is the previous one plus one inside the same transaction that writes it, and the row's primary
// key refuses a second event at the same number.
//
// Readers fetch the log in bounded pages from a cursor (the last sequence number they hold), so a
// reader that was disconnected, or a `Repo` that was evicted, resumes from storage rather than
// from anything held in memory.
//
// Observers registered with `observe` hear the new head after each commit that appended events. An
// observation is only a wake-up: it carries no events, and an observer reads them from storage.

import {
  eventVersion,
  isReadableVersion,
  isId,
  REOPEN_REASON_BEFORE_REASONS,
  validateEvent,
  type Actor,
  type EventPayload,
  type RailheadEvent,
  type RepoId,
} from "@railhead/shared/events";
import { atomically, migrate, type RepoStorage, type Synchronous } from "./storage";

/** The migration owner name of the event log's tables. */
export const EVENT_LOG_OWNER = "event_log";

/** Released schema steps of the event log. Append a step to change the schema; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE events (
    seq INTEGER PRIMARY KEY CHECK (seq > 0),
    body TEXT NOT NULL
  ) STRICT`,
  // The head is kept apart from the events, so losing the last event is a detectable gap rather
  // than a shorter log.
  `CREATE TABLE event_head (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seq INTEGER NOT NULL CHECK (seq >= 0)
  ) STRICT`,
  "INSERT INTO event_head (id, seq) SELECT 1, COALESCE(MAX(seq), 0) FROM events",
];

/** Most events one replay page may request. */
export const MAX_REPLAY_EVENTS = 256;

/**
 * Most JSON, in UTF-16 code units, one replay page returns. A page stops before the event that
 * would cross it, but always holds at least one event so a reader can make progress.
 */
export const MAX_REPLAY_JSON_LENGTH = 1024 * 1024;

/** Why the event log refused an operation. */
export type EventLogErrorCode =
  /** The repository id the log was opened with is not a repository identifier. */
  | "invalid_repo"
  /** An appended event breaks an invariant `validateEvent` checks. */
  | "invalid_event"
  /** A transaction was started inside another, or an append ran outside its transaction. */
  | "invalid_transaction"
  /** A replay cursor or limit is not a valid integer for its position. */
  | "invalid_request"
  /** A replay asked for more than `MAX_REPLAY_EVENTS` events. */
  | "replay_too_large"
  /** A replay cursor is past the last event, so the reader holds events this log never wrote. */
  | "cursor_ahead"
  /** A stored row cannot be read: a gap, a mismatched sequence or an unsupported version. */
  | "corrupt_log";

/** A refused event log operation. Nothing was written. */
export class EventLogError extends Error {
  /** Which refusal this is. */
  readonly code: EventLogErrorCode;

  constructor(code: EventLogErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EventLogError";
    this.code = code;
  }
}

/** What a transaction body can do: write state, and append the events recording it. */
export interface EventTransaction {
  /** The repository's SQLite storage, for the state change. The events table is written only by `append`. */
  readonly sql: SqlStorage;
  /**
   * Validates one event and appends it at the next sequence number. Throws `EventLogError` with
   * `invalid_event` when the event breaks an invariant; the body should let that throw roll the
   * whole transaction back.
   */
  append(actor: Actor, payload: EventPayload): RailheadEvent;
}

/** The result of a committed transaction, with the events it appended in order. */
export interface Committed<T> {
  /** What the transaction body returned. */
  value: T;
  /** The events appended, which a caller may now publish. Empty when the body appended none. */
  events: RailheadEvent[];
}

/** One page of the log. */
export interface ReplayPage {
  /** Events after the requested cursor, in sequence order with no gaps. */
  events: RailheadEvent[];
  /** The sequence number of the last event in the log when the page was read; 0 when it is empty. */
  head: number;
}

/** Hears the head after a commit that appended events. It must not throw or start a transaction. */
export type CommitObserver = (head: number) => void;

// Keyed by storage rather than by log, so a commit through any `EventLog` opened on a repository's
// storage wakes every observer of that repository.
const observers = new WeakMap<RepoStorage, Set<CommitObserver>>();

/** One repository's event log. Open it with `EventLog.open`. */
export class EventLog {
  readonly #storage: RepoStorage;
  readonly #repo: RepoId;
  readonly #clock: () => number;
  #inTransaction = false;

  private constructor(storage: RepoStorage, repo: RepoId, clock: () => number) {
    this.#storage = storage;
    this.#repo = repo;
    this.#clock = clock;
  }

  /**
   * Opens the log of `repo` in `storage`, creating or migrating its table first. `clock` gives the
   * time recorded on each event, in milliseconds since the Unix epoch.
   */
  static open(storage: RepoStorage, repo: RepoId, clock: () => number = Date.now): EventLog {
    if (!isId("repo", repo)) {
      throw new EventLogError("invalid_repo", "the event log needs a repository identifier");
    }
    migrate(storage, EVENT_LOG_OWNER, MIGRATIONS);
    return new EventLog(storage, repo, clock);
  }

  /** The sequence number of the last committed event, or 0 when the log is empty. */
  head(): number {
    const rows = this.#storage.sql
      .exec<{ seq: number }>("SELECT seq FROM event_head WHERE id = 1")
      .toArray();
    const row = rows[0];
    if (row === undefined) throw new EventLogError("corrupt_log", "the log has lost its head");
    return row.seq;
  }

  /**
   * Calls `observer` with the new head after every later commit that appended events, never inside
   * the transaction and never for a rollback. Returns the function that stops the observation.
   */
  observe(observer: CommitObserver): () => void {
    let set = observers.get(this.#storage);
    if (set === undefined) {
      set = new Set();
      observers.set(this.#storage, set);
    }
    // A fresh wrapper per call, so observing twice with one function is two observations.
    const entry: CommitObserver = (head) => observer(head);
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  /**
   * Runs `body` as one transaction in which it may change state and append events. If `body`
   * throws, its state changes and events are rolled back and the error is rethrown. `body` must not
   * await, and must not keep its `EventTransaction` beyond its return.
   */
  transaction<T>(body: (tx: EventTransaction) => Synchronous<T>): Committed<Synchronous<T>> {
    if (this.#inTransaction) {
      throw new EventLogError("invalid_transaction", "a transaction cannot start inside another");
    }
    const events: RailheadEvent[] = [];
    let open = true;
    let next = 0;
    const tx: EventTransaction = {
      sql: this.#storage.sql,
      append: (actor, payload) => {
        if (!open) {
          throw new EventLogError("invalid_transaction", "the transaction has already ended");
        }
        if (next === 0) next = this.head() + 1;
        const event = this.#append(next, actor, payload);
        next += 1;
        events.push(event);
        return event;
      },
    };
    this.#inTransaction = true;
    let value: Synchronous<T>;
    try {
      value = atomically(this.#storage, () => body(tx));
    } finally {
      open = false;
      this.#inTransaction = false;
    }
    const last = events.at(-1);
    if (last !== undefined) this.#notify(last.seq);
    return { value, events };
  }

  /**
   * Returns up to `limit` events after sequence number `after`, which is 0 to read from the start.
   * A page may hold fewer than `limit` events, bounded by `MAX_REPLAY_JSON_LENGTH`; the reader
   * continues from the last sequence number it received until it reaches `head`.
   */
  replay(after: number, limit: number): ReplayPage {
    if (!Number.isSafeInteger(after) || after < 0) {
      throw new EventLogError(
        "invalid_request",
        "the replay cursor must be a non-negative integer",
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new EventLogError("invalid_request", "the replay limit must be a positive integer");
    }
    if (limit > MAX_REPLAY_EVENTS) {
      throw new EventLogError(
        "replay_too_large",
        `a replay page holds at most ${MAX_REPLAY_EVENTS} events`,
      );
    }
    // One transaction so the page and the head describe the same moment.
    return atomically(this.#storage, () => {
      const head = this.head();
      if (after > head) {
        throw new EventLogError("cursor_ahead", `the replay cursor ${after} is past the log head`);
      }
      const rows = this.#storage.sql
        .exec<{ seq: number; body: string }>(
          "SELECT seq, body FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
          after,
          head,
          limit,
        )
        .toArray();
      const events: RailheadEvent[] = [];
      let length = 0;
      let full = rows.length === limit;
      for (const row of rows) {
        const expected = after + events.length + 1;
        if (row.seq !== expected) {
          throw new EventLogError("corrupt_log", `the log has a gap before sequence ${expected}`);
        }
        length += row.body.length;
        if (events.length > 0 && length > MAX_REPLAY_JSON_LENGTH) {
          full = true;
          break;
        }
        events.push(readStoredEvent(row.seq, row.body));
      }
      // A page that is neither at its limit nor its budget must reach the head.
      const reached = after + events.length;
      if (!full && reached < head) {
        throw new EventLogError("corrupt_log", `the log has a gap before sequence ${reached + 1}`);
      }
      return { events, head };
    });
  }

  // The transaction has committed, so an observer's failure must not reach the caller as if it
  // had not: it is reported by name only and the remaining observers still run.
  #notify(head: number): void {
    for (const observer of observers.get(this.#storage) ?? []) {
      try {
        observer(head);
      } catch (error) {
        console.error("event log observer failed", error instanceof Error ? error.name : "unknown");
      }
    }
  }

  #append(seq: number, actor: Actor, payload: EventPayload): RailheadEvent {
    const event: RailheadEvent = {
      v: eventVersion(payload.type),
      seq,
      at: this.#clock(),
      repo: this.#repo,
      actor,
      ...payload,
    };
    try {
      validateEvent(event);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "unknown reason";
      throw new EventLogError("invalid_event", `${payload.type} was refused: ${reason}`, {
        cause: error,
      });
    }
    this.#storage.sql.exec(
      "INSERT INTO events (seq, body) VALUES (?, ?)",
      seq,
      JSON.stringify(event),
    );
    this.#storage.sql.exec("UPDATE event_head SET seq = ? WHERE id = 1", seq);
    return event;
  }
}

/**
 * Reads one stored row. Rows are written only by `EventLog.append`, after `validateEvent`, so a row
 * is trusted as the event it was written as; these checks catch a row this code cannot read. A
 * `claim.reopened` appended before reopen reasons existed gets `REOPEN_REASON_BEFORE_REASONS`, so
 * every reader receives the current shape.
 */
function readStoredEvent(seq: number, body: string): RailheadEvent {
  const event: RailheadEvent = JSON.parse(body);
  if (event.seq !== seq) {
    throw new EventLogError("corrupt_log", `the row at sequence ${seq} holds another sequence`);
  }
  if (!isReadableVersion(event.v)) {
    throw new EventLogError(
      "corrupt_log",
      `the event at sequence ${seq} has unsupported schema version ${event.v}`,
    );
  }
  if (event.type === "claim.reopened" && !Object.hasOwn(event.data, "reason")) {
    return { ...event, data: { ...event.data, reason: REOPEN_REASON_BEFORE_REASONS } };
  }
  return event;
}
