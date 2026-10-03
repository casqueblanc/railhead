// The demo repository's side of the seed: it runs inside the `Repo` named `demo/upload-app` and
// is reached only after the control object has verified the owner's passkey for the action.
//
// Seed is reconciliation. It reads main from Artifacts first: main at the requested head is done,
// main at any other head is refused, and only a missing main is pushed. A push whose outcome is
// unknown is settled by reading main again, never by pushing twice. The Repo is initialized last,
// so the board shows the repository only once its main is in place; a seed that failed partway
// finishes on the next run. An initialized Repo is never pushed to: if its main is missing or
// empty, a reset failed partway, and the seed is refused until a reset finishes.
//
// Reset deletes, by exact name, every fork the Repo's Artifacts table recorded, then the main
// Artifacts repository, then the Repo's own storage. It never lists the namespace to choose what to
// delete. A failed deletion stops the reset before the Repo's storage is wiped, so the fork names
// stay readable and the next reset finishes the job; since main goes last, a reset that stopped
// early leaves main in place.
//
// One seed or reset runs at a time per object; a second is refused as busy. A binding call that
// changes Artifacts (create, token mint, delete) is recorded in storage before it starts, and a
// timeout does not settle it: every later seed and reset is refused as busy until the call answers,
// so a create that lands late cannot follow a reset that reported success. A late handle is
// disposed and a late token revoked. A create or mint record also stands for the token it may have
// left: the seed sweeps main's tokens before it initializes the Repo, on a retry that finds main
// already in place as well, and clears the record only once no live token is left. Tokens stay in
// this module and are never logged or returned.

import type { DemoSeedResult, DemoSeedState } from "@railhead/shared/board-api";
import { isCommitSha, type CommitSha, type RepoId } from "@railhead/shared/events";
import { mainRepoName } from "../../artifacts/adapter";
import { fail, ok, type PortResult } from "../../contracts/result";
import { migrate, type RepoStorage } from "../../repo/storage";
import { pushMain, type PushOutcome } from "./receivePack";

/** The repository methods the seed calls. `ArtifactsRepo` satisfies it. */
export type SeedArtifactsRepo = Disposable &
  Pick<ArtifactsRepo, "info" | "log" | "createToken" | "listTokens" | "revokeToken">;

/** The namespace methods the seed calls. The `ARTIFACTS` binding satisfies it. */
export interface SeedArtifacts {
  /** Creates a repository; throws `ALREADY_EXISTS` when it exists. Its initial token is revoked. */
  create(name: string): Promise<unknown>;
  /** Opens a repository; throws `NOT_FOUND` when it does not exist. */
  get(name: string): Promise<SeedArtifactsRepo>;
  /** Deletes a repository; `false` when there was none. */
  delete(name: string): Promise<boolean>;
}

/** What the target receives from its `Repo`. */
export interface SeedTargetContext {
  /** The repository's identifier, the same before and after `initialize`. */
  readonly repoId: RepoId;
  /** The Repo's storage, read for the forks the Artifacts module recorded. */
  readonly storage: RepoStorage;
  /** The Artifacts namespace, or `undefined` when the Worker has no `ARTIFACTS` binding. */
  readonly artifacts: SeedArtifacts | undefined;
  /** Sends the push. */
  readonly fetch: typeof fetch;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly clock: () => number;
  /** Whether the Repo has been initialized. */
  initialized(): boolean;
  /** Initializes the Repo as `demo/upload-app`. */
  initialize(): PortResult<unknown>;
  /** Deletes all of the Repo's storage and forgets its modules. */
  wipe(): Promise<void>;
}

/** Limits a test may tighten. */
export interface SeedTargetLimits {
  /** How long one Artifacts binding call may take before it counts as lost. */
  readonly callTimeoutMs: number;
  /** How long the push may take. */
  readonly pushTimeoutMs: number;
  /**
   * How long after it started a binding call a previous incarnation left unanswered counts as
   * settled: the push token's lifetime and a minute of clock skew. How late a call can take effect
   * is not measured.
   */
  readonly orphanSettleMs: number;
}

/** The production limits. */
export const SEED_TARGET_LIMITS: SeedTargetLimits = {
  callTimeoutMs: 10_000,
  pushTimeoutMs: 60_000,
  orphanSettleMs: 360_000,
};

/** The lifetime of the token minted for a push into an existing, empty main repository. */
const PUSH_TOKEN_TTL_SECONDS = 300;

/** Most tokens one seed revokes on a main that has no history yet. */
const MAX_SWEPT_TOKENS = 32;

/** The demo repository's seed and reset. */
export interface SeedTarget {
  /** The repository, or `null` when it was never initialized. */
  read(): Promise<PortResult<DemoSeedState | null>>;
  /** Makes main hold `head` from `pack`, then initializes the Repo. */
  seed(head: CommitSha, pack: Uint8Array): Promise<PortResult<DemoSeedResult>>;
  /** Deletes the repository's Artifacts repositories and its storage. */
  reset(): Promise<PortResult<DemoSeedResult>>;
}

/** The migration owner name of the seed's own table. */
const SEED_OWNER = "demo_seed_target";

/** Released schema steps of the seed's own table. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE demo_seed_effects (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('create', 'mint', 'delete')),
    incarnation TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    answered INTEGER NOT NULL DEFAULT 0 CHECK (answered IN (0, 1))
  ) STRICT`,
];

/** A binding call that changes Artifacts, recorded before it starts. */
type EffectKind = "create" | "mint" | "delete";

/** Builds the seed target of the demo repository's `Repo`. */
export function createSeedTarget(
  context: SeedTargetContext,
  limits: SeedTargetLimits = SEED_TARGET_LIMITS,
): SeedTarget {
  const sql = context.storage.sql;
  // Tells this object's records from those a previous incarnation left.
  const incarnation = crypto.randomUUID();
  // Records whose call has not answered yet, timed out or not.
  const unanswered = new Set<number>();
  let running = false;

  /** Runs `work` unless another seed or reset is running. */
  async function exclusive<T>(work: () => Promise<PortResult<T>>): Promise<PortResult<T>> {
    if (running) return busy();
    running = true;
    try {
      return await work();
    } finally {
      running = false;
    }
  }

  /** Bounds one binding call that changes nothing; a late answer is dropped. */
  function bounded<T>(work: Promise<T>): Promise<T> {
    return within(work, limits.callTimeoutMs);
  }

  /** Opens `name`, bounded; a handle that opens after its timeout is disposed. */
  function opened(artifacts: SeedArtifacts, name: string): Promise<SeedArtifactsRepo> {
    return answered(
      () => artifacts.get(name),
      (late) => {
        late[Symbol.dispose]();
      },
    );
  }

  /** Settles with `call`'s answer, or rejects at the timeout; a later answer goes to `late`. */
  function answered<T>(
    call: () => Promise<T>,
    late: (value: T) => void | Promise<void>,
    settled: () => void = () => undefined,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let decided = false;
      const timer = setTimeout(() => {
        decided = true;
        reject(new Error("Artifacts call timed out"));
      }, limits.callTimeoutMs);
      Promise.resolve()
        .then(call)
        .then(
          async (value) => {
            if (!decided) {
              decided = true;
              clearTimeout(timer);
              settled();
              resolve(value);
              return;
            }
            try {
              await late(value);
            } catch {
              // Nobody waits for a late answer's cleanup; the effect record still demands it.
            }
            settled();
          },
          (error: unknown) => {
            settled();
            if (decided) return;
            decided = true;
            clearTimeout(timer);
            reject(error);
          },
        );
    });
  }

  /**
   * Runs one binding call that changes Artifacts. Its record is written before the call and stays
   * unanswered, refusing every later seed and reset, until the call answers, however long after
   * its timeout. A `delete` record is dropped then; a `create` or `mint` record stays until a sweep
   * of main's tokens follows it, since either can leave a live token behind.
   */
  function effect<T>(
    kind: EffectKind,
    call: () => Promise<T>,
    late: (value: T) => Promise<void> = async () => undefined,
  ): Promise<T> {
    const { id } = sql
      .exec<{ id: number }>(
        "INSERT INTO demo_seed_effects (kind, incarnation, started_at) VALUES (?, ?, ?) RETURNING id",
        kind,
        incarnation,
        context.clock(),
      )
      .one();
    unanswered.add(id);
    return answered(call, late, () => {
      unanswered.delete(id);
      if (kind === "delete") sql.exec("DELETE FROM demo_seed_effects WHERE id = ?", id);
      else sql.exec("UPDATE demo_seed_effects SET answered = 1 WHERE id = ?", id);
    });
  }

  /**
   * Whether an earlier binding call may still change Artifacts. A call of this incarnation is
   * waited for until it answers. One a previous incarnation started and never saw answered cannot
   * answer here, and
   * Artifacts offers no way to cancel it, so it counts as settled once `orphanSettleMs` has passed
   * since it started; a call that takes effect later than that is not covered.
   */
  function unresolved(): boolean {
    migrate(context.storage, SEED_OWNER, MIGRATIONS);
    if (unanswered.size > 0) return true;
    const horizon = context.clock() - limits.orphanSettleMs;
    sql.exec(
      `DELETE FROM demo_seed_effects
       WHERE kind = 'delete' AND incarnation != ? AND started_at <= ?`,
      incarnation,
      horizon,
    );
    return (
      sql
        .exec(
          `SELECT 1 FROM demo_seed_effects
           WHERE answered = 0 AND incarnation != ? AND started_at > ? LIMIT 1`,
          incarnation,
          horizon,
        )
        .toArray().length > 0
    );
  }

  /** Whether a create or mint on main may have left a token no sweep has revoked since. */
  function tokensOwed(): boolean {
    return (
      sql.exec("SELECT 1 FROM demo_seed_effects WHERE kind IN ('create', 'mint') LIMIT 1").toArray()
        .length > 0
    );
  }

  /** Main's head, `null` for a repository without one, or `missing` when there is no repository. */
  async function readMain(
    artifacts: SeedArtifacts,
    name: string,
  ): Promise<PortResult<CommitSha | null | "missing">> {
    try {
      using repo = await opened(artifacts, name);
      const [latest] = await bounded(repo.log({ limit: 1 }));
      if (latest === undefined) return ok(null);
      return isCommitSha(latest.hash) ? ok(latest.hash) : artifactsFailed();
    } catch (error) {
      if (artifactsCode(error) === "NOT_FOUND") return ok("missing");
      return artifactsFailed();
    }
  }

  /**
   * A remote and a short-lived write token for an empty main, creating the repository when it is
   * missing. Both calls are recorded first, so the tokens they leave are swept even if the seed
   * stops here.
   */
  async function writeAccess(
    artifacts: SeedArtifacts,
    name: string,
    exists: boolean,
  ): Promise<PortResult<{ remote: string; token: string }>> {
    if (!exists) {
      try {
        await effect("create", () => artifacts.create(name));
      } catch (error) {
        if (artifactsCode(error) !== "ALREADY_EXISTS") return artifactsFailed();
      }
    }
    try {
      using repo = await opened(artifacts, name);
      const { remote } = await bounded(repo.info());
      const minted = await effect(
        "mint",
        () => repo.createToken("write", PUSH_TOKEN_TTL_SECONDS),
        // A token minted after its timeout reached nobody; the sweep that follows covers a failure.
        async (late) => {
          using again = await opened(artifacts, name);
          await bounded(again.revokeToken(late.id));
        },
      );
      return ok({ remote, token: minted.plaintext });
    } catch {
      return artifactsFailed();
    }
  }

  /**
   * Revokes every live token on main, then lists again to confirm none is left. Clears the create
   * and mint records once main is clean. Tokens are owed only between a seed's create or mint and
   * the sweep that must precede initialization, and an initialized Repo is never created or minted
   * on, so while any are owed no other module holds a token on main: every one is the seed's.
   */
  async function sweepTokens(artifacts: SeedArtifacts, name: string): Promise<boolean> {
    try {
      using repo = await opened(artifacts, name);
      const live = async () =>
        (await bounded(repo.listTokens())).tokens.filter((token) => token.state === "active");
      const before = await live();
      if (before.length > MAX_SWEPT_TOKENS) return false;
      for (const token of before) await bounded(repo.revokeToken(token.id));
      if ((await live()).length > 0) return false;
    } catch (error) {
      // No repository holds no token.
      if (artifactsCode(error) !== "NOT_FOUND") return false;
    }
    sql.exec("DELETE FROM demo_seed_effects WHERE kind IN ('create', 'mint')");
    return true;
  }

  /** The fork names the Artifacts module recorded in this Repo, if its table exists. */
  function forkNames(): string[] {
    const table = sql
      .exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'artifacts_forks'")
      .toArray();
    if (table.length === 0) return [];
    return sql
      .exec<{ repo: string }>("SELECT repo FROM artifacts_forks ORDER BY repo")
      .toArray()
      .map((row) => row.repo);
  }

  return {
    async read() {
      if (!context.initialized()) return ok(null);
      const { artifacts } = context;
      if (artifacts === undefined) return noArtifacts();
      const main = await readMain(artifacts, await mainRepoName(context.repoId));
      if (!main.ok) return main;
      return ok({ repo: context.repoId, main: main.value === "missing" ? null : main.value });
    },

    seed(head, pack) {
      return exclusive(async () => {
        const { artifacts } = context;
        if (artifacts === undefined) return noArtifacts();
        if (unresolved()) return busy();
        const name = await mainRepoName(context.repoId);
        const before = await readMain(artifacts, name);
        if (!before.ok) return before;
        let outcome: PushOutcome | null = null;
        if (before.value !== head) {
          if (before.value !== null && before.value !== "missing") return otherHead();
          if (context.initialized()) return halfReset();
          const access = await writeAccess(artifacts, name, before.value !== "missing");
          if (!access.ok) return access;
          outcome = await pushMain(
            { ...access.value, head, pack },
            context.fetch,
            limits.pushTimeoutMs,
          );
        }
        // Every token a seed asked for is revoked before the Repo opens main to anyone, on a retry
        // that finds main already in place too. The records are cleared only by a clean sweep.
        const swept = !tokensOwed() || (await sweepTokens(artifacts, name));
        // Whatever the push reported, main as Artifacts now holds it is the answer.
        const after = outcome === null ? before : await readMain(artifacts, name);
        if (!after.ok) return after;
        if (after.value !== head) {
          return after.value === null || after.value === "missing"
            ? fail("internal", `The push did not create main (${outcome ?? "skipped"}); try again.`)
            : otherHead();
        }
        // The token expires within minutes, but a revocation that failed is still reported.
        if (!swept) {
          return fail(
            "internal",
            "Main was imported but its push token was not revoked; try again.",
          );
        }
        const initialized = context.initialize();
        if (!initialized.ok) return initialized;
        return ok({ kind: "demo.seed", repo: context.repoId, head });
      });
    },

    reset() {
      return exclusive(async () => {
        const { artifacts } = context;
        if (artifacts === undefined) return noArtifacts();
        if (unresolved()) return busy();
        // Main goes last, so a deletion that fails leaves it in place behind the forks.
        const names = [...forkNames(), await mainRepoName(context.repoId)];
        let deleted = context.initialized();
        for (const name of names) {
          try {
            if (await effect("delete", () => artifacts.delete(name))) deleted = true;
          } catch {
            return artifactsFailed();
          }
        }
        // Every call answered, and main and its forks are gone with their tokens: the wipe drops no
        // record that still matters.
        await context.wipe();
        return ok({ kind: "demo.reset", deleted });
      });
    },
  };
}

/** Reads the `ARTIFACTS` binding from `env` when the Worker declares one. */
export function artifactsBinding(env: Env): SeedArtifacts | undefined {
  const binding: unknown = Reflect.get(env, "ARTIFACTS");
  if (typeof binding !== "object" || binding === null) return undefined;
  const methods = ["create", "get", "delete"].map((method) => Reflect.get(binding, method));
  if (!methods.every((method) => typeof method === "function")) return undefined;
  return {
    create: (name) => Reflect.apply(Reflect.get(binding, "create"), binding, [name]),
    get: (name) => Reflect.apply(Reflect.get(binding, "get"), binding, [name]),
    delete: (name) => Reflect.apply(Reflect.get(binding, "delete"), binding, [name]),
  };
}

function noArtifacts(): PortResult<never> {
  return fail("unavailable", "This instance has no Artifacts binding.");
}

function busy(): PortResult<never> {
  return fail("internal", "An earlier seed or reset has not finished with Artifacts; try again.");
}

function otherHead(): PortResult<never> {
  return fail("action_stale", "The demo repository's main holds another head. Reset it first.");
}

function halfReset(): PortResult<never> {
  return fail(
    "action_stale",
    "The demo repository lost its main to a reset that did not finish. Reset it first.",
  );
}

function artifactsFailed(): PortResult<never> {
  return fail("internal", "Artifacts did not answer as expected; try again.");
}

/** Settles with `work`, or rejects once `ms` milliseconds pass. */
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Artifacts call timed out"));
    }, ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/** The `ArtifactsError` code of `error`, or `undefined` for any other error. */
function artifactsCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}
