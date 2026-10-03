import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACTS_LIMITS,
  createArtifactsAdapter,
  forkRepoName,
  mainRepoName,
  type ArtifactsAdapterLimits,
} from "../src/artifacts/adapter";
import { FakeArtifacts } from "../src/artifacts/fake";
import type { ArtifactsPort } from "../src/contracts/artifacts";
import type { RepoStorage } from "../src/repo/storage";

const REPO = "rep_aaaaaaaaaaaa";
const OTHER_REPO = "rep_bbbbbbbbbbbb";
const CLAIM = "clm_claim0001";
const SECOND_CLAIM = "clm_claim0002";
const ROOT = "1".repeat(40);
const HEAD = "2".repeat(40);
const MISSING = "3".repeat(40);
const MINUTE = 60_000;

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

/** Runs `body` with a fake namespace holding this repository's main, and storage no other test uses. */
function withArtifacts(body: (setup: Setup) => Promise<void>): Promise<void> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const fake = new FakeArtifacts();
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
      expect(await port.revokeTokens(repo)).toEqual({ ok: true, value: undefined });
      expect(fake.accepts(predecessor)).toBe(false);
      expect(fake.accepts(reader)).toBe(false);

      const successor = await tokenValue(port, repo, "write");
      expect(successor).not.toBe(predecessor);
      expect(fake.liveTokens(repo).map((token) => token.plaintext)).toEqual([successor]);
    });
  });

  it("reports busy while a mint that started first runs, and that mint returns no token", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);

      const paused = fake.pauseNext("createToken");
      const minting = port.token(repo, "write", 10 * MINUTE);
      await paused.reached;
      expect(await port.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });
      paused.release();

      expect(await minting).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toEqual([]);
      expect(await port.revokeTokens(repo)).toEqual({ ok: true, value: undefined });
    });
  });

  it("sweeps the fork when the token minted during revocation cannot be revoked by id", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);

      const paused = fake.pauseNext("createToken");
      const minting = port.token(repo, "write", 10 * MINUTE);
      await paused.reached;
      expect(await port.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });
      fake.failRevocations(1);
      paused.release();

      expect(await minting).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toEqual([]);
    });
  });

  it("drops the fork's other cached tokens when a racing mint's cleanup sweeps the fork", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);

      const paused = fake.pauseNext("createToken");
      const minting = port.token(repo, "write", 10 * MINUTE);
      await paused.reached;
      expect(await port.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });
      // Minted and cached after that revocation returned, while the write mint still runs.
      const reader = await tokenValue(port, repo, "read");
      fake.failRevocations(1);
      paused.release();

      expect(await minting).toMatchObject({ ok: false, code: "busy" });
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

      const mintPaused = fake.pauseNext("createToken");
      const minting = port.token(repo, "write", 10 * MINUTE);
      await mintPaused.reached;
      expect(await port.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });
      fake.failRevocations(1);
      const sweepPaused = fake.pauseNext("listTokens");
      mintPaused.release();
      await sweepPaused.reached;

      expect(await port.token(repo, "read", 10 * MINUTE)).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(fake.tokensMinted).toBe(1);
      sweepPaused.release();
      expect(await minting).toMatchObject({ ok: false, code: "busy" });
      expect(fake.accepts(await tokenValue(port, repo, "read"))).toBe(true);
    });
  });

  it("mints nothing while a revocation runs, and the next token is accepted", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);
      const before = await tokenValue(port, repo, "write");

      const paused = fake.pauseNext("listTokens");
      const revoking = port.revokeTokens(repo);
      await paused.reached;
      expect(await port.token(repo, "write", 60 * MINUTE)).toMatchObject({
        ok: false,
        code: "busy",
      });
      expect(fake.tokensMinted).toBe(1);
      paused.release();
      expect(await revoking).toEqual({ ok: true, value: undefined });

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
      const first = port.revokeTokens(repo);
      await paused.reached;
      const second = port.revokeTokens(repo);
      expect(await second).toEqual({ ok: true, value: undefined });
      // The first revocation still runs, so its fence holds.
      expect(await port.token(repo, "read", 10 * MINUTE)).toMatchObject({ code: "busy" });
      paused.release();
      expect(await first).toEqual({ ok: true, value: undefined });

      expect(fake.accepts(before)).toBe(false);
      expect(fake.accepts(await tokenValue(port, repo, "read"))).toBe(true);
    });
  });

  it("revokes a token whose mint answered after its timeout, and holds revocation until then", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const repo = await forkClaim(port);

      const paused = fake.pauseNext("createToken");
      expect(await port.token(repo, "write", 10 * MINUTE)).toMatchObject({
        ok: false,
        code: "busy",
      });
      // The timed-out mint created a token Artifacts may still return.
      expect(fake.liveTokens(repo)).toHaveLength(1);
      expect(await port.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });

      paused.release();
      await vi.waitFor(() => {
        expect(fake.liveTokens(repo)).toEqual([]);
        expect(fake.openHandles).toBe(0);
      });
      expect(await port.revokeTokens(repo)).toEqual({ ok: true, value: undefined });
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

  it("holds revocation after a restart until a mint whose effect is delayed answers", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const before = adapter();
      const repo = await forkClaim(before);
      const paused = fake.pauseNext("createTokenBeforeMint");
      expect(await before.token(repo, "write", 10 * MINUTE)).toMatchObject({ code: "busy" });
      expect(fake.repos.get(repo)?.tokens).toHaveLength(1);

      // A fresh adapter on the same storage, as after the Durable Object restarts. However long the
      // old request stays unanswered, revocation must not report success while it may mint.
      const after = adapter();
      expect(await after.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });
      fake.advance(60 * MINUTE);
      expect(await after.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });

      // The delayed request now mints; its answer is what settles the record.
      paused.release();
      await vi.waitFor(() => {
        expect(fake.openHandles).toBe(0);
        expect(fake.tokensMinted).toBe(1);
        expect(fake.liveTokens(repo)).toEqual([]);
      });
      expect(await after.revokeTokens(repo)).toEqual({ ok: true, value: undefined });
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

      expect(await port.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toHaveLength(3);
      expect(await port.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toHaveLength(1);
      expect(await port.revokeTokens(repo)).toEqual({ ok: true, value: undefined });
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
      expect(await port.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });
      expect(Date.now() - started).toBeLessThan(500);
      const left = fake.liveTokens(repo).length;
      expect(left).toBeGreaterThan(0);
      expect(left).toBeLessThan(20);

      fake.slowRevocations(0);
      expect(await port.revokeTokens(repo)).toEqual({ ok: true, value: undefined });
    });
  });

  it("refuses main and repositories it does not own", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      const port = adapter();
      const mainToken = await tokenValue(port, main, "read");

      expect(await port.revokeTokens(main)).toMatchObject({ code: "invalid_request" });
      expect(await port.revokeTokens("rh-f-unknown")).toMatchObject({ code: "not_found" });
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

      expect(await port.revokeTokens(repo)).toMatchObject({ ok: false, code: "busy" });
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
      expect(await theirs.revokeTokens(forked.value.repo)).toMatchObject({ code: "not_found" });
      expect(fake.tokensMinted).toBe(0);
    });
  });
});
