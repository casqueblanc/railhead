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
// outbound grant lapses at the same moment. The fence enforces each command's timeout itself, since
// the SDK's streaming exec does not: at the timeout it aborts the command's output stream and the
// command fails. A start or command that fails, or times out, may have left a process running, so
// the fence retires the incarnation before it reports the failure; the repository holds a slot
// whose start or command failed as uncertain and never runs another command in it.
//
// A command abandoned at its timeout is still an SDK call in flight: the SDK retries a container
// that is starting for up to two minutes and may start it after the fence destroyed it. The fence
// keeps every such call tracked until it settles. While one is pending no destroy confirms
// retirement and `retire` rejects after `RETIRE_SETTLE_MS`, so the repository keeps the slot
// uncertain; when it settles, success or failure, the fence destroys the container again at once.
// Route, wake-up and destroy calls are never abandoned: the operation that made them awaits them.
//
// The grant also ends at retirement: the gateway asks
// `grantCurrent` before it uses it, and that is false from the moment retirement is recorded. A
// wake-up that arrives early schedules itself again, so a scheduler that runs callbacks before their
// time cannot consume the deadline.
//
// Retirement is recorded before the container is destroyed and confirmed after, and every attempt
// first schedules a retry wake-up, so a failed destroy, or one cut off by a restart, is retried with
// no other traffic. A retry that cannot be scheduled does not stop the destroy; if that destroy
// fails too, the incarnation stays retiring, the failure reports both, and the next wake-up or
// release destroys it. Retries back off and stop after `MAX_TEARDOWN_ATTEMPTS`; the repository keeps
// the sandbox's slot until it releases the sandbox itself, whatever the fence confirmed.

import { MAX_COMMAND_TIMEOUT_MS, type SandboxCommand } from "./entry";
import type { BoundedOutput } from "./output";
import type { SandboxGrant, SandboxPolicy } from "./policy";

/** The command that confirms a started container answers. */
export const START_PROBE = "git --version";

/** What the fence drives: one container and its object's scheduler. */
export interface FencedContainer {
  /** Points the container's outbound requests at the Git gateway under `grant`. */
  route(grant: SandboxGrant): Promise<void>;
  /**
   * Runs one command, starting the container if it is not running. Its output is bounded. When
   * `signal` aborts, it stops reading and rejects.
   */
  exec(
    command: string,
    options: { timeoutMs: number; signal: AbortSignal; env?: Record<string, string>; cwd?: string },
  ): Promise<BoundedOutput>;
  /** Destroys the container. Destroying one that is not running succeeds. */
  destroy(): Promise<void>;
  /**
   * Durably arranges for `expire` to run once no earlier than `at`, even if nothing else contacts
   * the object. `expire` tolerates running early and schedules itself again.
   */
  wake(at: number): Promise<void>;
}

/**
 * How long `retire` waits for a start or command already under way to settle before it reports the
 * teardown unconfirmed. Shorter than the repository's `DESTROY_TIMEOUT_MS`, so the fence answers
 * first.
 */
export const RETIRE_SETTLE_MS = 20_000;

/** How many destroys the fence attempts on its own before leaving teardown to the repository. */
export const MAX_TEARDOWN_ATTEMPTS = 8;

/** The wait before retrying the teardown after `attempts` attempts: 5 s, doubling, at most 5 min. */
export function teardownRetryDelay(attempts: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, attempts - 1), 300_000);
}

/** Why the fence refused an operation. */
export type FenceRefusal =
  | "retired"
  | "expired"
  | "not_started"
  | "probe_failed"
  | "timed_out"
  | "unsettled";

/**
 * A refused or failed operation. A start or command left nothing running; `unsettled`, from
 * `retire`, means an earlier command may still start the container, so retirement is unconfirmed.
 */
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
  readonly #settleMs: number;
  readonly #inflight = new Set<Promise<unknown>>();
  // Container commands not yet settled, including those whose caller stopped waiting at a timeout.
  readonly #effects = new Set<Promise<unknown>>();

  constructor(
    storage: Pick<DurableObjectStorage, "kv">,
    container: FencedContainer,
    clock: () => number,
    settleMs = RETIRE_SETTLE_MS,
  ) {
    this.#storage = storage;
    this.#container = container;
    this.#clock = clock;
    this.#settleMs = settleMs;
  }

  /** Starts the incarnation under `policy` until `deadline` and confirms it answers. */
  start(policy: SandboxPolicy, deadline: number): Promise<void> {
    return this.#track(async () => {
      const state = this.#read();
      if (state !== null && state.phase !== "live") throw new SandboxFenceError("retired");
      if (state !== null && state.deadline !== deadline) throw new SandboxFenceError("retired");
      if (this.#clock() >= deadline) return this.#expireFrom(deadline);
      this.#write({ phase: "live", deadline });
      try {
        await this.#container.wake(deadline);
        await this.#container.route({ policy, expiresAt: deadline });
        await this.#settleEffect();
        const probe = await this.#run(START_PROBE, { timeoutMs: this.#remaining(deadline) });
        await this.#settleEffect();
        if (probe.exitCode !== 0) throw new SandboxFenceError("probe_failed");
      } catch (error) {
        return this.#failClosed(deadline, error);
      }
    });
  }

  /** Runs one command, cut to the incarnation's remaining lifetime. */
  exec(command: SandboxCommand): Promise<BoundedOutput> {
    return this.#track(async () => {
      const state = this.#read();
      if (state === null) throw new SandboxFenceError("not_started");
      if (state.phase !== "live") throw new SandboxFenceError("retired");
      if (this.#clock() >= state.deadline) return this.#expireFrom(state.deadline);
      let result: BoundedOutput;
      try {
        result = await this.#run(command.command, {
          timeoutMs: Math.min(command.timeoutMs, this.#remaining(state.deadline)),
          ...(command.env === undefined ? {} : { env: command.env }),
          ...(command.cwd === undefined ? {} : { cwd: command.cwd }),
        });
      } catch (error) {
        return this.#failClosed(state.deadline, error);
      }
      await this.#settleEffect();
      // A result that arrives after the deadline belongs to an incarnation that no longer exists.
      if (this.#clock() >= state.deadline) return this.#expireFrom(state.deadline);
      return result;
    });
  }

  /**
   * Whether the outbound grant that lapses at `expiresAt` is still this live incarnation's. False
   * once retirement is recorded, which happens before the container is touched.
   */
  grantCurrent(expiresAt: number): boolean {
    const state = this.#read();
    return (
      state !== null &&
      state.phase === "live" &&
      state.deadline === expiresAt &&
      this.#clock() < state.deadline
    );
  }

  /**
   * Retires the incarnation for good and destroys its container. Returns once the container is
   * destroyed and every start, command and container call that was running here has settled; each
   * of those destroys the container again when it settles, so none can leave it running. Rejects
   * with `unsettled` when one is still pending after `RETIRE_SETTLE_MS`, and with the failure when a
   * destroy fails; either way a retry is left scheduled.
   */
  async retire(): Promise<void> {
    const deadline = this.#read()?.deadline ?? 0;
    const outstanding = [...this.#inflight, ...this.#effects];
    await this.#destroy(deadline);
    if (outstanding.length === 0) return;
    const settled = await this.#quiet(outstanding);
    await this.#destroy(deadline);
    if (!settled || this.#effects.size > 0) throw new SandboxFenceError("unsettled");
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
        if (this.#clock() >= state.deadline) return this.retire();
        try {
          await this.#container.wake(state.deadline);
        } catch (error) {
          // Without the wake-up nothing retires the incarnation at its deadline: retire it now.
          try {
            await this.retire();
          } catch (retireError) {
            throw new AggregateError(
              [error, retireError],
              "the sandbox lost its deadline wake-up",
              { cause: retireError },
            );
          }
          throw error;
        }
        return;
      case "retiring":
        return this.retire();
      case "retired":
        return;
      default:
        throw new Error(`unknown fence phase: ${state satisfies never}`);
    }
  }

  // Runs one command, aborting it at its timeout: the SDK does not stop a streaming command itself.
  // A container that ignores the abort is not waited for, but its call stays tracked until it
  // settles, and if it settles after its caller gave up the container is destroyed again.
  async #run(
    command: string,
    options: { timeoutMs: number; env?: Record<string, string>; cwd?: string },
  ): Promise<BoundedOutput> {
    const abort = new AbortController();
    const effect = this.#container.exec(command, { ...options, signal: abort.signal });
    let abandoned = false;
    this.#effects.add(effect);
    const settled = () => {
      this.#effects.delete(effect);
      if (abandoned) this.#reconcile();
    };
    // Registered before the race below, so the effect is forgotten before its caller resumes.
    effect.then(settled, settled);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true;
        abort.abort();
        reject(new SandboxFenceError("timed_out"));
      }, options.timeoutMs);
    });
    try {
      return await Promise.race([effect, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  // A command abandoned at its timeout settled. The start or command that ran it retired the
  // incarnation, but the call may have started the container since: destroy it again now. A failed
  // destroy stays recorded as retiring, with its retry scheduled, for the next wake-up or release.
  #reconcile(): void {
    const state = this.#read();
    if (state === null || state.phase === "live") return;
    this.#destroy(state.deadline).catch((error: unknown) => {
      console.error(
        "sandbox teardown after a late command failed",
        error instanceof Error ? error.name : "unknown",
      );
    });
  }

  // Waits up to `#settleMs` for `work` to settle; false when some of it has not.
  async #quiet(work: Promise<unknown>[]): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#settleMs);
    });
    try {
      return await Promise.race([Promise.allSettled(work).then(() => true), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  // After a start or command failed partway: it may have left a process running, so the container
  // is destroyed before the failure is reported. A refusal that already destroyed it passes through.
  async #failClosed(deadline: number, error: unknown): Promise<never> {
    if (
      error instanceof SandboxFenceError &&
      (error.code === "retired" || error.code === "expired")
    )
      throw error;
    try {
      await this.#destroy(deadline);
    } catch (destroyError) {
      throw new AggregateError([error, destroyError], "the sandbox failed and was not destroyed", {
        cause: destroyError,
      });
    }
    throw error;
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
  // container is touched, so a failure or a restart mid-destroy still leaves a retry behind. A retry
  // that cannot be scheduled does not stop this attempt; if the attempt fails as well, both
  // failures are reported and the incarnation stays retiring for the next wake-up or release.
  async #destroy(deadline: number): Promise<void> {
    const attempts = this.#retiring(deadline);
    let unscheduled: { error: unknown } | null = null;
    if (attempts < MAX_TEARDOWN_ATTEMPTS) {
      try {
        await this.#container.wake(this.#clock() + teardownRetryDelay(attempts));
      } catch (error) {
        unscheduled = { error };
      }
    }
    try {
      await this.#container.destroy();
    } catch (error) {
      // Another destroy may have confirmed retirement meanwhile; this failure unconfirms it.
      if (this.#read()?.phase !== "retiring")
        this.#write({ phase: "retiring", deadline, attempts });
      if (unscheduled === null) throw error;
      throw new AggregateError(
        [error, unscheduled.error],
        "the sandbox was not destroyed and its retry was not scheduled",
        { cause: error },
      );
    }
    // A command still in flight may start the container after this destroy: the incarnation stays
    // retiring until it settles and the destroy that follows confirms.
    if (this.#effects.size === 0) this.#write({ phase: "retired", deadline });
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
