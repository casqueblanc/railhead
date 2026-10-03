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
// The SDK joins a destroy that overlaps one already in flight rather than starting another, so the
// fence runs its destroys one after another and confirms retirement only with a destroy that began
// after the last command settled.
// Route, wake-up and destroy calls are never abandoned: the operation that made them awaits them.
//
// Container calls the fence does not issue itself, such as a backup restore or a process wait, run
// through `operate` under the same tracking, deadline and destroy-on-settle, and `admit` refuses
// every path that would reach or start the container outside the live incarnation, so a call that
// resumes after retirement cannot touch it.
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
//
// A retired incarnation's record is needed only while a start for it could still arrive. Every
// start carries its slot's deadline, and one that arrives at or after that deadline starts nothing,
// so once retirement is confirmed and the deadline has passed the object may forget the record and
// all its storage (`disposable`); a retirement confirmed early asks to be woken at the deadline for
// that. A sandbox retired before it ever started records a deadline `MAX_SANDBOX_LIFETIME_MS` from
// then: its slot was admitted earlier, so its deadline, and that of any start still on the way, is no
// later.

import { MAX_SANDBOX_LIFETIME_MS } from "./admission";
import { MAX_COMMAND_TIMEOUT_MS, type SandboxCommand } from "./entry";
import type { BoundedOutput } from "./output";
import { parseSandboxPolicy, type SandboxGrant, type SandboxPolicy } from "./policy";

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
  /** A start or join named another policy or deadline than the live incarnation's. */
  "mismatch" | "retired" | "expired" | "not_started" | "probe_failed" | "timed_out" | "unsettled";

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
 * The fence's durable record. `deadline` is when the incarnation must be gone; for one retired
 * before it started, the latest deadline its slot can have. Once it leaves `live` it never returns:
 * `retiring` means a destroy is not yet confirmed, `retired` that the last one succeeded.
 */
type FenceState =
  | { phase: "live"; deadline: number; policy: SandboxPolicy }
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
  // How many container commands have settled; a destroy that saw this change confirms nothing.
  #settlements = 0;
  // The last destroy queued; each waits for the one before, so none joins an earlier one.
  #teardown: Promise<unknown> = Promise.resolve();

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

  /**
   * Starts the incarnation under `policy` until `deadline` and confirms it answers. A repeat for the
   * live incarnation must name the same policy and deadline; one that names another is refused with
   * `mismatch` and changes nothing, so no caller can replace the grant the sandbox was admitted
   * under.
   */
  start(policy: SandboxPolicy, deadline: number): Promise<void> {
    return this.#track(async () => {
      const state = this.#read();
      if (state !== null && state.phase !== "live") throw new SandboxFenceError("retired");
      if (state !== null && state.deadline !== deadline) throw new SandboxFenceError("retired");
      if (state !== null && !samePolicy(state.policy, policy)) {
        throw new SandboxFenceError("mismatch");
      }
      if (this.#clock() >= deadline) return this.#expireFrom(deadline);
      this.#write({ phase: "live", deadline, policy });
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

  /**
   * Admits a caller to the incarnation a start already made live, under the same `policy` and
   * `deadline`; it starts, routes and runs nothing itself. Only the sandbox module's admission
   * starts an incarnation, so a caller naming a sandbox that was never admitted is refused with
   * `not_started`, and the name is retired so no later start can use it. A join that names another
   * policy or deadline is refused with `mismatch` and leaves the live incarnation as it was.
   */
  join(policy: SandboxPolicy, deadline: number): Promise<void> {
    return this.#track(async () => {
      const state = this.#read();
      if (state === null) {
        await this.#destroy(Math.min(deadline, this.#clock() + MAX_SANDBOX_LIFETIME_MS));
        throw new SandboxFenceError("not_started");
      }
      if (state.phase !== "live") throw new SandboxFenceError("retired");
      if (state.deadline !== deadline || !samePolicy(state.policy, policy)) {
        throw new SandboxFenceError("mismatch");
      }
      if (this.#clock() >= deadline) return this.#expireFrom(deadline);
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
   * Runs one container operation the fence does not issue itself, such as a backup restore or a
   * process wait, inside the live incarnation. It is refused, never started, once the incarnation is
   * retired or past its deadline, and abandoned at the deadline. Until it settles it holds
   * retirement unconfirmed like a command; if retirement happened while it ran, the container is
   * destroyed again before the operation reports, whether it succeeded or failed.
   */
  operate<T>(operation: () => Promise<T>): Promise<T> {
    return this.#track(async () => {
      const state = this.#read();
      if (state === null) throw new SandboxFenceError("not_started");
      if (state.phase !== "live") throw new SandboxFenceError("retired");
      if (this.#clock() >= state.deadline) return this.#expireFrom(state.deadline);
      let result: T;
      try {
        result = await this.#effect(operation, Math.max(1, state.deadline - this.#clock()));
      } catch (error) {
        await this.#settleEffect();
        if (this.#clock() >= state.deadline) return this.#expireFrom(state.deadline);
        return this.#failClosed(state.deadline, error);
      }
      await this.#settleEffect();
      if (this.#clock() >= state.deadline) return this.#expireFrom(state.deadline);
      return result;
    });
  }

  /**
   * Refuses unless the incarnation is live and before its deadline. Every path that reaches or
   * starts the container passes here, so an operation that resumes after retirement, or after the
   * deadline, cannot touch it.
   */
  admit(): void {
    const state = this.#read();
    if (state === null) throw new SandboxFenceError("not_started");
    if (state.phase !== "live") throw new SandboxFenceError("retired");
    if (this.#clock() >= state.deadline) throw new SandboxFenceError("expired");
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
    const deadline = this.#read()?.deadline ?? this.#clock() + MAX_SANDBOX_LIFETIME_MS;
    const outstanding = [...this.#inflight, ...this.#effects];
    const confirmed = await this.#destroy(deadline);
    if (outstanding.length === 0 && confirmed) return;
    const settled = outstanding.length === 0 || (await this.#quiet(outstanding));
    const confirmedAfter = await this.#destroy(deadline);
    if (!settled || !confirmedAfter) throw new SandboxFenceError("unsettled");
  }

  /**
   * The scheduled wake-up. Before the deadline it schedules itself again; at the deadline it retires
   * the incarnation; while a destroy is unconfirmed it retries it; once retired early, it asks to be
   * woken at the deadline, when the object becomes `disposable`.
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
        if (this.#clock() < state.deadline) await this.#container.wake(state.deadline);
        return;
      default:
        throw new Error(`unknown fence phase: ${state satisfies never}`);
    }
  }

  /**
   * Whether the object may delete its storage: retirement is confirmed, its deadline has passed, so
   * no start can still begin an incarnation, and nothing it ran is still outstanding. A record that
   * was never written is not disposable: there is nothing to delete.
   */
  disposable(): boolean {
    const state = this.#read();
    return (
      state !== null &&
      state.phase === "retired" &&
      this.#clock() >= state.deadline &&
      this.#inflight.size === 0 &&
      this.#effects.size === 0
    );
  }

  // Runs one command, aborting it at its timeout: the SDK does not stop a streaming command itself.
  async #run(
    command: string,
    options: { timeoutMs: number; env?: Record<string, string>; cwd?: string },
  ): Promise<BoundedOutput> {
    const abort = new AbortController();
    return this.#effect(
      () => this.#container.exec(command, { ...options, signal: abort.signal }),
      options.timeoutMs,
      abort,
    );
  }

  // Runs one container call, giving up on it at `timeoutMs`. A call that ignores `abort` is not
  // waited for, but it stays tracked until it settles, and if it settles after its caller gave up
  // the container is destroyed again.
  async #effect<T>(
    start: () => Promise<T>,
    timeoutMs: number,
    abort?: AbortController,
  ): Promise<T> {
    const effect = start();
    let abandoned = false;
    this.#effects.add(effect);
    const settled = () => {
      this.#effects.delete(effect);
      this.#settlements += 1;
      if (abandoned) this.#reconcile();
    };
    // Registered before the race below, so the effect is forgotten before its caller resumes.
    effect.then(settled, settled);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abandoned = true;
        abort?.abort();
        reject(new SandboxFenceError("timed_out"));
      }, timeoutMs);
    });
    try {
      return await Promise.race([effect, timedOut]);
    } finally {
      clearTimeout(timer);
    }
  }

  // A command abandoned at its timeout settled. The start or command that ran it retired the
  // incarnation, but the call may have started the container since: destroy it again once any
  // destroy under way has returned. A release waits for it like any other operation under way. A
  // failed destroy stays recorded as retiring, with its retry scheduled, for the next wake-up or
  // release.
  #reconcile(): void {
    const state = this.#read();
    if (state === null || state.phase === "live") return;
    this.#track(() => this.#destroy(state.deadline)).catch((error: unknown) => {
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

  // One destroy attempt, true when it confirmed retirement. The incarnation is marked retiring at
  // once, and the attempt runs after every earlier one has returned: the SDK would join a destroy
  // still in flight, which may have stopped the container before a late command started it again.
  // A retry is scheduled before the container is touched, so a failure or a restart mid-destroy
  // still leaves a retry behind. A retry that cannot be scheduled does not stop this attempt; if
  // the attempt fails as well, both failures are reported and the incarnation stays retiring for
  // the next wake-up or release.
  #destroy(deadline: number): Promise<boolean> {
    const attempts = this.#retiring(deadline);
    const turn = this.#teardown.then(() => this.#destroyAfter(deadline, attempts));
    this.#teardown = turn.catch(noop);
    return turn;
  }

  async #destroyAfter(deadline: number, attempts: number): Promise<boolean> {
    let unscheduled: { error: unknown } | null = null;
    if (attempts < MAX_TEARDOWN_ATTEMPTS) {
      try {
        await this.#container.wake(this.#clock() + teardownRetryDelay(attempts));
      } catch (error) {
        unscheduled = { error };
      }
    }
    const settlements = this.#settlements;
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
    // A command still in flight may start the container after this destroy, and one that settled
    // during it may have started it after the stop: the incarnation stays retiring until the
    // destroy that follows the last settlement confirms.
    if (this.#effects.size > 0 || this.#settlements !== settlements) return false;
    this.#write({ phase: "retired", deadline });
    return true;
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
      if (value.phase === "live" && "policy" in value) {
        const policy = parseSandboxPolicy(value.policy);
        if (policy !== null) return { phase: "live", deadline, policy };
      }
      if (value.phase === "retired") return { phase: "retired", deadline };
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

function noop(): void {}

// Whether two policies grant the same access. Each is parsed again, since a policy may arrive over
// RPC; parsed policies have one field order, so equal ones serialize alike.
function samePolicy(left: unknown, right: unknown): boolean {
  const parsed = parseSandboxPolicy(left);
  return parsed !== null && JSON.stringify(parsed) === JSON.stringify(parseSandboxPolicy(right));
}
