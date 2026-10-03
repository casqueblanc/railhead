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
// outbound grant lapses at the same moment.

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
  /** Durably arranges for `expire` to run at `deadline`, even if nothing else contacts the object. */
  scheduleExpiry(deadline: number): Promise<void>;
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

/** The fence's durable record. */
interface FenceState {
  /** When the incarnation must be gone; `0` when it was retired before it started. */
  deadline: number;
  /** Whether it was retired. Never cleared. */
  retired: boolean;
}

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
      if (state?.retired === true) throw new SandboxFenceError("retired");
      if (state !== null && state.deadline !== deadline) throw new SandboxFenceError("retired");
      if (this.#clock() >= deadline) return this.#expireFrom(deadline);
      this.#write({ deadline, retired: false });
      await this.#container.scheduleExpiry(deadline);
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
      if (state.retired) throw new SandboxFenceError("retired");
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
   * the container again when it resumes, so none can leave it running.
   */
  async retire(): Promise<void> {
    const state = this.#read();
    if (state?.retired !== true) this.#write({ deadline: state?.deadline ?? 0, retired: true });
    await this.#container.destroy();
    const outstanding = [...this.#inflight];
    if (outstanding.length === 0) return;
    await Promise.allSettled(outstanding);
    await this.#container.destroy();
  }

  /** The scheduled deadline: retires the incarnation unless that already happened. */
  async expire(): Promise<void> {
    const state = this.#read();
    if (state === null || state.retired) return;
    if (this.#clock() < state.deadline) return;
    await this.retire();
  }

  // Retires from inside a start or command, which `retire` would wait on: marks the incarnation
  // retired, destroys its container and refuses.
  async #expireFrom(deadline: number): Promise<never> {
    this.#write({ deadline, retired: true });
    await this.#container.destroy();
    throw new SandboxFenceError("expired");
  }

  // After an effect that may have started the container: if retirement happened meanwhile, destroy
  // it again before refusing, since that effect may have outlived the retirement's own destroy.
  async #settleEffect(): Promise<void> {
    if (this.#read()?.retired !== true) return;
    await this.#container.destroy();
    throw new SandboxFenceError("retired");
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
      typeof value !== "object" ||
      value === null ||
      !("deadline" in value) ||
      !("retired" in value) ||
      typeof value.deadline !== "number" ||
      typeof value.retired !== "boolean"
    ) {
      throw new Error("stored sandbox fence is not valid");
    }
    return { deadline: value.deadline, retired: value.retired };
  }

  #write(state: FenceState): void {
    this.#storage.kv.put(KEY, state);
  }
}
