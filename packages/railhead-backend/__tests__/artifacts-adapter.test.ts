import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACTS_LIMITS,
  createArtifactsAdapter,
  MAX_LIVE_FORK_TOKENS,
  MINT_CLOCK_SKEW_MS,
  forkRepoName,
  mainRepoName,
  mintCutoff,
  PARTIAL_TOKEN_LISTING,
  recordedForks,
  TOKEN_PAGE_SIZE,
  type ArtifactsAdapterLimits,
} from "../src/artifacts/adapter";
import { FakeArtifacts } from "../src/artifacts/fake";
import type { ArtifactsPort, MintCutoff } from "../src/contracts/artifacts";
import { migrate, type RepoStorage } from "../src/repo/storage";

const REPO = "rep_aaaaaaaaaaaa";
const OTHER_REPO = "rep_bbbbbbbbbbbb";
const CLAIM = "clm_claim0001";
const SECOND_CLAIM = "clm_claim0002";
const ROOT = "1".repeat(40);
const HEAD = "2".repeat(40);
const MISSING = "3".repeat(40);
const MINUTE = 60_000;
const REVOKED = { ok: true, value: "revoked" };
const PENDING_DEBT = { ok: true, value: "pending_debt" };

const FAST: ArtifactsAdapterLimits = {
  ...ARTIFACTS_LIMITS,
  callTimeoutMs: 50,
  sweepDeadlineMs: 1_000,
};

interface Setup {
  fake: FakeArtifacts;
  storage: RepoStorage;
  adapter: (repoId?: string, limits?: ArtifactsAdapterLimits) => ArtifactsPort;
  main: string;
}

// The storage and clock of the running test, for `cutoffNow`.
let running: { storage: RepoStorage; fake: FakeArtifacts } | null = null;

/** The cutoff of a revocation beginning now in the running test, as the claims module captures it. */
function cutoffNow(): MintCutoff {
  if (running === null) throw new Error("no test is running");
  return mintCutoff(running.storage, running.fake.clock());
}

/** Runs `body` with a fake namespace holding this repository's main, and storage no other test uses. */
function withArtifacts(body: (setup: Setup) => Promise<void>): Promise<void> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const fake = new FakeArtifacts();
    running = { storage: state.storage, fake };
    const main = await mainRepoName(REPO);
    fake.seed(main, [ROOT, HEAD]);
    const adapter = (repoId = REPO, limits = FAST): ArtifactsPort =>
      createArtifactsAdapter(
        { repoId, storage: state.storage, clock: fake.clock, namespace: fake },
        limits,
      );
    await body({ fake, storage: state.storage, adapter, main });
    expect(fake.openHandles).toBe(0);
  });
}

function forkRows(
  storage: RepoStorage,
): { claim_id: string; state: string; head: string | null }[] {
  return storage.sql
    .exec<{ claim_id: string; state: string; head: string | null }>(
      "SELECT claim_id, state, head FROM artifacts_forks ORDER BY claim_id",
    )
    .toArray();
}

function mintRows(storage: RepoStorage): number {
  return storage.sql.exec("SELECT 1 FROM artifacts_mints").toArray().length;
}

/** Forks `CLAIM` and returns the fork's name. */
async function forkClaim(port: ArtifactsPort): Promise<string> {
  const result = await port.forkForClaim(CLAIM, HEAD);
  if (!result.ok) throw new Error(`fork refused: ${result.code}`);
  return result.value.repo;
}

async function tokenValue(
  adapter: ArtifactsPort,
  repo: string,
  scope: "read" | "write",
): Promise<string> {
  const result = await adapter.token(repo, scope, 10 * MINUTE);
  if (!result.ok) throw new Error(`token refused: ${result.code}`);
  return result.value.value;
}

describe("forkForClaim", () => {
  it("forks main, revokes the initial token and returns the fork's head", async () => {
    await withArtifacts(async ({ fake, storage, adapter }) => {
      const port = adapter();
      const repo = await forkRepoName(REPO, CLAIM);

      expect(await port.forkForClaim(CLAIM, HEAD)).toEqual({
        ok: true,
        value: { repo, head: HEAD },
      });
      expect(fake.repos.get(repo)?.tokens).toHaveLength(1);
      expect(fake.liveTokens(repo)).toEqual([]);
      expect(forkRows(storage)).toEqual([{ claim_id: CLAIM, state: "ready", head: HEAD }]);
    });
  });

  it("returns the same fork on a repeat without forking again, also after a restart", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const first = await adapter().forkForClaim(CLAIM, HEAD);
      const again = await adapter().forkForClaim(CLAIM, HEAD);

      expect(again).toEqual(first);
      expect(fake.forkCalls).toBe(1);
    });
  });

  it("shares one attempt between concurrent requests for a claim", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const [a, b] = await Promise.all([
        port.forkForClaim(CLAIM, HEAD),
        port.forkForClaim(CLAIM, HEAD),
      ]);

      expect(a.ok && b.ok).toBe(true);
      expect(b).toEqual(a);
      expect(fake.forkCalls).toBe(1);
    });
  });

  it("refuses a malformed claim or base without calling Artifacts", async () => {
    await withArtifacts(async ({ fake, storage, adapter }) => {
      const port = adapter();

      expect(await port.forkForClaim("iss_claim0001", HEAD)).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(await port.forkForClaim(CLAIM, "HEAD")).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(fake.forkCalls).toBe(0);
      expect(forkRows(storage)).toEqual([]);
    });
  });

  it("reconciles a fork whose response was lost and revokes the token it never saw", async () => {
    await withArtifacts(async ({ fake, storage, adapter }) => {
      const repo = await forkRepoName(REPO, CLAIM);
      fake.failNextFork("lose-response");

      expect(await adapter().forkForClaim(CLAIM, HEAD)).toMatchObject({
        ok: false,
        code: "internal",
      });
      expect(fake.liveTokens(repo)).toHaveLength(1);
      expect(forkRows(storage)).toEqual([{ claim_id: CLAIM, state: "pending", head: null }]);
      // A pending fork is not usable.
      expect(await adapter().token(repo, "write", 10 * MINUTE)).toMatchObject({
        code: "not_found",
      });

      // A fresh adapter, as after the Durable Object restarts, adopts the fork.
      expect(await adapter().forkForClaim(CLAIM, HEAD)).toEqual({
        ok: true,
        value: { repo, head: HEAD },
      });
      expect(fake.forkCalls).toBe(1);
      expect(fake.liveTokens(repo)).toEqual([]);
    });
  });

  it("keeps a reconciled fork pending while its token listing is partial", async () => {
    await withArtifacts(async ({ fake, storage, adapter }) => {
      const repo = await forkRepoName(REPO, CLAIM);
      fake.failNextFork("lose-response");
      expect(await adapter().forkForClaim(CLAIM, HEAD)).toMatchObject({ ok: false });
      const live = [...fake.liveTokens(repo), fake.mintFor(repo, "write", 600)];

      // As if Artifacts stopped listing tokens: the page shows none of the two.
      fake.pageTokens(0);
      expect(await adapter().forkForClaim(CLAIM, HEAD)).toEqual(PARTIAL_TOKEN_LISTING);
      expect(fake.liveTokens(repo)).toEqual(live);
      expect(forkRows(storage)).toEqual([{ claim_id: CLAIM, state: "pending", head: null }]);

      fake.pageTokens(TOKEN_PAGE_SIZE);
      expect(await adapter().forkForClaim(CLAIM, HEAD)).toEqual({
        ok: true,
        value: { repo, head: HEAD },
      });
      expect(fake.liveTokens(repo)).toEqual([]);
      expect(fake.forkCalls).toBe(1);
    });
  });

  it("treats a timed-out fork as uncertain and adopts it on the next request", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const repo = await forkRepoName(REPO, CLAIM);
      fake.failNextFork("hang-after-create");
      const port = adapter();

      expect(await port.forkForClaim(CLAIM, HEAD)).toMatchObject({ ok: false, code: "busy" });
      expect(await port.forkForClaim(CLAIM, HEAD)).toMatchObject({ ok: true, value: { repo } });
      expect(fake.forkCalls).toBe(1);
      expect(fake.liveTokens(repo)).toEqual([]);
    });
  });

  it("forks again when the timed-out attempt created nothing", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      fake.failNextFork("hang");
      const port = adapter();

      expect(await port.forkForClaim(CLAIM, HEAD)).toMatchObject({ ok: false, code: "busy" });
      expect(await port.forkForClaim(CLAIM, HEAD)).toMatchObject({ ok: true });
      expect(fake.forkCalls).toBe(2);
    });
  });

  it("sweeps the fork's tokens when revoking the initial one by value fails", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const repo = await forkRepoName(REPO, CLAIM);
      fake.failRevocations(1);

      expect(await adapter().forkForClaim(CLAIM, HEAD)).toMatchObject({ ok: true });
      expect(fake.liveTokens(repo)).toEqual([]);
    });
  });

  it("keeps the fork unusable while its initial token stays live", async () => {
    await withArtifacts(async ({ fake, storage, adapter }) => {
      const repo = await forkRepoName(REPO, CLAIM);
      fake.failRevocations(100);

      expect(await adapter().forkForClaim(CLAIM, HEAD)).toMatchObject({ ok: false, code: "busy" });
      expect(forkRows(storage)).toEqual([{ claim_id: CLAIM, state: "pending", head: null }]);
      expect(await adapter().commitExists(repo, HEAD)).toMatchObject({ code: "not_found" });
    });
  });

  it("reports a missing main repository", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      fake.repos.delete(main);

      expect(await adapter().forkForClaim(CLAIM, HEAD)).toMatchObject({
        ok: false,
        code: "not_found",
      });
    });
  });
});

describe("commitExists", () => {
  it("finds a commit on a fork and on main, and not a missing one", async () => {
    await withArtifacts(async ({ adapter, main }) => {
      const port = adapter();
      const forked = await port.forkForClaim(CLAIM, HEAD);
      if (!forked.ok) throw new Error("fork failed");

      expect(await port.commitExists(forked.value.repo, ROOT)).toEqual({ ok: true, value: true });
      expect(await port.commitExists(forked.value.repo, MISSING)).toEqual({
        ok: true,
        value: false,
      });
      expect(await port.commitExists(main, HEAD)).toEqual({ ok: true, value: true });
    });
  });

  it("refuses a malformed commit id and a repository it does not own", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      fake.seed("someone-else", [HEAD]);
      const port = adapter();

      expect(await port.commitExists(main, "abc")).toMatchObject({ code: "invalid_request" });
      expect(await port.commitExists("someone-else", HEAD)).toMatchObject({ code: "not_found" });
    });
  });

  it("reports a repository that is still forking as busy", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      const port = adapter();
      const repo = fake.repos.get(main);
      if (repo === undefined) throw new Error("main missing");
      repo.forking = true;

      expect(await port.commitExists(main, HEAD)).toMatchObject({ ok: false, code: "busy" });
    });
  });
});

describe("token", () => {
  it("mints a read token for main with the requested lifetime and refuses write", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      const port = adapter();
      const read = await port.token(main, "read", 2 * MINUTE);

      expect(read).toMatchObject({
        ok: true,
        value: { scope: "read", repo: main, expiresAt: fake.clock() + 2 * MINUTE },
      });
      expect(read.ok && fake.accepts(read.value.value)).toBe(true);
      expect(await port.token(main, "write", 2 * MINUTE)).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(fake.liveTokens(main).map((token) => token.scope)).toEqual(["read"]);
    });
  });

  it("accepts lifetimes only from one minute to one hour, in whole milliseconds", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      const port = adapter();

      for (const ttl of [MINUTE - 1, 60 * MINUTE + 1, 90_000.5, Number.NaN]) {
        expect(await port.token(main, "read", ttl)).toMatchObject({ code: "invalid_request" });
      }
      expect(fake.tokensMinted).toBe(0);
      expect(await port.token(main, "read", MINUTE)).toMatchObject({ ok: true });
      expect(await port.token(main, "write", 60 * MINUTE)).toMatchObject({
        code: "invalid_request",
      });
      expect(fake.tokensMinted).toBe(1);
    });
  });

  it("reuses a cached token until half its lifetime is gone, then mints a new one", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const forked = await port.forkForClaim(CLAIM, HEAD);
      if (!forked.ok) throw new Error("fork failed");
      const repo = forked.value.repo;

      const first = await tokenValue(port, repo, "write");
      expect(await tokenValue(port, repo, "write")).toBe(first);
      expect(await tokenValue(port, repo, "read")).not.toBe(first);
      expect(fake.tokensMinted).toBe(2);

      fake.advance(5 * MINUTE + 1);
      const renewed = await tokenValue(port, repo, "write");
      expect(renewed).not.toBe(first);
      expect(fake.tokensMinted).toBe(3);

      // The first token expires on its own; the fake no longer accepts it.
      fake.advance(5 * MINUTE);
      expect(fake.accepts(first)).toBe(false);
      expect(fake.accepts(renewed)).toBe(true);
    });
  });

  it("mints one token for concurrent requests with the same scope", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);

      const values = await Promise.all(
        Array.from({ length: 5 }, () => tokenValue(port, repo, "write")),
      );
      expect(new Set(values).size).toBe(1);
      expect(fake.tokensMinted).toBe(1);
    });
  });

  it("holds a bounded number of cached tokens", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      const port = adapter(REPO, { ...FAST, maxCachedTokens: 1 });
      const forked = await port.forkForClaim(CLAIM, HEAD);
      if (!forked.ok) throw new Error("fork failed");

      const first = await tokenValue(port, main, "read");
      await tokenValue(port, forked.value.repo, "read");
      expect(await tokenValue(port, main, "read")).not.toBe(first);
      expect(fake.tokensMinted).toBe(3);
    });
  });
});

describe("revokeTokens", () => {
  it("revokes every live token, and a successor never receives the predecessor's", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const forked = await port.forkForClaim(CLAIM, HEAD);
      if (!forked.ok) throw new Error("fork failed");
      const repo = forked.value.repo;
      const predecessor = await tokenValue(port, repo, "write");
      const reader = await tokenValue(port, repo, "read");

      // Takeover: claims revokes the fork's tokens, then the successor asks for one.
      expect(await port.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
      expect(fake.accepts(predecessor)).toBe(false);
      expect(fake.accepts(reader)).toBe(false);

      const successor = await tokenValue(port, repo, "write");
      expect(successor).not.toBe(predecessor);
      expect(fake.liveTokens(repo).map((token) => token.plaintext)).toEqual([successor]);
    });
  });

  it("revokes a fork's tokens at the bound from one listing that covers them all", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      const held = Array.from({ length: MAX_LIVE_FORK_TOKENS }, () =>
        fake.mintFor(repo, "write", 600),
      );
      const lists = fake.listTokensCalls;

      expect(await port.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
      expect(held.some((token) => fake.accepts(token.plaintext))).toBe(false);
      // The first listing showed every token; the second confirmed none was left.
      expect(fake.listTokensCalls).toBe(lists + 2);
    });
  });

  it("fails loudly when newer tokens beyond the bound hide a covered one", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const port = adapter();
        const repo = await forkClaim(port);
        const holder = await tokenValue(port, repo, "write");
        const cutoff = cutoffNow();
        // A later mint is unanswered, so tokens of no logged mint created now cannot be placed.
        const paused = fake.pauseNext("createTokenBeforeMint");
        const minting = port.token(repo, "read", 10 * MINUTE);
        await paused.reached;
        fake.advance(1);
        for (let i = 0; i < TOKEN_PAGE_SIZE; i += 1) fake.mintFor(repo, "write", 600);

        // The page holds the newest 30, none covered, and hides the holder's: no revocation.
        expect(await port.revokeTokens(repo, cutoff)).toEqual(PARTIAL_TOKEN_LISTING);
        expect(fake.accepts(holder)).toBe(true);
        expect(errors).toHaveBeenCalledWith(
          JSON.stringify({ event: "artifacts.partial_token_listing", total: 31, listed: 30 }),
        );
        paused.release();
        expect(await minting).toMatchObject({ ok: false, code: "busy" });
      } finally {
        errors.mockRestore();
      }
    });
  });

  it("fails loudly, and mints nothing, while a listing covers less than its total", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const port = adapter();
        const repo = await forkClaim(port);
        const holder = await tokenValue(port, repo, "write");

        // As if Artifacts stopped listing tokens: the page shows none of the one live token.
        fake.pageTokens(0);
        expect(await port.revokeTokens(repo, cutoffNow())).toEqual(PARTIAL_TOKEN_LISTING);
        expect(fake.accepts(holder)).toBe(true);
        expect(await port.token(repo, "read", 10 * MINUTE)).toEqual(PARTIAL_TOKEN_LISTING);
        expect(fake.createTokenCalls).toBe(1);
        expect(errors).toHaveBeenCalledTimes(2);

        // Nothing was recorded against the fork: once the listing is whole, the release succeeds.
        fake.pageTokens(TOKEN_PAGE_SIZE);
        expect(await port.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
        expect(fake.accepts(holder)).toBe(false);
      } finally {
        errors.mockRestore();
      }
    });
  });

  it("refuses a fork mint as busy at the bound, and mints again once a token expires", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      for (let i = 0; i < MAX_LIVE_FORK_TOKENS - 1; i += 1) fake.mintFor(repo, "write", 300);

      // One short of the bound, the mint goes ahead and reaches it.
      const writer = await tokenValue(port, repo, "write");
      expect(fake.liveTokens(repo)).toHaveLength(MAX_LIVE_FORK_TOKENS);
      expect(await port.token(repo, "read", 10 * MINUTE)).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(fake.createTokenCalls).toBe(1);
      // A cached token is still served, since serving it creates none.
      expect(await tokenValue(port, repo, "write")).toBe(writer);

      fake.advance(5 * MINUTE);
      expect(fake.accepts(await tokenValue(port, repo, "read"))).toBe(true);
      expect(fake.createTokenCalls).toBe(2);
    });
  });

  it("mints nothing for a request whose fork listing a release overlapped", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);

      const paused = fake.pauseNext("listTokens");
      const requesting = port.token(repo, "write", 10 * MINUTE);
      await paused.reached;
      expect(await port.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
      paused.release();

      expect(await requesting).toMatchObject({ ok: false, code: "busy" });
      expect(fake.createTokenCalls).toBe(0);
      expect(fake.liveTokens(repo)).toEqual([]);
    });
  });

  // Release and takeover both revoke through `revokeTokens`, so these are their paths.
  it("reports busy while a mint that started first runs, and that mint returns no token", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);

      // Held before minting, so the token appears after the revocation's sweep has listed.
      const paused = fake.pauseNext("createTokenBeforeMint");
      const minting = port.token(repo, "write", 10 * MINUTE);
      await paused.reached;
      expect(await port.revokeTokens(repo, cutoffNow())).toMatchObject({ ok: false, code: "busy" });
      paused.release();

      expect(await minting).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toEqual([]);
      expect(await port.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
    });
  });

  it("sweeps the fork when the token minted during revocation cannot be revoked by id", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);

      const paused = fake.pauseNext("createTokenBeforeMint");
      const minting = port.token(repo, "write", 10 * MINUTE);
      await paused.reached;
      expect(await port.revokeTokens(repo, cutoffNow())).toMatchObject({ ok: false, code: "busy" });
      fake.failRevocations(1);
      paused.release();

      expect(await minting).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toEqual([]);
    });
  });

  it("drops the fork's cached tokens when a racing mint's cleanup sweeps the fork", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      const reader = await tokenValue(port, repo, "read");

      const paused = fake.pauseNext("createTokenBeforeMint");
      const minting = port.token(repo, "write", 10 * MINUTE);
      await paused.reached;
      expect(await port.revokeTokens(repo, cutoffNow())).toMatchObject({ ok: false, code: "busy" });
      fake.failRevocations(1);
      paused.release();

      expect(await minting).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toEqual([]);
      expect(fake.accepts(reader)).toBe(false);
      const renewed = await tokenValue(port, repo, "read");
      expect(renewed).not.toBe(reader);
      expect(fake.accepts(renewed)).toBe(true);
    });
  });

  it("mints nothing while a racing mint's cleanup sweeps the fork", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);

      const mintPaused = fake.pauseNext("createTokenBeforeMint");
      const minting = port.token(repo, "write", 10 * MINUTE);
      await mintPaused.reached;
      expect(await port.revokeTokens(repo, cutoffNow())).toMatchObject({ ok: false, code: "busy" });
      fake.failRevocations(1);
      const sweepPaused = fake.pauseNext("listTokens");
      mintPaused.release();
      await sweepPaused.reached;

      // The read waits behind the write and its cleanup rather than minting beside them.
      const reading = port.token(repo, "read", 10 * MINUTE);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fake.createTokenCalls).toBe(1);
      sweepPaused.release();
      expect(await minting).toMatchObject({ ok: false, code: "busy" });
      const read = await reading;
      expect(read.ok && fake.accepts(read.value.value)).toBe(true);
      expect(fake.createTokenCalls).toBe(2);
    });
  });

  it("mints nothing while a revocation runs, and the next token is accepted", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      const before = await tokenValue(port, repo, "write");

      const paused = fake.pauseNext("listTokens");
      const revoking = port.revokeTokens(repo, cutoffNow());
      await paused.reached;
      expect(await port.token(repo, "write", 60 * MINUTE)).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(fake.tokensMinted).toBe(1);
      paused.release();
      expect(await revoking).toEqual(REVOKED);

      const after = await tokenValue(port, repo, "write");
      expect(after).not.toBe(before);
      expect(fake.accepts(before)).toBe(false);
      expect(fake.accepts(after)).toBe(true);
    });
  });

  it("lets concurrent revocations both finish before minting again", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      const before = await tokenValue(port, repo, "read");

      const paused = fake.pauseNext("listTokens");
      const first = port.revokeTokens(repo, cutoffNow());
      await paused.reached;
      const second = port.revokeTokens(repo, cutoffNow());
      expect(await second).toEqual(REVOKED);
      // The first revocation still runs, so its fence holds.
      expect(await port.token(repo, "read", 10 * MINUTE)).toMatchObject({ code: "busy" });
      paused.release();
      expect(await first).toEqual(REVOKED);

      expect(fake.accepts(before)).toBe(false);
      expect(fake.accepts(await tokenValue(port, repo, "read"))).toBe(true);
    });
  });

  it("revokes a token whose mint answered after its timeout, and holds revocation until then", async () => {
    await withArtifacts(async ({ fake, adapter, storage }) => {
      const port = adapter();
      const repo = await forkClaim(port);

      const paused = fake.pauseNext("createToken");
      expect(await port.token(repo, "write", 10 * MINUTE)).toMatchObject({
        ok: false,
        code: "busy",
      });
      // The timed-out mint created a token Artifacts may still return.
      expect(fake.liveTokens(repo)).toHaveLength(1);
      expect(await port.revokeTokens(repo, cutoffNow())).toMatchObject({ ok: false, code: "busy" });
      // This incarnation's mint can still answer, so time alone does not settle it.
      fake.advance(10 * MINUTE + MINT_CLOCK_SKEW_MS);
      expect(await port.revokeTokens(repo, cutoffNow())).toMatchObject({ ok: false, code: "busy" });

      paused.release();
      await vi.waitFor(() => {
        expect(mintRows(storage)).toBe(0);
        expect(fake.openHandles).toBe(0);
      });
      // Expired by now, and revoked as well once the late answer arrived.
      expect(fake.repos.get(repo)?.tokens.map((token) => token.revoked)).toEqual([true, true]);
      expect(await port.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
      const retried = await tokenValue(port, repo, "write");
      expect(fake.accepts(retried)).toBe(true);
      expect(fake.tokensMinted).toBe(2);
    });
  });

  it("revokes a late main token without sweeping main", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      const port = adapter();
      const kept = await tokenValue(port, main, "read");
      fake.advance(5 * MINUTE + 1);

      const paused = fake.pauseNext("createToken");
      expect(await port.token(main, "read", 10 * MINUTE)).toMatchObject({ code: "busy" });
      paused.release();

      await vi.waitFor(() => {
        expect(fake.liveTokens(main).map((token) => token.plaintext)).toEqual([kept]);
        expect(fake.openHandles).toBe(0);
      });
    });
  });

  it("sweeps on every revocation after a restart and succeeds only past the old mint's bound", async () => {
    await withArtifacts(async ({ fake, adapter, storage }) => {
      const before = adapter();
      const repo = await forkClaim(before);
      const paused = fake.pauseNext("createToken");
      expect(await before.token(repo, "write", 10 * MINUTE)).toMatchObject({ code: "busy" });
      const [minted] = fake.liveTokens(repo);
      if (minted === undefined) throw new Error("the paused mint created no token");

      // A fresh adapter on the same storage, as after the Durable Object restarts. The old request
      // cannot answer it, so revocation sweeps and stays busy until the mint's bound has passed.
      const after = adapter();
      expect(await after.revokeTokens(repo, cutoffNow())).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(fake.accepts(minted.plaintext)).toBe(false);
      fake.advance(10 * MINUTE + MINT_CLOCK_SKEW_MS - 1);
      expect(await after.revokeTokens(repo, cutoffNow())).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(mintRows(storage)).toBe(1);

      fake.advance(1);
      expect(await after.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
      expect(mintRows(storage)).toBe(0);

      // The old request answers after its record was dropped; the new incarnation is unaffected.
      paused.release();
      await vi.waitFor(() => {
        expect(fake.openHandles).toBe(0);
      });
      expect(fake.liveTokens(repo)).toEqual([]);
      const fresh = await tokenValue(after, repo, "write");
      expect(fake.accepts(fresh)).toBe(true);
      expect(mintRows(storage)).toBe(0);
    });
  });

  it("revokes a token a previous incarnation's mint creates late, on the next revocation", async () => {
    await withArtifacts(async ({ fake, adapter, storage }) => {
      const before = adapter();
      const repo = await forkClaim(before);
      // The request takes effect only later, and its answer never reaches the old adapter.
      const effect = fake.pauseNext("createTokenBeforeMint");
      fake.pauseNext("createToken");
      expect(await before.token(repo, "write", 10 * MINUTE)).toMatchObject({ code: "busy" });

      const after = adapter();
      fake.advance(10 * MINUTE + MINT_CLOCK_SKEW_MS - 1);
      expect(await after.revokeTokens(repo, cutoffNow())).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(fake.liveTokens(repo)).toEqual([]);

      effect.release();
      await vi.waitFor(() => {
        expect(fake.liveTokens(repo)).toHaveLength(1);
      });
      expect(await after.revokeTokens(repo, cutoffNow())).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(fake.liveTokens(repo)).toEqual([]);
      expect(mintRows(storage)).toBe(1);

      fake.advance(1);
      expect(await after.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
      expect(mintRows(storage)).toBe(0);
      expect(fake.liveTokens(repo)).toEqual([]);
    });
  });

  it("refuses a fork's tokens while a previous incarnation's mint is unsettled", async () => {
    await withArtifacts(async ({ fake, adapter, storage }) => {
      const before = adapter();
      const repo = await forkClaim(before);
      const paused = fake.pauseNext("createTokenBeforeMint");
      expect(await before.token(repo, "write", 60 * MINUTE)).toMatchObject({ code: "busy" });

      const after = adapter();
      for (const scope of ["write", "read"] as const) {
        expect(await after.token(repo, scope, 10 * MINUTE)).toMatchObject({
          ok: false,
          code: "busy",
        });
      }
      fake.advance(60 * MINUTE + MINT_CLOCK_SKEW_MS - 1);
      expect(await after.token(repo, "read", 10 * MINUTE)).toMatchObject({ code: "busy" });
      expect(fake.createTokenCalls).toBe(1);
      expect(mintRows(storage)).toBe(1);

      // Past the bound the record is dropped and minting resumes.
      fake.advance(1);
      expect(fake.accepts(await tokenValue(after, repo, "read"))).toBe(true);
      expect(mintRows(storage)).toBe(0);

      paused.release();
      await vi.waitFor(() => {
        expect(fake.openHandles).toBe(0);
      });
    });
  });

  it("refuses new mints at once while one is unanswered, with bounded calls and rows", async () => {
    await withArtifacts(async ({ fake, adapter, storage, main }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      const paused = fake.pauseNext("createTokenBeforeMint");
      expect(await port.token(repo, "write", 10 * MINUTE)).toMatchObject({ code: "busy" });

      const started = Date.now();
      for (let i = 0; i < 10; i += 1) {
        for (const scope of ["write", "read"] as const) {
          expect(await port.token(repo, scope, 10 * MINUTE)).toMatchObject({
            ok: false,
            code: "busy",
          });
        }
      }
      // Each refusal is decided before any binding call, well inside one call timeout.
      expect(Date.now() - started).toBeLessThan(FAST.callTimeoutMs);
      expect(fake.createTokenCalls).toBe(1);
      expect(mintRows(storage)).toBe(1);
      // Another repository's lane is independent.
      expect(await port.token(main, "read", 10 * MINUTE)).toMatchObject({ ok: true });

      paused.release();
      await vi.waitFor(() => {
        expect(mintRows(storage)).toBe(0);
        expect(fake.openHandles).toBe(0);
      });
      // The late token was revoked, and the next request mints normally.
      expect(fake.liveTokens(repo)).toEqual([]);
      expect(fake.accepts(await tokenValue(port, repo, "write"))).toBe(true);
    });
  });

  it("refuses callers beyond the waiting queue without calling Artifacts", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter(REPO, { ...FAST, callTimeoutMs: 1_000, maxWaitingMints: 2 });
      const repo = await forkClaim(port);
      const paused = fake.pauseNext("createTokenBeforeMint");

      const admitted = Array.from({ length: 3 }, () => port.token(repo, "write", 10 * MINUTE));
      await paused.reached;
      const refused = await Promise.all(
        Array.from({ length: 4 }, () => port.token(repo, "write", 10 * MINUTE)),
      );
      expect(refused.map((result) => !result.ok && result.code)).toEqual([
        "busy",
        "busy",
        "busy",
        "busy",
      ]);
      expect(fake.createTokenCalls).toBe(1);

      paused.release();
      const values = await Promise.all(admitted);
      expect(values.every((result) => result.ok)).toBe(true);
      expect(new Set(values.map((result) => result.ok && result.value.value)).size).toBe(1);
      expect(fake.createTokenCalls).toBe(1);
      // Once the queue drains it admits again.
      expect(await port.token(repo, "write", 10 * MINUTE)).toMatchObject({ ok: true });
    });
  });

  it("gives up a waiting caller after the queue wait, and it never mints", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter(REPO, { ...FAST, callTimeoutMs: 1_000, queueWaitMs: 50 });
      const repo = await forkClaim(port);
      const paused = fake.pauseNext("createTokenBeforeMint");

      const first = port.token(repo, "write", 10 * MINUTE);
      await paused.reached;
      const started = Date.now();
      expect(await port.token(repo, "read", 10 * MINUTE)).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(Date.now() - started).toBeLessThan(500);

      paused.release();
      expect(await first).toMatchObject({ ok: true });
      // The abandoned read request did not run when its turn came.
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(fake.createTokenCalls).toBe(1);
      expect(fake.accepts(await tokenValue(port, repo, "read"))).toBe(true);
      expect(fake.createTokenCalls).toBe(2);
    });
  });

  it("disposes a repository handle that opens after its timeout", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      const port = adapter();
      const paused = fake.pauseNext("get");

      expect(await port.commitExists(main, HEAD)).toMatchObject({ ok: false, code: "busy" });
      expect(fake.openHandles).toBe(1);
      paused.release();
      await vi.waitFor(() => {
        expect(fake.openHandles).toBe(0);
      });
      expect(await port.commitExists(main, HEAD)).toEqual({ ok: true, value: true });
    });
  });

  it("stops after its revocation budget and continues on a repeat", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter(REPO, { ...FAST, maxRevokesPerSweep: 2 });
      const repo = await forkClaim(port);
      for (let i = 0; i < 5; i += 1) fake.mintFor(repo, "write", 600);

      expect(await port.revokeTokens(repo, cutoffNow())).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toHaveLength(3);
      expect(await port.revokeTokens(repo, cutoffNow())).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toHaveLength(1);
      expect(await port.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
      expect(fake.liveTokens(repo)).toEqual([]);
    });
  });

  it("stops at its deadline when every revocation is slow", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter(REPO, { ...FAST, sweepDeadlineMs: 100 });
      const repo = await forkClaim(port);
      for (let i = 0; i < 20; i += 1) fake.mintFor(repo, "write", 600);
      fake.slowRevocations(30);

      const started = Date.now();
      expect(await port.revokeTokens(repo, cutoffNow())).toMatchObject({ ok: false, code: "busy" });
      expect(Date.now() - started).toBeLessThan(500);
      const left = fake.liveTokens(repo).length;
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThan(20);

      fake.slowRevocations(0);
      expect(await port.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
    });
  });

  it("refuses main and repositories it does not own", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      const port = adapter();
      const mainToken = await tokenValue(port, main, "read");

      expect(await port.revokeTokens(main, cutoffNow())).toMatchObject({ code: "invalid_request" });
      expect(await port.revokeTokens("rh-f-unknown", cutoffNow())).toMatchObject({
        code: "not_found",
      });
      expect(fake.accepts(mainToken)).toBe(true);
    });
  });

  it("reports busy and forgets cached tokens when revocation does not take", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const forked = await port.forkForClaim(CLAIM, HEAD);
      if (!forked.ok) throw new Error("fork failed");
      const repo = forked.value.repo;
      const before = await tokenValue(port, repo, "write");
      fake.failRevocations(100);

      expect(await port.revokeTokens(repo, cutoffNow())).toMatchObject({ ok: false, code: "busy" });
      fake.failRevocations(0);
      expect(await tokenValue(port, repo, "write")).not.toBe(before);
    });
  });
});

describe("repository isolation", () => {
  it("names forks per repository and refuses another repository's main and forks", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      const mine = adapter();
      const forked = await mine.forkForClaim(CLAIM, HEAD);
      if (!forked.ok) throw new Error("fork failed");
      const theirs = adapter(OTHER_REPO);

      expect(await forkRepoName(OTHER_REPO, CLAIM)).not.toBe(forked.value.repo);
      expect(await forkRepoName(REPO, SECOND_CLAIM)).not.toBe(forked.value.repo);
      expect(await mainRepoName(OTHER_REPO)).not.toBe(main);
      for (const repo of [main, forked.value.repo]) {
        expect(await theirs.token(repo, "read", 10 * MINUTE)).toMatchObject({ code: "not_found" });
        expect(await theirs.commitExists(repo, HEAD)).toMatchObject({ code: "not_found" });
      }
      expect(await theirs.revokeTokens(forked.value.repo, cutoffNow())).toMatchObject({
        code: "not_found",
      });
      expect(fake.tokensMinted).toBe(0);
    });
  });
});

describe("recordedForks", () => {
  it("lists every recorded fork, pending or ready, by name", async () => {
    await withArtifacts(async ({ fake, storage, adapter }) => {
      const port = adapter();
      const ready = await forkClaim(port);
      const pending = await forkRepoName(REPO, SECOND_CLAIM);
      fake.failNextFork("lose-response");
      expect(await port.forkForClaim(SECOND_CLAIM, HEAD)).toMatchObject({ ok: false });

      expect(recordedForks(storage)).toEqual([ready, pending].toSorted());
    });
  });

  it("lists nothing in storage the adapter never used", async () => {
    await withArtifacts(async ({ storage }) => {
      expect(recordedForks(storage)).toEqual([]);
    });
  });

  it("throws rather than read a fork table newer than this code knows", async () => {
    await withArtifacts(async ({ storage, adapter }) => {
      await forkClaim(adapter());
      storage.sql.exec("UPDATE railhead_migrations SET version = 99 WHERE owner = 'artifacts'");

      expect(() => recordedForks(storage)).toThrow(/newer than/);
    });
  });
});

describe("revocation cutoff", () => {
  it("revokes tokens of mints logged up to the cutoff and leaves those of later mints", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      const before = await tokenValue(port, repo, "write");
      const cutoff = cutoffNow();
      const after = await tokenValue(port, repo, "read");

      expect(await port.revokeTokens(repo, cutoff)).toEqual(REVOKED);
      expect(fake.accepts(before)).toBe(false);
      expect(fake.accepts(after)).toBe(true);
      // A sweep that begins later covers both.
      expect(await port.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
      expect(fake.accepts(after)).toBe(false);
    });
  });

  it("revokes an unlogged token created before the attempt less the skew, and defers a newer one while a later mint is unanswered", async () => {
    await withArtifacts(async ({ fake, storage, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      const old = fake.mintFor(repo, "write", 3600);
      fake.advance(MINT_CLOCK_SKEW_MS + 1);
      const cutoff = cutoffNow();

      // A Repo restarted since the attempt began mints for a newer holder; Artifacts has made the
      // token but its answer, and so its id, has not arrived.
      const holder = adapter();
      const gate = fake.pauseNext("createToken");
      const minting = holder.token(repo, "write", 10 * MINUTE);
      await gate.reached;
      const [unlogged] = fake.liveTokens(repo).filter((token) => token.id !== old.id);
      if (unlogged === undefined) throw new Error("the mint made no token");

      expect(await port.revokeTokens(repo, cutoff)).toEqual(PENDING_DEBT);
      expect(fake.accepts(old.plaintext)).toBe(false);
      expect(fake.accepts(unlogged.plaintext)).toBe(true);

      gate.release();
      const held = await minting;
      if (!held.ok) throw new Error(`token refused: ${held.code}`);
      expect(held.value.value).toBe(unlogged.plaintext);
      // The next sweep under the same cutoff places the token after it, and settles.
      expect(await port.revokeTokens(repo, cutoff)).toEqual(REVOKED);
      expect(fake.accepts(held.value.value)).toBe(true);
      expect(await tokenValue(holder, repo, "write")).toBe(held.value.value);
      expect(fake.accepts(held.value.value)).toBe(true);
    });
  });

  it("revokes a recent unlogged token when no later mint is unanswered", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      const cutoff = cutoffNow();
      const stray = fake.mintFor(repo, "write", 3600);

      expect(await port.revokeTokens(repo, cutoff)).toEqual(REVOKED);
      expect(fake.accepts(stray.plaintext)).toBe(false);
    });
  });

  it("logs a token whose mint answered after its timeout, so a sweep places it by its mint", async () => {
    await withArtifacts(async ({ fake, storage, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      const cutoff = cutoffNow();
      const gate = fake.pauseNext("createToken");
      expect(await port.token(repo, "write", 10 * MINUTE)).toMatchObject({
        ok: false,
        code: "busy",
      });
      // The late answer arrives; the adapter's own revocation of it fails, so the token stays live.
      fake.failRevocations(1);
      gate.release();
      await vi.waitFor(() => expect(mintRows(storage)).toBe(0), { timeout: 1000 });
      const [late] = fake.liveTokens(repo);
      if (late === undefined) throw new Error("the late token was revoked");

      // Logged after the cutoff, it is left alone; unlogged, it would have been deferred.
      expect(await port.revokeTokens(repo, cutoff)).toEqual(REVOKED);
      expect(fake.accepts(late.plaintext)).toBe(true);
      expect(await port.revokeTokens(repo, cutoffNow())).toEqual(REVOKED);
      expect(fake.accepts(late.plaintext)).toBe(false);
    });
  });
});

describe("migrations", () => {
  it("drops the sweep debts earlier versions recorded and keeps the mint log", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    await runInDurableObject(stub, async (_instance, state) => {
      const storage = state.storage;
      // The adapter's schema before debts kept a cutoff.
      migrate(storage, "artifacts", [
        `CREATE TABLE artifacts_forks (
          claim_id TEXT PRIMARY KEY, repo TEXT NOT NULL UNIQUE, base TEXT NOT NULL, head TEXT,
          state TEXT NOT NULL CHECK (state IN ('pending', 'ready')), created_at INTEGER NOT NULL
        ) STRICT`,
        `CREATE TABLE artifacts_mints (
          id TEXT PRIMARY KEY, repo TEXT NOT NULL, started_at INTEGER NOT NULL, ttl_ms INTEGER NOT NULL
        ) STRICT`,
        `CREATE TABLE artifacts_token_debts (
          repo TEXT PRIMARY KEY, owed_until INTEGER NOT NULL, retry_at INTEGER NOT NULL,
          generation INTEGER NOT NULL
        ) STRICT`,
        `CREATE TABLE artifacts_mint_log (
          seq INTEGER PRIMARY KEY AUTOINCREMENT, mint_id TEXT NOT NULL UNIQUE, repo TEXT NOT NULL,
          token_id TEXT, keep_until INTEGER NOT NULL
        ) STRICT`,
        "CREATE INDEX artifacts_mint_log_by_repo ON artifacts_mint_log (repo, token_id)",
      ]);
      storage.sql.exec(
        "INSERT INTO artifacts_mint_log (mint_id, repo, keep_until) VALUES ('m1', 'f', 1), ('m2', 'f', 1)",
      );
      storage.sql.exec("INSERT INTO artifacts_token_debts VALUES ('f', 2000000000, 1000000000, 4)");

      const fake = new FakeArtifacts();
      createArtifactsAdapter({ repoId: REPO, storage, clock: fake.clock, namespace: fake }, FAST);
      expect(
        storage.sql
          .exec(
            "SELECT name FROM sqlite_master WHERE name IN ('artifacts_token_debts', 'artifacts_sweep_debts')",
          )
          .toArray(),
      ).toEqual([]);
      expect(mintCutoff(storage, fake.clock()).seq).toBe(2);
    });
  });
});

describe("FakeArtifacts listTokens", () => {
  it("lists one page of the newest live tokens, with a total of live tokens only", async () => {
    const fake = new FakeArtifacts();
    fake.seed("r", [ROOT]);
    const tokens = Array.from({ length: TOKEN_PAGE_SIZE + 3 }, () => {
      fake.advance(1);
      return fake.mintFor("r", "read", 60);
    });
    const [revoked, expiring] = tokens;
    if (revoked === undefined || expiring === undefined) throw new Error("no tokens");
    revoked.revoked = true;
    // Expires first, alone: every later token was created after it.
    fake.advance(60_000 - TOKEN_PAGE_SIZE - 1);
    using handle = await fake.get("r");
    const listed = await handle.listTokens();

    const live = tokens.slice(2).toReversed();
    expect(listed.total).toBe(live.length);
    expect(listed.tokens.map((token) => token.id)).toEqual(
      live.slice(0, TOKEN_PAGE_SIZE).map((token) => token.id),
    );
    expect(listed.tokens.every((token) => token.state === "active")).toBe(true);
  });
});
