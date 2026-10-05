import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MAX_TEARDOWN_ATTEMPTS,
  START_PROBE,
  SandboxFence,
  SandboxFenceError,
  teardownRetryDelay,
  type FencedContainer,
} from "../src/sandbox/fence";
import { MAX_SANDBOX_LIFETIME_MS } from "../src/sandbox/admission";
import { MAX_OUTPUT_BYTES } from "../src/sandbox/entry";
import { serveGitGateway, type GatewayDeps } from "../src/sandbox/gateway";
import { readBoundedExec } from "../src/sandbox/output";
import { CANDIDATE_REF_PREFIX, type SandboxGrant, type SandboxPolicy } from "../src/sandbox/policy";
import { wakeTime } from "../src/sandbox/sandboxObject";
import { deferred } from "./sliceWorld";

const POLICY: SandboxPolicy = {
  host: "acct.artifacts.cloudflare.net",
  namespace: "railhead",
  read: ["main-repo"],
  write: { repo: "main-repo", refPrefix: `${CANDIDATE_REF_PREFIX}chk_attempt1/` },
};

// Not on a whole second, so a scheduler that keeps whole seconds would wake the fence early.
const START = 1_000_900;
const DEADLINE = START + 60_000;

// How long a test fence's `retire` waits for operations under way, in real milliseconds.
const SETTLE_MS = 60;

function noop(): void {}

/**
 * A container that, like the SDK's, starts on any command and stops on destroy. Each operation can
 * be paused with `hold` until the test releases it. Its scheduler is the SDK's as well: it keeps
 * each wake-up in whole seconds, rounded down, and runs it once.
 */
class FakeContainer {
  running = false;
  destroys = 0;
  destroyFails = false;
  /** Whether the next destroy never returns, as when the object restarts during it. */
  destroyHangs = false;
  /** Whether scheduling a wake-up fails. */
  wakeFails = false;
  /** A wake-up time whose next scheduling fails, once. */
  wakeFailsOnceAt: number | null = null;
  /** What the next command does instead of succeeding. */
  nextExec: "fails" | "exits_1" | "ignores_timeout" | null = null;
  grants: SandboxGrant[] = [];
  /** Every wake-up the fence asked for, in milliseconds. */
  wakes: number[] = [];
  /** The wake-ups still scheduled, in the seconds the SDK keeps. */
  scheduled: { seconds: number }[] = [];
  commands: { command: string; timeoutMs: number }[] = [];
  readonly #held = new Map<string, Promise<void>>();

  hold(op: "route" | "exec"): () => void {
    const gate = deferred();
    this.#held.set(op, gate.promise);
    return () => {
      this.#held.delete(op);
      gate.resolve();
    };
  }

  readonly container: FencedContainer = {
    route: async (grant) => {
      await this.#held.get("route");
      this.grants.push(grant);
    },
    exec: async (command, options) => {
      this.commands.push({ command, timeoutMs: options.timeoutMs });
      await this.#held.get("exec");
      this.running = true;
      const outcome = this.nextExec;
      this.nextExec = null;
      switch (outcome) {
        case "fails":
          throw new Error("scripted command failure");
        case "exits_1":
          return { exitCode: 1, stdout: "", stderr: "", truncated: false };
        case "ignores_timeout":
          // Neither the signal nor the timeout stops it, as with the SDK's streaming exec.
          return new Promise<never>(noop);
        case null:
          return { exitCode: 0, stdout: "ok", stderr: "", truncated: false };
        default:
          throw new Error(`unknown scripted command: ${outcome satisfies never}`);
      }
    },
    destroy: async () => {
      this.destroys += 1;
      if (this.destroyHangs) {
        this.destroyHangs = false;
        await new Promise<void>(noop);
      }
      if (this.destroyFails) throw new Error("scripted destroy failure");
      this.running = false;
    },
    wake: async (at) => {
      if (this.wakeFails) throw new Error("scripted wake failure");
      if (this.wakeFailsOnceAt === at) {
        this.wakeFailsOnceAt = null;
        throw new Error("scripted wake failure");
      }
      this.wakes.push(at);
      this.scheduled.push({ seconds: Math.floor(at / 1_000) });
    },
  };
}

interface Harness {
  fence: SandboxFence;
  fake: FakeContainer;
  advance: (ms: number) => void;
  /** A second fence over the same storage, as after the object restarted. */
  reopen: () => SandboxFence;
  /** The fence's durable phase. */
  phase: () => string | null;
  /** Deletes the object's storage, as `RailheadSandbox` does once the fence is disposable. */
  forget: () => Promise<void>;
  /** A fence over the same storage that drives `container` instead of the fake. */
  over: (container: FencedContainer) => SandboxFence;
  /**
   * The object's alarm, as the SDK runs it: every wake-up due now runs once on a fresh fence and is
   * then removed, whether it succeeded or failed. One scheduled while they run waits for the next.
   */
  alarm: () => Promise<void>;
}

/** Runs `body` with a fence over the storage of a Durable Object no other test touches. */
function withFence(body: (harness: Harness) => Promise<void>): Promise<void> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    let now = START;
    const clock = () => now;
    const fake = new FakeContainer();
    const reopen = () => new SandboxFence(state.storage, fake.container, clock, SETTLE_MS);
    await body({
      fence: reopen(),
      fake,
      advance: (ms) => (now += ms),
      reopen,
      over: (container) => new SandboxFence(state.storage, container, clock, SETTLE_MS),
      forget: () => state.storage.deleteAll(),
      phase: () => {
        const stored: unknown = state.storage.kv.get("railhead:fence");
        if (typeof stored !== "object" || stored === null || !("phase" in stored)) return null;
        return typeof stored.phase === "string" ? stored.phase : null;
      },
      alarm: async () => {
        const due = fake.scheduled.filter((wake) => wake.seconds * 1_000 <= now);
        for (const wake of due) {
          await reopen()
            .expire()
            .catch(() => undefined);
          fake.scheduled.splice(fake.scheduled.indexOf(wake), 1);
        }
      },
    });
  });
}

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof SandboxFenceError) return error.code;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("sandbox fence", () => {
  it("starts under a grant that lapses at the deadline and schedules its own expiry", async () => {
    await withFence(async ({ fence, fake }) => {
      await fence.start(POLICY, DEADLINE);

      expect(fake.running).toBe(true);
      expect(fake.grants).toEqual([{ policy: POLICY, expiresAt: DEADLINE }]);
      expect(fake.wakes).toEqual([DEADLINE]);
      expect(fake.commands).toEqual([{ command: START_PROBE, timeoutMs: 60_000 }]);
    });
  });

  it("retires at its deadline with no other traffic though the scheduler wakes it early", async () => {
    await withFence(async ({ fence, fake, advance, alarm }) => {
      await fence.start(POLICY, DEADLINE);

      // The scheduler kept the deadline's whole second and wakes the fence 900 ms early.
      advance(59_100);
      await alarm();
      expect(fake.running).toBe(true);

      advance(900);
      await alarm();
      expect(fake.running).toBe(false);
      expect(await refusal(fence.exec({ command: "true", timeoutMs: 1_000 }))).toBe("retired");
      expect(fake.running).toBe(false);
    });
  });

  it("schedules wake-ups the SDK cannot run before their time", () => {
    expect(wakeTime(1_060_900).getTime()).toBe(1_061_000);
    expect(wakeTime(1_060_001).getTime()).toBe(1_061_000);
    expect(wakeTime(1_060_000).getTime()).toBe(1_060_000);
    // The SDK keeps whole seconds, rounding down: the second it keeps is never before the wake-up.
    for (const at of [DEADLINE, DEADLINE + 1, DEADLINE + 999]) {
      expect(Math.floor(wakeTime(at).getTime() / 1_000) * 1_000).toBeGreaterThanOrEqual(at);
    }
  });

  it("cuts a command to the remaining lifetime and refuses a result that arrives after it", async () => {
    await withFence(async ({ fence, fake, advance }) => {
      await fence.start(POLICY, DEADLINE);
      advance(50_000);
      const resume = fake.hold("exec");

      const run = fence.exec({ command: "make test", timeoutMs: 600_000 });
      await flush();
      expect(fake.commands.at(-1)).toEqual({ command: "make test", timeoutMs: 10_000 });
      advance(10_000);
      resume();

      expect(await refusal(run)).toBe("expired");
      expect(fake.running).toBe(false);
      expect(await refusal(fence.exec({ command: "true", timeoutMs: 1_000 }))).toBe("retired");
    });
  });

  it("refuses a start that arrives after retirement and runs nothing", async () => {
    await withFence(async ({ fence, fake }) => {
      // A release can reach the object before the start that preceded it.
      await fence.retire();

      expect(await refusal(fence.start(POLICY, DEADLINE))).toBe("retired");
      expect(fake.running).toBe(false);
      expect(fake.commands).toEqual([]);
      expect(fake.grants).toEqual([]);
    });
  });

  it("waits for a paused start on retire, and that start destroys the container it started", async () => {
    await withFence(async ({ fence, fake }) => {
      const resume = fake.hold("exec");
      const start = fence.start(POLICY, DEADLINE);
      await flush();

      let retired = false;
      const retire = fence.retire().then(() => {
        retired = true;
      });
      await flush();
      expect(retired).toBe(false);

      // The probe starts the container after retirement destroyed it once.
      resume();
      expect(await refusal(start)).toBe("retired");
      await retire;
      expect(retired).toBe(true);
      expect(fake.running).toBe(false);
    });
  });

  it("refuses a start paused before routing once retired, without running the probe", async () => {
    await withFence(async ({ fence, fake }) => {
      const resume = fake.hold("route");
      const start = fence.start(POLICY, DEADLINE);
      await flush();
      const retire = fence.retire();
      await flush();

      resume();
      expect(await refusal(start)).toBe("retired");
      await retire;
      expect(fake.commands).toEqual([]);
      expect(fake.running).toBe(false);
    });
  });

  it("refuses a start past its deadline or for another deadline", async () => {
    await withFence(async ({ fence, fake, advance }) => {
      await fence.start(POLICY, DEADLINE);
      expect(await refusal(fence.start(POLICY, DEADLINE + 1))).toBe("retired");
      expect(fake.running).toBe(true);

      advance(60_000);
      expect(await refusal(fence.start(POLICY, DEADLINE))).toBe("expired");
      expect(fake.running).toBe(false);
    });
  });

  it("stays retired when destroy fails, so a retry can finish the teardown", async () => {
    await withFence(async ({ fence, fake, reopen }) => {
      await fence.start(POLICY, DEADLINE);
      fake.destroyFails = true;

      await expect(fence.retire()).rejects.toThrow("scripted destroy failure");
      expect(fake.running).toBe(true);
      expect(await refusal(reopen().exec({ command: "true", timeoutMs: 1_000 }))).toBe("retired");

      fake.destroyFails = false;
      await reopen().retire();
      expect(fake.running).toBe(false);
    });
  });

  it("destroys at the deadline a container whose release failed, with no other traffic", async () => {
    await withFence(async ({ fence, fake, advance, alarm }) => {
      await fence.start(POLICY, DEADLINE);
      fake.destroyFails = true;
      await expect(fence.retire()).rejects.toThrow("scripted destroy failure");
      fake.destroyFails = false;

      advance(60_000);
      await alarm();

      expect(fake.running).toBe(false);
    });
  });

  it("retries a destroy that failed at the deadline, with no other traffic", async () => {
    await withFence(async ({ fence, fake, advance, alarm }) => {
      await fence.start(POLICY, DEADLINE);
      fake.destroyFails = true;
      advance(60_000);
      await alarm();
      expect(fake.running).toBe(true);

      fake.destroyFails = false;
      advance(teardownRetryDelay(1));
      await alarm();

      expect(fake.running).toBe(false);
      expect(fake.destroys).toBe(2);
    });
  });

  it("retries a destroy cut off by a restart", async () => {
    await withFence(async ({ fence, fake, advance, alarm }) => {
      await fence.start(POLICY, DEADLINE);
      fake.destroyHangs = true;
      // The release never returns: the object restarted while it waited on the container.
      void fence.retire();
      await flush();
      expect(fake.running).toBe(true);

      advance(teardownRetryDelay(1));
      await alarm();

      expect(fake.running).toBe(false);
    });
  });

  it("stops retrying on its own after the last attempt, leaving the release to the repository", async () => {
    await withFence(async ({ fence, fake, advance, alarm }) => {
      await fence.start(POLICY, DEADLINE);
      fake.destroyFails = true;
      advance(60_000);
      for (let i = 0; i < MAX_TEARDOWN_ATTEMPTS + 4; i += 1) {
        await alarm();
        advance(teardownRetryDelay(MAX_TEARDOWN_ATTEMPTS));
      }

      expect(fake.destroys).toBe(MAX_TEARDOWN_ATTEMPTS);
      expect(fake.scheduled).toEqual([]);
      expect(fake.running).toBe(true);

      fake.destroyFails = false;
      await fence.retire();
      expect(fake.running).toBe(false);
    });
  });

  it("refuses a command before any start", async () => {
    await withFence(async ({ fence, fake }) => {
      expect(await refusal(fence.exec({ command: "true", timeoutMs: 1_000 }))).toBe("not_started");
      expect(fake.commands).toEqual([]);
    });
  });
});

const encoder = new TextEncoder();

/** A candidate push, its pkt-lines written by hand. */
function candidatePush(): Request {
  const line = `${"0".repeat(40)} ${"2".repeat(40)} ${CANDIDATE_REF_PREFIX}chk_attempt1/head\u0000report-status\n`;
  const pkt = (encoder.encode(line).length + 4).toString(16).padStart(4, "0") + line;
  return new Request(`https://${POLICY.host}/git/railhead/main-repo.git/git-receive-pack`, {
    method: "POST",
    body: `${pkt}0000PACKbytes`,
  });
}

/**
 * A gateway over `fence`'s grant check. After `hold`, a mint waits until the test resumes it, and
 * `minting` settles once one has begun.
 */
function gateway(fence: () => SandboxFence, clock: () => number) {
  const minted: string[] = [];
  const forwarded: string[] = [];
  let mintGate: Promise<void> | null = null;
  const minting = deferred();
  const deps: GatewayDeps = {
    mint: async (repo, scope) => {
      minted.push(`${repo}:${scope}`);
      minting.resolve();
      await mintGate;
      return "token";
    },
    fetch: async (request) => {
      forwarded.push(await request.text());
      return new Response("upstream");
    },
    now: clock,
    current: async (expiresAt) => fence().grantCurrent(expiresAt),
  };
  return {
    minted,
    forwarded,
    minting: minting.promise,
    hold: () => {
      const gate = deferred();
      mintGate = gate.promise;
      return gate.resolve;
    },
    serve: (request: Request) =>
      serveGitGateway(request, { policy: POLICY, expiresAt: DEADLINE }, deps),
  };
}

describe("sandbox fence admission", () => {
  const OTHER: SandboxPolicy = { ...POLICY, read: ["other-repo"], write: null };

  it("accepts a repeat start under the same policy and refuses one that would replace it", async () => {
    await withFence(async ({ fence, fake }) => {
      await fence.start(POLICY, DEADLINE);
      await fence.start(POLICY, DEADLINE);

      expect(await refusal(fence.start(OTHER, DEADLINE))).toBe("mismatch");
      // The incarnation keeps the grant it was admitted under, and still runs.
      expect(fake.grants).toEqual([
        { policy: POLICY, expiresAt: DEADLINE },
        { policy: POLICY, expiresAt: DEADLINE },
      ]);
      expect(fence.grantCurrent(DEADLINE)).toBe(true);
      expect(fake.running).toBe(true);
      await fence.exec({ command: "true", timeoutMs: 1_000 });
    });
  });

  it("joins only the live incarnation under its own policy and deadline, starting nothing", async () => {
    await withFence(async ({ fence, fake }) => {
      await fence.start(POLICY, DEADLINE);
      const commands = fake.commands.length;

      await fence.join(POLICY, DEADLINE);
      expect(await refusal(fence.join(OTHER, DEADLINE))).toBe("mismatch");
      expect(await refusal(fence.join(POLICY, DEADLINE + 1))).toBe("mismatch");

      expect(fake.grants).toHaveLength(1);
      expect(fake.commands).toHaveLength(commands);
      expect(fence.grantCurrent(DEADLINE)).toBe(true);
    });
  });

  it("refuses to join a sandbox never started, and retires the name for any later start", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      expect(await refusal(fence.join(POLICY, DEADLINE))).toBe("not_started");

      expect(fake.grants).toEqual([]);
      expect(fake.commands).toEqual([]);
      expect(phase()).toBe("retired");
      expect(await refusal(fence.start(POLICY, DEADLINE))).toBe("retired");
    });
  });

  it("refuses to join a retired incarnation", async () => {
    await withFence(async ({ fence }) => {
      await fence.start(POLICY, DEADLINE);
      await fence.retire();

      expect(await refusal(fence.join(POLICY, DEADLINE))).toBe("retired");
    });
  });
});

describe("sandbox fence disposal", () => {
  it("is disposable only once retired and past the deadline, never while live", async () => {
    await withFence(async ({ fence, fake, advance, forget, reopen }) => {
      expect(fence.disposable()).toBe(false);
      await fence.start(POLICY, DEADLINE);
      expect(fence.disposable()).toBe(false);

      await fence.retire();
      expect(fence.disposable()).toBe(false);
      advance(DEADLINE - START - 1);
      expect(fence.disposable()).toBe(false);
      advance(1);

      expect(fence.disposable()).toBe(true);
      expect(await refusal(fence.start(POLICY, DEADLINE))).toBe("retired");

      // Once the storage is gone, a late start for the incarnation is past its deadline and starts
      // nothing; the object is disposable again.
      await forget();
      const commands = fake.commands.length;
      const grants = fake.grants.length;
      const restarted = reopen();
      expect(await refusal(restarted.start(POLICY, DEADLINE))).toBe("expired");
      expect(fake.commands).toHaveLength(commands);
      expect(fake.grants).toHaveLength(grants);
      expect(fake.running).toBe(false);
      expect(restarted.disposable()).toBe(true);
    });
  });

  it("asks to be woken at the deadline after an early retirement, then becomes disposable", async () => {
    await withFence(async ({ fence, fake, advance, alarm }) => {
      await fence.start(POLICY, DEADLINE);
      await fence.retire();
      // The deadline wake-up from the start is spent, as when the SDK ran it early.
      fake.scheduled.length = 0;

      advance(5_000);
      await fence.expire();
      expect(fake.wakes.at(-1)).toBe(DEADLINE);
      expect(fence.disposable()).toBe(false);

      advance(DEADLINE - START - 5_000);
      await alarm();
      expect(fence.disposable()).toBe(true);
    });
  });

  it("asks to be woken at the deadline when the last destroy attempt confirms early", async () => {
    await withFence(async ({ fence, fake, advance, alarm, phase }) => {
      // The longest lifetime: every retry fits before it.
      const deadline = START + MAX_SANDBOX_LIFETIME_MS;
      await fence.start(POLICY, deadline);
      // The start's deadline wake-up ran early, as a scheduler may, and is spent.
      fake.scheduled.length = 0;
      fake.destroyFails = true;
      await fence.retire().catch(noop);
      for (let attempt = 1; attempt < MAX_TEARDOWN_ATTEMPTS - 1; attempt += 1) {
        advance(teardownRetryDelay(attempt));
        await alarm();
      }
      expect(fake.destroys).toBe(MAX_TEARDOWN_ATTEMPTS - 1);
      expect(phase()).toBe("retiring");

      fake.destroyFails = false;
      advance(teardownRetryDelay(MAX_TEARDOWN_ATTEMPTS - 1));
      await alarm();

      expect(fake.destroys).toBe(MAX_TEARDOWN_ATTEMPTS);
      expect(phase()).toBe("retired");
      expect(fake.scheduled).toEqual([{ seconds: Math.floor(deadline / 1_000) }]);
      expect(fence.disposable()).toBe(false);

      // Past the deadline, that wake-up runs and the object may delete its storage.
      advance(MAX_SANDBOX_LIFETIME_MS);
      await alarm();
      expect(fake.scheduled).toEqual([]);
      expect(fence.disposable()).toBe(true);
    });
  });

  it("fails a confirmed release whose deadline wake-up cannot be scheduled, then schedules it at the next wake-up", async () => {
    await withFence(async ({ fence, fake, advance, alarm, phase }) => {
      await fence.start(POLICY, DEADLINE);
      fake.scheduled.length = 0;
      fake.wakes.length = 0;
      fake.wakeFailsOnceAt = DEADLINE;

      await expect(fence.retire()).rejects.toThrow("scripted wake failure");
      expect(fake.destroys).toBe(1);
      expect(phase()).toBe("retired");
      expect(fake.wakes).not.toContain(DEADLINE);

      // The retry wake-up the destroy scheduled first finds it retired and asks for the deadline.
      advance(teardownRetryDelay(1));
      await alarm();
      expect(fake.wakes.at(-1)).toBe(DEADLINE);
      expect(fence.disposable()).toBe(false);

      advance(DEADLINE - START - teardownRetryDelay(1));
      await alarm();
      expect(fence.disposable()).toBe(true);
    });
  });

  it("asks to be woken at once when the last destroy attempt confirms past the deadline", async () => {
    await withFence(async ({ fence, fake, advance, phase }) => {
      await fence.start(POLICY, DEADLINE);
      fake.destroyFails = true;
      for (let attempt = 1; attempt < MAX_TEARDOWN_ATTEMPTS; attempt += 1) {
        await fence.retire().catch(noop);
      }
      fake.destroyFails = false;
      advance(DEADLINE - START + 1_000);
      fake.scheduled.length = 0;

      await fence.retire();

      expect(fake.destroys).toBe(MAX_TEARDOWN_ATTEMPTS);
      expect(phase()).toBe("retired");
      expect(fake.scheduled).toEqual([{ seconds: Math.floor((DEADLINE + 1_000) / 1_000) }]);
      expect(fence.disposable()).toBe(true);
    });
  });

  it("is not disposable while a destroy is unconfirmed, though the deadline passed", async () => {
    await withFence(async ({ fence, fake, advance, phase }) => {
      await fence.start(POLICY, DEADLINE);
      fake.destroyFails = true;
      await fence.retire().catch(noop);
      advance(DEADLINE - START);

      expect(phase()).toBe("retiring");
      expect(fence.disposable()).toBe(false);

      fake.destroyFails = false;
      await fence.expire();
      expect(phase()).toBe("retired");
      expect(fence.disposable()).toBe(true);
    });
  });

  it("keeps a sandbox released before it started refused until any deadline its slot had passed", async () => {
    await withFence(async ({ fence, fake, advance }) => {
      await fence.retire();
      const latest = START + MAX_SANDBOX_LIFETIME_MS;

      advance(MAX_SANDBOX_LIFETIME_MS - 1);
      expect(fence.disposable()).toBe(false);
      expect(await refusal(fence.start(POLICY, latest))).toBe("retired");
      advance(1);

      expect(fence.disposable()).toBe(true);
      expect(fake.commands).toEqual([]);
      expect(fake.grants).toEqual([]);
    });
  });
});

describe("sandbox grant at retirement", () => {
  it("holds only for the live incarnation's own deadline, until that deadline", async () => {
    await withFence(async ({ fence, advance }) => {
      expect(fence.grantCurrent(DEADLINE)).toBe(false);
      await fence.start(POLICY, DEADLINE);

      expect(fence.grantCurrent(DEADLINE)).toBe(true);
      expect(fence.grantCurrent(DEADLINE + 1)).toBe(false);
      advance(DEADLINE - START - 1);
      expect(fence.grantCurrent(DEADLINE)).toBe(true);
      advance(1);
      expect(fence.grantCurrent(DEADLINE)).toBe(false);
    });
  });

  it("forwards nothing from a push whose token mint spans an early retirement", async () => {
    await withFence(async ({ fence, reopen }) => {
      let now = START;
      const git = gateway(reopen, () => now);
      await fence.start(POLICY, DEADLINE);
      const resume = git.hold();

      const pending = git.serve(candidatePush());
      await git.minting;
      expect(git.minted).toEqual(["main-repo:write"]);
      // Released well before the deadline, while the token is being minted.
      now += 1_000;
      await fence.retire();
      resume();
      const response = await pending;

      expect(response.status).toBe(403);
      expect(await response.text()).toContain("retired");
      expect(git.forwarded).toEqual([]);
    });
  });

  it("refuses a container whose destroy failed, though its grant has time left", async () => {
    await withFence(async ({ fence, fake, reopen }) => {
      const git = gateway(reopen, () => START + 1_000);
      await fence.start(POLICY, DEADLINE);
      expect((await git.serve(candidatePush())).status).toBe(200);
      fake.destroyFails = true;

      await expect(fence.retire()).rejects.toThrow("scripted destroy failure");
      expect(fake.running).toBe(true);
      const response = await git.serve(candidatePush());

      expect(response.status).toBe(403);
      expect(await response.text()).toContain("retired");
      // Refused before a token was minted for it.
      expect(git.minted).toEqual(["main-repo:write"]);
      expect(git.forwarded).toHaveLength(1);
    });
  });

  it("refuses the old sandbox's grant after the same attempt is readmitted in a fresh one", async () => {
    await withFence(async ({ fence: old }) => {
      await old.start(POLICY, DEADLINE);
      await old.retire();
      // The readmitted attempt runs in another object, under the same policy and candidate prefix.
      const fresh = env.REPO.getByName(crypto.randomUUID());
      await runInDurableObject(fresh, async (_instance, state) => {
        const replacement = new SandboxFence(
          state.storage,
          new FakeContainer().container,
          () => START,
        );
        await replacement.start(POLICY, DEADLINE);
        const oldGit = gateway(
          () => old,
          () => START + 1_000,
        );
        const freshGit = gateway(
          () => replacement,
          () => START + 1_000,
        );

        expect(await (await oldGit.serve(candidatePush())).text()).toContain("retired");
        expect((await freshGit.serve(candidatePush())).status).toBe(200);
        expect(oldGit.minted).toEqual([]);
        expect(oldGit.forwarded).toEqual([]);
        expect(freshGit.forwarded).toHaveLength(1);
      });
    });
  });
});

describe("sandbox fence failures", () => {
  it("destroys the container when the start probe fails or exits non-zero", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      fake.nextExec = "exits_1";
      expect(await refusal(fence.start(POLICY, DEADLINE))).toBe("probe_failed");
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
    });
    await withFence(async ({ fence, fake, phase }) => {
      fake.nextExec = "fails";
      await expect(fence.start(POLICY, DEADLINE)).rejects.toThrow("scripted command failure");
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
    });
  });

  it("destroys the container when a command fails, and runs nothing after", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      await fence.start(POLICY, DEADLINE);
      fake.nextExec = "fails";

      await expect(fence.exec({ command: "make", timeoutMs: 1_000 })).rejects.toThrow(
        "scripted command failure",
      );
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
      expect(await refusal(fence.exec({ command: "true", timeoutMs: 1_000 }))).toBe("retired");
    });
  });

  it("times out a command the container does not stop and destroys the container", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      await fence.start(POLICY, DEADLINE);
      fake.nextExec = "ignores_timeout";

      expect(await refusal(fence.exec({ command: "sleep 600", timeoutMs: 20 }))).toBe("timed_out");
      expect(fake.running).toBe(false);
      // The abandoned command never settles, so retirement never confirms.
      expect(phase()).toBe("retiring");
    });
  });

  it("reports both failures and keeps the container retiring when a failed command's destroy fails", async () => {
    await withFence(async ({ fence, fake, phase, reopen }) => {
      await fence.start(POLICY, DEADLINE);
      fake.nextExec = "fails";
      fake.destroyFails = true;

      const error: unknown = await fence
        .exec({ command: "make", timeoutMs: 1_000 })
        .catch((e) => e);
      expect(error).toBeInstanceOf(AggregateError);
      expect(fake.running).toBe(true);
      expect(phase()).toBe("retiring");

      fake.destroyFails = false;
      await reopen().retire();
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
    });
  });

  it("still destroys on release when no wake-up can be scheduled, and reports the lost deadline wake-up", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      await fence.start(POLICY, DEADLINE);
      fake.wakeFails = true;

      await expect(fence.retire()).rejects.toThrow("scripted wake failure");

      expect(fake.destroys).toBe(1);
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
    });
  });

  it("keeps a release whose retry and destroy both fail retiring, and finishes it after a restart", async () => {
    await withFence(async ({ fence, fake, phase, reopen }) => {
      await fence.start(POLICY, DEADLINE);
      fake.wakeFails = true;
      fake.destroyFails = true;

      await expect(fence.retire()).rejects.toThrow(
        "the sandbox was not destroyed and its retry was not scheduled",
      );
      expect(fake.destroys).toBe(1);
      expect(fake.running).toBe(true);
      expect(phase()).toBe("retiring");
      expect(reopen().grantCurrent(DEADLINE)).toBe(false);

      fake.wakeFails = false;
      fake.destroyFails = false;
      await reopen().retire();
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
    });
  });

  it("still destroys at the deadline when the retry wake-up cannot be scheduled", async () => {
    await withFence(async ({ fence, fake, advance, alarm, phase }) => {
      await fence.start(POLICY, DEADLINE);
      fake.wakeFails = true;
      fake.destroyFails = true;
      advance(60_000);
      await alarm();

      expect(fake.destroys).toBe(1);
      expect(fake.running).toBe(true);
      expect(phase()).toBe("retiring");
      // No retry was scheduled; the deadline's wake-up was consumed.
      expect(fake.scheduled).toEqual([]);

      // The repository's release, or any later wake-up, finishes the teardown.
      fake.wakeFails = false;
      fake.destroyFails = false;
      await fence.retire();
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
    });
  });

  it("retires early rather than lose its deadline when an early wake-up cannot reschedule", async () => {
    await withFence(async ({ fence, fake, advance, alarm, phase }) => {
      await fence.start(POLICY, DEADLINE);
      fake.wakeFails = true;
      advance(59_100);
      await alarm();

      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
    });
  });
});

describe("sandbox command timeout over the output reader", () => {
  it("stops reading a command that outlives its timeout and destroys its container", async () => {
    await withFence(async ({ over, phase }) => {
      // A container whose command writes until something stops it, read as the SDK driver reads.
      let processRunning = false;
      let streamCancelled = false;
      const container: FencedContainer = {
        route: async () => undefined,
        wake: async () => undefined,
        destroy: async () => {
          processRunning = false;
        },
        exec: async (command, options) => {
          if (command === START_PROBE) {
            return { exitCode: 0, stdout: "", stderr: "", truncated: false };
          }
          processRunning = true;
          const frames = new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (!processRunning) return controller.close();
              controller.enqueue(encoder.encode(`data: {"type":"stdout","data":"z"}\n\n`));
              await new Promise((resolve) => setTimeout(resolve, 2));
            },
            cancel() {
              streamCancelled = true;
            },
          });
          return readBoundedExec(frames, MAX_OUTPUT_BYTES, options.signal);
        },
      };
      const fence = over(container);
      await fence.start(POLICY, DEADLINE);

      expect(await refusal(fence.exec({ command: "sleep 600", timeoutMs: 30 }))).toBe("timed_out");
      expect(streamCancelled).toBe(true);
      expect(processRunning).toBe(false);
      expect(phase()).toBe("retired");
    });
  });
});

describe("sandbox command settling after its timeout", () => {
  it("keeps retirement unconfirmed until a late command settles, then destroys what it started", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      await fence.start(POLICY, DEADLINE);
      // The command is still starting the container when its timeout fires.
      const resume = fake.hold("exec");
      expect(await refusal(fence.exec({ command: "make", timeoutMs: 20 }))).toBe("timed_out");
      expect(phase()).toBe("retiring");

      // The release cannot confirm while the command may still start the container.
      expect(await refusal(fence.retire())).toBe("unsettled");
      expect(phase()).toBe("retiring");
      expect(fence.grantCurrent(DEADLINE)).toBe(false);

      const destroysBefore = fake.destroys;
      resume();
      await flush();
      expect(fake.destroys).toBe(destroysBefore + 1);
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
      await fence.retire();
      expect(fake.running).toBe(false);
    });
  });

  it("confirms a release that was waiting once the late command settles within the bound", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      await fence.start(POLICY, DEADLINE);
      const resume = fake.hold("exec");
      expect(await refusal(fence.exec({ command: "make", timeoutMs: 20 }))).toBe("timed_out");

      let confirmed = false;
      const retire = fence.retire().then(() => {
        confirmed = true;
      });
      await flush();
      expect(confirmed).toBe(false);

      resume();
      await retire;
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
    });
  });

  it("destroys the container a late command started though the command then failed", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      await fence.start(POLICY, DEADLINE);
      const resume = fake.hold("exec");
      expect(await refusal(fence.exec({ command: "make", timeoutMs: 20 }))).toBe("timed_out");
      expect(await refusal(fence.retire())).toBe("unsettled");

      // As the SDK driver's reader does: the container starts, then the aborted read rejects.
      fake.nextExec = "fails";
      resume();
      await flush();
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
      await fence.retire();
    });
  });

  it("destroys the container a start's late probe started", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      const resume = fake.hold("exec");
      // Twenty milliseconds of lifetime is the probe's timeout.
      expect(await refusal(fence.start(POLICY, START + 20))).toBe("timed_out");
      expect(await refusal(fence.retire())).toBe("unsettled");
      expect(await refusal(fence.start(POLICY, START + 20))).toBe("retired");

      resume();
      await flush();
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
    });
  });

  it("never confirms retirement, on release or at a wake-up, while a late command never settles", async () => {
    await withFence(async ({ fence, fake, phase, advance }) => {
      await fence.start(POLICY, DEADLINE);
      fake.nextExec = "ignores_timeout";
      expect(await refusal(fence.exec({ command: "make", timeoutMs: 20 }))).toBe("timed_out");

      expect(await refusal(fence.retire())).toBe("unsettled");
      // The wake-up runs in the same object, where the command is still in flight.
      advance(60_000);
      expect(await refusal(fence.expire())).toBe("unsettled");
      expect(phase()).toBe("retiring");
      expect(await refusal(fence.retire())).toBe("unsettled");
      expect(phase()).toBe("retiring");
      // Each attempt left its retry scheduled.
      expect(fake.scheduled.length).toBeGreaterThan(0);
    });
  });
});

/**
 * A container whose destroy behaves as the SDK's: one that overlaps a destroy in flight joins it
 * rather than stopping the container again, and the container stops before that destroy returns.
 * Every destroy is held until the test returns it; a command started by `make` waits for `resume`.
 */
function coalescingContainer(late: "succeeds" | "fails") {
  const state = {
    running: false,
    /** Destroys that reached the container, not counting those that joined one in flight. */
    stops: 0,
    /** Returns the destroy in flight. */
    finishDestroy: noop,
  };
  const command = deferred();
  const stopped = { ...deferred(), count: 0 };
  let inflight: Promise<void> | null = null;
  const container: FencedContainer = {
    route: async () => undefined,
    wake: async () => undefined,
    destroy: () => {
      if (inflight !== null) return inflight;
      state.stops += 1;
      state.running = false;
      const gate = deferred();
      state.finishDestroy = gate.resolve;
      inflight = gate.promise.then(() => {
        inflight = null;
      });
      stopped.resolve();
      return inflight;
    },
    exec: async (name) => {
      if (name !== START_PROBE) await command.promise;
      state.running = true;
      if (name !== START_PROBE && late === "fails") throw new Error("aborted output reader");
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    },
  };
  return { state, container, resume: command.resolve, firstStop: stopped.promise };
}

describe("sandbox teardown racing a late command", () => {
  for (const late of ["succeeds", "fails"] as const) {
    it(`destroys again after a late command that ${late} restarted the container during a destroy`, async () => {
      await withFence(async ({ over, phase }) => {
        const sdk = coalescingContainer(late);
        const fence = over(sdk.container);
        await fence.start(POLICY, DEADLINE);
        expect(sdk.state.running).toBe(true);

        // The command times out and its fail-closed destroy stops the container, still in flight.
        const exec = refusal(fence.exec({ command: "make", timeoutMs: 20 }));
        await sdk.firstStop;
        expect(sdk.state.stops).toBe(1);
        expect(sdk.state.running).toBe(false);

        // The abandoned command starts the container again and settles while that destroy runs.
        sdk.resume();
        await flush();
        expect(sdk.state.running).toBe(true);

        // The first destroy returns; it stopped the container before the restart, so it confirms
        // nothing, and the next destroy reaches the container rather than joining it.
        sdk.state.finishDestroy();
        expect(await exec).toBe("timed_out");
        await flush();
        expect(phase()).toBe("retiring");
        expect(sdk.state.stops).toBe(2);
        expect(sdk.state.running).toBe(false);

        sdk.state.finishDestroy();
        await flush();
        expect(phase()).toBe("retired");
        expect(sdk.state.stops).toBe(2);
      });
    });
  }

  it("confirms a release only after a destroy that followed the late command's restart", async () => {
    await withFence(async ({ over, phase }) => {
      const sdk = coalescingContainer("succeeds");
      const fence = over(sdk.container);
      await fence.start(POLICY, DEADLINE);

      const exec = refusal(fence.exec({ command: "make", timeoutMs: 20 }));
      await sdk.firstStop;
      // The release arrives while the command is pending and the fail-closed destroy is in flight.
      let released = false;
      const release = fence.retire().then(() => {
        released = true;
      });
      sdk.resume();
      await flush();
      sdk.state.finishDestroy();
      expect(await exec).toBe("timed_out");

      // Every later destroy reaches the container; none returns until the one before it has.
      for (let stops = 2; stops <= 4; stops += 1) {
        await flush();
        expect(sdk.state.stops).toBe(stops);
        expect(released).toBe(false);
        sdk.state.finishDestroy();
      }
      await release;
      expect(sdk.state.running).toBe(false);
      expect(phase()).toBe("retired");
    });
  });
});

/**
 * A container operation the fence does not issue itself, such as the SDK's backup restore: it
 * waits on R2 until the test answers, then reaches the container through `admit`, as every SDK path
 * to it does through `RailheadSandbox.containerFetch`.
 */
function pausedOperation(fence: SandboxFence, fake: FakeContainer) {
  const r2 = deferred();
  const touched: string[] = [];
  let started = false;
  const operation = async () => {
    started = true;
    await r2.promise;
    fence.admit();
    fake.running = true;
    touched.push("extract");
    return "restored";
  };
  return { operation, answer: r2.resolve, touched, started: () => started };
}

describe("sandbox operations the fence does not issue itself", () => {
  it("runs one inside the live incarnation and leaves it live", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      await fence.start(POLICY, DEADLINE);
      const paused = pausedOperation(fence, fake);
      const result = fence.operate(paused.operation);
      paused.answer();
      expect(await result).toBe("restored");
      expect(paused.touched).toEqual(["extract"]);
      expect(phase()).toBe("live");
      expect(fence.grantCurrent(DEADLINE)).toBe(true);
    });
  });

  it("refuses one before the start, after retirement or past the deadline without running it", async () => {
    await withFence(async ({ fence, fake, advance }) => {
      const early = pausedOperation(fence, fake);
      expect(await refusal(fence.operate(early.operation))).toBe("not_started");
      expect(early.started()).toBe(false);

      await fence.start(POLICY, DEADLINE);
      advance(60_000);
      const late = pausedOperation(fence, fake);
      const destroysBefore = fake.destroys;
      expect(await refusal(fence.operate(late.operation))).toBe("expired");
      expect(late.started()).toBe(false);
      expect(fake.destroys).toBe(destroysBefore + 1);

      const retired = pausedOperation(fence, fake);
      expect(await refusal(fence.operate(retired.operation))).toBe("retired");
      expect(retired.started()).toBe(false);
      expect(fake.running).toBe(false);
    });
  });

  it("never touches the container when a restore started before expiry resumes after it", async () => {
    await withFence(async ({ fence, fake, phase, advance }) => {
      await fence.start(POLICY, DEADLINE);
      const restore = pausedOperation(fence, fake);
      const result = refusal(fence.operate(restore.operation));
      await flush();
      expect(restore.started()).toBe(true);

      // The deadline's wake-up, in the same object, retires the incarnation while the restore waits
      // on R2, and cannot confirm the teardown.
      advance(60_000);
      expect(await refusal(fence.expire())).toBe("unsettled");
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retiring");
      expect(fence.grantCurrent(DEADLINE)).toBe(false);
      // A release cannot confirm the teardown while the restore is unresolved.
      expect(await refusal(fence.retire())).toBe("unsettled");
      expect(phase()).toBe("retiring");

      const destroysBefore = fake.destroys;
      restore.answer();
      expect(await result).toBe("retired");
      expect(restore.touched).toEqual([]);
      expect(fake.running).toBe(false);
      // Settling destroys again and confirms the teardown.
      expect(fake.destroys).toBe(destroysBefore + 1);
      expect(phase()).toBe("retired");
      await fence.retire();
    });
  });

  it("holds a release until a paused operation settles, then refuses it", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      await fence.start(POLICY, DEADLINE);
      const restore = pausedOperation(fence, fake);
      const result = refusal(fence.operate(restore.operation));
      await flush();

      let confirmed = false;
      const retire = fence.retire().then(() => {
        confirmed = true;
      });
      await flush();
      expect(confirmed).toBe(false);

      restore.answer();
      await retire;
      expect(await result).toBe("retired");
      expect(restore.touched).toEqual([]);
      expect(phase()).toBe("retired");
    });
  });

  it("destroys the container when an operation fails, and refuses the next", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      await fence.start(POLICY, DEADLINE);
      const failure = new Error("backup not found");
      await expect(
        fence.operate(async () => {
          fake.running = true;
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect(fake.running).toBe(false);
      expect(phase()).toBe("retired");
      const next = pausedOperation(fence, fake);
      expect(await refusal(fence.operate(next.operation))).toBe("retired");
      expect(next.started()).toBe(false);
    });
  });

  it("abandons an operation at the deadline and destroys the container when it settles", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      // Twenty milliseconds of lifetime is the operation's whole budget.
      await fence.start(POLICY, START + 20);
      const restore = pausedOperation(fence, fake);
      expect(await refusal(fence.operate(restore.operation))).toBe("timed_out");
      expect(phase()).toBe("retiring");
      expect(await refusal(fence.retire())).toBe("unsettled");

      const destroysBefore = fake.destroys;
      restore.answer();
      await flush();
      expect(restore.touched).toEqual([]);
      expect(fake.destroys).toBe(destroysBefore + 1);
      expect(phase()).toBe("retired");
    });
  });
});

describe("sandbox admission to the container", () => {
  it("admits only the live incarnation, up to one millisecond before its deadline", async () => {
    await withFence(async ({ fence, advance }) => {
      expect(await refusal(Promise.resolve().then(() => fence.admit()))).toBe("not_started");
      await fence.start(POLICY, DEADLINE);
      fence.admit();
      advance(DEADLINE - START - 1);
      fence.admit();
      advance(1);
      expect(await refusal(Promise.resolve().then(() => fence.admit()))).toBe("expired");
    });
  });

  it("refuses from the moment retirement is recorded, before the destroy returns", async () => {
    await withFence(async ({ fence, fake }) => {
      await fence.start(POLICY, DEADLINE);
      fake.destroyHangs = true;
      void fence.retire();
      await flush();
      expect(await refusal(Promise.resolve().then(() => fence.admit()))).toBe("retired");
    });
  });
});
