// Sandbox: the isolated environment merges and checks run in, with bounded lifetime and concurrency.
// No adapter calls it directly; the merge and checks modules reach it through `ports().sandbox`.
//
// An attempt asks for a sandbox with `admit`, runs commands with `exec` and ends it with `release`.
// Admission is bounded per repository (see `admission.ts`). A sandbox's lifetime runs from its
// admission and is enforced twice: its own object retires it at the deadline through a durable alarm
// and its Git grant lapses then (see `fence.ts`), whether or not anything else happens, and the next
// `admit` or `exec` here tears down every slot past its deadline and frees it once the teardown is
// confirmed. Command output comes from code the sandbox ran and is untrusted: callers never log it
// or give it authority.

import { fail, ok, type PortResult } from "../contracts/result";
import type { ModuleFactory } from "../repo/composeRepo";
import {
  SlotTable,
  type Admission,
  type SandboxAttemptId,
  type SlotRecord,
  type UncertainReason,
} from "./admission";
import type { BoundedOutput } from "./output";
import type { SandboxPolicy } from "./policy";
import { sdkDriver } from "./sandboxObject";

export type { Admission, SandboxAttemptId, SlotRecord, SlotState } from "./admission";
export type { SandboxPolicy } from "./policy";

/** How long a sandbox may take to start and answer its first command. */
const START_TIMEOUT_MS = 90_000;

/** How long a teardown may take before the slot is recorded as uncertain. */
export const DESTROY_TIMEOUT_MS = 30_000;

/** The longest one command may run. A command is also cut to its sandbox's remaining lifetime. */
export const MAX_COMMAND_TIMEOUT_MS = 10 * 60_000;

/** How much longer than its own timeout a command's answer may take to arrive. */
const EXEC_GRACE_MS = 15_000;

/**
 * The most bytes of each output stream returned from one command. The container object drops the
 * rest as it arrives, so no more than this is held or sent over RPC.
 */
export const MAX_OUTPUT_BYTES = 64 * 1024;

/** One command to run in an admitted sandbox. */
export interface SandboxCommand {
  /** A shell command line, built by trusted backend code. */
  command: string;
  /** Environment variables for this command only. Never a secret. */
  env?: Record<string, string>;
  /** Working directory. */
  cwd?: string;
  /** How long it may run, in milliseconds. */
  timeoutMs: number;
}

/** What a command produced. Its output is untrusted text. */
export interface SandboxExec {
  /** The process exit code. */
  exitCode: number;
  /** Standard output, cut to `MAX_OUTPUT_BYTES`. */
  stdout: string;
  /** Standard error, cut to `MAX_OUTPUT_BYTES`. */
  stderr: string;
  /** Whether either stream was cut. */
  truncated: boolean;
}

/** The sandbox's port. */
export interface SandboxPort {
  /**
   * Admits `attemptId` and starts its sandbox under `policy`, or queues it when every slot is
   * taken. A queued attempt asks again to learn its position or be admitted, at least every
   * `QUEUED_ATTEMPT_TTL_MS` or it loses its place; a full queue is refused with `busy`. A start that does not confirm leaves the slot `uncertain`.
   */
  admit(
    attemptId: SandboxAttemptId,
    policy: SandboxPolicy,
    lifetimeMs: number,
  ): Promise<PortResult<Admission>>;
  /**
   * Runs one command in the attempt's running sandbox, cut to its remaining lifetime. A timeout
   * leaves the slot `uncertain`; a result that arrives after the slot ended is refused.
   */
  exec(attemptId: SandboxAttemptId, command: SandboxCommand): Promise<PortResult<SandboxExec>>;
  /**
   * Destroys the attempt's sandbox and frees its slot, or leaves the slot `uncertain` when the
   * teardown does not confirm. Releasing an uncertain slot retries the teardown. A repeat after the
   * slot is freed returns `null`.
   */
  release(attemptId: SandboxAttemptId): Promise<PortResult<SlotRecord | null>>;
  /** Every slot of this repository, uncertain ones included. */
  slots(): Promise<PortResult<SlotRecord[]>>;
}

/**
 * The container runtime behind the port. Production uses `sdkDriver`; tests supply their own. Each
 * sandbox name is used for one admission only.
 */
export interface SandboxDriver {
  /**
   * Starts the named sandbox under `policy`, arranges its own teardown at `deadline` and confirms
   * it answers. Refused once the sandbox was destroyed.
   */
  start(sandbox: string, policy: SandboxPolicy, deadline: number): Promise<void>;
  /**
   * Runs one command and returns its exit code and output, each stream at most
   * `MAX_OUTPUT_BYTES`. Refused once destroyed. A command that fails or outlives its timeout
   * destroys the sandbox before it rejects.
   */
  exec(sandbox: string, command: SandboxCommand): Promise<BoundedOutput>;
  /**
   * Destroys the named sandbox for good: no later start or command runs in it. Resolves once no
   * start or command already under way can leave it running. Destroying one that never ran, or
   * was already destroyed, succeeds.
   */
  destroy(sandbox: string): Promise<void>;
}

/** What the sandbox module needs besides its storage. */
export interface SandboxDeps {
  driver: SandboxDriver;
  clock: () => number;
  /**
   * How long a start and a teardown may take, and how late a command's answer may be:
   * `START_TIMEOUT_MS`, `DESTROY_TIMEOUT_MS` and `EXEC_GRACE_MS`.
   */
  timeouts?: { startMs: number; destroyMs: number; execGraceMs: number };
}

/** Builds the sandbox access of one repository over `driver`. */
export function createSandboxPort(slots: SlotTable, deps: SandboxDeps): SandboxPort {
  const { driver, clock } = deps;
  const { startMs, destroyMs, execGraceMs } = deps.timeouts ?? {
    startMs: START_TIMEOUT_MS,
    destroyMs: DESTROY_TIMEOUT_MS,
    execGraceMs: EXEC_GRACE_MS,
  };

  async function teardown(slot: SlotRecord): Promise<PortResult<SlotRecord | null>> {
    const outcome = await settle(driver.destroy(slot.sandbox), destroyMs);
    if (outcome.kind !== "done") return uncertain(slot, "destroy_failed");
    slots.released(slot);
    return ok(null);
  }

  async function sweep(): Promise<void> {
    for (const slot of slots.expired(clock())) {
      const releasing = slots.beginRelease(slot.attemptId, slot.sandbox);
      if (releasing !== null) await teardown(releasing);
    }
  }

  function uncertain(slot: SlotRecord, reason: UncertainReason): PortResult<never> {
    slots.uncertain(slot, reason);
    return fail("unavailable", "The sandbox did not confirm; its slot is held until released.");
  }

  return {
    async admit(attemptId, policy, lifetimeMs) {
      await sweep();
      const admission = slots.admit(attemptId, policy, lifetimeMs, clock());
      if (!admission.ok || admission.value.kind !== "admitted") return admission;
      const { slot } = admission.value;
      if (slot.deadline === null) throw new Error("admitted slot has no deadline");
      const outcome = await settle(driver.start(slot.sandbox, slot.policy, slot.deadline), startMs);
      if (outcome.kind !== "done") return uncertain(slot, "start_failed");
      const running = slots.started(slot);
      if (running === null) return fail("busy", "The sandbox was released while it started.");
      return ok({ kind: "admitted", slot: running });
    },

    async exec(attemptId, command) {
      if (
        !Number.isSafeInteger(command.timeoutMs) ||
        command.timeoutMs < 1 ||
        command.timeoutMs > MAX_COMMAND_TIMEOUT_MS
      ) {
        return fail(
          "invalid_request",
          `The timeout must be from 1 to ${MAX_COMMAND_TIMEOUT_MS} ms.`,
        );
      }
      await sweep();
      const slot = slots.get(attemptId);
      if (slot === null || slot.state !== "running" || slot.deadline === null) {
        return fail("not_found", "This attempt has no running sandbox.");
      }
      const { deadline } = slot;
      const limit = Math.min(command.timeoutMs, deadline - clock());
      if (limit <= 0) {
        await sweep();
        return fail("not_found", "This attempt has no running sandbox.");
      }
      const outcome = await settle(driver.exec(slot.sandbox, command), limit + execGraceMs);
      // The slot may have been released, replaced or passed its deadline while the command ran.
      const current = slots.get(attemptId);
      if (
        current === null ||
        current.sandbox !== slot.sandbox ||
        current.state !== "running" ||
        clock() >= deadline
      ) {
        await sweep();
        return fail("not_found", "This attempt's sandbox ended while the command ran.");
      }
      if (outcome.kind !== "done") return uncertain(slot, "command_timeout");
      const stdout = cut(outcome.value.stdout);
      const stderr = cut(outcome.value.stderr);
      return ok({
        exitCode: outcome.value.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: outcome.value.truncated || stdout.cut || stderr.cut,
      });
    },

    async release(attemptId) {
      const slot = slots.beginRelease(attemptId);
      if (slot === null) return ok(null);
      return teardown(slot);
    },

    async slots() {
      return ok(slots.list());
    },
  };
}

/** Builds the sandbox access of one repository. */
export const sandbox: ModuleFactory<SandboxPort> = (context) =>
  createSandboxPort(new SlotTable(context.storage), {
    driver: sdkDriver(context.env),
    clock: context.clock,
  });

type Settled<T> = { kind: "done"; value: T } | { kind: "failed" } | { kind: "timeout" };

// Waits for `work` up to `ms`. A failure or a timeout is reported, never thrown: the caller records
// the slot as uncertain, since neither proves the sandbox stopped.
async function settle<T>(work: Promise<T>, ms: number): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
  });
  try {
    return await Promise.race([
      work.then(
        (value): Settled<T> => ({ kind: "done", value }),
        (): Settled<T> => ({ kind: "failed" }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// The driver bounds output already; the port holds it to the same limit whatever a driver returns.
function cut(text: string): { text: string; cut: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= MAX_OUTPUT_BYTES) return { text, cut: false };
  // A split multi-byte character decodes to U+FFFD rather than failing.
  return { text: decoder.decode(bytes.subarray(0, MAX_OUTPUT_BYTES)), cut: true };
}
