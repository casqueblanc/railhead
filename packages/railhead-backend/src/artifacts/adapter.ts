// The Artifacts adapter behind `ArtifactsPort`: one fork per claim, commit lookups, and short-lived
// tokens minted inside the Worker. Every binding call is bounded by a timeout, and a result that
// arrives after its timeout is still cleaned up: a late handle is disposed and a late token revoked.
// A fork whose response was lost is recorded as pending before the call and reconciled on the next
// request, and the token Artifacts returns with a new fork is revoked before the fork is used. A
// fork's token mint is recorded before the call too, so a revocation never reports success while a
// mint of this incarnation may still create a token. Each repository has at most one unanswered
// mint and a short queue of waiting callers; anyone beyond that is told the repository is busy.
//
// A record left by a previous incarnation of the Durable Object can never be settled, and Artifacts
// offers no cancellation or issuance deadline. Every revocation of that fork sweeps all its live
// tokens and reports busy until the mint's start, its requested lifetime and the clock skew have
// passed, so a late token created within that window is revoked by a later sweep. A token Artifacts
// creates after the final sweep escapes; how late a mint can take effect is not yet measured.
//
// A sweep whose token listing cannot cover every token does not count as a revocation: the fork
// owes a sweep, `revokeTokens` reports `pending_debt` rather than `revoked`, and the fork takes no
// new token until a later sweep sees every token or every token it may hold has expired. Each
// partial sweep bumps the debt's generation, and a clean sweep clears only the generation it saw
// before it listed, so an older clean result never erases a newer partial one. Every token request
// checks for a debt in the same step that serves a cached token or starts a mint, and again before
// it returns a minted one.
//
// Every fork mint also gets a sequence number in a log kept until its token must have expired, and
// the token's id once the mint answers, before the token is handed out. A revocation sweeps only
// what its `MintCutoff` covers: tokens of mints logged at or before the cutoff, and tokens of no
// logged mint that were created before the attempt began, less the clock skew, or while no later
// mint was unanswered. A token of a later mint is left alone, so a sweep that resumes late, after
// a Repo restart and a newer sweep, never ends a newer holder's access.
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
import type {
  ArtifactsPort,
  ArtifactsRepoName,
  ArtifactsToken,
  MintCutoff,
  TokenRevocation,
} from "../contracts/artifacts";
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

/** The limits of one token sweep, shared by every caller of `revokeActiveTokens`. */
export interface TokenSweepLimits {
  /** How long one binding call may take before it counts as lost. */
  readonly callTimeoutMs: number;
  /** How long one token sweep may run, across all its calls, before it reports the repository busy. */
  readonly sweepDeadlineMs: number;
  /** How many tokens one sweep revokes before it reports the repository busy. */
  readonly maxRevokesPerSweep: number;
}

/** Limits a test may tighten. */
export interface ArtifactsAdapterLimits extends TokenSweepLimits {
  /** How many tokens the cache holds before it drops the oldest. */
  readonly maxCachedTokens: number;
  /** How many token requests may wait for a repository's running mint before more are refused. */
  readonly maxWaitingMints: number;
  /** How long a token request waits for its turn before it reports the repository busy. */
  readonly queueWaitMs: number;
}

/** The production limits. */
export const ARTIFACTS_LIMITS: ArtifactsAdapterLimits = {
  callTimeoutMs: 10_000,
  maxCachedTokens: 256,
  sweepDeadlineMs: 30_000,
  maxRevokesPerSweep: 64,
  maxWaitingMints: 8,
  queueWaitMs: 20_000,
};

/** The shortest token lifetime Artifacts accepts. */
export const MIN_TOKEN_TTL_MS = 60_000;
/** The longest token lifetime this adapter mints. Artifacts allows a year; Railhead never needs it. */
export const MAX_TOKEN_TTL_MS = 3_600_000;
/**
 * How long after a previous incarnation's mint started, beyond its requested lifetime, revocation
 * keeps sweeping for a token it may still create. A design margin, not a measured bound.
 */
export const MINT_CLOCK_SKEW_MS = 300_000;
/** How many list-and-revoke rounds one token sweep makes before reporting the repository busy. */
const MAX_REVOKE_ROUNDS = 5;
/** How long after one sweep of a fork that owes tokens a token request may sweep it again. */
export const TOKEN_DEBT_RETRY_MS = 60_000;

/** The migration owner name of the adapter's tables. */
const ARTIFACTS_OWNER = "artifacts";

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
    started_at INTEGER NOT NULL,
    ttl_ms INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE artifacts_token_debts (
    repo TEXT PRIMARY KEY,
    owed_until INTEGER NOT NULL,
    retry_at INTEGER NOT NULL,
    generation INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE artifacts_mint_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    mint_id TEXT NOT NULL UNIQUE,
    repo TEXT NOT NULL,
    token_id TEXT,
    keep_until INTEGER NOT NULL
  ) STRICT`,
  "CREATE INDEX artifacts_mint_log_by_repo ON artifacts_mint_log (repo, token_id)",
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
  migrate(context.storage, ARTIFACTS_OWNER, MIGRATIONS);
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

/** The mint requests of one repository: at most one runs, and the rest wait in order. */
interface Lane {
  /** Settles when the last request in the lane has finished. */
  tail: Promise<void>;
  /** The running request and those waiting behind it. */
  size: number;
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
  // Token requests per repository, so concurrent misses mint one token at a time.
  readonly #lanes = new Map<ArtifactsRepoName, Lane>();
  // Repositories with a mint call of this incarnation that has not answered. At most one each.
  readonly #unanswered = new Set<ArtifactsRepoName>();
  // The mint records this incarnation wrote. Only these can still be settled by their call's answer.
  readonly #ownMints = new Set<string>();
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
      return await this.#inLane(repo, () => this.#issue(repo, target, scope, ttlMs, key));
    });
  }

  async revokeTokens(
    repo: ArtifactsRepoName,
    cutoff: MintCutoff,
  ): Promise<PortResult<TokenRevocation>> {
    return guarded(async () => {
      const target = await this.#resolve(repo);
      if (target === null) return unknownRepo();
      if (target.kind === "main") return invalid("main's tokens are not revoked through a claim");
      return await this.#fenced(repo, async () => {
        // Checked before the sweep: a covered mint that has not answered could create a token after
        // the sweep lists, so success waits for it. The sweep still runs, revoking what exists now.
        const unsettled = this.#mintsInFlight(repo, cutoff.seq).length > 0;
        // Read before listing: a debt an overlapping sweep records later is newer than this result.
        const seen = this.#debtGeneration(repo);
        using handle = await this.#open(repo);
        // Judged from the last listing, which is the one the sweep's result stands on.
        let deferred = false;
        const swept = await sweepTokens(handle, this.#limits, (active) => {
          const covered = this.#covered(repo, cutoff, active);
          deferred = covered.deferred;
          return covered.revoke;
        });
        // A listing that cannot cover every token (#161 qualifies the binding's paging) may hide a
        // live token, so it is no revocation: the fork owes a sweep and takes no new token until a
        // later sweep is clean or every token it may hold has expired.
        if (swept === "partial") this.#oweSweep(repo);
        else if (swept !== "clean") return swept;
        if (unsettled)
          return fail("busy", "A token for the repository may still be minted; try again.");
        // A deferred token was never handed out: no logged mint answered with it. Recording a debt
        // would make the next token request sweep every token, a newer holder's included, so the
        // caller's revocation stays owed instead and a later sweep revokes it once it is old enough.
        if (deferred) return ok("pending_debt");
        if (swept === "clean" && seen !== null) this.#clearDebt(repo, seen);
        this.#dropExpiredDebt(repo);
        return ok(this.#debtGeneration(repo) === null ? "revoked" : "pending_debt");
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
    // Settled first: from the fence check below to `#beginMint`, nothing may be awaited, or a
    // revocation could start and finish in the gap and the mint would outlive its sweep.
    const owed = await this.#settleDebt(repo);
    if (!owed.ok) return owed;
    if (this.#revoking.has(repo)) {
      return fail("busy", "The repository's tokens are being revoked; try again.");
    }
    // Checked again here, in the step that serves or mints: a sweep may have recorded a debt while
    // `#settleDebt` was awaited.
    if (this.#debtGeneration(repo) !== null) return owingDebt();
    const claimId = target.kind === "fork" ? target.claimId : null;
    const now = this.#context.clock();
    const cached = this.#cache.get(key);
    // A cached token is reused while at least half the requested lifetime remains.
    if (cached !== undefined && cached.token.expiresAt - now >= ttlMs / 2) {
      return ok({ ...cached.token });
    }
    // A mint that timed out may still answer; another beside it would let unanswered calls pile up.
    if (this.#unanswered.has(repo) || (target.kind === "fork" && this.#previousMints(repo) > 0)) {
      return fail("busy", "An earlier token for the repository is still being minted; try again.");
    }
    const epoch = this.#epoch(repo);
    // Recorded in the same step as the fence check above, so a revocation that starts later sees it.
    const ttlSeconds = Math.ceil(ttlMs / 1000);
    const mint = this.#beginMint(repo, target.kind === "fork" ? ttlSeconds * 1000 : null);
    let settled = true;
    try {
      using handle = await this.#open(repo);
      const created = await this.#bounded(handle.createToken(scope, ttlSeconds), {
        late: (pending) => {
          settled = false;
          void this.#discardLate(repo, pending, mint);
        },
      });
      this.#logToken(mint, created.id);
      const expiresAt = Date.parse(created.expiresAt);
      // A debt recorded while the mint ran means a sweep may have missed a live token, so this one
      // is not handed out either.
      const revokedDuring = this.#epoch(repo) !== epoch || this.#debtGeneration(repo) !== null;
      if (revokedDuring || Number.isNaN(expiresAt)) {
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
        return revokedDuring
          ? fail("busy", "The repository's tokens were revoked while one was minted.")
          : fail("internal", "Artifacts returned a token without a valid expiry.");
      }
      const token: ArtifactsToken = { value: created.plaintext, scope, repo, expiresAt };
      this.#remember(key, { token, claimId }, now);
      return ok({ ...token });
    } finally {
      // Once the call has answered, any token it created exists, and a revocation's sweep finds it.
      if (settled) this.#endMint(repo, mint);
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
      this.#logToken(mint, created.id);
      using handle = await this.#open(repo);
      await this.#bounded(handle.revokeToken(created.id));
    } catch {
      // No caller remains to report to. A fork's token left live is revoked by the next sweep, as
      // `revokeTokens` waits for this mint; any token expires within its requested lifetime.
    } finally {
      this.#endMint(repo, mint);
    }
  }

  /**
   * Runs `work` once the repository's earlier token requests have finished. A request that finds
   * the queue full, or waits longer than the queue allows, is refused without running.
   */
  async #inLane<T>(
    repo: ArtifactsRepoName,
    work: () => Promise<PortResult<T>>,
  ): Promise<PortResult<T>> {
    let lane = this.#lanes.get(repo);
    if (lane === undefined) {
      lane = { tail: Promise.resolve(), size: 0 };
      this.#lanes.set(repo, lane);
    }
    // The running request counts toward the size, so this admits it and `maxWaitingMints` more.
    if (lane.size > this.#limits.maxWaitingMints) {
      return fail("busy", "Too many token requests for the repository are waiting; try again.");
    }
    const current = lane;
    const turn = current.tail;
    const { promise: finished, resolve: release } = signal();
    current.tail = finished;
    current.size += 1;
    // The next request waits for this one's predecessor as well, even when this one gives up.
    const leave = (): void => {
      release();
      current.size -= 1;
      if (current.size === 0 && this.#lanes.get(repo) === current) this.#lanes.delete(repo);
    };
    if (!(await settlesWithin(turn, this.#limits.queueWaitMs))) {
      void turn.then(leave);
      return fail("busy", "An earlier token request for the repository is still running.");
    }
    try {
      return await work();
    } finally {
      leave();
    }
  }

  /** Marks a mint of `repo` unanswered, and records a fork's mint so a restart still sees it. */
  #beginMint(repo: ArtifactsRepoName, forkTtlMs: number | null): string | null {
    this.#unanswered.add(repo);
    if (forkTtlMs === null) return null;
    const id = crypto.randomUUID();
    const { sql } = this.#context.storage;
    const now = this.#context.clock();
    atomically(this.#context.storage, () => {
      sql.exec(
        "INSERT INTO artifacts_mints (id, repo, started_at, ttl_ms) VALUES (?, ?, ?, ?)",
        id,
        repo,
        now,
        forkTtlMs,
      );
      // Kept until any token the mint makes has expired, so a sweep can still place it.
      sql.exec("DELETE FROM artifacts_mint_log WHERE repo = ? AND keep_until <= ?", repo, now);
      sql.exec(
        "INSERT INTO artifacts_mint_log (mint_id, repo, keep_until) VALUES (?, ?, ?)",
        id,
        repo,
        now + forkTtlMs + MINT_CLOCK_SKEW_MS,
      );
    });
    this.#ownMints.add(id);
    return id;
  }

  #endMint(repo: ArtifactsRepoName, id: string | null): void {
    this.#unanswered.delete(repo);
    if (id === null) return;
    this.#ownMints.delete(id);
    atomically(this.#context.storage, () => {
      this.#context.storage.sql.exec("DELETE FROM artifacts_mints WHERE id = ?", id);
    });
  }

  /** Records the token a fork's mint answered with, before anyone is handed it. */
  #logToken(mint: string | null, tokenId: string): void {
    if (mint === null) return;
    atomically(this.#context.storage, () => {
      this.#context.storage.sql.exec(
        "UPDATE artifacts_mint_log SET token_id = ? WHERE mint_id = ?",
        tokenId,
        mint,
      );
    });
  }

  /**
   * How many mints of a previous incarnation of the Durable Object may still create a token on
   * `repo`. They can never answer, so each counts until its start, the lifetime it asked for and
   * `MINT_CLOCK_SKEW_MS` have passed, and its record is dropped then. A revocation reports success
   * only after a sweep that runs once none counts; a token created after that sweep escapes it.
   */
  #previousMints(repo: ArtifactsRepoName): number {
    return this.#mintsInFlight(repo, null).filter((id) => !this.#ownMints.has(id)).length;
  }

  /**
   * The ids of `repo`'s unanswered mints, this incarnation's and earlier ones', logged at or before
   * `through` when it is given. A mint recorded before the log existed counts as logged before any
   * cutoff. An earlier incarnation's mint past its start, requested lifetime and
   * `MINT_CLOCK_SKEW_MS` no longer counts, and its record is dropped.
   */
  #mintsInFlight(repo: ArtifactsRepoName, through: number | null): string[] {
    const storage = this.#context.storage;
    const rows = storage.sql
      .exec<{ id: string; started_at: number; ttl_ms: number }>(
        `SELECT m.id, m.started_at, m.ttl_ms FROM artifacts_mints m
         LEFT JOIN artifacts_mint_log l ON l.mint_id = m.id
         WHERE m.repo = ? AND (? IS NULL OR l.seq IS NULL OR l.seq <= ?)`,
        repo,
        through,
        through,
      )
      .toArray();
    const now = this.#context.clock();
    const over = rows.filter(
      (row) =>
        !this.#ownMints.has(row.id) && row.started_at + row.ttl_ms + MINT_CLOCK_SKEW_MS <= now,
    );
    if (over.length > 0) {
      atomically(storage, () => {
        for (const row of over) {
          storage.sql.exec("DELETE FROM artifacts_mints WHERE id = ?", row.id);
        }
      });
    }
    return rows.filter((row) => !over.includes(row)).map((row) => row.id);
  }

  /**
   * Which of `repo`'s live tokens `cutoff` covers. A token of a logged mint is covered when the mint
   * was logged at or before the cutoff. A token of no logged mint is covered when it was created
   * before the attempt began, less `MINT_CLOCK_SKEW_MS`, or when no later mint is unanswered, since
   * every later mint's token is logged once it answers. Any other is deferred to a later sweep.
   */
  #covered(
    repo: ArtifactsRepoName,
    cutoff: MintCutoff,
    active: readonly ArtifactsTokenInfo[],
  ): { revoke: ArtifactsTokenInfo[]; deferred: boolean } {
    const { sql } = this.#context.storage;
    const logged = new Map(
      sql
        .exec<{ token_id: string; seq: number }>(
          "SELECT token_id, seq FROM artifacts_mint_log WHERE repo = ? AND token_id IS NOT NULL",
          repo,
        )
        .toArray()
        .map((row) => [row.token_id, row.seq]),
    );
    const [later] = sql
      .exec<{ unanswered: number }>(
        `SELECT EXISTS (SELECT 1 FROM artifacts_mint_log
           WHERE repo = ? AND seq > ? AND token_id IS NULL AND keep_until > ?) AS unanswered`,
        repo,
        cutoff.seq,
        this.#context.clock(),
      )
      .toArray();
    const placedBefore = cutoff.startedAt - MINT_CLOCK_SKEW_MS;
    const revoke: ArtifactsTokenInfo[] = [];
    let deferred = false;
    for (const token of active) {
      const seq = logged.get(token.id);
      if (seq !== undefined) {
        if (seq <= cutoff.seq) revoke.push(token);
      } else if (later?.unanswered !== 1 || Date.parse(token.createdAt) < placedBefore) {
        revoke.push(token);
      } else {
        deferred = true;
      }
    }
    return { revoke, deferred };
  }

  /**
   * Records that `repo`'s last sweep could not see every token, under a new generation. Every token
   * minted before now has expired by `owed_until`, as a fork's tokens live at most
   * `MAX_TOKEN_TTL_MS` and none is minted while the debt stands. A repeat keeps the first deadline,
   * since nothing was minted in between.
   */
  #oweSweep(repo: ArtifactsRepoName): void {
    const now = this.#context.clock();
    atomically(this.#context.storage, () => {
      this.#context.storage.sql.exec(
        `INSERT INTO artifacts_token_debts (repo, owed_until, retry_at, generation)
         VALUES (?, ?, ?, 1)
         ON CONFLICT (repo) DO UPDATE SET
           retry_at = excluded.retry_at,
           generation = artifacts_token_debts.generation + 1`,
        repo,
        now + MAX_TOKEN_TTL_MS + MINT_CLOCK_SKEW_MS,
        now + TOKEN_DEBT_RETRY_MS,
      );
    });
  }

  /** The generation of `repo`'s outstanding debt, or `null` when it owes no sweep. */
  #debtGeneration(repo: ArtifactsRepoName): number | null {
    const [debt] = this.#context.storage.sql
      .exec<{ generation: number }>(
        "SELECT generation FROM artifacts_token_debts WHERE repo = ?",
        repo,
      )
      .toArray();
    return debt?.generation ?? null;
  }

  /**
   * Clears `repo`'s debt if it is still the generation a clean sweep saw before listing. A newer
   * generation was recorded by a partial sweep that may have listed after it, so it stands.
   */
  #clearDebt(repo: ArtifactsRepoName, seen: number): void {
    atomically(this.#context.storage, () => {
      this.#context.storage.sql.exec(
        "DELETE FROM artifacts_token_debts WHERE repo = ? AND generation = ?",
        repo,
        seen,
      );
    });
  }

  /** Drops `repo`'s debt once every token it may hold from before the debt began has expired. */
  #dropExpiredDebt(repo: ArtifactsRepoName): void {
    atomically(this.#context.storage, () => {
      this.#context.storage.sql.exec(
        "DELETE FROM artifacts_token_debts WHERE repo = ? AND owed_until <= ?",
        repo,
        this.#context.clock(),
      );
    });
  }

  /**
   * Lets a mint on `repo` proceed only once the fork owes no sweep. A debt ends when its deadline
   * passes or a sweep sees every token; a token request sweeps again at most once per
   * `TOKEN_DEBT_RETRY_MS`, and is refused as busy meanwhile.
   */
  async #settleDebt(repo: ArtifactsRepoName): Promise<PortResult<void>> {
    const storage = this.#context.storage;
    const [debt] = storage.sql
      .exec<{ owed_until: number; retry_at: number; generation: number }>(
        "SELECT owed_until, retry_at, generation FROM artifacts_token_debts WHERE repo = ?",
        repo,
      )
      .toArray();
    if (debt === undefined) return ok(undefined);
    const now = this.#context.clock();
    const owing = owingDebt();
    if (debt.owed_until <= now) {
      this.#dropExpiredDebt(repo);
      return ok(undefined);
    }
    if (debt.retry_at > now) return owing;
    // Pushed back before the sweep, so a sweep that throws is not repeated at once either.
    atomically(storage, () => {
      storage.sql.exec(
        "UPDATE artifacts_token_debts SET retry_at = ? WHERE repo = ?",
        now + TOKEN_DEBT_RETRY_MS,
        repo,
      );
    });
    let epoch = 0;
    const swept = await this.#fenced(repo, async () => {
      epoch = this.#epoch(repo);
      using handle = await this.#open(repo);
      return await sweepTokens(handle, this.#limits);
    });
    if (swept === "partial") return owing;
    if (swept !== "clean") return swept;
    // A release or takeover that revoked during this sweep may have finished already; the request
    // that began before it gets no token, and that revocation settles the debt by its own result.
    if (this.#epoch(repo) !== epoch) {
      return fail("busy", "The repository's tokens were revoked while its debt was settled.");
    }
    // A sweep that began before this one may have recorded a newer debt meanwhile; that one stands.
    this.#clearDebt(repo, debt.generation);
    return this.#debtGeneration(repo) === null ? ok(undefined) : owing;
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
    if (!swept.ok) throw new UnrevokedTokens(swept);
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

  #revokeActive(handle: ArtifactsRepoHandle): Promise<PortResult<void>> {
    return revokeActiveTokens(handle, this.#limits);
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

  #bounded<T>(work: Promise<T>, options: BoundedOptions<T> = {}): Promise<T> {
    return boundedCall(work, options.timeoutMs ?? this.#limits.callTimeoutMs, options.late);
  }
}

/**
 * Waits for `work` up to `timeoutMs`, then rejects with `CallTimedOut`. The call keeps running, so
 * `late` takes over any result that holds a resource.
 */
export async function boundedCall<T>(
  work: Promise<T>,
  timeoutMs: number,
  late?: (pending: Promise<T>) => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      late?.(work);
      reject(new CallTimedOut());
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The failure of a sweep whose listing showed no live token but did not cover every token. The
 * listing has no page argument, so the rest cannot be reached and a retry would see the same page.
 */
export const PARTIAL_TOKEN_LISTING: PortFailure = fail(
  "internal",
  "Artifacts listed only part of the repository's tokens, so the rest cannot be checked for live ones.",
);

/**
 * Revokes every live token on `handle`'s repository, within a total deadline and revocation
 * budget. Running out of either while live tokens are still listed reports busy; a repeat
 * continues where this one stopped. A binding call that fails or times out throws.
 *
 * `listTokens` returns one page and takes no page argument, so the sweep revokes the live tokens
 * it can see and lists again. It reports the repository clean only from a listing that shows no
 * live token and whose page covers `total`. A listing that shows no live token but covers less
 * than `total` fails with `PARTIAL_TOKEN_LISTING` instead of busy: `total` likely counts revoked
 * and expired tokens too, so if the page keeps those, no repeat would ever see further. Whether the
 * binding's page keeps or drops revoked tokens is not verified; #161 qualifies it against live
 * Artifacts. A claim's revocation does not fail on a partial listing: it reports `pending_debt`.
 */
export async function revokeActiveTokens(
  handle: Pick<ArtifactsRepo, "listTokens" | "revokeToken">,
  limits: TokenSweepLimits,
): Promise<PortResult<void>> {
  const swept = await sweepTokens(handle, limits);
  if (swept === "clean") return ok(undefined);
  return swept === "partial" ? { ...PARTIAL_TOKEN_LISTING } : swept;
}

/**
 * `revokeActiveTokens`, with a partial listing told apart from other failures, revoking only the
 * live tokens `select` picks from each listing. It is `clean` once a listing that covers every
 * token shows none of those.
 */
async function sweepTokens(
  handle: Pick<ArtifactsRepo, "listTokens" | "revokeToken">,
  limits: TokenSweepLimits,
  select: (active: ArtifactsTokenInfo[]) => readonly ArtifactsTokenInfo[] = (active) => active,
): Promise<"clean" | "partial" | PortFailure> {
  const unfinished = fail("busy", "The repository still has live tokens; try again.");
  // Wall time, like the per-call timer; an injected clock need not move while calls run.
  const deadline = Date.now() + limits.sweepDeadlineMs;
  const remaining = (): number => Math.min(limits.callTimeoutMs, deadline - Date.now());
  let budget = limits.maxRevokesPerSweep;
  for (let round = 0; round < MAX_REVOKE_ROUNDS; round += 1) {
    if (remaining() <= 0) return unfinished;
    const listed = await boundedCall(handle.listTokens(), remaining());
    const revoke = select(listed.tokens.filter((token) => token.state === "active"));
    if (revoke.length === 0) {
      return listed.total <= listed.tokens.length ? "clean" : "partial";
    }
    for (const token of revoke) {
      if (budget === 0 || remaining() <= 0) return unfinished;
      budget -= 1;
      await boundedCall(handle.revokeToken(token.id), remaining());
    }
  }
  return unfinished;
}

/**
 * The names of every fork the adapter recorded in `storage`, pending or ready, in name order. It
 * brings the adapter's table up to date first, so it throws rather than answer from a schema newer
 * than this code knows.
 */
export function recordedForks(storage: RepoStorage): ArtifactsRepoName[] {
  migrate(storage, ARTIFACTS_OWNER, MIGRATIONS);
  return storage.sql
    .exec<{ repo: string }>("SELECT repo FROM artifacts_forks ORDER BY repo")
    .toArray()
    .map((row) => row.repo);
}

/**
 * The cutoff of a revocation attempt beginning at `startedAt`: every fork mint logged so far, and
 * none logged later, since the log's sequence only grows. Read it in the transaction that starts
 * the attempt. It brings the adapter's tables up to date first, like `recordedForks`.
 */
export function mintCutoff(storage: RepoStorage, startedAt: number): MintCutoff {
  migrate(storage, ARTIFACTS_OWNER, MIGRATIONS);
  const [row] = storage.sql
    .exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) AS seq FROM artifacts_mint_log")
    .toArray();
  return { seq: row?.seq ?? 0, startedAt };
}

/** A promise and the function that resolves it. */
function signal(): { promise: Promise<void>; resolve: () => void } {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: () => settle?.() };
}

/** Whether `work` settles within `ms` milliseconds of wall time. */
async function settlesWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, ms);
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** A fork's live tokens could not all be revoked, so it must not be used yet. */
class UnrevokedTokens extends Error {
  /** The sweep's failure, reported as the request's. */
  readonly failure: PortFailure;

  constructor(failure: PortFailure) {
    super("fork still has live tokens");
    this.name = "UnrevokedTokens";
    this.failure = failure;
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
export function artifactsCode(error: unknown): ArtifactsErrorCode | null {
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
  if (error instanceof UnrevokedTokens) return error.failure;
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

function owingDebt(): PortFailure {
  return fail("busy", "The repository's earlier tokens are not all revoked yet; try again.");
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
