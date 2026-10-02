import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
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

const FAST: ArtifactsAdapterLimits = { callTimeoutMs: 50, maxCachedTokens: 256 };

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

  it("holds a bounded number of cached tokens", async () => {
    await withArtifacts(async ({ fake, adapter, main }) => {
      const port = adapter(REPO, { callTimeoutMs: 50, maxCachedTokens: 1 });
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

  it("never caches or returns a token minted while revocation ran", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const forked = await port.forkForClaim(CLAIM, HEAD);
      if (!forked.ok) throw new Error("fork failed");
      const repo = forked.value.repo;

      const paused = fake.pauseNextMint();
      const minting = port.token(repo, "write", 10 * MINUTE);
      await paused.reached;
      expect(await port.revokeTokens(repo)).toMatchObject({ ok: true });
      paused.release();

      expect(await minting).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toEqual([]);
    });
  });

  it("sweeps the fork when the token minted during revocation cannot be revoked by id", async () => {
    await withArtifacts(async ({ fake, adapter }) => {
      const port = adapter();
      const forked = await port.forkForClaim(CLAIM, HEAD);
      if (!forked.ok) throw new Error("fork failed");
      const repo = forked.value.repo;

      const paused = fake.pauseNextMint();
      const minting = port.token(repo, "write", 10 * MINUTE);
      await paused.reached;
      expect(await port.revokeTokens(repo)).toMatchObject({ ok: true });
      fake.failRevocations(1);
      paused.release();

      expect(await minting).toMatchObject({ ok: false, code: "busy" });
      expect(fake.liveTokens(repo)).toEqual([]);
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
