// Stream: live delivery of a repository's events to board subscribers. A subscription is a
// convenience over the durable log, never delivery the board relies on: the board's persisted
// cursor and `readEvents` are what survive a restart or hibernation.
//
// A subscription holds only its cursor and its listener; it buffers no events. Each delivery reads
// the next page after the cursor from storage, so an event appended while a page is in flight, or
// before the subscription caught up, is read on the next pass rather than lost, and the memory a
// subscriber costs does not grow with how far behind it is. The event log's commit observer is the
// only wake-up; nothing polls, so an idle repository with subscribers stays idle.
//
// Nothing here survives the Repo being evicted: subscriptions live in memory, and a board that
// loses one pages from its own cursor and subscribes again.

import { RpcTarget } from "cloudflare:workers";
import {
  MAX_PUSH_BATCH,
  MAX_UNACKNOWLEDGED_EVENTS,
  type SubscriptionEnd,
} from "@railhead/shared/board-api";
import type { RailheadEvent } from "@railhead/shared/events";
import { fail, ok, type PortResult } from "../../contracts/result";
import type { ModuleFactory } from "../../repo/composeRepo";
import type { EventLog } from "../../repo/eventLog";

/** The subscriber's side, as the Repo receives it across the Worker's RPC boundary. */
export interface StreamListener {
  /** Receives the next events after the cursor, in order and gapless. */
  events(events: RailheadEvent[]): Promise<void>;
  /** Called once when the subscription ends. */
  ended(reason: SubscriptionEnd): Promise<void>;
}

/** A live subscription. It holds its slot until every reference to it is released, ended or not. */
export interface StreamSubscription {
  /** Ends the subscription; no listener call follows the returned promise. */
  cancel(): Promise<void>;
}

/** Live subscriptions to one repository's log. */
export interface StreamPort {
  /** Delivers every event after `cursor` to `listener` until cancelled or ended. */
  subscribe(cursor: number, listener: StreamListener): Promise<PortResult<StreamSubscription>>;
  /** Ends every live subscription with `reason`, as when the history they follow is deleted. */
  endAll(reason: SubscriptionEnd): void;
}

/**
 * Most subscriptions one repository holds; past it `subscribe` fails with `quota_exceeded`. An
 * ended subscription keeps its slot until its handle is released and its listener calls in flight
 * settle or time out.
 */
export const MAX_SUBSCRIPTIONS = 256;

/**
 * How long a listener may take to settle one delivery, in milliseconds, before the subscription
 * ends with `slow`.
 */
export const DELIVERY_TIMEOUT_MS = 30_000;

/** Tuning a test may shorten. Production uses the defaults. */
export interface StreamOptions {
  /** See `DELIVERY_TIMEOUT_MS`. */
  deliveryTimeoutMs?: number;
}

/** Builds the stream module of one repository. */
export const stream: ModuleFactory<StreamPort> = (context) => streamPort(context.log);

/** The stream port over `log`. */
export function streamPort(log: EventLog, options: StreamOptions = {}): StreamPort {
  const hub = new Hub(log, options.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS);
  return {
    subscribe: async (cursor, listener) => hub.subscribe(cursor, listener),
    endAll: (reason) => hub.endAll(reason),
  };
}

class Hub {
  readonly #log: EventLog;
  readonly #timeoutMs: number;
  readonly #live = new Set<Subscription>();
  #stopObserving: (() => void) | null = null;

  constructor(log: EventLog, timeoutMs: number) {
    this.#log = log;
    this.#timeoutMs = timeoutMs;
  }

  subscribe(cursor: number, listener: StreamListener): PortResult<StreamSubscription> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      return fail("invalid_request", "The cursor must be a whole number from 0.");
    }
    if (cursor > this.#log.head()) {
      return fail("cursor_ahead", "The cursor is ahead of this repository's log.");
    }
    if (this.#live.size >= MAX_SUBSCRIPTIONS) {
      return fail("quota_exceeded", "This repository has too many live subscriptions.");
    }
    // A stub received as an argument is released when the call returns, so the subscription keeps
    // its own duplicate and releases it when it ends.
    const held = retain(listener);
    const subscription = new Subscription(this.#log, cursor, held, this.#timeoutMs, () =>
      this.#remove(subscription),
    );
    this.#live.add(subscription);
    // Observe only while someone listens, so an unwatched repository does no work on commit.
    this.#stopObserving ??= this.#log.observe((head) => {
      for (const live of this.#live) live.wake(head);
    });
    subscription.wake(this.#log.head());
    return ok(new SubscriptionHandle(subscription));
  }

  endAll(reason: SubscriptionEnd): void {
    for (const live of this.#live) live.end(reason);
    // Ended subscriptions ignore wakes, so the log need not be watched while their slots drain.
    this.#stopObserving?.();
    this.#stopObserving = null;
  }

  #remove(subscription: Subscription): void {
    this.#live.delete(subscription);
    if (this.#live.size === 0 && this.#stopObserving !== null) {
      this.#stopObserving();
      this.#stopObserving = null;
    }
  }
}

/** One subscriber's cursor and delivery loop. */
class Subscription {
  readonly #log: EventLog;
  readonly #listener: StreamListener;
  readonly #timeoutMs: number;
  readonly #onEnd: () => void;
  // The `seq` of the last event the listener acknowledged.
  #cursor: number;
  #head: number;
  #sending = false;
  // The head when the delivery in flight was sent.
  #sentAtHead = 0;
  #ended = false;
  // An `ended` call is in flight.
  #ending = false;
  #listenerReleased = false;
  // Every reference to the subscription's handle is gone.
  #handleReleased = false;
  #finished = false;

  constructor(
    log: EventLog,
    cursor: number,
    listener: StreamListener,
    timeoutMs: number,
    onEnd: () => void,
  ) {
    this.#log = log;
    this.#cursor = cursor;
    this.#head = cursor;
    this.#listener = listener;
    this.#timeoutMs = timeoutMs;
    this.#onEnd = onEnd;
  }

  /** Learns that the log reached `head`, and delivers if the listener is behind. */
  wake(head: number): void {
    if (this.#ended) return;
    this.#head = Math.max(this.#head, head);
    // Catching up from an old cursor is not slow; falling further behind while a delivery stays
    // unsettled is.
    if (this.#sending && this.#head - this.#sentAtHead > MAX_UNACKNOWLEDGED_EVENTS) {
      this.end("slow");
      return;
    }
    if (!this.#sending && this.#cursor < this.#head) void this.#pump();
  }

  /** Ends the subscription; `reason` is sent to the listener, `null` sends nothing. */
  end(reason: SubscriptionEnd | null): void {
    if (this.#ended) return;
    this.#ended = true;
    if (reason === null) {
      this.#finish();
      return;
    }
    this.#ending = true;
    // Started inside the chain, so a listener that throws synchronously is still released.
    void Promise.resolve()
      .then(() => withTimeout(this.#listener.ended(reason), this.#timeoutMs))
      .then((outcome) => {
        if (outcome === "timeout") reportFailure("stream listener ended timed out", null);
      })
      .catch((error: unknown) => reportFailure("stream listener ended failed", error))
      .finally(() => {
        this.#ending = false;
        this.#finish();
      });
  }

  /** Learns that the handle is gone: the subscription ends, and its slot may be freed. */
  releaseHandle(): void {
    this.#handleReleased = true;
    this.end(null);
    this.#finish();
  }

  // Releases the listener once the subscription has ended and no listener call is in flight, and
  // frees the slot once the handle is released too. Releasing the listener is how the subscriber
  // learns of an end it was not told about, and its cleanup is what releases the handle; holding
  // the slot until then makes the slot bound also bound the calls, timers and handles a churning
  // subscriber leaves on either side.
  #finish(): void {
    if (!this.#ended || this.#sending || this.#ending) return;
    if (!this.#listenerReleased) {
      this.#listenerReleased = true;
      release(this.#listener);
    }
    if (!this.#handleReleased || this.#finished) return;
    this.#finished = true;
    this.#onEnd();
  }

  async #pump(): Promise<void> {
    this.#sending = true;
    try {
      while (!this.#ended && this.#cursor < this.#head) {
        const page = this.#log.replay(this.#cursor, MAX_PUSH_BATCH);
        this.#head = Math.max(this.#head, page.head);
        const last = page.events.at(-1);
        if (last === undefined) return;
        this.#sentAtHead = this.#head;
        const delivered = await this.#deliver(page.events);
        if (!delivered || this.#ended) return;
        this.#cursor = last.seq;
      }
    } catch (error) {
      // The log could not be read. The board pages from its cursor and meets the same fault there.
      reportFailure("stream delivery failed", error);
      this.end("restart");
    } finally {
      this.#sending = false;
      this.#finish();
    }
  }

  // Resolves `true` once the listener settles the batch, `false` if the subscription ended first.
  async #deliver(events: RailheadEvent[]): Promise<boolean> {
    try {
      const outcome = await withTimeout(this.#listener.events(events), this.#timeoutMs);
      if (outcome === "timeout") {
        this.end("slow");
        return false;
      }
      return true;
    } catch (error) {
      // The listener is gone, most often because its socket closed: nobody is left to tell.
      reportFailure("stream listener failed", error);
      this.end(null);
      return false;
    }
  }
}

/** The subscription as the Worker holds it, across the Repo's RPC boundary. */
class SubscriptionHandle extends RpcTarget implements StreamSubscription {
  readonly #subscription: Subscription;

  constructor(subscription: Subscription) {
    super();
    this.#subscription = subscription;
  }

  async cancel(): Promise<void> {
    this.#subscription.end(null);
  }

  // The runtime calls this once every stub of the handle is released, including when the Worker's
  // execution context ends before its cancel arrives, so a lost cancel still frees the slot.
  [Symbol.dispose](): void {
    this.#subscription.releaseHandle();
  }
}

// A duplicate of `listener` when it is an RPC stub, or `listener` itself.
function retain(listener: StreamListener & { dup?: () => StreamListener }): StreamListener {
  return listener.dup?.() ?? listener;
}

// Settles with `call`'s outcome, or with "timeout" after `ms`, then releases the call's result.
// An RPC call's result holds the Repo until it is disposed, settled or not; disposing one still in
// flight abandons it.
async function withTimeout(call: Promise<void>, ms: number): Promise<"done" | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  try {
    return await Promise.race([call.then((): "done" => "done"), timedOut]);
  } finally {
    clearTimeout(timer);
    release(call);
  }
}

/** Disposes `value` when the transport made it disposable: a stub or an RPC call's result. */
export function release(value: object): void {
  const dispose: unknown = Reflect.get(value, Symbol.dispose);
  if (typeof dispose === "function") dispose.call(value);
}

// Only the error's name: a message may carry data from the listener's side.
function reportFailure(what: string, error: unknown): void {
  console.error(what, error instanceof Error ? error.name : "unknown");
}
