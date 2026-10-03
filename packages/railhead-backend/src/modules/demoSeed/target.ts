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
// Reset deletes, by exact name, every fork the Artifacts adapter recorded in the Repo, then the main
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
import {
  ARTIFACTS_LIMITS,
  boundedCall,
  MINT_CLOCK_SKEW_MS,
  mainRepoName,
  recordedForks,
  revokeActiveTokens,
  type TokenSweepLimits,
} from "../../artifacts/adapter";
import { fail, ok, type PortResult } from "../../contracts/result";
import { migrate, type RepoStorage } from "../../repo/storage";
import { BUNDLE_REF } from "./bundle";
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
  /** The Repo's storage, where the Artifacts adapter records its forks. */
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

/** Limits a test may tighten. The token sweep is the Artifacts adapter's, with its limits. */
export interface SeedTargetLimits extends TokenSweepLimits {
  /** How long the push may take. */
  readonly pushTimeoutMs: number;
  /**
   * How long after it started a binding call a previous incarnation left unanswered counts as
   * settled. How late a call can take effect is not measured.
   */
  readonly orphanSettleMs: number;
  /** How long a read of main answers every later read, so unauthenticated reads stay bounded. */
  readonly readCacheMs: number;
}

/** The lifetime of the token minted for a push into an existing, empty main repository. */
const PUSH_TOKEN_TTL_SECONDS = 300;

/** The production limits. */
export const SEED_TARGET_LIMITS: SeedTargetLimits = {
  callTimeoutMs: ARTIFACTS_LIMITS.callTimeoutMs,
  sweepDeadlineMs: ARTIFACTS_LIMITS.sweepDeadlineMs,
  maxRevokesPerSweep: ARTIFACTS_LIMITS.maxRevokesPerSweep,
  pushTimeoutMs: 60_000,
  // The adapter's rule for a mint a previous incarnation never saw answered: its requested lifetime
  // and the clock skew.
  orphanSettleMs: PUSH_TOKEN_TTL_SECONDS * 1000 + MINT_CLOCK_SKEW_MS,
  readCacheMs: 5_000,
};

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
  // The last read of main and when it started. Anyone may read, so reads within `readCacheMs` of
  // it share its answer instead of calling Artifacts again; a seed or reset drops it.
  let lastRead: { at: number; result: Promise<PortResult<DemoSeedState | null>> } | null = null;

  /** Runs `work` unless another seed or reset is running. */
  async function exclusive<T>(work: () => Promise<PortResult<T>>): Promise<PortResult<T>> {
    if (running) return busy();
    running = true;
    try {
      return await work();
    } finally {
      running = false;
      lastRead = null;
    }
  }

  /** The repository as Artifacts holds it now. */
  async function readState(artifacts: SeedArtifacts): Promise<PortResult<DemoSeedState | null>> {
    const main = await readMain(artifacts, await mainRepoName(context.repoId));
    if (!main.ok) return main;
    return ok({ repo: context.repoId, main: main.value === "missing" ? null : main.value });
  }

  /** Bounds one binding call that changes nothing; a late answer is dropped. */
  function bounded<T>(work: Promise<T>): Promise<T> {
    return boundedCall(work, limits.callTimeoutMs);
  }

  /** Opens `name`, bounded; a handle that opens after its timeout is disposed. */
  function opened(artifacts: SeedArtifacts, name: string): Promise<SeedArtifactsRepo> {
    return boundedCall(artifacts.get(name), limits.callTimeoutMs, (pending) => {
      void pending.then(
        (late) => late[Symbol.dispose](),
        () => undefined,
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
    const settle = (): void => {
      unanswered.delete(id);
      if (kind === "delete") sql.exec("DELETE FROM demo_seed_effects WHERE id = ?", id);
      else sql.exec("UPDATE demo_seed_effects SET answered = 1 WHERE id = ?", id);
    };
    let timedOut = false;
    // The record settles before an answer in time reaches the caller, and after a late answer's
    // cleanup.
    const tracked = Promise.resolve()
      .then(call)
      .then(
        async (value) => {
          if (timedOut) {
            try {
              await late(value);
            } catch {
              // Nobody waits for a late answer's cleanup; the effect record still demands it.
            }
          }
          settle();
          return value;
        },
        (error: unknown) => {
          settle();
          throw error;
        },
      );
    return boundedCall(tracked, limits.callTimeoutMs, () => {
      timedOut = true;
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

  /**
   * The head of main's `refs/heads/main`, which the push creates, whatever `HEAD` names: `null`
   * when the repository has no such branch or no commit on it, or `missing` when there is no
   * repository.
   */
  async function readMain(
    artifacts: SeedArtifacts,
    name: string,
  ): Promise<PortResult<CommitSha | null | "missing">> {
    let repo: SeedArtifactsRepo;
    try {
      repo = await opened(artifacts, name);
    } catch (error) {
      return artifactsCode(error) === "NOT_FOUND" ? ok("missing") : artifactsFailed();
    }
    using handle = repo;
    try {
      const [latest] = await bounded(handle.log({ ref: BUNDLE_REF, limit: 1 }));
      if (latest === undefined) return ok(null);
      return isCommitSha(latest.hash) ? ok(latest.hash) : artifactsFailed();
    } catch (error) {
      // The repository exists, so a missing ref is a main branch not created yet.
      return artifactsCode(error) === "NOT_FOUND" ? ok(null) : artifactsFailed();
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
   * Revokes every live token on main with the Artifacts adapter's sweep, which lists until none is
   * left within its deadline and revocation budget; a sweep that runs out leaves the rest to the
   * next seed, and one whose listing cannot cover every token fails. Clears the create and mint records once main is clean. Tokens are owed only between
   * a seed's create or mint and the sweep that must precede initialization, and an initialized Repo
   * is never created or minted on, so while any are owed no other module holds a token on main:
   * every one is the seed's.
   */
  async function sweepTokens(artifacts: SeedArtifacts, name: string): Promise<boolean> {
    try {
      using repo = await opened(artifacts, name);
      const swept = await revokeActiveTokens(repo, limits);
      if (!swept.ok) return false;
    } catch (error) {
      // No repository holds no token.
      if (artifactsCode(error) !== "NOT_FOUND") return false;
    }
    sql.exec("DELETE FROM demo_seed_effects WHERE kind IN ('create', 'mint')");
    return true;
  }

  return {
    read() {
      if (!context.initialized()) return Promise.resolve(ok(null));
      const { artifacts } = context;
      if (artifacts === undefined) return Promise.resolve(noArtifacts());
      const now = context.clock();
      if (lastRead === null || now < lastRead.at || now - lastRead.at >= limits.readCacheMs) {
        lastRead = { at: now, result: readState(artifacts) };
      }
      return lastRead.result;
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
        let forks: string[];
        try {
          forks = recordedForks(context.storage);
        } catch {
          return fail("internal", "The demo repository's fork records could not be read.");
        }
        const names = [...forks, await mainRepoName(context.repoId)];
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

/** The `ArtifactsError` code of `error`, or `undefined` for any other error. */
function artifactsCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const code: unknown = Reflect.get(error, "code");
  return typeof code === "string" ? code : undefined;
}
