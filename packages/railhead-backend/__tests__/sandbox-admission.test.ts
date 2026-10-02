import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  MAX_ACTIVE_SANDBOXES,
  MAX_QUEUED_ATTEMPTS,
  MAX_SANDBOX_LIFETIME_MS,
  QUEUED_ATTEMPT_TTL_MS,
  SlotTable,
} from "../src/sandbox/admission";
import {
  MAX_OUTPUT_BYTES,
  createSandboxPort,
  type SandboxCommand,
  type SandboxDriver,
  type SandboxPort,
} from "../src/sandbox/entry";
import { CANDIDATE_REF_PREFIX, type SandboxPolicy } from "../src/sandbox/policy";
import type { RepoStorage } from "../src/repo/storage";

const LIFETIME = 60_000;

function policy(attemptId: string): SandboxPolicy {
  return {
    host: "acct.artifacts.cloudflare.net",
    namespace: "railhead",
    read: ["main-repo"],
    write: { repo: "main-repo", refPrefix: `${CANDIDATE_REF_PREFIX}${attemptId}/` },
  };
}

function attempt(n: number): string {
  return `chk_attempt${String(n).padStart(3, "0")}`;
}

type Behaviour = "ok" | "fail" | "hang";

/** A container runtime that records which sandboxes run, with scripted failures. */
class FakeDriver {
  readonly running = new Set<string>();
  readonly destroyed: string[] = [];
  start: Behaviour = "ok";
  destroy: Behaviour = "ok";
  exec: Behaviour = "ok";
  output = "done";

  readonly driver: SandboxDriver = {
    start: async (name) => {
      this.running.add(name);
      await this.#act(this.start);
    },
    exec: async (_name, _command: SandboxCommand) => {
      await this.#act(this.exec);
      return { exitCode: 3, stdout: this.output, stderr: "err" };
    },
    destroy: async (name) => {
      await this.#act(this.destroy);
      this.running.delete(name);
      this.destroyed.push(name);
    },
  };

  async #act(behaviour: Behaviour): Promise<void> {
    switch (behaviour) {
      case "ok":
        return;
      case "fail":
        throw new Error("scripted failure");
      case "hang":
        return new Promise(() => {});
      default:
        throw new Error("unknown behaviour");
    }
  }
}

interface Harness {
  port: SandboxPort;
  fake: FakeDriver;
  storage: RepoStorage;
  advance: (ms: number) => void;
}

/** Runs `body` with a sandbox port over the storage of a Durable Object no other test touches. */
function withPort(body: (harness: Harness) => Promise<void>): Promise<void> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    let now = 1_000_000;
    const fake = new FakeDriver();
    const slots = new SlotTable(state.storage, "rep_test0001");
    const port = createSandboxPort(slots, {
      driver: fake.driver,
      clock: () => now,
      timeouts: { startMs: 20, destroyMs: 20 },
    });
    await body({ port, fake, storage: state.storage, advance: (ms) => (now += ms) });
  });
}

async function admit(port: SandboxPort, n: number) {
  return port.admit(attempt(n), policy(attempt(n)), LIFETIME);
}

async function states(port: SandboxPort): Promise<string[]> {
  const result = await port.slots();
  if (!result.ok) throw new Error("slots failed");
  return result.value.map((slot) => `${slot.attemptId}:${slot.state}`);
}

describe("sandbox admission", () => {
  it("admits, runs a command and tears the sandbox down explicitly", async () => {
    await withPort(async ({ port, fake }) => {
      const admitted = await admit(port, 1);
      expect(admitted).toMatchObject({ ok: true, value: { kind: "admitted" } });
      if (!admitted.ok || admitted.value.kind === "queued") throw new Error("not admitted");
      expect(admitted.value.slot).toMatchObject({
        state: "running",
        deadline: 1_000_000 + LIFETIME,
      });
      const name = admitted.value.slot.sandbox;
      expect(fake.running.has(name)).toBe(true);

      const run = await port.exec(attempt(1), { command: "git status", timeoutMs: 1_000 });
      expect(run).toEqual({
        ok: true,
        value: { exitCode: 3, stdout: "done", stderr: "err", truncated: false },
      });

      expect(await port.release(attempt(1))).toEqual({ ok: true, value: null });
      expect(fake.running.size).toBe(0);
      expect(fake.destroyed).toEqual([name]);
      expect(await states(port)).toEqual([]);
      // A repeat after the slot is freed changes nothing.
      expect(await port.release(attempt(1))).toEqual({ ok: true, value: null });
      expect(fake.destroyed).toEqual([name]);
    });
  });

  it("returns the same running sandbox for a repeated admission", async () => {
    await withPort(async ({ port, fake }) => {
      await admit(port, 1);
      const again = await admit(port, 1);

      expect(again).toMatchObject({ ok: true, value: { kind: "running" } });
      expect(fake.running.size).toBe(1);
    });
  });

  it("queues beyond the bound, refuses beyond the queue and admits in order as slots free", async () => {
    await withPort(async ({ port, fake }) => {
      for (let n = 1; n <= MAX_ACTIVE_SANDBOXES; n += 1) {
        expect(await admit(port, n)).toMatchObject({ value: { kind: "admitted" } });
      }
      for (let n = 1; n <= MAX_QUEUED_ATTEMPTS; n += 1) {
        expect(await admit(port, MAX_ACTIVE_SANDBOXES + n)).toEqual({
          ok: true,
          value: { kind: "queued", position: n },
        });
      }
      const overflow = await admit(port, 99);
      expect(overflow).toMatchObject({ ok: false, code: "busy" });
      expect(fake.running.size).toBe(MAX_ACTIVE_SANDBOXES);

      // The second in line cannot jump the first once a slot frees.
      await port.release(attempt(1));
      expect(await admit(port, MAX_ACTIVE_SANDBOXES + 2)).toEqual({
        ok: true,
        value: { kind: "queued", position: 2 },
      });
      expect(await admit(port, MAX_ACTIVE_SANDBOXES + 1)).toMatchObject({
        value: { kind: "admitted" },
      });
      expect(fake.running.size).toBe(MAX_ACTIVE_SANDBOXES);
      expect((await states(port)).filter((s) => s.endsWith(":queued"))).toHaveLength(
        MAX_QUEUED_ATTEMPTS - 1,
      );
      expect(await states(port)).not.toContain(`${attempt(99)}:queued`);
    });
  });

  it("drops a queued attempt that stopped asking, so it cannot block the queue", async () => {
    await withPort(async ({ port, advance }) => {
      const long = (n: number) =>
        port.admit(attempt(n), policy(attempt(n)), MAX_SANDBOX_LIFETIME_MS);
      for (let n = 1; n <= MAX_ACTIVE_SANDBOXES; n += 1) await long(n);
      expect(await long(10)).toMatchObject({ value: { kind: "queued", position: 1 } });
      expect(await long(11)).toMatchObject({ value: { kind: "queued", position: 2 } });
      await port.release(attempt(1));

      // Attempt 11 keeps asking within the window; attempt 10 never asks again.
      advance(QUEUED_ATTEMPT_TTL_MS - 1);
      expect(await long(11)).toMatchObject({ value: { kind: "queued", position: 2 } });
      advance(1);
      expect(await long(11)).toMatchObject({ value: { kind: "admitted" } });
      expect(await states(port)).not.toContain(`${attempt(10)}:queued`);
    });
  });

  it("drops a queued attempt on release without destroying anything", async () => {
    await withPort(async ({ port, fake }) => {
      for (let n = 1; n <= MAX_ACTIVE_SANDBOXES + 1; n += 1) await admit(port, n);

      expect(await port.release(attempt(MAX_ACTIVE_SANDBOXES + 1))).toEqual({
        ok: true,
        value: null,
      });
      expect(fake.destroyed).toEqual([]);
      expect(await states(port)).toHaveLength(MAX_ACTIVE_SANDBOXES);
    });
  });

  it.each([
    ["an attempt without a prefix", "attempt1", policy("chk_attempt1"), LIFETIME],
    [
      "a policy that writes main",
      attempt(1),
      { ...policy(attempt(1)), write: { repo: "main-repo", refPrefix: "refs/heads/main" } },
      LIFETIME,
    ],
    ["a lifetime above the maximum", attempt(1), policy(attempt(1)), MAX_SANDBOX_LIFETIME_MS + 1],
    ["a fractional lifetime", attempt(1), policy(attempt(1)), 60_000.5],
  ])("refuses %s and starts nothing", async (_name, id, input, lifetime) => {
    await withPort(async ({ port, fake }) => {
      expect(await port.admit(id, input, lifetime)).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(fake.running.size).toBe(0);
      expect(await states(port)).toEqual([]);
    });
  });

  it("accepts the longest lifetime and refuses a repeat with another policy", async () => {
    await withPort(async ({ port }) => {
      expect(
        await port.admit(attempt(1), policy(attempt(1)), MAX_SANDBOX_LIFETIME_MS),
      ).toMatchObject({
        ok: true,
      });
      expect(
        await port.admit(
          attempt(1),
          { ...policy(attempt(1)), read: ["other"] },
          MAX_SANDBOX_LIFETIME_MS,
        ),
      ).toMatchObject({ ok: false, code: "invalid_request" });
    });
  });
});

describe("sandbox lifetime and uncertain slots", () => {
  it("keeps the slot uncertain when the start does not confirm, and frees it once torn down", async () => {
    await withPort(async ({ port, fake }) => {
      fake.start = "fail";
      expect(await admit(port, 1)).toMatchObject({ ok: false, code: "unavailable" });
      expect(await states(port)).toEqual([`${attempt(1)}:uncertain`]);
      // The uncertain slot still counts: the attempt cannot run commands or be admitted afresh.
      expect(await port.exec(attempt(1), { command: "true", timeoutMs: 1_000 })).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(await admit(port, 1)).toMatchObject({ ok: false, code: "busy" });

      expect(await port.release(attempt(1))).toEqual({ ok: true, value: null });
      expect(fake.running.size).toBe(0);
      expect(await states(port)).toEqual([]);
    });
  });

  it("holds uncertain slots against the bound", async () => {
    await withPort(async ({ port, fake }) => {
      for (let n = 1; n <= MAX_ACTIVE_SANDBOXES; n += 1) await admit(port, n);
      await port.release(attempt(1));
      // Fill the freed slot with a start that fails: it stays held, so the next attempt queues.
      fake.start = "fail";
      expect(await admit(port, 5)).toMatchObject({ ok: false, code: "unavailable" });
      fake.start = "ok";
      expect(await admit(port, 6)).toEqual({ ok: true, value: { kind: "queued", position: 1 } });
    });
  });

  it("records a start that times out as uncertain", async () => {
    await withPort(async ({ port, fake }) => {
      fake.start = "hang";

      expect(await admit(port, 1)).toMatchObject({ ok: false, code: "unavailable" });
      expect(await states(port)).toEqual([`${attempt(1)}:uncertain`]);
      expect(fake.running.size).toBe(1);
    });
  });

  it("keeps the slot uncertain when a command times out", async () => {
    await withPort(async ({ port, fake }) => {
      await admit(port, 1);
      fake.exec = "hang";

      expect(await port.exec(attempt(1), { command: "sleep 999", timeoutMs: 20 })).toMatchObject({
        ok: false,
        code: "unavailable",
      });
      expect(await states(port)).toEqual([`${attempt(1)}:uncertain`]);
    });
  });

  it("keeps the slot uncertain when destroy fails, and retries the teardown on release", async () => {
    await withPort(async ({ port, fake }) => {
      await admit(port, 1);
      fake.destroy = "fail";

      expect(await port.release(attempt(1))).toMatchObject({ ok: false, code: "unavailable" });
      expect(await states(port)).toEqual([`${attempt(1)}:uncertain`]);
      expect(fake.running.size).toBe(1);

      fake.destroy = "hang";
      expect(await port.release(attempt(1))).toMatchObject({ ok: false, code: "unavailable" });
      expect(await states(port)).toEqual([`${attempt(1)}:uncertain`]);

      fake.destroy = "ok";
      expect(await port.release(attempt(1))).toEqual({ ok: true, value: null });
      expect(fake.running.size).toBe(0);
      expect(await states(port)).toEqual([]);
    });
  });

  it("tears down a sandbox past its deadline before admitting another", async () => {
    await withPort(async ({ port, fake, advance }) => {
      await admit(port, 1);
      advance(LIFETIME);

      expect(await port.exec(attempt(1), { command: "true", timeoutMs: 1_000 })).toMatchObject({
        ok: false,
        code: "not_found",
      });
      expect(fake.running.size).toBe(0);
      expect(await states(port)).toEqual([]);
    });
  });

  it("refuses a command timeout out of range and cuts long output", async () => {
    await withPort(async ({ port, fake }) => {
      await admit(port, 1);
      fake.output = "x".repeat(MAX_OUTPUT_BYTES + 10);

      expect(await port.exec(attempt(1), { command: "true", timeoutMs: 0 })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      const run = await port.exec(attempt(1), { command: "cat big", timeoutMs: 1_000 });
      if (!run.ok) throw new Error("exec failed");
      expect(run.value.stdout).toHaveLength(MAX_OUTPUT_BYTES);
      expect(run.value.truncated).toBe(true);
    });
  });
});
