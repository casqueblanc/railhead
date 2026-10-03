// The Artifacts adapter behind `ArtifactsPort`: one fork per claim, commit lookups, and short-lived
// tokens minted inside the Worker. Every binding call is bounded by a timeout, and a result that
// arrives after its timeout is still cleaned up: a late handle is disposed and a late token revoked.
// A fork whose response was lost is recorded as pending before the call and reconciled on the next
// request, and the token Artifacts returns with a new fork is revoked before the fork is used. A
// fork's token mint is recorded before the call too, so a revocation never reports success while a
// mint that started before it may still create a token.
//
// Tokens never leave this module except through `token`, whose caller streams them to Artifacts.
// Nothing here logs a token, a repository name or a binding error's message.

import {
  isCommitSha,
  isId,
  type ClaimId,
  type CommitSha,
  type RepoId,
} from "@railhead/shared/events";
import type { ArtifactsPort, ArtifactsRepoName, ArtifactsToken } from "../contracts/artifacts";
import { fail, ok, type PortFailure, type PortResult } from "../contracts/result";
import { atomically, migrate, type RepoStorage } from "../repo/storage";

/** The binding methods this adapter calls on one Artifacts repository. `ArtifactsRepo` satisfies it. */
export type ArtifactsRepoHandle = Disposable &
  Pick<ArtifactsRepo, "fork" | "createToken" | "listTokens" | "revokeToken" | "readCommit" | "log">;

/** The namespace-level binding this adapter needs. The `ARTIFACTS` binding satisfies it. */
export interface ArtifactsNamespace {
  /** Opens a repository; throws an `ArtifactsError` such as `NOT_FOUND` or `FORK_IN_PROGRESS`. */
  get(name: string): Promise<ArtifactsRepoHandle>;
}

/** What the adapter receives from its `Repo`. */
export interface ArtifactsAdapterContext {
  /** The repository whose main and forks this adapter may touch, and no other. */
  readonly repoId: RepoId;
  /** The repository's storage, where fork records live in this module's own table. */
  readonly storage: RepoStorage;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly clock: () => number;
  /** The Artifacts namespace. */
  readonly namespace: ArtifactsNamespace;
}

/** Limits a test may tighten. */
export interface ArtifactsAdapterLimits {
  /** How long one binding call may take before it counts as lost. */
  readonly callTimeoutMs: number;
  /** How many tokens the cache holds before it drops the oldest. */
  readonly maxCachedTokens: number;
  /** How long one token sweep may run, across all its calls, before it reports the repository busy. */
  readonly sweepDeadlineMs: number;
  /** How many tokens one sweep revokes before it reports the repository busy. */
  readonly maxRevokesPerSweep: number;
  /**
   * How long after it started a mint that never answered still blocks revocation. After this the
   * call is taken as abandoned: an unverified assumption about Artifacts that H04 must qualify.
   */
  readonly mintSettleMs: number;
}

/** The production limits. */
export const ARTIFACTS_LIMITS: ArtifactsAdapterLimits = {
  callTimeoutMs: 10_000,
  maxCachedTokens: 256,
  sweepDeadlineMs: 30_000,
  maxRevokesPerSweep: 64,
  mintSettleMs: 60_000,
};

/** The shortest token lifetime Artifacts accepts. */
export const MIN_TOKEN_TTL_MS = 60_000;
/** The longest token lifetime this adapter mints. Artifacts allows a year; Railhead never needs it. */
export const MAX_TOKEN_TTL_MS = 3_600_000;
/** How many list-and-revoke rounds `revokeTokens` makes before reporting the repository busy. */
const MAX_REVOKE_ROUNDS = 5;

const MIGRATIONS = [
  `CREATE TABLE artifacts_forks (
    claim_id TEXT PRIMARY KEY,
    repo TEXT NOT NULL UNIQUE,
    base TEXT NOT NULL,
    head TEXT,
    state TEXT NOT NULL CHECK (state IN ('pending', 'ready')),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE artifacts_mints (
    id TEXT PRIMARY KEY,
    repo TEXT NOT NULL,
    started_at INTEGER NOT NULL
  ) STRICT`,
];

/**
 * The Artifacts name of `repoId`'s main repository. Names are derived on the server and never
 * taken from a client: a hash keeps them short and free of characters Artifacts may refuse.
 */
export async function mainRepoName(repoId: RepoId): Promise<ArtifactsRepoName> {
  return `rh-m-${await digest(repoId)}`;
}

/** The Artifacts name of `claimId`'s fork of `repoId`'s main repository. */
export async function forkRepoName(repoId: RepoId, claimId: ClaimId): Promise<ArtifactsRepoName> {
  return `rh-f-${await digest(`${repoId}/${claimId}`)}`;
}

/** Builds the Artifacts port of one repository and migrates its table. */
export function createArtifactsAdapter(
  context: ArtifactsAdapterContext,
  limits: ArtifactsAdapterLimits = ARTIFACTS_LIMITS,
): ArtifactsPort {
  migrate(context.storage, "artifacts", MIGRATIONS);
  return new ArtifactsAdapter(context, limits);
}

type ForkState = "pending" | "ready";

interface ForkRow {
  claim_id: string;
  repo: string;
  head: string | null;
  state: ForkState;
}

type Target = { kind: "main" } | { kind: "fork"; claimId: ClaimId };

interface CachedToken {
  token: ArtifactsToken;
  claimId: ClaimId | null;
}

interface BoundedOptions<T> {
  /** Takes ownership of the call's eventual outcome when the call times out. */
  late?: (pending: Promise<T>) => void;
  /** A shorter limit than the per-call timeout. */
  timeoutMs?: number;
}

/** A binding call that did not answer in time. Its effect, if any, is unknown. */
class CallTimedOut extends Error {
  constructor() {
    super("Artifacts call timed out");
    this.name = "CallTimedOut";
  }
}

class ArtifactsAdapter implements ArtifactsPort {
  readonly #context: ArtifactsAdapterContext;
  readonly #limits: ArtifactsAdapterLimits;
  readonly #forks = new Map<
    ClaimId,
    Promise<PortResult<{ repo: ArtifactsRepoName; head: CommitSha }>>
  >();
  readonly #cache = new Map<string, CachedToken>();
  // Bumped by `revokeTokens`, so a token minted while a revocation ran is never cached or returned.
  readonly #epochs = new Map<ArtifactsRepoName, number>();
  // How many sweeps of each repository are running. While one runs, no mint starts there.
  readonly #revoking = new Map<ArtifactsRepoName, number>();
  // The latest mint per cache key, so concurrent misses for one key mint one token at a time.
  readonly #minting = new Map<string, Promise<void>>();
  #mainName: Promise<ArtifactsRepoName> | null = null;

  constructor(context: ArtifactsAdapterContext, limits: ArtifactsAdapterLimits) {
    this.#context = context;
    this.#limits = limits;
  }

  forkForClaim(
    claimId: ClaimId,
    base: CommitSha,
  ): Promise<PortResult<{ repo: ArtifactsRepoName; head: CommitSha }>> {
    if (!isId("claim", claimId)) return Promise.resolve(invalid("claim id is malformed"));
    if (!isCommitSha(base)) return Promise.resolve(invalid("base is not a commit id"));
    // Concurrent requests for one claim share one attempt, so the fork is created at most once.
    const running = this.#forks.get(claimId);
    if (running !== undefined) return running;
    const attempt = guarded(() => this.#fork(claimId, base)).finally(() => {
      this.#forks.delete(claimId);
    });
    this.#forks.set(claimId, attempt);
    return attempt;
  }

  async commitExists(repo: ArtifactsRepoName, commit: CommitSha): Promise<PortResult<boolean>> {
    if (!isCommitSha(commit)) return invalid("commit is not a commit id");
    return guarded(async () => {
      const target = await this.#resolve(repo);
      if (target === null) return unknownRepo();
      using handle = await this.#open(repo);
      const found = await this.#bounded(handle.readCommit(commit));
      return ok(found !== null);
    });
  }

  async token(
    repo: ArtifactsRepoName,
    scope: "read" | "write",
    ttlMs: number,
  ): Promise<PortResult<ArtifactsToken>> {
    if (!Number.isInteger(ttlMs) || ttlMs < MIN_TOKEN_TTL_MS || ttlMs > MAX_TOKEN_TTL_MS) {
      return invalid(`ttlMs must be an integer from ${MIN_TOKEN_TTL_MS} to ${MAX_TOKEN_TTL_MS}`);
    }
    return guarded(async () => {
      const target = await this.#resolve(repo);
      if (target === null) return unknownRepo();
      if (target.kind === "main" && scope === "write") {
        return invalid("main is written only through the main writer");
      }
      const key = cacheKey(repo, scope, target.kind === "fork" ? target.claimId : null);
      return await this.#oneAtATime(key, () => this.#issue(repo, target, scope, ttlMs, key));
    });
  }

  async revokeTokens(repo: ArtifactsRepoName): Promise<PortResult<void>> {
    return guarded(async () => {
      const target = await this.#resolve(repo);
      if (target === null) return unknownRepo();
      if (target.kind === "main") return invalid("main's tokens are not revoked through a claim");
      return await this.#fenced(repo, async () => {
        // A mint that has not answered could create a token after the sweep lists, so sweep only
        // once none is running.
        if (this.#mintsRunning(repo)) {
          return fail("busy", "A token for the repository is still being minted; try again.");
        }
        using handle = await this.#open(repo);
        return await this.#revokeActive(handle);
      });
    });
  }

  async #issue(
    repo: ArtifactsRepoName,
    target: Target,
    scope: "read" | "write",
    ttlMs: number,
    key: string,
  ): Promise<PortResult<ArtifactsToken>> {
    if (this.#revoking.has(repo)) {
      return fail("busy", "The repository's tokens are being revoked; try again.");
    }
    const claimId = target.kind === "fork" ? target.claimId : null;
    const now = this.#context.clock();
    const cached = this.#cache.get(key);
    // A cached token is reused while at least half the requested lifetime remains.
    if (cached !== undefined && cached.token.expiresAt - now >= ttlMs / 2) {
      return ok({ ...cached.token });
    }
    const epoch = this.#epoch(repo);
    // Recorded in the same step as the fence check above, so a revocation that starts later sees it.
    const mint = target.kind === "fork" ? this.#recordMint(repo) : null;
    let settled = true;
    try {
      using handle = await this.#open(repo);
      const created = await this.#bounded(handle.createToken(scope, Math.ceil(ttlMs / 1000)), {
        late: (pending) => {
          settled = false;
          void this.#discardLate(repo, pending, mint);
        },
      });
      const expiresAt = Date.parse(created.expiresAt);
      if (this.#epoch(repo) !== epoch || Number.isNaN(expiresAt)) {
        // Revoked while minting, or unusable: this token must not stay live. A fork's tokens may all
        // be swept if revoking this one fails; main's may not, as that would revoke the train's.
        const revoked = await this.#bounded(handle.revokeToken(created.id)).catch(() => false);
        if (!revoked) {
          if (target.kind === "main") {
            return fail("internal", "A minted token could not be revoked.");
          }
          // The sweep may revoke the fork's other tokens, so none is handed out or minted meanwhile.
          const swept = await this.#fenced(repo, () => this.#revokeActive(handle));
          if (!swept.ok) return swept;
        }
        return this.#epoch(repo) !== epoch
          ? fail("busy", "The repository's tokens were revoked while one was minted.")
          : fail("internal", "Artifacts returned a token without a valid expiry.");
      }
      const token: ArtifactsToken = { value: created.plaintext, scope, repo, expiresAt };
      this.#remember(key, { token, claimId }, now);
      return ok({ ...token });
    } finally {
      // Once the call has answered, any token it created exists, and a revocation's sweep finds it.
      if (settled && mint !== null) this.#forgetMint(mint);
    }
  }

  /** Revokes a token whose mint answered after its timeout. Nobody waits for this. */
  async #discardLate(
    repo: ArtifactsRepoName,
    pending: Promise<ArtifactsCreateTokenResult>,
    mint: string | null,
  ): Promise<void> {
    try {
      const created = await pending;
      using handle = await this.#open(repo);
      await this.#bounded(handle.revokeToken(created.id));
    } catch {
      // No caller remains to report to. A fork's token left live is revoked by the next sweep, as
      // `revokeTokens` waits for this mint; any token expires within its requested lifetime.
    } finally {
      if (mint !== null) this.#forgetMint(mint);
    }
  }

  /** Runs `work` after the previous work for `key` has finished. */
  async #oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
    const current = (this.#minting.get(key) ?? Promise.resolve()).then(work);
    const finished = current.then(
      () => undefined,
      () => undefined,
    );
    this.#minting.set(key, finished);
    try {
      return await current;
    } finally {
      if (this.#minting.get(key) === finished) this.#minting.delete(key);
    }
  }

  #recordMint(repo: ArtifactsRepoName): string {
    const id = crypto.randomUUID();
    atomically(this.#context.storage, () => {
      this.#context.storage.sql.exec(
        "INSERT INTO artifacts_mints (id, repo, started_at) VALUES (?, ?, ?)",
        id,
        repo,
        this.#context.clock(),
      );
    });
    return id;
  }

  #forgetMint(id: string): void {
    atomically(this.#context.storage, () => {
      this.#context.storage.sql.exec("DELETE FROM artifacts_mints WHERE id = ?", id);
    });
  }

  /**
   * Whether a mint for `repo` may still create a token. A record outlives its adapter, so a mint
   * started before a restart counts until `mintSettleMs` has passed.
   */
  #mintsRunning(repo: ArtifactsRepoName): boolean {
    const abandonedBefore = this.#context.clock() - this.#limits.mintSettleMs;
    return atomically(this.#context.storage, () => {
      const sql = this.#context.storage.sql;
      sql.exec(
        "DELETE FROM artifacts_mints WHERE repo = ? AND started_at <= ?",
        repo,
        abandonedBefore,
      );
      return (
        sql.exec("SELECT 1 FROM artifacts_mints WHERE repo = ? LIMIT 1", repo).toArray().length > 0
      );
    });
  }

  async #fork(
    claimId: ClaimId,
    base: CommitSha,
  ): Promise<PortResult<{ repo: ArtifactsRepoName; head: CommitSha }>> {
    const existing = this.#readFork(claimId);
    if (existing?.state === "ready" && existing.head !== null) {
      return ok({ repo: existing.repo, head: existing.head });
    }
    const name = await forkRepoName(this.#context.repoId, claimId);
    if (existing === null) {
      // Recorded before the call: a lost response leaves this row, and the next request reconciles.
      atomically(this.#context.storage, () => {
        this.#context.storage.sql.exec(
          `INSERT INTO artifacts_forks (claim_id, repo, base, head, state, created_at)
           VALUES (?, ?, ?, NULL, 'pending', ?)`,
          claimId,
          name,
          base,
          this.#context.clock(),
        );
      });
    } else {
      const reconciled = await this.#reconcile(name);
      if (reconciled !== "absent") return this.#finish(claimId, name, reconciled);
    }
    using main = await this.#open(await this.#main());
    let initialToken: string;
    try {
      const created = await this.#bounded(main.fork(name, { defaultBranchOnly: true }));
      initialToken = created.token;
    } catch (error) {
      // The fork exists although this request did not see it created: adopt it.
      if (artifactsCode(error) !== "ALREADY_EXISTS") throw error;
      const reconciled = await this.#reconcile(name);
      if (reconciled === "absent") return fail("busy", "The claim's fork is being created.");
      return this.#finish(claimId, name, reconciled);
    }
    using fork = await this.#open(name);
    const revoked = await this.#bounded(fork.revokeToken(initialToken));
    // `false` means Artifacts did not find the token by value, so sweep every live token instead.
    if (!revoked) {
      const swept = await this.#revokeActive(fork);
      if (!swept.ok) return swept;
    }
    return this.#finish(claimId, name, await this.#head(fork));
  }

  /**
   * Looks for a fork whose creation response was lost. When it exists, revokes every live token on
   * it, including the initial one this module never saw, and returns its head.
   */
  async #reconcile(name: ArtifactsRepoName): Promise<CommitSha | "absent"> {
    let fork: ArtifactsRepoHandle;
    try {
      fork = await this.#open(name);
    } catch (error) {
      if (artifactsCode(error) === "NOT_FOUND") return "absent";
      throw error;
    }
    using handle = fork;
    const swept = await this.#revokeActive(handle);
    if (!swept.ok) throw new UnrevokedTokens();
    return await this.#head(handle);
  }

  #finish(
    claimId: ClaimId,
    repo: ArtifactsRepoName,
    head: CommitSha,
  ): PortResult<{ repo: ArtifactsRepoName; head: CommitSha }> {
    atomically(this.#context.storage, () => {
      this.#context.storage.sql.exec(
        `UPDATE artifacts_forks SET head = ?, state = 'ready' WHERE claim_id = ?`,
        head,
        claimId,
      );
    });
    return ok({ repo, head });
  }

  async #head(fork: ArtifactsRepoHandle): Promise<CommitSha> {
    const [latest] = await this.#bounded(fork.log({ limit: 1 }));
    if (latest === undefined || !isCommitSha(latest.hash)) throw new MissingHead();
    return latest.hash;
  }

  /**
   * Revokes every live token on `handle`'s repository, within a total deadline and revocation
   * budget. Running out of either reports busy; a repeat continues where this one stopped.
   */
  async #revokeActive(handle: ArtifactsRepoHandle): Promise<PortResult<void>> {
    const unfinished = fail("busy", "The repository still has live tokens; try again.");
    // Wall time, like the per-call timer; the injected clock need not move while calls run.
    const deadline = Date.now() + this.#limits.sweepDeadlineMs;
    const remaining = (): number => Math.min(this.#limits.callTimeoutMs, deadline - Date.now());
    let budget = this.#limits.maxRevokesPerSweep;
    for (let round = 0; round < MAX_REVOKE_ROUNDS; round += 1) {
      if (remaining() <= 0) return unfinished;
      const listed = await this.#bounded(handle.listTokens(), { timeoutMs: remaining() });
      const active = listed.tokens.filter((token) => token.state === "active");
      if (active.length === 0) return ok(undefined);
      for (const token of active) {
        if (budget === 0 || remaining() <= 0) return unfinished;
        budget -= 1;
        await this.#bounded(handle.revokeToken(token.id), { timeoutMs: remaining() });
      }
    }
    return unfinished;
  }

  async #resolve(repo: ArtifactsRepoName): Promise<Target | null> {
    if (repo === (await this.#main())) return { kind: "main" };
    const rows = this.#context.storage.sql
      .exec<{ claim_id: string }>(
        "SELECT claim_id FROM artifacts_forks WHERE repo = ? AND state = 'ready'",
        repo,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    // The name must still derive from this repository, so a row can never grant another's fork.
    if (repo !== (await forkRepoName(this.#context.repoId, row.claim_id))) return null;
    return { kind: "fork", claimId: row.claim_id };
  }

  #readFork(claimId: ClaimId): ForkRow | null {
    const rows = this.#context.storage.sql
      .exec<{ claim_id: string; repo: string; head: string | null; state: string }>(
        "SELECT claim_id, repo, head, state FROM artifacts_forks WHERE claim_id = ?",
        claimId,
      )
      .toArray();
    const row = rows[0];
    if (row === undefined) return null;
    return { claim_id: row.claim_id, repo: row.repo, head: row.head, state: forkState(row.state) };
  }

  #main(): Promise<ArtifactsRepoName> {
    this.#mainName ??= mainRepoName(this.#context.repoId);
    return this.#mainName;
  }

  #open(name: ArtifactsRepoName): Promise<ArtifactsRepoHandle> {
    return this.#bounded(this.#context.namespace.get(name), {
      // A handle that opens after its timeout has no owner but this.
      late: (pending) => {
        void pending.then(
          (handle) => handle[Symbol.dispose](),
          () => undefined,
        );
      },
    });
  }

  /**
   * Runs `sweep` with new mints for `repo` refused and its cached tokens and running mints
   * forgotten first, so no token is handed out even if the sweep fails. Sweeps may overlap.
   */
  async #fenced<T>(repo: ArtifactsRepoName, sweep: () => Promise<T>): Promise<T> {
    this.#revoking.set(repo, (this.#revoking.get(repo) ?? 0) + 1);
    try {
      this.#epochs.set(repo, this.#epoch(repo) + 1);
      for (const [key, entry] of this.#cache) {
        if (entry.token.repo === repo) this.#cache.delete(key);
      }
      return await sweep();
    } finally {
      const running = (this.#revoking.get(repo) ?? 1) - 1;
      if (running === 0) this.#revoking.delete(repo);
      else this.#revoking.set(repo, running);
    }
  }

  #epoch(repo: ArtifactsRepoName): number {
    return this.#epochs.get(repo) ?? 0;
  }

  #remember(key: string, entry: CachedToken, now: number): void {
    for (const [cachedKey, cached] of this.#cache) {
      if (cached.token.expiresAt <= now) this.#cache.delete(cachedKey);
    }
    this.#cache.delete(key);
    this.#cache.set(key, entry);
    // Map iteration follows insertion order, so the first keys are the oldest.
    for (const oldest of this.#cache.keys()) {
      if (this.#cache.size <= this.#limits.maxCachedTokens) break;
      this.#cache.delete(oldest);
    }
  }

  /**
   * Waits for `work` up to the per-call timeout. On timeout the call keeps running, so `late` takes
   * over any result that holds a resource.
   */
  async #bounded<T>(work: Promise<T>, options: BoundedOptions<T> = {}): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        options.late?.(work);
        reject(new CallTimedOut());
      }, options.timeoutMs ?? this.#limits.callTimeoutMs);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A fork's live tokens could not all be revoked, so it must not be used yet. */
class UnrevokedTokens extends Error {
  constructor() {
    super("fork still has live tokens");
    this.name = "UnrevokedTokens";
  }
}

/** A fork's default branch has no commit. */
class MissingHead extends Error {
  constructor() {
    super("fork has no head commit");
    this.name = "MissingHead";
  }
}

const ARTIFACTS_ERROR_CODES = [
  "ALREADY_EXISTS",
  "NOT_FOUND",
  "CREATE_IN_PROGRESS",
  "IMPORT_IN_PROGRESS",
  "FORK_IN_PROGRESS",
  "INVALID_INPUT",
  "INVALID_REPO_NAME",
  "INVALID_TTL",
  "INVALID_URL",
  "REMOTE_AUTH_REQUIRED",
  "UPSTREAM_UNAVAILABLE",
  "MEMORY_LIMIT",
  "INTERNAL_ERROR",
] as const satisfies readonly ArtifactsErrorCode[];

/** The `ArtifactsError` code of `error`, or `null` for any other error. */
function artifactsCode(error: unknown): ArtifactsErrorCode | null {
  if (!(error instanceof Error) || !("code" in error)) return null;
  const { code } = error;
  return ARTIFACTS_ERROR_CODES.find((known) => known === code) ?? null;
}

/** Runs `body`, turning a thrown binding error into a refusal that names no secret. */
async function guarded<T>(body: () => Promise<PortResult<T>>): Promise<PortResult<T>> {
  try {
    return await body();
  } catch (error) {
    return failureOf(error);
  }
}

function failureOf(error: unknown): PortFailure {
  if (error instanceof CallTimedOut) {
    return fail("busy", "Artifacts did not answer in time; the request may be repeated.");
  }
  if (error instanceof UnrevokedTokens) {
    return fail("busy", "The claim's fork still has live tokens; try again.");
  }
  if (error instanceof MissingHead) {
    return fail("internal", "The claim's fork has no commit.");
  }
  const code = artifactsCode(error);
  if (code === null) throw error;
  switch (code) {
    case "NOT_FOUND":
      return fail("not_found", "The Artifacts repository does not exist.");
    case "CREATE_IN_PROGRESS":
    case "IMPORT_IN_PROGRESS":
    case "FORK_IN_PROGRESS":
    case "UPSTREAM_UNAVAILABLE":
      return fail("busy", "The Artifacts repository is not ready yet.");
    case "ALREADY_EXISTS":
    case "INVALID_INPUT":
    case "INVALID_REPO_NAME":
    case "INVALID_TTL":
    case "INVALID_URL":
    case "REMOTE_AUTH_REQUIRED":
    case "MEMORY_LIMIT":
    case "INTERNAL_ERROR":
      return fail("internal", "Artifacts refused the request.");
    default:
      return code satisfies never;
  }
}

function invalid(message: string): PortFailure {
  return fail("invalid_request", `${message}.`);
}

function unknownRepo(): PortFailure {
  return fail("not_found", "No such Artifacts repository belongs to this repository.");
}

function cacheKey(
  repo: ArtifactsRepoName,
  scope: "read" | "write",
  claimId: ClaimId | null,
): string {
  return JSON.stringify([repo, scope, claimId]);
}

function forkState(value: string): ForkState {
  if (value === "pending" || value === "ready") return value;
  throw new Error("artifacts_forks holds an unknown state");
}

async function digest(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
  );
  return Array.from(bytes.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
