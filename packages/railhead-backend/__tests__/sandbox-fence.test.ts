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
import { MAX_OUTPUT_BYTES } from "../src/sandbox/entry";
import { serveGitGateway, type GatewayDeps } from "../src/sandbox/gateway";
import { readBoundedExec } from "../src/sandbox/output";
import { CANDIDATE_REF_PREFIX, type SandboxGrant, type SandboxPolicy } from "../src/sandbox/policy";
import { wakeTime } from "../src/sandbox/sandboxObject";

const POLICY: SandboxPolicy = {
  host: "acct.artifacts.cloudflare.net",
  namespace: "railhead",
  read: ["main-repo"],
  write: { repo: "main-repo", refPrefix: `${CANDIDATE_REF_PREFIX}chk_attempt1/` },
};

// Not on a whole second, so a scheduler that keeps whole seconds would wake the fence early.
const START = 1_000_900;
const DEADLINE = START + 60_000;

function noop(): void {}

/** A promise the test settles by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = noop;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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
    const reopen = () => new SandboxFence(state.storage, fake.container, clock);
    await body({
      fence: reopen(),
      fake,
      advance: (ms) => (now += ms),
      reopen,
      over: (container) => new SandboxFence(state.storage, container, clock),
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
      expect(phase()).toBe("retired");
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

  it("still destroys on release when the retry wake-up cannot be scheduled", async () => {
    await withFence(async ({ fence, fake, phase }) => {
      await fence.start(POLICY, DEADLINE);
      fake.wakeFails = true;

      await fence.retire();

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
