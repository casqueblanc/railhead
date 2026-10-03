// Transactions and schema migrations over a `Repo` Durable Object's SQLite storage.
//
// Each feature that keeps tables in the repository's storage owns their migrations and runs them
// through `migrate` under its own name, so features never edit a shared schema file. Every write
// that must be atomic with another goes through `atomically`: SQLite-backed Durable Objects reject
// `BEGIN` statements, and `transactionSync` is the only way to group writes.

/** The part of a Durable Object's storage this module uses. A `Repo` passes `ctx.storage`. */
export type RepoStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

/** The part of a Durable Object's storage that holds its one alarm. */
export type AlarmStorage = Pick<DurableObjectStorage, "getAlarm" | "setAlarm">;

/**
 * Sets the object's one alarm to `at` unless it is already set earlier, so one module's wake
 * never delays another's. A module woken before its own time asks again from its `resume`.
 */
export async function wakeNoLaterThan(storage: AlarmStorage, at: number): Promise<void> {
  const current = await storage.getAlarm();
  if (current === null || at < current) await storage.setAlarm(at);
}

/** Why a storage operation was refused. */
export type StorageErrorCode =
  /** A migration owner's name is not a lowercase identifier. */
  | "invalid_owner"
  /** The stored schema is newer than the code reading it, so the code must not touch it. */
  | "schema_ahead";

/** A refused storage operation. Nothing was written. */
export class StorageError extends Error {
  /** Which refusal this is. */
  readonly code: StorageErrorCode;

  constructor(code: StorageErrorCode, message: string) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

/** A value `atomically` may return: anything but a promise, since the transaction is synchronous. */
export type Synchronous<T> = T extends PromiseLike<unknown> ? never : T;

/**
 * Runs `body` as one SQLite transaction and returns its result. If `body` throws, every write it
 * made is rolled back and the error is rethrown. `body` must not await: the transaction commits
 * when it returns.
 */
export function atomically<T>(storage: RepoStorage, body: () => Synchronous<T>): Synchronous<T> {
  return storage.transactionSync(body);
}

const MIGRATIONS_TABLE = "railhead_migrations";
const OWNER = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * Brings `owner`'s tables up to date by running, in order, each statement of `steps` not yet
 * applied, all in one transaction. A step is never edited once released: a schema change is a new
 * step at the end. Returns the number of steps applied now.
 *
 * Throws `StorageError` with `schema_ahead` when storage records more steps than `steps` holds,
 * which means older code is reading a newer schema.
 */
export function migrate(storage: RepoStorage, owner: string, steps: readonly string[]): number {
  if (!OWNER.test(owner)) {
    throw new StorageError("invalid_owner", "migration owner is not a lowercase identifier");
  }
  return atomically(storage, () => {
    storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        owner TEXT PRIMARY KEY,
        version INTEGER NOT NULL
      ) STRICT`,
    );
    const applied = appliedVersion(storage, owner);
    if (applied > steps.length) {
      throw new StorageError(
        "schema_ahead",
        `${owner} schema is at version ${applied}, newer than the ${steps.length} steps known here`,
      );
    }
    const pending = steps.slice(applied);
    for (const step of pending) storage.sql.exec(step);
    if (pending.length > 0) {
      storage.sql.exec(
        `INSERT INTO ${MIGRATIONS_TABLE} (owner, version) VALUES (?, ?)
         ON CONFLICT (owner) DO UPDATE SET version = excluded.version`,
        owner,
        steps.length,
      );
    }
    return pending.length;
  });
}

function appliedVersion(storage: RepoStorage, owner: string): number {
  const rows = storage.sql
    .exec<{ version: number }>(`SELECT version FROM ${MIGRATIONS_TABLE} WHERE owner = ?`, owner)
    .toArray();
  return rows[0]?.version ?? 0;
}
