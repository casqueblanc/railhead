// The demo repository's side of the seed: it runs inside the `Repo` named `demo/upload-app` and
// is reached only after the control object has verified the owner's passkey for the action.
//
// Seed is reconciliation. It reads main from Artifacts first: main at the requested head is done,
// main at any other head is refused, and only a missing main is pushed. A push whose outcome is
// unknown is settled by reading main again, never by pushing twice. The Repo is initialized last,
// so the board shows the repository only once its main is in place; a seed that failed partway
// finishes on the next run.
//
// Reset deletes, by exact name, the repository's main Artifacts repository and every fork its
// Artifacts table recorded, then the Repo's own storage. It never lists the namespace to choose
// what to delete. A failed deletion stops the reset before the Repo's storage is wiped, so the fork
// names stay readable and the next reset finishes the job.
//
// One seed or reset runs at a time per object; a second is refused as busy. Tokens stay in this
// module: they are revoked after the push and never logged or returned.

import type { DemoSeedResult, DemoSeedState } from "@railhead/shared/board-api";
import { isCommitSha, type CommitSha, type RepoId } from "@railhead/shared/events";
import { mainRepoName } from "../../artifacts/adapter";
import { fail, ok, type PortResult } from "../../contracts/result";
import type { RepoStorage } from "../../repo/storage";
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
}

/** The production limits. */
export const SEED_TARGET_LIMITS: SeedTargetLimits = {
  callTimeoutMs: 10_000,
  pushTimeoutMs: 60_000,
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

/** Builds the seed target of the demo repository's `Repo`. */
export function createSeedTarget(
  context: SeedTargetContext,
  limits: SeedTargetLimits = SEED_TARGET_LIMITS,
): SeedTarget {
  let running = false;

  /** Runs `work` unless another seed or reset is running. */
  async function exclusive<T>(work: () => Promise<PortResult<T>>): Promise<PortResult<T>> {
    if (running) return fail("internal", "Another seed or reset is running; try again.");
    running = true;
    try {
      return await work();
    } finally {
      running = false;
    }
  }

  /** Bounds one binding call; a late answer is dropped. */
  function bounded<T>(work: Promise<T>): Promise<T> {
    return within(work, limits.callTimeoutMs);
  }

  /** Main's head, `null` for a repository without one, or `missing` when there is no repository. */
  async function readMain(
    artifacts: SeedArtifacts,
    name: string,
  ): Promise<PortResult<CommitSha | null | "missing">> {
    try {
      using repo = await bounded(artifacts.get(name));
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
   * missing. Every live token is revoked first, the day-long one `create` returns included: main
   * has no history yet, so any token on it is a leftover of this or an earlier attempt.
   */
  async function writeAccess(
    artifacts: SeedArtifacts,
    name: string,
    exists: boolean,
  ): Promise<PortResult<{ remote: string; token: string }>> {
    if (!exists) {
      try {
        await bounded(artifacts.create(name));
      } catch (error) {
        if (artifactsCode(error) !== "ALREADY_EXISTS") return artifactsFailed();
      }
    }
    try {
      using repo = await bounded(artifacts.get(name));
      const swept = await sweepTokens(repo);
      if (!swept.ok) return swept;
      const { remote } = await bounded(repo.info());
      const minted = await bounded(repo.createToken("write", PUSH_TOKEN_TTL_SECONDS));
      return ok({ remote, token: minted.plaintext });
    } catch {
      return artifactsFailed();
    }
  }

  async function sweepTokens(repo: SeedArtifactsRepo): Promise<PortResult<void>> {
    const { tokens } = await bounded(repo.listTokens());
    const live = tokens.filter((token) => token.state === "active");
    if (live.length > MAX_SWEPT_TOKENS) {
      return fail("internal", "The demo main repository holds too many tokens to revoke.");
    }
    for (const token of live) await bounded(repo.revokeToken(token.id));
    return ok(undefined);
  }

  async function revoke(artifacts: SeedArtifacts, name: string, token: string): Promise<boolean> {
    try {
      using repo = await bounded(artifacts.get(name));
      return await bounded(repo.revokeToken(token));
    } catch {
      return false;
    }
  }

  /** The fork names the Artifacts module recorded in this Repo, if its table exists. */
  function forkNames(): string[] {
    const sql = context.storage.sql;
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
        const name = await mainRepoName(context.repoId);
        const before = await readMain(artifacts, name);
        if (!before.ok) return before;
        if (before.value !== head) {
          if (before.value !== null && before.value !== "missing") {
            return fail(
              "action_stale",
              "The demo repository's main holds another head. Reset it first.",
            );
          }
          const access = await writeAccess(artifacts, name, before.value !== "missing");
          if (!access.ok) return access;
          const outcome: PushOutcome = await pushMain(
            { ...access.value, head, pack },
            context.fetch,
            limits.pushTimeoutMs,
          );
          const revoked = await revoke(artifacts, name, access.value.token);
          // Whatever the push reported, main as Artifacts now holds it is the answer.
          const after = await readMain(artifacts, name);
          if (!after.ok) return after;
          if (after.value !== head) {
            return after.value === null || after.value === "missing"
              ? fail("internal", `The push did not create main (${outcome}); try again.`)
              : fail(
                  "action_stale",
                  "The demo repository's main holds another head. Reset it first.",
                );
          }
          // The token expires within minutes, but a revocation that failed is still reported.
          if (!revoked) {
            return fail(
              "internal",
              "Main was imported but its push token was not revoked; try again.",
            );
          }
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
        const names = [await mainRepoName(context.repoId), ...forkNames()];
        let deleted = context.initialized();
        for (const name of names) {
          try {
            if (await bounded(artifacts.delete(name))) deleted = true;
          } catch {
            return artifactsFailed();
          }
        }
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
