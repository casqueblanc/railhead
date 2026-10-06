import { SELF, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { newWebSocketRpcSession } from "capnweb";
import { beforeEach, describe, expect, it } from "vitest";
import { API_PATH, type RailheadApi } from "@railhead/shared/api";
import {
  MAX_DEMO_BUNDLE_BYTES,
  type DemoSeedAction,
  type DemoSeedResult,
  type PasskeyAssertion,
  type PasskeyRegistration,
} from "@railhead/shared/board-api";
import { isRepoSegment } from "@railhead/shared/agent-api";
import {
  createArtifactsAdapter,
  mainRepoName,
  MINT_CLOCK_SKEW_MS,
  TOKEN_PAGE_SIZE,
} from "../src/artifacts/adapter";
import { FakeArtifacts, FakeArtifactsError } from "../src/artifacts/fake";
import { actionChallenge, relyingParty, type StoredCredential } from "../src/auth/passkeyVerifier";
import { fail, ok, type PortResult } from "../src/contracts/result";
import { toBoard } from "../src/gateway/rpc";
import { readBundle } from "../src/modules/demoSeed/bundle";
import {
  checkPerformInput,
  createSeedControl,
  type SeedTargetCalls,
} from "../src/modules/demoSeed/control";
import { DEMO_OBJECT_NAME, DEMO_SEED_CONTROL, demoRepoId } from "../src/modules/demoSeed/entry";
import { pushMain } from "../src/modules/demoSeed/receivePack";
import {
  createSeedTarget,
  SEED_TARGET_LIMITS,
  type SeedArtifacts,
  type SeedTargetLimits,
  type SeedArtifactsRepo,
  type SeedTarget,
} from "../src/modules/demoSeed/target";
import type { InstanceOwnerPort } from "../src/modules/owner/entry";
import { InstanceOwner } from "../src/modules/owner/instance";
import { OWNER_OBJECT_NAME } from "../src/modules/owner/OwnerObject";
import type { RepoStorage } from "../src/repo/storage";

const HOST = "railhead.mashin.workers.dev";
const ORIGIN = `https://${HOST}`;
const HEAD = "a".repeat(40);
const OTHER_HEAD = "b".repeat(40);
const REPO_ID = "rep_demo0000000000";
const enc = new TextEncoder();

// ---------------------------------------------------------------------------------------------
// Bundles

/** A v2 bundle with `header` lines after the signature and a minimal pack. */
function bundle(lines: string[], pack: Uint8Array = fakePack()): Uint8Array {
  const header = enc.encode(`# v2 git bundle\n${lines.map((line) => `${line}\n`).join("")}\n`);
  const out = new Uint8Array(header.length + pack.length);
  out.set(header);
  out.set(pack, header.length);
  return out;
}

/** "PACK", version 2, zero objects, and a 20-byte trailer: the smallest pack shape. */
function fakePack(): Uint8Array {
  const pack = new Uint8Array(32);
  pack.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  return pack;
}

const MAIN_BUNDLE = bundle([`${HEAD} refs/heads/main`]);

describe("readBundle", () => {
  it("reads main's head and the pack that follows the header", () => {
    const read = readBundle(MAIN_BUNDLE);
    if (!read.ok) throw new Error(read.reason);
    expect(read.bundle.head).toBe(HEAD);
    expect([...read.bundle.pack]).toEqual([...fakePack()]);
  });

  it("refuses prerequisites, other refs, a second ref and a missing pack", () => {
    expect(readBundle(bundle([`-${OTHER_HEAD}`, `${HEAD} refs/heads/main`]))).toEqual({
      ok: false,
      reason: "prerequisites",
    });
    expect(readBundle(bundle([`${HEAD} refs/heads/dev`]))).toEqual({
      ok: false,
      reason: "wrong_refs",
    });
    expect(
      readBundle(bundle([`${HEAD} refs/heads/main`, `${OTHER_HEAD} refs/heads/main`])),
    ).toEqual({ ok: false, reason: "wrong_refs" });
    expect(readBundle(bundle([]))).toEqual({ ok: false, reason: "wrong_refs" });
    expect(readBundle(bundle([`${HEAD} refs/heads/main`], new Uint8Array(40)))).toEqual({
      ok: false,
      reason: "no_pack",
    });
  });

  it("refuses a v3 bundle, plain bytes and a header without an end", () => {
    const v3 = enc.encode(`# v3 git bundle\n${HEAD} refs/heads/main\n\nPACK`);
    expect(readBundle(v3)).toEqual({ ok: false, reason: "not_a_bundle" });
    expect(readBundle(new Uint8Array(0))).toEqual({ ok: false, reason: "not_a_bundle" });
    expect(readBundle(enc.encode(`# v2 git bundle\n${"x".repeat(5000)}`))).toEqual({
      ok: false,
      reason: "not_a_bundle",
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Fake Artifacts with create, delete and a receive-pack endpoint

interface Push {
  url: string;
  authorization: string | null;
  command: string;
}

/** The merged `FakeArtifacts`, with the namespace calls and the Git endpoint the seed uses. */
class SeedFake implements SeedArtifacts {
  readonly fake = new FakeArtifacts();
  readonly pushes: Push[] = [];
  readonly deleted: string[] = [];
  /** How the next push misbehaves. */
  pushFault: "none" | "lose-response" | "drop" | "reject" = "none";
  failNextDelete = false;
  /** Makes every `get` fail as an Artifacts error, until cleared. */
  failGets = false;
  /** A repository whose deletion fails every time, until cleared. */
  failDeleteOf: string | null = null;
  /** Runs once when the next push reaches the Git endpoint. */
  onNextPush: (() => void) | null = null;

  /** Holds the next `create` before it creates anything, as a request whose effect is delayed. */
  holdNextCreate(): Hold {
    const hold = held();
    this.#createGate = hold;
    return hold;
  }

  /** Holds the next `delete` before it deletes anything, as a request whose effect is delayed. */
  holdNextDelete(): Hold {
    const hold = held();
    this.#deleteGate = hold;
    return hold;
  }

  /**
   * Holds the next push after its token is accepted: the client's request may time out, and main is
   * created when the hold is released, as a push Artifacts applies late.
   */
  holdNextPush(): Hold {
    const hold = held();
    this.#pushGate = hold;
    return hold;
  }

  #createGate: Hold | null = null;
  #deleteGate: Hold | null = null;
  #pushGate: Hold | null = null;

  /** Makes the next `create` take effect and never answer, as when its object was evicted. */
  hangAfterNextCreate = false;
  /** Makes the next `delete` take effect and never answer, as when its object was evicted. */
  hangAfterNextDelete = false;
  /** Runs once after the next deletion takes effect. */
  afterNextDelete: ((name: string) => void) | null = null;

  async create(name: string): Promise<unknown> {
    const gate = this.#createGate;
    this.#createGate = null;
    if (gate !== null) await gate.wait();
    if (this.fake.repos.has(name)) throw new FakeArtifactsError("ALREADY_EXISTS");
    this.fake.seed(name, []);
    const token = this.fake.mintFor(name, "write", 86_400);
    if (this.hangAfterNextCreate) {
      this.hangAfterNextCreate = false;
      return new Promise(() => {});
    }
    return { remote: remote(name), token: token.plaintext };
  }

  /** How many repositories were opened. */
  gets = 0;

  async get(name: string): Promise<SeedArtifactsRepo> {
    this.gets += 1;
    if (this.failGets) throw new FakeArtifactsError("INTERNAL_ERROR");
    const handle = await this.fake.get(name);
    return {
      ...handle,
      [Symbol.dispose]: () => handle[Symbol.dispose](),
      // Artifacts resolves a branch by its short name and answers an empty log for a full ref name.
      log: async (opts) => (opts?.ref?.startsWith("refs/") === true ? [] : handle.log(opts)),
      info: async () => ({
        id: name,
        name,
        description: null,
        defaultBranch: "main",
        createdAt: "",
        updatedAt: "",
        lastPushAt: null,
        source: null,
        readOnly: false,
        remote: remote(name),
      }),
    };
  }

  async delete(name: string): Promise<boolean> {
    const gate = this.#deleteGate;
    this.#deleteGate = null;
    if (gate !== null) await gate.wait();
    if (this.failNextDelete || this.failDeleteOf === name) {
      this.failNextDelete = false;
      throw new FakeArtifactsError("INTERNAL_ERROR");
    }
    this.deleted.push(name);
    const existed = this.fake.repos.delete(name);
    const after = this.afterNextDelete;
    this.afterNextDelete = null;
    after?.(name);
    if (this.hangAfterNextDelete) {
      this.hangAfterNextDelete = false;
      return new Promise(() => {});
    }
    return existed;
  }

  /** Artifacts' receive-pack: creates main at the command's head for a live token. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("Authorization");
    const body = init?.body;
    if (!(body instanceof Uint8Array)) throw new TypeError("expected a byte body");
    const length = Number.parseInt(new TextDecoder().decode(body.subarray(0, 4)), 16);
    const command = new TextDecoder().decode(body.subarray(4, length));
    this.pushes.push({ url, authorization, command });
    const hook = this.onNextPush;
    this.onNextPush = null;
    hook?.();
    const fault = this.pushFault;
    this.pushFault = "none";
    if (fault === "drop") throw new TypeError("network lost");
    if (fault === "reject") return new Response(pkt(["unpack ok", "ng refs/heads/main denied"]));
    const name = /\/([^/]+)\.git\/git-receive-pack$/.exec(url)?.[1];
    const token = authorization?.replace(/^Bearer /, "") ?? "";
    const repo = name === undefined ? undefined : this.fake.repos.get(name);
    if (repo === undefined || !this.fake.accepts(token)) return new Response("", { status: 403 });
    const head = command.split(" ")[1] ?? "";
    const gate = this.#pushGate;
    this.#pushGate = null;
    if (gate !== null) {
      // Main is created from the zero id when the hold is released, if it still exists and is
      // empty, whether or not the client still waits.
      const applied = gate.wait().then(() => {
        const current = name === undefined ? undefined : this.fake.repos.get(name);
        if (current !== undefined && current.commits.length === 0) current.commits.push(head);
      });
      await new Promise<void>((resolve, reject) => {
        void applied.then(resolve);
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The push timed out", "TimeoutError"));
        });
      });
      return new Response(pkt(["unpack ok", "ok refs/heads/main"]));
    }
    repo.commits.splice(0, repo.commits.length, head);
    if (fault === "lose-response") throw new TypeError("response lost");
    return new Response(pkt(["unpack ok", "ok refs/heads/main"]));
  };
}

/** A call held at a point until `release`; `reached` resolves once it is held. */
interface Hold {
  reached: Promise<void>;
  release: () => void;
  /** Called by the held call: marks it reached and waits for `release`. */
  wait: () => Promise<void>;
}

function held(): Hold {
  let reach: (() => void) | undefined;
  let release: (() => void) | undefined;
  const reached = new Promise<void>((resolve) => {
    reach = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    reached,
    release: () => release?.(),
    wait: () => {
      reach?.();
      return gate;
    },
  };
}

/** A fetch that answers every request with `body`. */
function answering(body: string): typeof fetch {
  return async () => new Response(body);
}

function remote(name: string): string {
  return `https://fake.artifacts.invalid/git/default/${name}.git`;
}

function pkt(lines: string[]): string {
  return `${lines
    .map((line) => `${(line.length + 5).toString(16).padStart(4, "0")}${line}\n`)
    .join("")}0000`;
}

// ---------------------------------------------------------------------------------------------
// pushMain

describe("pushMain", () => {
  it("creates main from the zero id with report-status, authorized by the token", async () => {
    const seed = new SeedFake();
    const name = "rh-m-push";
    await seed.create(name);
    const token = seed.fake.mintFor(name, "write", 300).plaintext;
    const outcome = await pushMain(
      { remote: remote(name), token, head: HEAD, pack: fakePack() },
      seed.fetch,
    );
    expect(outcome).toBe("pushed");
    expect(seed.pushes).toEqual([
      {
        url: `${remote(name)}/git-receive-pack`,
        authorization: `Bearer ${token}`,
        command: `${"0".repeat(40)} ${HEAD} refs/heads/main\0report-status\n`,
      },
    ]);
    expect(seed.fake.repos.get(name)?.commits).toEqual([HEAD]);
  });

  it("reports a refused ref, a denied token and a lost request differently", async () => {
    const seed = new SeedFake();
    await seed.create("rh-m-x");
    const request = { remote: remote("rh-m-x"), token: "nope", head: HEAD, pack: fakePack() };
    expect(await pushMain(request, seed.fetch)).toBe("refused");
    seed.pushFault = "reject";
    expect(await pushMain(request, seed.fetch)).toBe("refused");
    seed.pushFault = "drop";
    expect(await pushMain(request, seed.fetch)).toBe("uncertain");
    expect(await pushMain(request, answering("not pkt-lines"))).toBe("uncertain");
    expect(await pushMain(request, answering("0".repeat(10_000)))).toBe("uncertain");
  });

  it("does not follow a redirect, so the token reaches no other host", async () => {
    const modes: (string | undefined)[] = [];
    const redirecting: typeof fetch = async (_input, init) => {
      modes.push(init?.redirect);
      return new Response(null, {
        status: 302,
        headers: { Location: "https://elsewhere.invalid/" },
      });
    };
    const request = { remote: remote("rh-m-r"), token: "t", head: HEAD, pack: fakePack() };
    expect(await pushMain(request, redirecting)).toBe("refused");
    expect(modes).toEqual(["manual"]);
  });

  it("never sends to a remote that is not plain HTTPS", async () => {
    const seed = new SeedFake();
    for (const bad of ["http://fake.invalid/r.git", "https://x:y@fake.invalid/r.git", "nope"]) {
      expect(
        await pushMain({ remote: bad, token: "t", head: HEAD, pack: fakePack() }, seed.fetch),
      ).toBe("refused");
    }
    expect(seed.pushes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// The target

interface TargetSetup {
  seed: SeedFake;
  target: SeedTarget;
  storage: RepoStorage;
  host: { initialized: boolean; initializeCalls: number; wipes: number };
  main: string;
  clock: { now: number };
  /** A new target on the same storage, as after the object restarted. */
  restart: () => SeedTarget;
}

const SHORT_CALLS: SeedTargetLimits = { ...SEED_TARGET_LIMITS, callTimeoutMs: 50 };

const UNCONFIRMED = {
  ok: false,
  code: "internal",
  message:
    "An earlier change to Artifacts never answered and its effect cannot be confirmed yet; try again later.",
};

const ORPHAN_BUSY = {
  ok: false,
  code: "busy",
  message:
    "An earlier change to Artifacts never answered and has not settled yet; try again in a few minutes.",
};

const CREATE_UNSETTLED = {
  ok: false,
  code: "busy",
  message:
    "An earlier create of main never answered and may still land; seed again before resetting.",
};

const MINT_UNSETTLED = {
  ok: false,
  code: "busy",
  message:
    "An earlier token request on main never answered and may still mint a token; reset the demo repository, then seed it.",
};

/** A push token's lifetime plus the clock skew margin, which once bounded a lost mint. */
const PUSH_TOKEN_EXPIRY_MS = 300_000 + MINT_CLOCK_SKEW_MS;

/** The seed's effect records, oldest first. */
function effectRows(storage: RepoStorage): { kind: string; answered: number }[] {
  return storage.sql
    .exec<{ kind: string; answered: number }>(
      "SELECT kind, answered FROM demo_seed_effects ORDER BY id",
    )
    .toArray();
}

/** A retryable refusal for `eventually`. */
function busyResult(): PortResult<never> {
  return { ok: false, code: "busy", message: "not yet" };
}

const PUSH_UNCONFIRMED = {
  ok: false,
  code: "internal",
  message:
    "An earlier push to main never answered and may still land; seed again before resetting.",
};

function withTarget(
  body: (setup: TargetSetup) => Promise<void>,
  options: { artifacts?: boolean; limits?: SeedTargetLimits } = {},
): Promise<void> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const seed = new SeedFake();
    const host = { initialized: false, initializeCalls: 0, wipes: 0 };
    const clock = { now: 1_000_000 };
    const restart = () =>
      createSeedTarget(
        {
          repoId: REPO_ID,
          storage: state.storage,
          artifacts: options.artifacts === false ? undefined : seed,
          fetch: seed.fetch,
          clock: () => clock.now,
          initialized: () => host.initialized,
          initialize: () => {
            host.initializeCalls += 1;
            host.initialized = true;
            return ok(undefined);
          },
          wipe: async () => {
            host.wipes += 1;
            host.initialized = false;
          },
        },
        options.limits ?? { ...SEED_TARGET_LIMITS, callTimeoutMs: 1_000 },
      );
    const target = restart();
    const main = await mainRepoName(REPO_ID);
    await body({ seed, target, storage: state.storage, host, main, clock, restart });
    expect(seed.fake.openHandles).toBe(0);
  });
}

/** Retries `attempt` until it succeeds, for calls refused while an earlier one settles. */
async function eventually<T>(
  attempt: () => Promise<PortResult<T>>,
  ms = 5_000,
): Promise<PortResult<T>> {
  const deadline = Date.now() + ms;
  for (;;) {
    const result = await attempt();
    if (result.ok || Date.now() > deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("toBoard", () => {
  it("passes busy to the board with its message, and hides an agent-only code", () => {
    expect(toBoard(fail("busy", "Try again in a few minutes."))).toEqual({
      ok: false,
      code: "busy",
      message: "Try again in a few minutes.",
    });
    expect(toBoard(fail("rate_limited", "slow down"))).toEqual({
      ok: false,
      code: "internal",
      message: "The backend failed.",
    });
    expect(toBoard(ok(1))).toEqual(ok(1));
  });
});

describe("seed target", () => {
  it("creates main, pushes the bundle, revokes every token and initializes the Repo", () =>
    withTarget(async ({ seed, target, host, main }) => {
      expect(await target.read()).toEqual(ok(null));
      const result = await target.seed(HEAD, fakePack());
      expect(result).toEqual(ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }));
      expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
      expect(seed.pushes).toHaveLength(1);
      expect(seed.fake.liveTokens(main)).toEqual([]);
      expect(host.initialized).toBe(true);
      expect(await target.read()).toEqual(ok({ repo: REPO_ID, main: HEAD }));
    }));

  it("answers repeated reads from one Artifacts read for a few seconds", () =>
    withTarget(async ({ seed, target, clock }) => {
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: true });
      const before = seed.gets;
      const reads = await Promise.all(Array.from({ length: 20 }, () => target.read()));
      expect(reads).toEqual(Array.from({ length: 20 }, () => ok({ repo: REPO_ID, main: HEAD })));
      clock.now += SEED_TARGET_LIMITS.readCacheMs - 1;
      expect(await target.read()).toEqual(ok({ repo: REPO_ID, main: HEAD }));
      expect(seed.gets).toBe(before + 1);

      // Past the interval the next read asks Artifacts again.
      clock.now += 1;
      expect(await target.read()).toEqual(ok({ repo: REPO_ID, main: HEAD }));
      expect(seed.gets).toBe(before + 2);
    }));

  it("drops the cached read after a seed or reset, even one that fails", () =>
    withTarget(async ({ seed, target, main }) => {
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: true });
      expect(await target.read()).toEqual(ok({ repo: REPO_ID, main: HEAD }));
      seed.fake.repos.get(main)?.commits.splice(0, 1, OTHER_HEAD);
      // Within the interval the cached answer stands.
      expect(await target.read()).toEqual(ok({ repo: REPO_ID, main: HEAD }));

      expect(await target.seed(HEAD, fakePack())).toMatchObject({
        ok: false,
        code: "action_stale",
      });
      expect(await target.read()).toEqual(ok({ repo: REPO_ID, main: OTHER_HEAD }));

      seed.fake.repos.get(main)?.commits.splice(0, 1, HEAD);
      seed.failDeleteOf = main;
      expect(await target.reset()).toMatchObject({ ok: false, code: "internal" });
      expect(await target.read()).toEqual(ok({ repo: REPO_ID, main: HEAD }));
    }));

  it("reads nothing from Artifacts before the Repo is initialized", () =>
    withTarget(async ({ seed, target }) => {
      expect(await target.read()).toEqual(ok(null));
      expect(seed.gets).toBe(0);
    }));

  it("succeeds again without pushing for the same head, and refuses another head", () =>
    withTarget(async ({ seed, target, host, main }) => {
      await target.seed(HEAD, fakePack());
      expect(await target.seed(HEAD, fakePack())).toEqual(
        ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
      );
      const other = await target.seed(OTHER_HEAD, fakePack());
      expect(other).toMatchObject({ ok: false, code: "action_stale" });
      expect(seed.pushes).toHaveLength(1);
      expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
      expect(host.initializeCalls).toBe(2);
    }));

  it("reconciles a push whose response was lost by reading main back", () =>
    withTarget(async ({ seed, target, main }) => {
      seed.pushFault = "lose-response";
      expect(await target.seed(HEAD, fakePack())).toEqual(
        ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
      );
      expect(seed.pushes).toHaveLength(1);
      expect(seed.fake.liveTokens(main)).toEqual([]);
    }));

  it("leaves the Repo uninitialized after a failed push, and finishes on the next seed", () =>
    withTarget(async ({ seed, target, host, main }) => {
      seed.pushFault = "drop";
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: false, code: "internal" });
      expect(host.initialized).toBe(false);
      expect(seed.fake.repos.get(main)?.commits).toEqual([]);
      expect(seed.fake.liveTokens(main)).toEqual([]);
      // The main repository already exists: the retry mints a fresh token instead of creating it.
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: true });
      expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
      expect(seed.fake.liveTokens(main)).toEqual([]);
    }));

  it("refuses to seed or reset without an Artifacts binding, changing nothing", () =>
    withTarget(
      async ({ seed, target, host }) => {
        expect(await target.seed(HEAD, fakePack())).toMatchObject({
          ok: false,
          code: "unavailable",
        });
        expect(await target.reset()).toMatchObject({ ok: false, code: "unavailable" });
        expect(host).toEqual({ initialized: false, initializeCalls: 0, wipes: 0 });
        expect(seed.pushes).toEqual([]);
      },
      { artifacts: false },
    ));

  it("refuses a second seed while one is running", () =>
    withTarget(async ({ seed, target }) => {
      const paused = seed.fake.pauseNext("get");
      const first = target.seed(HEAD, fakePack());
      await paused.reached;
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: false, code: "busy" });
      expect(await target.reset()).toMatchObject({ ok: false, code: "busy" });
      paused.release();
      expect(await first).toMatchObject({ ok: true });
    }));

  it("refuses to reset until a create that timed out answers, then deletes what it made", () =>
    withTarget(
      async ({ seed, target, host, main }) => {
        const create = seed.holdNextCreate();
        const first = target.seed(HEAD, fakePack());
        await create.reached;
        expect(await first).toMatchObject({ ok: false, code: "internal" });
        // The lock is free, but the create may still land: neither a seed nor a reset may run.
        expect(await target.reset()).toMatchObject({ ok: false, code: "busy" });
        expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: false, code: "busy" });
        expect(host.wipes).toBe(0);
        expect(seed.deleted).toEqual([]);

        create.release();
        expect(await eventually(() => target.reset())).toEqual(
          ok({ kind: "demo.reset", deleted: true }),
        );
        expect(seed.fake.repos.has(main)).toBe(false);
        expect(host.wipes).toBe(1);
      },
      { limits: SHORT_CALLS },
    ));

  it("refuses to seed until a token mint that timed out answers, and revokes that token", () =>
    withTarget(
      async ({ seed, target, host, main }) => {
        seed.fake.seed(main, []);
        const mint = seed.fake.pauseNext("createTokenBeforeMint");
        const first = target.seed(HEAD, fakePack());
        await mint.reached;
        expect(await first).toMatchObject({ ok: false, code: "internal" });
        expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: false, code: "busy" });
        expect(seed.pushes).toEqual([]);

        // The mint lands after its caller gave up; nothing may report success while it is live.
        mint.release();
        expect(await eventually(() => target.seed(HEAD, fakePack()))).toEqual(
          ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
        );
        expect(seed.fake.tokensMinted).toBe(2);
        expect(seed.fake.liveTokens(main)).toEqual([]);
        expect(host.initialized).toBe(true);
      },
      { limits: SHORT_CALLS },
    ));

  it("after a restart, settles a create the previous object never saw answered by reading main", () =>
    withTarget(
      async ({ seed, target, host, main, restart }) => {
        seed.hangAfterNextCreate = true;
        expect(await target.seed(HEAD, fakePack())).toMatchObject({
          ok: false,
          code: "internal",
        });

        // The new object cannot see the old call answer, but main exists, so the create took
        // effect and cannot take effect again: the reset needs no wait.
        const restarted = restart();
        expect(await restarted.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
        expect(seed.fake.repos.has(main)).toBe(false);
        expect(host.wipes).toBe(1);
      },
      { limits: SHORT_CALLS },
    ));

  it("after a restart, refuses a reset while a lost create may land, even after its answer", () =>
    withTarget(
      async ({ storage, seed, target, host, main, restart }) => {
        seed.hangAfterNextCreate = true;
        const create = seed.holdNextCreate();
        const first = target.seed(HEAD, fakePack());
        await create.reached;
        expect(await first).toMatchObject({ ok: false, code: "internal" });

        // Main is missing, but the create the old object lost may still land: the reset refuses
        // and keeps its record.
        const restarted = restart();
        expect(await restarted.reset()).toEqual(CREATE_UNSETTLED);
        expect(host.wipes).toBe(0);
        expect(seed.deleted).toEqual([]);
        expect(effectRows(storage)).toEqual([{ kind: "create", answered: 0 }]);

        // The lost create lands after the reset answered. Nothing was reported reset, and the
        // next reset reads main back, deletes it with its token, and leaves nothing to land.
        create.release();
        await eventually(async () => (seed.fake.repos.has(main) ? ok(true) : busyResult()));
        expect(seed.fake.liveTokens(main)).toHaveLength(1);
        expect(await restarted.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
        expect(host.wipes).toBe(1);
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(seed.fake.repos.has(main)).toBe(false);
        expect(seed.fake.repos.size).toBe(0);
      },
      { limits: SHORT_CALLS },
    ));

  it("after a restart, seeds over a create that never took effect, even if it lands late", () =>
    withTarget(
      async ({ seed, target, host, main, restart }) => {
        seed.hangAfterNextCreate = true;
        const create = seed.holdNextCreate();
        const first = target.seed(HEAD, fakePack());
        await create.reached;
        expect(await first).toMatchObject({ ok: false, code: "internal" });

        // The new object's own create answers; the held one has not reached Artifacts yet. Only a
        // seed may run over it: a reset would leave main free for the create to land on.
        seed.hangAfterNextCreate = false;
        const restarted = restart();
        expect(await restarted.reset()).toEqual(CREATE_UNSETTLED);
        expect(await restarted.seed(HEAD, fakePack())).toEqual(
          ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
        );
        expect(host.initialized).toBe(true);
        expect(seed.fake.liveTokens(main)).toEqual([]);

        // The lost create lands on the seeded main and is refused; main keeps its head.
        create.release();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
        expect(seed.fake.liveTokens(main)).toEqual([]);

        // Main settled the create, so the reset runs.
        expect(await restarted.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
        expect(seed.fake.repos.has(main)).toBe(false);
      },
      { limits: SHORT_CALLS },
    ));

  it("after a restart, keeps a create record while Artifacts cannot be read, and reports busy", () =>
    withTarget(
      async ({ storage, seed, target, host, main, restart }) => {
        seed.hangAfterNextCreate = true;
        expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: false, code: "internal" });

        const restarted = restart();
        seed.failGets = true;
        expect(await restarted.reset()).toEqual(ORPHAN_BUSY);
        expect(await restarted.seed(HEAD, fakePack())).toEqual(ORPHAN_BUSY);
        expect(effectRows(storage)).toEqual([{ kind: "create", answered: 0 }]);
        expect(seed.deleted).toEqual([]);
        expect(host.wipes).toBe(0);

        // Once Artifacts answers, main read back shows the create took effect, and the reset
        // deletes it.
        seed.failGets = false;
        expect(await restarted.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
        expect(seed.fake.repos.has(main)).toBe(false);
        expect(host.wipes).toBe(1);
      },
      { limits: SHORT_CALLS },
    ));

  it("after a restart, refuses until a delete that has not taken effect does, then seeds safely", () =>
    withTarget(
      async ({ seed, target, host, main, clock, restart }) => {
        expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: true });
        seed.hangAfterNextDelete = true;
        const deletion = seed.holdNextDelete();
        const first = target.reset();
        await deletion.reached;
        expect(await first).toMatchObject({ ok: false, code: "internal" });

        const restarted = restart();
        clock.now += 3_600_000;
        expect(await restarted.reset()).toEqual(UNCONFIRMED);
        expect(await restarted.seed(HEAD, fakePack())).toEqual(UNCONFIRMED);
        expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
        expect(host.wipes).toBe(0);

        // The delete lands and never answers. Main is gone, so it is settled: the reset finishes,
        // and a new main is not deleted by it afterwards.
        deletion.release();
        expect(await eventually(() => restarted.reset())).toEqual(
          ok({ kind: "demo.reset", deleted: true }),
        );
        expect(host.wipes).toBe(1);
        expect(await restarted.seed(HEAD, fakePack())).toEqual(
          ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
        );
        expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
        expect(seed.fake.liveTokens(main)).toEqual([]);
      },
      { limits: SHORT_CALLS },
    ));

  it("after a restart, refuses to seed over a lost token mint, however old, until a reset", () =>
    withTarget(
      async ({ storage, seed, target, host, main, clock, restart }) => {
        seed.fake.seed(main, []);
        const mint = seed.fake.pauseNext("createTokenBeforeMint");
        const answer = seed.fake.pauseNext("createToken");
        const first = target.seed(HEAD, fakePack());
        await mint.reached;
        expect(await first).toMatchObject({ ok: false, code: "internal" });

        // The mint may still be issued, with its lifetime counted from then, so no age settles it.
        const restarted = restart();
        clock.now += PUSH_TOKEN_EXPIRY_MS + 1;
        expect(await restarted.seed(HEAD, fakePack())).toEqual(MINT_UNSETTLED);
        expect(seed.pushes).toEqual([]);
        expect(host.initialized).toBe(false);
        expect(effectRows(storage)).toEqual([{ kind: "mint", answered: 0 }]);

        // It is issued late and leaves a live write token on main, which still refuses the seed.
        // Its call never answers, as the object that made it is gone.
        mint.release();
        await answer.reached;
        const [late] = seed.fake.liveTokens(main);
        if (late === undefined) throw new Error("the late mint left no token");
        expect(late.scope).toBe("write");
        expect(await restarted.seed(HEAD, fakePack())).toEqual(MINT_UNSETTLED);
        expect(host.initialized).toBe(false);

        // The reset deletes main and the token with it; the seed then finishes on a clean main.
        expect(await restarted.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
        expect(await restarted.seed(HEAD, fakePack())).toEqual(
          ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
        );
        expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
        expect(seed.fake.liveTokens(main)).toEqual([]);
        expect(seed.fake.accepts(late.plaintext)).toBe(false);
        expect(host.initialized).toBe(true);
      },
      { limits: SHORT_CALLS },
    ));

  it("after a restart, a reset settles a lost token mint at once by deleting main", () =>
    withTarget(
      async ({ seed, target, host, main, restart }) => {
        seed.fake.seed(main, []);
        const mint = seed.fake.pauseNext("createTokenBeforeMint");
        const answer = seed.fake.pauseNext("createToken");
        const first = target.seed(HEAD, fakePack());
        await mint.reached;
        expect(await first).toMatchObject({ ok: false, code: "internal" });

        const restarted = restart();
        expect(await restarted.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
        expect(seed.fake.repos.has(main)).toBe(false);
        expect(host.wipes).toBe(1);

        // Issued after the reset, the lost mint's token belongs to the deleted repository: the
        // next seed finishes, and the token opens nothing on the new main.
        mint.release();
        await answer.reached;
        expect(seed.fake.tokensMinted).toBe(1);
        expect(seed.fake.repos.has(main)).toBe(false);
        expect(await restarted.seed(HEAD, fakePack())).toEqual(
          ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
        );
        expect(seed.fake.liveTokens(main)).toEqual([]);
        expect(host.initialized).toBe(true);
      },
      { limits: SHORT_CALLS },
    ));

  it("refuses to reset while a push that timed out may still land, until main holds it", () =>
    withTarget(
      async ({ seed, target, host, main, restart }) => {
        const push = seed.holdNextPush();
        const first = target.seed(HEAD, fakePack());
        await push.reached;
        expect(await first).toMatchObject({ ok: false, code: "internal" });
        expect(seed.fake.repos.get(main)?.commits).toEqual([]);

        // Neither this object nor a restarted one resets while the push may land.
        expect(await target.reset()).toEqual(PUSH_UNCONFIRMED);
        expect(await restart().reset()).toEqual(PUSH_UNCONFIRMED);
        expect(seed.deleted).toEqual([]);
        expect(host.wipes).toBe(0);

        // The push lands late. Main now holds a commit, so no push can land on it any more, and
        // the reset deletes it.
        push.release();
        expect(await eventually(() => target.reset())).toEqual(
          ok({ kind: "demo.reset", deleted: true }),
        );
        expect(seed.fake.repos.has(main)).toBe(false);
        expect(host.wipes).toBe(1);
      },
      { limits: { ...SEED_TARGET_LIMITS, callTimeoutMs: 1_000, pushTimeoutMs: 50 } },
    ));

  it("settles a push that never answered when seeding again creates main", () =>
    withTarget(
      async ({ seed, target, host, main }) => {
        const push = seed.holdNextPush();
        expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: false, code: "internal" });
        expect(await target.reset()).toEqual(PUSH_UNCONFIRMED);

        expect(await target.seed(HEAD, fakePack())).toEqual(
          ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
        );
        expect(seed.fake.liveTokens(main)).toEqual([]);
        expect(await target.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
        expect(host.wipes).toBe(1);

        // The first push applies only to a main that still exists.
        push.release();
        await Promise.resolve();
        expect(seed.fake.repos.has(main)).toBe(false);
      },
      { limits: { ...SEED_TARGET_LIMITS, callTimeoutMs: 1_000, pushTimeoutMs: 50 } },
    ));

  it("does not report a reset when main reappears after its deletion", () =>
    withTarget(async ({ seed, target, host, main }) => {
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: true });
      seed.afterNextDelete = (name) => {
        if (name === main) seed.fake.seed(main, [OTHER_HEAD]);
      };
      expect(await target.reset()).toEqual({
        ok: false,
        code: "internal",
        message: "Main reappeared while the demo repository was reset; try again.",
      });
      expect(host.wipes).toBe(0);
      expect(host.initialized).toBe(true);

      expect(await target.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
      expect(seed.fake.repos.has(main)).toBe(false);
      expect(host.wipes).toBe(1);
    }));

  it("revokes the push token on a same-head retry after its revocation failed", () =>
    withTarget(async ({ seed, target, host, main }) => {
      seed.fake.failRevocations(100);
      expect(await target.seed(HEAD, fakePack())).toEqual({
        ok: false,
        code: "internal",
        message: "Main was imported but its push token was not revoked; try again.",
      });
      expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
      expect(seed.fake.liveTokens(main)).not.toEqual([]);
      expect(host.initialized).toBe(false);

      // Main already holds the head, so nothing is pushed, but the owed sweep still runs.
      seed.fake.failRevocations(0);
      expect(await target.seed(HEAD, fakePack())).toEqual(
        ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
      );
      expect(seed.pushes).toHaveLength(1);
      expect(seed.fake.liveTokens(main)).toEqual([]);
      expect(host.initialized).toBe(true);
    }));

  it("after a restart between push and revocation, revokes the token before initializing", () =>
    withTarget(async ({ seed, target, host, main, restart }) => {
      seed.fake.failRevocations(100);
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: false, code: "internal" });
      expect(seed.fake.liveTokens(main)).not.toEqual([]);

      seed.fake.failRevocations(0);
      const restarted = restart();
      expect(await restarted.seed(HEAD, fakePack())).toEqual(
        ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
      );
      expect(seed.fake.liveTokens(main)).toEqual([]);
      expect(host.initialized).toBe(true);
      // Once main is clean nothing is owed: a later seed on an operating main sweeps nothing.
      const holder = seed.fake.mintFor(main, "read", 300);
      expect(await restarted.seed(HEAD, fakePack())).toMatchObject({ ok: true });
      expect(seed.fake.liveTokens(main)).toEqual([holder]);
    }));

  it("revokes more live tokens than one sweep's budget across retries, then initializes", () =>
    withTarget(
      async ({ seed, target, host, main }) => {
        // The create's token and the push token, plus 40 more, all left on main by the seed.
        seed.onNextPush = () => {
          for (let i = 0; i < 40; i += 1) seed.fake.mintFor(main, "write", 300);
        };
        const unrevoked = {
          ok: false,
          code: "internal",
          message: "Main was imported but its push token was not revoked; try again.",
        };
        expect(await target.seed(HEAD, fakePack())).toEqual(unrevoked);
        expect(seed.fake.liveTokens(main)).toHaveLength(42 - 16);
        expect(host.initialized).toBe(false);
        expect(await target.seed(HEAD, fakePack())).toEqual(unrevoked);
        expect(seed.fake.liveTokens(main)).toHaveLength(42 - 32);
        expect(await target.seed(HEAD, fakePack())).toEqual(
          ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
        );
        expect(seed.fake.liveTokens(main)).toEqual([]);
        expect(seed.pushes).toHaveLength(1);
        expect(host.initialized).toBe(true);
      },
      { limits: { ...SEED_TARGET_LIMITS, callTimeoutMs: 1_000, maxRevokesPerSweep: 16 } },
    ));

  it("stops a slow sweep at its total deadline, and the next seed finishes it", () =>
    withTarget(
      async ({ seed, target, host, main }) => {
        seed.onNextPush = () => {
          for (let i = 0; i < 30; i += 1) seed.fake.mintFor(main, "write", 300);
        };
        seed.fake.slowRevocations(40);
        const started = Date.now();
        expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: false, code: "internal" });
        // Thirty-two revocations at 40 ms each would take 1.28 s; the deadline stops it near 200 ms.
        expect(Date.now() - started).toBeLessThan(1_000);
        const left = seed.fake.liveTokens(main).length;
        expect(left).toBeGreaterThan(0);
        expect(left).toBeLessThan(32);
        expect(host.initialized).toBe(false);

        seed.fake.slowRevocations(0);
        expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: true });
        expect(seed.fake.liveTokens(main)).toEqual([]);
        expect(host.initialized).toBe(true);
      },
      { limits: { ...SEED_TARGET_LIMITS, callTimeoutMs: 1_000, sweepDeadlineMs: 200 } },
    ));

  it("does not initialize while main's token listing is partial, and finishes once it is whole", () =>
    withTarget(async ({ seed, target, host, main }) => {
      seed.onNextPush = () => {
        for (let i = 0; i < 10; i += 1) seed.fake.mintFor(main, "write", 300);
      };
      // As if Artifacts stopped listing tokens: the sweep sees none of the twelve.
      seed.fake.pageTokens(0);
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: false, code: "internal" });
      expect(seed.fake.liveTokens(main)).toHaveLength(12);
      expect(host.initialized).toBe(false);

      seed.fake.pageTokens(TOKEN_PAGE_SIZE);
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: true });
      expect(seed.fake.liveTokens(main)).toEqual([]);
      expect(host.initialized).toBe(true);
    }));

  it("reads main by its branch name, which Artifacts resolves where the full ref name is empty", () =>
    withTarget(async ({ seed, target, host, main }) => {
      expect(await target.seed(HEAD, fakePack())).toEqual(
        ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
      );
      expect(seed.pushes).toHaveLength(1);
      expect(seed.pushes[0]?.command).toContain(" refs/heads/main\0");
      expect(await target.read()).toEqual(ok({ repo: REPO_ID, main: HEAD }));
      using repo = await seed.get(main);
      expect(await repo.log({ ref: "refs/heads/main", limit: 1 })).toEqual([]);

      // A seed whose push landed before the Repo was initialized finds main in place.
      host.initialized = false;
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: true });
      expect(seed.pushes).toHaveLength(1);
      expect(host.initialized).toBe(true);
    }));

  it("reads main's branch, not HEAD, so a HEAD naming another branch still seeds", () =>
    withTarget(async ({ seed, target, host, main }) => {
      seed.fake.seed(main, []).headRef = "refs/heads/trunk";
      expect(await target.seed(HEAD, fakePack())).toEqual(
        ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
      );
      expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
      expect(host.initialized).toBe(true);
      expect(await target.read()).toEqual(ok({ repo: REPO_ID, main: HEAD }));
      // A retry reads the same branch and finds the work done, pushing nothing.
      expect(await target.seed(HEAD, fakePack())).toMatchObject({ ok: true });
      expect(seed.pushes).toHaveLength(1);
    }));

  it("resets by deleting the recorded forks and then main by name, and nothing else", () =>
    withTarget(async ({ seed, target, storage, host, main }) => {
      await target.seed(HEAD, fakePack());
      seed.fake.seed("rh-m-another-repo", [OTHER_HEAD]);
      const adapter = createArtifactsAdapter({
        repoId: REPO_ID,
        storage,
        clock: seed.fake.clock,
        namespace: seed.fake,
      });
      const fork = await adapter.forkForClaim("clm_claim0001", HEAD);
      if (!fork.ok) throw new Error(fork.code);

      expect(await target.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
      expect(seed.deleted).toEqual([fork.value.repo, main]);
      expect([...seed.fake.repos.keys()]).toEqual(["rh-m-another-repo"]);
      expect(host.wipes).toBe(1);

      // A reset of an absent repository deletes nothing and still succeeds.
      expect(await target.reset()).toEqual(ok({ kind: "demo.reset", deleted: false }));
    }));

  it("refuses a reset when the fork records are newer than this code, deleting nothing", () =>
    withTarget(async ({ seed, target, storage, host, main }) => {
      await target.seed(HEAD, fakePack());
      const adapter = createArtifactsAdapter({
        repoId: REPO_ID,
        storage,
        clock: seed.fake.clock,
        namespace: seed.fake,
      });
      const fork = await adapter.forkForClaim("clm_claim0001", HEAD);
      if (!fork.ok) throw new Error(fork.code);
      storage.sql.exec("UPDATE railhead_migrations SET version = 99 WHERE owner = 'artifacts'");

      expect(await target.reset()).toEqual({
        ok: false,
        code: "internal",
        message: "The demo repository's fork records could not be read.",
      });
      expect(seed.deleted).toEqual([]);
      expect(seed.fake.repos.has(fork.value.repo)).toBe(true);
      expect(seed.fake.repos.has(main)).toBe(true);
      expect(host.wipes).toBe(0);
    }));

  it("stops a reset whose deletion failed before wiping the Repo", () =>
    withTarget(async ({ seed, target, host, main }) => {
      await target.seed(HEAD, fakePack());
      seed.failNextDelete = true;
      expect(await target.reset()).toMatchObject({ ok: false, code: "internal" });
      expect(host.wipes).toBe(0);
      expect(seed.fake.repos.has(main)).toBe(true);
      expect(await target.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
      expect(host.wipes).toBe(1);
    }));

  it("refuses every seed after a reset whose first deletion failed, until a reset finishes", () =>
    withTarget(async ({ seed, target, storage, host, main }) => {
      await target.seed(HEAD, fakePack());
      const adapter = createArtifactsAdapter({
        repoId: REPO_ID,
        storage,
        clock: seed.fake.clock,
        namespace: seed.fake,
      });
      const fork = await adapter.forkForClaim("clm_claim0001", HEAD);
      if (!fork.ok) throw new Error(fork.code);
      const pushes = seed.pushes.length;
      const mints = seed.fake.createTokenCalls;

      seed.failDeleteOf = fork.value.repo;
      expect(await target.reset()).toMatchObject({ ok: false, code: "internal" });
      expect(seed.deleted).toEqual([]);
      expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
      expect(host.wipes).toBe(0);

      // The failed call may still have deleted the fork, so even main's own head is refused.
      for (const head of [HEAD, OTHER_HEAD]) {
        expect(await target.seed(head, fakePack())).toMatchObject({
          ok: false,
          code: "action_stale",
        });
      }
      expect(seed.pushes.length).toBe(pushes);
      expect(seed.fake.createTokenCalls).toBe(mints);
      expect(host.initializeCalls).toBe(1);

      seed.failDeleteOf = null;
      expect(await target.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
      expect(seed.deleted).toEqual([fork.value.repo, main]);
      expect(host.wipes).toBe(1);
      expect(await target.seed(HEAD, fakePack())).toEqual(
        ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
      );
    }));

  it("refuses a same-head seed after a reset deleted one fork and failed on the next", () =>
    withTarget(async ({ seed, target, storage, host, main, restart }) => {
      await target.seed(HEAD, fakePack());
      const adapter = createArtifactsAdapter({
        repoId: REPO_ID,
        storage,
        clock: seed.fake.clock,
        namespace: seed.fake,
      });
      const forks: string[] = [];
      for (const claim of ["clm_claim0001", "clm_claim0002"] as const) {
        const fork = await adapter.forkForClaim(claim, HEAD);
        if (!fork.ok) throw new Error(fork.code);
        forks.push(fork.value.repo);
      }
      // The reset deletes forks in name order.
      const [first, second] = forks.toSorted();
      if (first === undefined || second === undefined) throw new Error("two forks expected");

      seed.failDeleteOf = second;
      expect(await target.reset()).toMatchObject({ ok: false, code: "internal" });
      expect(seed.deleted).toEqual([first]);
      expect(seed.fake.repos.has(first)).toBe(false);
      expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
      expect(host.wipes).toBe(0);

      // Main still holds the head, but the Repo still records the deleted fork: the seed must not
      // report the demo as seeded, and neither may a restarted object.
      const refused = {
        ok: false,
        code: "action_stale",
        message: "A reset of the demo repository did not finish. Reset it first.",
      };
      expect(await target.seed(HEAD, fakePack())).toEqual(refused);
      expect(await restart().seed(HEAD, fakePack())).toEqual(refused);
      expect(host.initializeCalls).toBe(1);

      // A reset that finishes skips the fork already gone, deletes the rest and clears the way.
      seed.failDeleteOf = null;
      expect(await target.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
      expect(seed.deleted).toEqual([first, second, main]);
      expect(host.wipes).toBe(1);
      expect(await target.seed(HEAD, fakePack())).toEqual(
        ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
      );
      expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
      expect(seed.fake.liveTokens(main)).toEqual([]);
    }));

  it("refuses to seed an initialized Repo whose main is missing or empty until a reset", () =>
    withTarget(async ({ seed, target, host, main }) => {
      await target.seed(HEAD, fakePack());
      const pushes = seed.pushes.length;
      const mints = seed.fake.createTokenCalls;

      // Main lost its history, then the repository itself, under an initialized Repo.
      seed.fake.repos.get(main)?.commits.splice(0);
      expect(await target.seed(HEAD, fakePack())).toMatchObject({
        ok: false,
        code: "action_stale",
      });
      seed.fake.repos.delete(main);
      expect(await target.seed(HEAD, fakePack())).toMatchObject({
        ok: false,
        code: "action_stale",
      });
      expect(seed.fake.repos.has(main)).toBe(false);
      expect(seed.pushes.length).toBe(pushes);
      expect(seed.fake.createTokenCalls).toBe(mints);
      expect(host.initializeCalls).toBe(1);

      // A finished reset clears the way, and the seed creates main again and leaves no token.
      expect(await target.reset()).toEqual(ok({ kind: "demo.reset", deleted: true }));
      expect(await target.seed(HEAD, fakePack())).toEqual(
        ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
      );
      expect(seed.fake.repos.get(main)?.commits).toEqual([HEAD]);
      expect(seed.fake.liveTokens(main)).toEqual([]);
    }));
});

// ---------------------------------------------------------------------------------------------
// The control: a software authenticator stands in for the owner's passkey

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

function derInteger(raw: Uint8Array): number[] {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start += 1;
  const body = [...raw.subarray(start)];
  if ((body[0] ?? 0) & 0x80) body.unshift(0);
  return [0x02, body.length, ...body];
}

/** The CBOR text string `text`, shorter than 24 bytes. */
function cborText(text: string): number[] {
  const bytes = enc.encode(text);
  return [0x60 | bytes.length, ...bytes];
}

class Authenticator {
  #counter = 0;

  private constructor(
    readonly privateKey: CryptoKey,
    readonly credential: StoredCredential,
    readonly idBytes: Uint8Array,
  ) {}

  static async create(): Promise<Authenticator> {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    if (!("privateKey" in pair)) throw new Error("ECDSA generateKey returned a single key");
    const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
    if (!(exported instanceof ArrayBuffer)) throw new Error("raw export is not bytes");
    const raw = new Uint8Array(exported);
    const cose = Uint8Array.from([
      0xa5,
      0x01,
      0x02,
      0x03,
      0x26,
      0x20,
      0x01,
      0x21,
      0x58,
      32,
      ...raw.slice(1, 33),
      0x22,
      0x58,
      32,
      ...raw.slice(33),
    ]);
    const idBytes = crypto.getRandomValues(new Uint8Array(16));
    return new Authenticator(
      pair.privateKey,
      {
        credentialId: b64url(idBytes),
        publicKey: cose,
        userHandle: b64url(crypto.getRandomValues(new Uint8Array(16))),
        signCount: 0,
      },
      idBytes,
    );
  }

  /** A registration of this credential with a `none` attestation, for the enrollment ceremony. */
  async register(challenge: string): Promise<PasskeyRegistration> {
    const clientData = enc.encode(
      JSON.stringify({ type: "webauthn.create", challenge, origin: ORIGIN, crossOrigin: false }),
    );
    const authData = Uint8Array.from([
      ...(await sha256(enc.encode(HOST))),
      0x45,
      0,
      0,
      0,
      0,
      ...new Uint8Array(16),
      0,
      this.idBytes.length,
      ...this.idBytes,
      ...this.credential.publicKey,
    ]);
    const attestation = Uint8Array.from([
      0xa3,
      ...cborText("fmt"),
      ...cborText("none"),
      ...cborText("attStmt"),
      0xa0,
      ...cborText("authData"),
      0x58,
      authData.length,
      ...authData,
    ]);
    return {
      credentialId: this.credential.credentialId,
      clientDataJson: b64url(clientData),
      attestationObject: b64url(attestation),
    };
  }

  async assert(
    challenge: string,
    userHandle: string = this.credential.userHandle,
  ): Promise<PasskeyAssertion> {
    this.#counter += 1;
    const clientData = enc.encode(
      JSON.stringify({ type: "webauthn.get", challenge, origin: ORIGIN, crossOrigin: false }),
    );
    const authData = new Uint8Array(37);
    authData.set(await sha256(enc.encode(HOST)), 0);
    authData[32] = 0x05;
    new DataView(authData.buffer).setUint32(33, this.#counter, false);
    const signed = Uint8Array.from([...authData, ...(await sha256(clientData))]);
    const raw = new Uint8Array(
      await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.privateKey, signed),
    );
    const der = [...derInteger(raw.subarray(0, 32)), ...derInteger(raw.subarray(32))];
    return {
      credentialId: this.credential.credentialId,
      clientDataJson: b64url(clientData),
      authenticatorData: b64url(authData),
      signature: b64url(Uint8Array.from([0x30, der.length, ...der])),
      userHandle,
    };
  }
}

interface ControlSetup {
  auth: Authenticator;
  control: ReturnType<typeof createSeedControl>;
  calls: { seed: { head: string; pack: number[] }[]; resets: number };
  clock: { now: number };
  sign: (action: DemoSeedAction) => Promise<{ challengeId: string; assertion: PasskeyAssertion }>;
}

function withControl(
  body: (setup: ControlSetup) => Promise<void>,
  options: { enrolled?: boolean } = {},
): Promise<void> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const auth = await Authenticator.create();
    const clock = { now: Date.now() };
    const calls: ControlSetup["calls"] = { seed: [], resets: 0 };
    let signCount = 0;
    const instance: InstanceOwnerPort = {
      credential: async () =>
        options.enrolled === false
          ? null
          : { userId: "usr_owner0000001", credential: auth.credential },
      recordSignCount: async (_id, count) => {
        if (count <= signCount) return false;
        signCount = count;
        return true;
      },
    };
    const target: SeedTargetCalls = {
      seed: async (head, pack): Promise<PortResult<DemoSeedResult>> => {
        calls.seed.push({ head, pack: [...pack] });
        return ok({ kind: "demo.seed", repo: REPO_ID, head });
      },
      reset: async () => {
        calls.resets += 1;
        return ok({ kind: "demo.reset", deleted: true });
      },
    };
    const control = createSeedControl({
      storage: state.storage,
      clock: () => clock.now,
      repoId: REPO_ID,
      instance,
      relyingParty: relyingParty(HOST),
      target,
    });
    const sign = async (action: DemoSeedAction) => {
      const prepared = await control.prepare(action);
      if (!prepared.ok) throw new Error(`prepare failed: ${prepared.code}`);
      return {
        challengeId: prepared.value.challengeId,
        assertion: await auth.assert(prepared.value.challenge),
      };
    };
    await body({ auth, control, calls, clock, sign });
  });
}

describe("seed control", () => {
  it("hands a verified seed and its pack to the demo repository, once", () =>
    withControl(async ({ control, calls, sign }) => {
      const { challengeId, assertion } = await sign({ kind: "demo.seed", head: HEAD });
      expect(await control.perform(challengeId, assertion, MAIN_BUNDLE)).toEqual(
        ok({ kind: "demo.seed", repo: REPO_ID, head: HEAD }),
      );
      expect(calls.seed).toEqual([{ head: HEAD, pack: [...fakePack()] }]);
      expect(await control.perform(challengeId, assertion, MAIN_BUNDLE)).toMatchObject({
        ok: false,
        code: "proof_expired",
      });
      expect(calls.seed).toHaveLength(1);
    }));

  it("refuses a bundle that does not match the approved head without spending the proof", () =>
    withControl(async ({ control, calls, sign }) => {
      const { challengeId, assertion } = await sign({ kind: "demo.seed", head: HEAD });
      const other = bundle([`${OTHER_HEAD} refs/heads/main`]);
      for (const wrong of [other, null, new Uint8Array(MAX_DEMO_BUNDLE_BYTES + 1), fakePack()]) {
        expect(await control.perform(challengeId, assertion, wrong)).toMatchObject({
          ok: false,
          code: "invalid_request",
        });
      }
      expect(calls.seed).toEqual([]);
      expect(await control.perform(challengeId, assertion, MAIN_BUNDLE)).toMatchObject({
        ok: true,
      });
    }));

  it("resets only with a reset proof and no bundle", () =>
    withControl(async ({ control, calls, sign }) => {
      const reset = await sign({ kind: "demo.reset" });
      expect(await control.perform(reset.challengeId, reset.assertion, MAIN_BUNDLE)).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(await control.perform(reset.challengeId, reset.assertion, null)).toEqual(
        ok({ kind: "demo.reset", deleted: true }),
      );
      expect(calls.resets).toBe(1);
    }));

  it("refuses a proof whose signature counter did not advance, and spends it", () =>
    withControl(async ({ control, calls, sign }) => {
      // Signed first with counter 1, used after an assertion with counter 2 was recorded: what a
      // cloned or replaying authenticator presents.
      const earlier = await sign({ kind: "demo.reset" });
      const later = await sign({ kind: "demo.seed", head: HEAD });
      expect(await control.perform(later.challengeId, later.assertion, MAIN_BUNDLE)).toMatchObject({
        ok: true,
      });

      expect(await control.perform(earlier.challengeId, earlier.assertion, null)).toMatchObject({
        ok: false,
        code: "proof_invalid",
      });
      expect(calls.resets).toBe(0);
      expect(calls.seed).toHaveLength(1);
      expect(await control.perform(earlier.challengeId, earlier.assertion, null)).toMatchObject({
        ok: false,
        code: "proof_expired",
      });
      expect(calls.resets).toBe(0);
    }));

  it("refuses an assertion for another challenge, a forged seal and an expired challenge", () =>
    withControl(async ({ control, calls, clock, sign }) => {
      const seed = await sign({ kind: "demo.seed", head: HEAD });
      const reset = await sign({ kind: "demo.reset" });
      expect(await control.perform(reset.challengeId, seed.assertion, null)).toMatchObject({
        ok: false,
        code: "proof_invalid",
      });

      // The same fields under a reset action, with the seed's seal: the seal no longer checks.
      const parts = seed.challengeId.split(".");
      const forgedAction = b64url(enc.encode(JSON.stringify({ kind: "demo.reset" })));
      const forged = [parts[0], parts[1], parts[2], forgedAction, parts[4]].join(".");
      expect(await control.perform(forged, seed.assertion, null)).toMatchObject({
        ok: false,
        code: "proof_invalid",
      });
      expect(await control.perform("not-a-challenge", seed.assertion, null)).toMatchObject({
        ok: false,
        code: "invalid_request",
      });

      clock.now += 3 * 60_000;
      expect(await control.perform(seed.challengeId, seed.assertion, MAIN_BUNDLE)).toMatchObject({
        ok: false,
        code: "proof_expired",
      });
      expect(calls).toEqual({ seed: [], resets: 0 });
    }));

  it("refuses to prepare a malformed head or before an owner passkey is enrolled", async () => {
    await withControl(async ({ control }) => {
      expect(await control.prepare({ kind: "demo.seed", head: "HEAD" })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    });
    await withControl(
      async ({ control }) => {
        expect(await control.prepare({ kind: "demo.reset" })).toMatchObject({
          ok: false,
          code: "unavailable",
        });
      },
      { enrolled: false },
    );
  });
});

/** A challenge id shaped like a seed challenge for `action`, under a seal no object issued. */
function forgedChallengeId(action: DemoSeedAction, prefix = "dsc"): string {
  return [
    `${prefix}_${"0".repeat(32)}`,
    String(Date.now() + 60_000),
    b64url(new Uint8Array(32).fill(1)),
    b64url(enc.encode(JSON.stringify(action))),
    b64url(new Uint8Array(32).fill(2)),
  ].join(".");
}

describe("checkPerformInput", () => {
  const seedId = forgedChallengeId({ kind: "demo.seed", head: HEAD });

  it("passes a seed-shaped id with a bundle up to the bound, and a reset with none", () => {
    expect(checkPerformInput(seedId, MAIN_BUNDLE)).toEqual(ok(undefined));
    expect(checkPerformInput(seedId, new Uint8Array(MAX_DEMO_BUNDLE_BYTES))).toEqual(ok(undefined));
    expect(checkPerformInput(forgedChallengeId({ kind: "demo.reset" }), null)).toEqual(
      ok(undefined),
    );
  });

  it("refuses a bundle one byte over the bound", () => {
    expect(checkPerformInput(seedId, new Uint8Array(MAX_DEMO_BUNDLE_BYTES + 1))).toEqual({
      ok: false,
      code: "invalid_request",
      message: "The bundle is too large.",
    });
  });

  it("refuses an id not shaped like a seed challenge", () => {
    const parts = seedId.split(".");
    for (const id of [
      "",
      "not-a-challenge",
      parts.slice(0, 4).join("."),
      `${seedId}.extra`,
      // An owner-action id, or one sealing something that is not a seed action.
      forgedChallengeId({ kind: "demo.seed", head: HEAD }, "pkc"),
      [parts[0], parts[1], parts[2], b64url(enc.encode('{"kind":"demo.drop"}')), parts[4]].join(
        ".",
      ),
      `${seedId}${"A".repeat(1024)}`,
    ]) {
      expect(checkPerformInput(id, null)).toEqual({
        ok: false,
        code: "invalid_request",
        message: "That is not an action challenge id.",
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The deployed entry

async function openSession(): Promise<WebSocket> {
  const response = await SELF.fetch(`${ORIGIN}${API_PATH}`, { headers: { Upgrade: "websocket" } });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new TypeError("Expected a WebSocket response.");
  socket.accept();
  return socket;
}

describe("demo seed entry", () => {
  // The pool declares the Worker's `ARTIFACTS` binding but cannot reach it, as it is remote only.
  // The demo object reads the binding when its seed target is first built, so it is removed first.
  beforeEach(async () => {
    await runInDurableObject(env.REPO.getByName(DEMO_OBJECT_NAME), (instance) => {
      Reflect.set(instance, "env", { ...env, ARTIFACTS: undefined });
    });
  });

  it("reports a fresh instance's demo repository as absent and refuses without an owner", async () => {
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using seed = await api.demoSeed();
    expect(await seed.read()).toEqual({ ok: true, value: null });
    expect(await seed.prepare({ kind: "demo.reset" })).toMatchObject({
      ok: false,
      code: "unavailable",
    });
  });

  it("refuses a malformed action at the RPC boundary", async () => {
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using seed = await api.demoSeed();
    const bogus: unknown = { kind: "demo.drop" };
    // @ts-expect-error: the boundary's own validation is under test.
    await expect(seed.prepare(bogus)).rejects.toThrow();
  });

  it("refuses an oversized bundle and a malformed id before the control object", async () => {
    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using seed = await api.demoSeed();
    const assertion: PasskeyAssertion = {
      credentialId: "AAAA",
      clientDataJson: "AAAA",
      authenticatorData: "AAAA",
      signature: "AAAA",
      userHandle: null,
    };
    const forged = forgedChallengeId({ kind: "demo.seed", head: HEAD });
    // Within the bound, the forged id reaches the control, which refuses its seal.
    expect(await seed.perform(forged, assertion, MAIN_BUNDLE)).toMatchObject({
      ok: false,
      code: "proof_invalid",
    });
    // Over it, the Worker refuses first: the control, which checks the seal before the size, would
    // have answered `proof_invalid`.
    const oversized = new Uint8Array(MAX_DEMO_BUNDLE_BYTES + 1);
    expect(await seed.perform(forged, assertion, oversized)).toEqual({
      ok: false,
      code: "invalid_request",
      message: "The bundle is too large.",
    });
    expect(await seed.perform("not-a-challenge", assertion, oversized)).toEqual({
      ok: false,
      code: "invalid_request",
      message: "That is not an action challenge id.",
    });
  });

  it("answers each role only on its own object", async () => {
    const other = env.REPO.getByName("acme/not-the-demo");
    expect(await other.seedDemo(HEAD, fakePack())).toMatchObject({ ok: false, code: "not_found" });
    expect(await other.resetDemo()).toMatchObject({ ok: false, code: "not_found" });
    expect(await other.prepareDemoSeed({ kind: "demo.reset" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const demo = env.REPO.getByName(DEMO_OBJECT_NAME);
    expect(await demo.prepareDemoSeed({ kind: "demo.reset" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    const control = env.REPO.getByName(DEMO_SEED_CONTROL);
    expect(await control.resetDemo()).toMatchObject({ ok: false, code: "not_found" });
    // Without the binding, the deployed demo repository refuses to seed and stays absent.
    expect(await demo.seedDemo(HEAD, fakePack())).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(await demo.describe()).toBeNull();
  });

  it("keeps the control object out of the repository address space", async () => {
    // No `org/name` pair of repository segments names the control object, so no route reaches it.
    const [org, name, ...rest] = DEMO_SEED_CONTROL.split("/");
    expect(rest.length > 0 || !isRepoSegment(org ?? "") || !isRepoSegment(name ?? "")).toBe(true);
    const control = env.REPO.getByName(DEMO_SEED_CONTROL);
    for (const [o, n] of [
      ["railhead-seed", "demo"],
      ["railhead", "demo-seed"],
      ["demo", "upload-app"],
    ] as const) {
      expect(await control.initialize(o, n)).toMatchObject({ ok: false, code: "invalid_request" });
    }
    expect(await control.describe()).toBeNull();
    // The name the control once had is an ordinary repository address with no seed authority.
    const formerName = env.REPO.getByName("railhead-seed/demo");
    expect(await formerName.prepareDemoSeed({ kind: "demo.reset" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
  });

  it("performs the owner's reset and a seed near the bundle bound through the session", async () => {
    const auth = await Authenticator.create();
    const userHandle = await runInDurableObject(
      env.OWNER.getByName(OWNER_OBJECT_NAME),
      async (_instance, state) => {
        const owner = new InstanceOwner(state.storage, {
          bootstrapToken: "t".repeat(40),
          relyingParty: relyingParty(HOST),
          clock: Date.now,
        });
        const challenge = await owner.prepareEnrollment("t".repeat(40));
        if (!challenge.ok) throw new Error(`enrollment failed: ${challenge.code}`);
        const done = await owner.completeEnrollment(
          challenge.value.challengeId,
          await auth.register(challenge.value.challenge),
        );
        if (!done.ok) throw new Error(`enrollment failed: ${done.code}`);
        return challenge.value.userHandle;
      },
    );
    const party = relyingParty(HOST);
    if (party === undefined) throw new Error("the test host is not a relying party host");

    using api = newWebSocketRpcSession<RailheadApi>(await openSession());
    using seed = await api.demoSeed();

    const reset = await seed.prepare({ kind: "demo.reset" });
    if (!reset.ok) throw new Error(`prepare failed: ${reset.code}`);
    // The WebAuthn challenge is bound to the demo repository's identifier and the sealed fields.
    const [challengeId, expiresAt, nonce] = reset.value.challengeId.split(".");
    const expected = await actionChallenge(party, {
      repoId: demoRepoId(env),
      challengeId: challengeId ?? "",
      nonce: nonce ?? "",
      expiresAt: Number(expiresAt),
      action: { kind: "demo.reset" },
    });
    expect(expected).toEqual({ ok: true, challenge: reset.value.challenge });
    expect(reset.value.allowCredentials).toEqual([auth.credential.credentialId]);

    // The proof is spent at the control; without an Artifacts binding the demo repository then
    // answers `unavailable`, and the same proof cannot be used again.
    const resetProof = await auth.assert(reset.value.challenge, userHandle);
    expect(await seed.perform(reset.value.challengeId, resetProof, null)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(await seed.perform(reset.value.challengeId, resetProof, null)).toMatchObject({
      ok: false,
      code: "proof_expired",
    });

    // A bundle one byte under the bound crosses Cap'n Web and the Durable Object call intact.
    const header = enc.encode(`# v2 git bundle\n${HEAD} refs/heads/main\n\n`);
    const pack = new Uint8Array(MAX_DEMO_BUNDLE_BYTES - 1 - header.length);
    pack.set(fakePack());
    const large = new Uint8Array(header.length + pack.length);
    large.set(header);
    large.set(pack, header.length);
    expect(large.length).toBe(MAX_DEMO_BUNDLE_BYTES - 1);
    const seeded = await seed.prepare({ kind: "demo.seed", head: HEAD });
    if (!seeded.ok) throw new Error(`prepare failed: ${seeded.code}`);
    const seedProof = await auth.assert(seeded.value.challenge, userHandle);
    expect(await seed.perform(seeded.value.challengeId, seedProof, large)).toMatchObject({
      ok: false,
      code: "unavailable",
    });
    expect(await seed.perform(seeded.value.challengeId, seedProof, large)).toMatchObject({
      ok: false,
      code: "proof_expired",
    });
    expect(await seed.read()).toEqual({ ok: true, value: null });
  });
});
