import { getSandbox } from "@cloudflare/sandbox";
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
import { openSandbox } from "../src/sandbox/sandboxObject";
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

type Behaviour = "ok" | "fail" | "hang" | "pause";

/**
 * A container runtime that records which sandboxes run, with scripted failures. A `pause`d
 * operation waits until the test calls `resume`, which settles it as `ok` would.
 */
class FakeDriver {
  readonly running = new Set<string>();
  readonly destroyed: string[] = [];
  readonly deadlines = new Map<string, number>();
  start: Behaviour = "ok";
  destroy: Behaviour = "ok";
  exec: Behaviour = "ok";
  output = "done";
  truncated = false;
  readonly #paused: (() => void)[] = [];

  resume(): void {
    for (const release of this.#paused.splice(0)) release();
  }

  readonly driver: SandboxDriver = {
    start: async (name, _policy, deadline) => {
      this.running.add(name);
      this.deadlines.set(name, deadline);
      await this.#act(this.start);
    },
    exec: async (_name, _command: SandboxCommand) => {
      await this.#act(this.exec);
      return { exitCode: 3, stdout: this.output, stderr: "err", truncated: this.truncated };
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
      case "pause":
        return new Promise((resolve) => {
          this.#paused.push(resolve);
        });
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
    const slots = new SlotTable(state.storage);
    const port = createSandboxPort(slots, {
      driver: fake.driver,
      clock: () => now,
      timeouts: { startMs: 20, destroyMs: 20, execGraceMs: 20 },
    });
    await body({ port, fake, storage: state.storage, advance: (ms) => (now += ms) });
  });
}

async function admit(port: SandboxPort, n: number) {
  return port.admit(attempt(n), policy(attempt(n)), LIFETIME);
}

/** Lets pending promise callbacks run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
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

  it("reports output the driver cut and keeps the sandbox running", async () => {
    await withPort(async ({ port, fake }) => {
      await admit(port, 1);
      fake.output = "first 64 KiB";
      fake.truncated = true;

      const run = await port.exec(attempt(1), { command: "yes", timeoutMs: 1_000 });

      expect(run).toEqual({
        ok: true,
        value: { exitCode: 3, stdout: "first 64 KiB", stderr: "err", truncated: true },
      });
      expect(await states(port)).toEqual([`${attempt(1)}:running`]);
    });
  });
});

describe("sandbox names", () => {
  const options = { sleepAfter: "45m", enableDefaultSession: false } as const;

  it("names every admission with a fresh name the SDK accepts, however long the identifiers", async () => {
    // The repository ID the Repo object records: `rep_` and its 64-character object ID.
    const repoId = `rep_${env.REPO.idFromName("acme/widgets").toString()}`;
    const shortest = "chk_abcdef";
    const longest = `chk_${"a".repeat(64)}`;
    // The former name, `<repoId>.<attemptId>`, is over the SDK's limit for every attempt.
    expect(() => getSandbox(env.SANDBOX, `${repoId}.${shortest}`.toLowerCase(), options)).toThrow(
      "1-63",
    );

    await withPort(async ({ port, fake }) => {
      const names: string[] = [];
      for (const id of [shortest, longest, "chk_ABCDEF"]) {
        const admitted = await port.admit(id, policy(attempt(1)), LIFETIME);
        if (!admitted.ok || admitted.value.kind === "queued") throw new Error("not admitted");
        names.push(admitted.value.slot.sandbox);
      }
      // Attempts that differ only in case get distinct sandboxes.
      expect(new Set(names).size).toBe(3);
      for (const name of names) {
        expect(name).toMatch(/^sbx-[0-9a-f]{32}$/);
        // The production driver opens each name for start, command and teardown alike.
        expect(() => openSandbox(env, name)).not.toThrow();
      }

      // A readmission after release gets another sandbox, so nothing of the first can reach it.
      await port.release(shortest);
      const again = await port.admit(shortest, policy(attempt(1)), LIFETIME);
      if (!again.ok || again.value.kind === "queued") throw new Error("not readmitted");
      expect(names).not.toContain(again.value.slot.sandbox);
      expect(fake.destroyed).toEqual([names[0]]);
    });
  });
});

describe("sandbox completions and deadlines", () => {
  it("ignores a start that completes after its slot was released and readmitted", async () => {
    await withPort(async ({ port, fake }) => {
      fake.start = "pause";
      const first = admit(port, 1);
      await flush();
      const [staleName] = fake.running;

      expect(await port.release(attempt(1))).toEqual({ ok: true, value: null });
      fake.start = "ok";
      const second = await admit(port, 1);
      if (!second.ok || second.value.kind === "queued") throw new Error("not readmitted");
      const fresh = second.value.slot;

      // The first start completes now and must not touch the readmitted slot.
      fake.resume();
      expect(await first).toMatchObject({ ok: false, code: "busy" });
      expect(staleName).toBeDefined();
      expect(fresh.sandbox).not.toBe(staleName);
      const slots = await port.slots();
      expect(slots).toEqual({ ok: true, value: [fresh] });
    });
  });

  it("refuses a command result that arrives after the deadline and tears the sandbox down", async () => {
    await withPort(async ({ port, fake, advance }) => {
      const admitted = await admit(port, 1);
      if (!admitted.ok || admitted.value.kind === "queued") throw new Error("not admitted");
      fake.exec = "pause";

      const run = port.exec(attempt(1), { command: "make test", timeoutMs: 1_000 });
      await flush();
      advance(LIFETIME);
      fake.resume();

      expect(await run).toMatchObject({ ok: false, code: "not_found" });
      expect(fake.destroyed).toEqual([admitted.value.slot.sandbox]);
      expect(await states(port)).toEqual([]);
    });
  });

  it("starts the sandbox with the deadline counted from admission", async () => {
    await withPort(async ({ port, fake }) => {
      const admitted = await admit(port, 1);
      if (!admitted.ok || admitted.value.kind === "queued") throw new Error("not admitted");
      const { sandbox, deadline } = admitted.value.slot;

      expect(fake.deadlines.get(sandbox)).toBe(1_000_000 + LIFETIME);
      expect(deadline).toBe(1_000_000 + LIFETIME);
    });
  });

  it("tears down an uncertain slot past its deadline, and holds it while the teardown fails", async () => {
    await withPort(async ({ port, fake, advance }) => {
      const admitted = await admit(port, 1);
      if (!admitted.ok || admitted.value.kind === "queued") throw new Error("not admitted");
      fake.exec = "hang";
      await port.exec(attempt(1), { command: "sleep 999", timeoutMs: 10 });
      expect(await states(port)).toEqual([`${attempt(1)}:uncertain`]);
      advance(LIFETIME);

      // The sweep runs on the next admission; a failed teardown keeps the slot held.
      fake.destroy = "fail";
      await admit(port, 2);
      expect(await states(port)).toEqual([`${attempt(1)}:uncertain`, `${attempt(2)}:running`]);
      expect(fake.running.has(admitted.value.slot.sandbox)).toBe(true);

      fake.destroy = "ok";
      await admit(port, 3);
      expect(fake.running.has(admitted.value.slot.sandbox)).toBe(false);
      expect(await states(port)).toEqual([`${attempt(2)}:running`, `${attempt(3)}:running`]);
    });
  });
});
