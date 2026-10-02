// The Artifacts adapter behind `ArtifactsPort`: one fork per claim, commit lookups, and short-lived
// tokens minted inside the Worker. Every binding call is bounded by a timeout. A fork whose
// response was lost is recorded as pending before the call and reconciled on the next request, and
// the token Artifacts returns with a new fork is revoked before the fork is used.
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
}

/** The production limits. */
export const ARTIFACTS_LIMITS: ArtifactsAdapterLimits = {
  callTimeoutMs: 10_000,
  maxCachedTokens: 256,
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
      const claimId = target.kind === "fork" ? target.claimId : null;
      const key = cacheKey(repo, scope, claimId);
      const now = this.#context.clock();
      const cached = this.#cache.get(key);
      // A cached token is reused while at least half the requested lifetime remains.
      if (cached !== undefined && cached.token.expiresAt - now >= ttlMs / 2) {
        return ok({ ...cached.token });
      }
      const epoch = this.#epoch(repo);
      using handle = await this.#open(repo);
      const created = await this.#bounded(handle.createToken(scope, Math.ceil(ttlMs / 1000)));
      const expiresAt = Date.parse(created.expiresAt);
      if (this.#epoch(repo) !== epoch || Number.isNaN(expiresAt)) {
        // Revoked while minting, or unusable: this token must not stay live.
        await this.#bounded(handle.revokeToken(created.id));
        return this.#epoch(repo) !== epoch
          ? fail("busy", "The repository's tokens were revoked while one was minted.")
          : fail("internal", "Artifacts returned a token without a valid expiry.");
      }
      const token: ArtifactsToken = { value: created.plaintext, scope, repo, expiresAt };
      this.#remember(key, { token, claimId }, now);
      return ok({ ...token });
    });
  }

  async revokeTokens(repo: ArtifactsRepoName): Promise<PortResult<void>> {
    return guarded(async () => {
      const target = await this.#resolve(repo);
      if (target === null) return unknownRepo();
      if (target.kind === "main") return invalid("main's tokens are not revoked through a claim");
      // Forget cached tokens before revoking, so none is handed out even if revocation fails.
      this.#epochs.set(repo, this.#epoch(repo) + 1);
      for (const [key, entry] of this.#cache) {
        if (entry.token.repo === repo) this.#cache.delete(key);
      }
      using handle = await this.#open(repo);
      return await this.#revokeActive(handle);
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

  async #revokeActive(handle: ArtifactsRepoHandle): Promise<PortResult<void>> {
    for (let round = 0; round < MAX_REVOKE_ROUNDS; round += 1) {
      const listed = await this.#bounded(handle.listTokens());
      const active = listed.tokens.filter((token) => token.state === "active");
      if (active.length === 0) return ok(undefined);
      for (const token of active) await this.#bounded(handle.revokeToken(token.id));
    }
    return fail("busy", "The repository still has live tokens; try again.");
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
    return this.#bounded(this.#context.namespace.get(name));
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

  async #bounded<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CallTimedOut()), this.#limits.callTimeoutMs);
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
