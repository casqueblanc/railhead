// The fence each sandbox's container object keeps around its one incarnation.
//
// A sandbox name is used for exactly one admitted slot, so the object behind it serves one
// incarnation: started once, commanded until its deadline, then retired for good. Retirement is
// durable and terminal. A start or command that arrives after it is refused, and one that was
// already running when it happened destroys the container again before it reports, so a late start
// cannot leave a container running after the backend freed its slot. `retire` returns only when no
// such operation is still outstanding in this object.
//
// The deadline is enforced here as well as in the repository: `start` schedules `expire` for the
// deadline in the object's own durable alarm, commands are cut to the remaining lifetime, and the
// outbound grant lapses at the same moment. A wake-up that arrives early schedules itself again, so
// a scheduler that runs callbacks before their time cannot consume the deadline.
//
// Retirement is recorded before the container is destroyed and confirmed after, and every attempt
// first schedules a retry wake-up, so a failed destroy, or one cut off by a restart, is retried with
// no other traffic. Retries back off and stop after `MAX_TEARDOWN_ATTEMPTS`; the repository keeps
// the sandbox's slot until it releases the sandbox itself, whatever the fence confirmed.

import { MAX_COMMAND_TIMEOUT_MS, type SandboxCommand } from "./entry";
import type { SandboxGrant, SandboxPolicy } from "./policy";

/** The command that confirms a started container answers. */
export const START_PROBE = "git --version";

/** What the fence drives: one container and its object's scheduler. */
export interface FencedContainer {
  /** Points the container's outbound requests at the Git gateway under `grant`. */
  route(grant: SandboxGrant): Promise<void>;
  /** Runs one command, starting the container if it is not running. */
  exec(
    command: string,
    options: { timeoutMs: number; env?: Record<string, string>; cwd?: string },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Destroys the container. Destroying one that is not running succeeds. */
  destroy(): Promise<void>;
  /**
   * Durably arranges for `expire` to run once no earlier than `at`, even if nothing else contacts
   * the object. `expire` tolerates running early and schedules itself again.
   */
  wake(at: number): Promise<void>;
}

/** How many destroys the fence attempts on its own before leaving teardown to the repository. */
export const MAX_TEARDOWN_ATTEMPTS = 8;

/** The wait before retrying the teardown after `attempts` attempts: 5 s, doubling, at most 5 min. */
export function teardownRetryDelay(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

/** Why the fence refused an operation. */
export type FenceRefusal = "retired" | "expired" | "not_started" | "probe_failed";

/** A refused start or command. It ran nothing that is still running. */
export class SandboxFenceError extends Error {
  readonly code: FenceRefusal;

  constructor(code: FenceRefusal) {
    super(`sandbox operation refused: ${code}`);
    this.name = "SandboxFenceError";
    this.code = code;
  }
}

/**
 * The fence's durable record. `deadline` is when the incarnation must be gone, `0` when it was
 * retired before it started. Once it leaves `live` it never returns: `retiring` means a destroy is
 * not yet confirmed, `retired` that the last one succeeded.
 */
type FenceState =
  | { phase: "live"; deadline: number }
  | { phase: "retiring"; deadline: number; attempts: number }
  | { phase: "retired"; deadline: number };

const KEY = "railhead:fence";

/** The fence of one container object, over that object's storage. */
export class SandboxFence {
  readonly #storage: Pick<DurableObjectStorage, "kv">;
  readonly #container: FencedContainer;
  readonly #clock: () => number;
  readonly #inflight = new Set<Promise<unknown>>();

  constructor(
    storage: Pick<DurableObjectStorage, "kv">,
    container: FencedContainer,
    clock: () => number,
  ) {
    this.#storage = storage;
    this.#container = container;
    this.#clock = clock;
  }

  /** Starts the incarnation under `policy` until `deadline` and confirms it answers. */
  start(policy: SandboxPolicy, deadline: number): Promise<void> {
    return this.#track(async () => {
      const state = this.#read();
      if (state !== null && state.phase !== "live") throw new SandboxFenceError("retired");
      if (state !== null && state.deadline !== deadline) throw new SandboxFenceError("retired");
      if (this.#clock() >= deadline) return this.#expireFrom(deadline);
      this.#write({ phase: "live", deadline });
      await this.#container.wake(deadline);
      await this.#container.route({ policy, expiresAt: deadline });
      await this.#settleEffect();
      const probe = await this.#container.exec(START_PROBE, {
        timeoutMs: this.#remaining(deadline),
      });
      await this.#settleEffect();
      if (probe.exitCode !== 0) throw new SandboxFenceError("probe_failed");
    });
  }

  /** Runs one command, cut to the incarnation's remaining lifetime. */
  exec(command: SandboxCommand): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.#track(async () => {
      const state = this.#read();
      if (state === null) throw new SandboxFenceError("not_started");
      if (state.phase !== "live") throw new SandboxFenceError("retired");
      if (this.#clock() >= state.deadline) return this.#expireFrom(state.deadline);
      const result = await this.#container.exec(command.command, {
        timeoutMs: Math.min(command.timeoutMs, this.#remaining(state.deadline)),
        ...(command.env === undefined ? {} : { env: command.env }),
        ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
      });
      await this.#settleEffect();
      // A result that arrives after the deadline belongs to an incarnation that no longer exists.
      if (this.#clock() >= state.deadline) return this.#expireFrom(state.deadline);
      return result;
    });
  }

  /**
   * Retires the incarnation for good and destroys its container. Returns once the container is
   * destroyed and every start or command that was running here has settled; each of those destroys
   * the container again when it resumes, so none can leave it running. A failed destroy rejects and
   * leaves a retry scheduled.
   */
  async retire(): Promise<void> {
    const deadline = this.#read()?.deadline ?? 0;
    const outstanding = [...this.#inflight];
    await this.#destroy(deadline);
    if (outstanding.length === 0) return;
    await Promise.allSettled(outstanding);
    await this.#destroy(deadline);
  }

  /**
   * The scheduled wake-up. Before the deadline it schedules itself again; at the deadline it retires
   * the incarnation; while a destroy is unconfirmed it retries it.
   */
  async expire(): Promise<void> {
    const state = this.#read();
    if (state === null) return;
    switch (state.phase) {
      case "live":
        if (this.#clock() < state.deadline) return this.#container.wake(state.deadline);
        return this.retire();
      case "retiring":
        return this.retire();
      case "retired":
        return;
      default:
        throw new Error(`unknown fence phase: ${state satisfies never}`);
    }
  }

  // Retires from inside a start or command, which `retire` would wait on: destroys the container
  // and refuses.
  async #expireFrom(deadline: number): Promise<never> {
    await this.#destroy(deadline);
    throw new SandboxFenceError("expired");
  }

  // After an effect that may have started the container: if retirement happened meanwhile, destroy
  // it again before refusing, since that effect may have outlived the retirement's own destroy.
  async #settleEffect(): Promise<void> {
    const state = this.#read();
    if (state === null || state.phase === "live") return;
    await this.#destroy(state.deadline);
    throw new SandboxFenceError("retired");
  }

  // One destroy attempt. The incarnation is marked retiring and a retry is scheduled before the
  // container is touched, so a failure or a restart mid-destroy still leaves a retry behind.
  async #destroy(deadline: number): Promise<void> {
    const attempts = this.#retiring(deadline);
    if (attempts < MAX_TEARDOWN_ATTEMPTS) {
      await this.#container.wake(this.#clock() + teardownRetryDelay(attempts));
    }
    try {
      await this.#container.destroy();
    } catch (error) {
      // Another destroy may have confirmed retirement meanwhile; this failure unconfirms it.
      if (this.#read()?.phase !== "retiring")
        this.#write({ phase: "retiring", deadline, attempts });
      throw error;
    }
    this.#write({ phase: "retired", deadline });
  }

  // Records one more unconfirmed destroy and returns how many there have been in a row.
  #retiring(deadline: number): number {
    const state = this.#read();
    const attempts = state?.phase === "retiring" ? state.attempts + 1 : 1;
    this.#write({ phase: "retiring", deadline, attempts });
    return attempts;
  }

  #remaining(deadline: number): number {
    return Math.max(1, Math.min(MAX_COMMAND_TIMEOUT_MS, deadline - this.#clock()));
  }

  #track<T>(work: () => Promise<T>): Promise<T> {
    const running = work();
    this.#inflight.add(running);
    const forget = () => this.#inflight.delete(running);
    running.then(forget, forget);
    return running;
  }

  #read(): FenceState | null {
    const value: unknown = this.#storage.kv.get(KEY);
    if (value === undefined) return null;
    if (
      typeof value === "object" &&
      value !== null &&
      "phase" in value &&
      "deadline" in value &&
      typeof value.deadline === "number"
    ) {
      const { deadline } = value;
      if (value.phase === "live" || value.phase === "retired")
        return { phase: value.phase, deadline };
      if (value.phase === "retiring" && "attempts" in value && typeof value.attempts === "number") {
        return { phase: "retiring", deadline, attempts: value.attempts };
      }
    }
    throw new Error("stored sandbox fence is not valid");
  }

  #write(state: FenceState): void {
    this.#storage.kv.put(KEY, state);
  }
}
