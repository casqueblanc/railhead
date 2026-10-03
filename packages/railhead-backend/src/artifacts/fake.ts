// A controllable in-memory Artifacts namespace for tests of the adapter and its consumers. It keeps
// the binding's observable contract (initial token on fork, token states and expiry, `null` for a
// missing commit, `ArtifactsError` codes) and adds switches for the failures a real service shows
// rarely: a lost fork response, a hung or late call, slow revocations, and a fork still in
// progress. It proves nothing about
// the deployed service's revocation timing or limits; that evidence is H04's.

import type { ArtifactsNamespace, ArtifactsRepoHandle } from "./adapter";

/** The error the fake throws, shaped like the binding's `ArtifactsError`. */
export class FakeArtifactsError extends Error {
  /** The binding's error code. */
  readonly code: ArtifactsErrorCode;

  constructor(code: ArtifactsErrorCode) {
    super(`fake Artifacts: ${code}`);
    this.name = "ArtifactsError";
    this.code = code;
  }
}

/** One token the fake has minted. */
export interface FakeToken {
  /** The token's id. */
  readonly id: string;
  /** Its secret value. */
  readonly plaintext: string;
  /** What it allows. */
  readonly scope: "read" | "write";
  /** When it stops working, in fake-clock milliseconds. */
  readonly expiresAtMs: number;
  /** Whether it was revoked. */
  revoked: boolean;
}

/** One repository in the fake namespace. */
export interface FakeRepo {
  /** Commits on the default branch, oldest first. */
  readonly commits: string[];
  /** Every token minted for it, revoked or not. */
  readonly tokens: FakeToken[];
  /** True while the fake reports the repository as still forking. */
  forking: boolean;
  /** The ref `HEAD` names. Only `refs/heads/main` holds `commits`; any other ref is empty. */
  headRef: string;
}

/** How a paged `listTokens` chooses its tokens. */
export type TokenPageOrder =
  /** The first tokens in creation order, whatever their state. */
  | "creation"
  /** Live tokens first, then the others, each in creation order. */
  | "live-first";

/** How the next `fork` call misbehaves. */
export type ForkFault =
  /** The fork is created, then the call throws as if the response were lost. */
  | "lose-response"
  /** The fork is created, then the call never answers. */
  | "hang-after-create"
  /** The call never answers and creates nothing. */
  | "hang";

/** A point in a fake call where `pauseNext` can hold it. */
export type PausableCall =
  /** `get`, after the handle is open. */
  | "get"
  /** `createToken`, after the token is minted. */
  | "createToken"
  /** `createToken`, before anything is minted, as a request whose effect is delayed. */
  | "createTokenBeforeMint"
  /** `listTokens`, before it lists. */
  | "listTokens";

interface Gate {
  held: Promise<void>;
  reach: () => void;
}

/** A fake Artifacts namespace whose clock, failures and contents a test controls. */
export class FakeArtifacts implements ArtifactsNamespace {
  /** Repositories by name. */
  readonly repos = new Map<string, FakeRepo>();
  /** Handles opened and not yet disposed. */
  openHandles = 0;
  /** How many `fork` calls reached the fake. */
  forkCalls = 0;
  /** How many `createToken` calls reached the fake, whether or not they minted. */
  createTokenCalls = 0;
  /** How many tokens were minted with `createToken`. */
  tokensMinted = 0;
  /** How many `listTokens` calls reached the fake. */
  listTokensCalls = 0;
  #now: number;
  #nextId = 1;
  #forkFaults: ForkFault[] = [];
  #revokeFails = 0;
  #revokeDelayMs = 0;
  #tokenPage: { size: number; order: TokenPageOrder } | null = null;
  readonly #gates = new Map<PausableCall, Gate>();

  constructor(now = 1_000_000) {
    this.#now = now;
  }

  /** The fake's clock, to pass to the adapter as its `clock`. */
  readonly clock = (): number => this.#now;

  /** Moves the clock forward. */
  advance(ms: number): void {
    this.#now += ms;
  }

  /** Creates a repository whose default branch holds `commits`, oldest first. */
  seed(name: string, commits: string[]): FakeRepo {
    const repo: FakeRepo = {
      commits: [...commits],
      tokens: [],
      forking: false,
      headRef: "refs/heads/main",
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** Makes the next `fork` call misbehave as `fault`. */
  failNextFork(fault: ForkFault): void {
    this.#forkFaults.push(fault);
  }

  /** Makes the next `count` `revokeToken` calls answer `false` without revoking. */
  failRevocations(count: number): void {
    this.#revokeFails = count;
  }

  /** Makes every `revokeToken` call take `ms` milliseconds of wall time before it answers. */
  slowRevocations(ms: number): void {
    this.#revokeDelayMs = ms;
  }

  /**
   * Makes `listTokens` return at most `size` tokens, chosen by `order`, with `total` still counting
   * every token, revoked and expired ones too; `null` lists them all. Which order the binding uses,
   * and whether it keeps revoked tokens, is not known, so tests cover both.
   */
  pageTokens(size: number | null, order: TokenPageOrder = "creation"): void {
    this.#tokenPage = size === null ? null : { size, order };
  }

  /**
   * Holds the next call at `call` until `release` is called, so a test can act while it is in
   * flight. `reached` resolves once the call is held.
   */
  pauseNext(call: PausableCall): { reached: Promise<void>; release: () => void } {
    let release: (() => void) | undefined;
    let reach: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    this.#gates.set(call, {
      held: new Promise<void>((resolve) => {
        release = resolve;
      }),
      reach: () => reach?.(),
    });
    return { reached, release: () => release?.() };
  }

  /** Mints a live token on `name` directly, as another holder of the repository would. */
  mintFor(name: string, scope: "read" | "write", ttlSeconds: number): FakeToken {
    const repo = this.repos.get(name);
    if (repo === undefined) throw new FakeArtifactsError("NOT_FOUND");
    return this.#mint(repo, scope, ttlSeconds);
  }

  /** Whether `plaintext` would be accepted by the fake's Git endpoint now. */
  accepts(plaintext: string): boolean {
    for (const repo of this.repos.values()) {
      for (const token of repo.tokens) {
        if (token.plaintext === plaintext) return !token.revoked && token.expiresAtMs > this.#now;
      }
    }
    return false;
  }

  /** The tokens of `name` that are neither revoked nor expired. */
  liveTokens(name: string): FakeToken[] {
    return (this.repos.get(name)?.tokens ?? []).filter(
      (token) => !token.revoked && token.expiresAtMs > this.#now,
    );
  }

  async get(name: string): Promise<ArtifactsRepoHandle> {
    const repo = this.repos.get(name);
    if (repo === undefined) throw new FakeArtifactsError("NOT_FOUND");
    if (repo.forking) throw new FakeArtifactsError("FORK_IN_PROGRESS");
    this.openHandles += 1;
    const handle = this.#handle(repo);
    await this.#hold("get");
    return handle;
  }

  async #hold(call: PausableCall): Promise<void> {
    const gate = this.#gates.get(call);
    if (gate === undefined) return;
    this.#gates.delete(call);
    gate.reach();
    await gate.held;
  }

  #mint(repo: FakeRepo, scope: "read" | "write", ttlSeconds: number): FakeToken {
    const id = `tok_${this.#nextId}`;
    const token: FakeToken = {
      id,
      plaintext: `secret-${this.#nextId}-${crypto.randomUUID()}`,
      scope,
      expiresAtMs: this.#now + ttlSeconds * 1000,
      revoked: false,
    };
    this.#nextId += 1;
    repo.tokens.push(token);
    return token;
  }

  #handle(repo: FakeRepo): ArtifactsRepoHandle {
    let disposed = false;
    const live = (): void => {
      if (disposed) throw new Error("fake Artifacts handle used after dispose");
    };
    return {
      [Symbol.dispose]: () => {
        if (!disposed) this.openHandles -= 1;
        disposed = true;
      },
      fork: async (name) => {
        live();
        this.forkCalls += 1;
        const fault = this.#forkFaults.shift();
        if (fault === "hang") return new Promise(() => {});
        if (this.repos.has(name)) throw new FakeArtifactsError("ALREADY_EXISTS");
        const fork = this.seed(name, repo.commits);
        const initial = this.#mint(fork, "write", 86_400);
        if (fault === "lose-response") throw new FakeArtifactsError("INTERNAL_ERROR");
        if (fault === "hang-after-create") return new Promise(() => {});
        return {
          id: name,
          name,
          description: null,
          defaultBranch: "main",
          remote: `https://fake.artifacts.invalid/${name}.git`,
          token: initial.plaintext,
        };
      },
      createToken: async (scope = "write", ttl = 86_400) => {
        live();
        if (!Number.isInteger(ttl) || ttl < 60 || ttl > 31_536_000) {
          throw new FakeArtifactsError("INVALID_TTL");
        }
        this.createTokenCalls += 1;
        await this.#hold("createTokenBeforeMint");
        this.tokensMinted += 1;
        const token = this.#mint(repo, scope, ttl);
        await this.#hold("createToken");
        return {
          id: token.id,
          plaintext: token.plaintext,
          scope,
          expiresAt: new Date(token.expiresAtMs).toISOString(),
        };
      },
      listTokens: async () => {
        live();
        this.listTokensCalls += 1;
        await this.#hold("listTokens");
        const tokens = repo.tokens.map((token) => ({
          id: token.id,
          scope: token.scope,
          state: tokenState(token, this.#now),
          createdAt: new Date(this.#now).toISOString(),
          expiresAt: new Date(token.expiresAtMs).toISOString(),
        }));
        const page = this.#tokenPage;
        if (page === null) return { tokens, total: tokens.length };
        const ordered =
          page.order === "creation"
            ? tokens
            : [
                ...tokens.filter((token) => token.state === "active"),
                ...tokens.filter((token) => token.state !== "active"),
              ];
        return { tokens: ordered.slice(0, page.size), total: tokens.length };
      },
      revokeToken: async (tokenOrId) => {
        live();
        if (tokenOrId === "") throw new FakeArtifactsError("INVALID_INPUT");
        if (this.#revokeDelayMs > 0) await wait(this.#revokeDelayMs);
        if (this.#revokeFails > 0) {
          this.#revokeFails -= 1;
          return false;
        }
        const token = repo.tokens.find(
          (candidate) => candidate.id === tokenOrId || candidate.plaintext === tokenOrId,
        );
        if (token === undefined) return false;
        token.revoked = true;
        return true;
      },
      readCommit: async (hash) => {
        live();
        if (!/^[0-9a-f]{40}$/.test(hash)) throw new FakeArtifactsError("INVALID_INPUT");
        if (!repo.commits.includes(hash)) return null;
        return {
          hash,
          treeHash: hash,
          message: "fake commit",
          author: { name: "fake", email: "fake@example.invalid" },
          committer: { name: "fake", email: "fake@example.invalid" },
          parents: [],
          authoredAt: 0,
          committedAt: 0,
        };
      },
      log: async (opts) => {
        live();
        const limit = opts?.limit ?? 50;
        const ref = opts?.ref === undefined || opts.ref === "HEAD" ? repo.headRef : opts.ref;
        const commits = ref === "refs/heads/main" || ref === "main" ? repo.commits : [];
        return commits
          .toReversed()
          .slice(0, limit)
          .map((hash) => ({
            hash,
            treeHash: hash,
            message: "fake commit",
            author: { name: "fake", email: "fake@example.invalid" },
            committer: { name: "fake", email: "fake@example.invalid" },
            parents: [],
            authoredAt: 0,
            committedAt: 0,
          }));
      },
    };
  }
}

function tokenState(token: FakeToken, now: number): "active" | "expired" | "revoked" {
  if (token.revoked) return "revoked";
  return token.expiresAtMs > now ? "active" : "expired";
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
