// Keeps a folded board current from one repository's log over one session, following the
// snapshot-plus-cursor contract in `@railhead/shared/board-api`: page `readEvents` from the cursor
// up to the head, subscribe from the cursor, and on a gap or a `slow` or `restart` end, page over
// the gap and subscribe again. Every read and subscribe carries a deadline: one that stays pending
// stops the stream as failed. The stream never holds board state; its sink folds and reports the
// cursor, which is what a later session resumes from, together with the history the cursor was read
// under. Every call after the first page carries that history, so once the owner resets the
// repository the backend refuses the old cursor and the stream stops as failed instead of folding
// the new history's events onto the old board.

import { RpcTarget } from "capnweb";
import {
  MAX_EVENT_PAGE,
  type BoardErrorCode,
  type BoardListener,
  type SubscriptionEnd,
} from "@railhead/shared/board-api";
import type { RailheadEvent, RepoId } from "@railhead/shared/events";
import type { BoardSession, SubscriptionSession } from "./apiSession";
import { withDeadline } from "./deadline";

/** Resyncs in a row that may leave the cursor where it was before the stream gives up. */
export const MAX_RESYNCS_WITHOUT_PROGRESS = 5;

/** How long a subscription must stay live before resyncs that follow it count from zero again. */
export const HEALTHY_LIVE_MS = 60_000;

/** Where a board read in an earlier session stands. */
export interface Resume {
  /** The `seq` of the last event the board applied. */
  cursor: number;
  /** The `EventPage.history` that cursor was read under. */
  history: string;
}

/** Where the fold stands after applying a batch. */
export interface Applied {
  /** The `seq` of the last event applied, or 0 before the first. */
  cursor: number;
  /** The fold stopped for good; nothing more is read. */
  halted: boolean;
}

/** Why the stream stopped keeping the board current. */
export type StreamStop =
  /** The backend serves no log for this repository, or no stream module. */
  | "unavailable"
  /** The session lost access to the repository. */
  | "revoked"
  /** The fold stopped on an event it could not apply. */
  | "halted"
  /** The backend failed, kept failing to deliver or did not answer in time; a new session may recover. */
  | "failed";

/** What the stream is doing. */
export type StreamPhase =
  | { kind: "catching_up" }
  | { kind: "live" }
  | { kind: "stopped"; reason: StreamStop };

/** Where the stream sends what it reads. Called only while the stream is not disposed. */
export interface StreamSink {
  /**
   * The log's repository and the history its cursors belong to, from the first page of each catch-up,
   * before any of its events are applied.
   */
  onRepo(repo: RepoId, history: string): void;
  /** Folds `events`, which may repeat or skip events, and reports the resulting cursor. */
  onEvents(events: readonly RailheadEvent[]): Applied;
  onPhase(phase: StreamPhase): void;
}

const stopFor = (code: BoardErrorCode): StreamStop => {
  switch (code) {
    case "not_found":
    case "unavailable":
      return "unavailable";
    case "invalid_request":
    case "cursor_ahead":
    case "proof_invalid":
    case "proof_expired":
    case "action_stale":
    case "bootstrap_closed":
    case "quota_exceeded":
    case "internal":
      return "failed";
    default:
      return unreachable(code);
  }
};

/**
 * The board's side of one subscription. It forwards only while it is the current one. The backend
 * can also drop a subscription without calling `ended` (it does on a delivery failure); Cap'n Web
 * then disposes this target, which the stream treats as a lost subscription.
 */
class Listener extends RpcTarget implements BoardListener {
  readonly #stream: BoardStream;

  constructor(stream: BoardStream) {
    super();
    this.#stream = stream;
  }

  async events(events: RailheadEvent[]): Promise<void> {
    this.#stream.delivered(this, events);
  }

  async ended(reason: SubscriptionEnd): Promise<void> {
    this.#stream.endedBy(this, reason);
  }

  [Symbol.dispose](): void {
    this.#stream.releasedBy(this);
  }
}

/** Keeps one board current over one session until disposed or stopped. */
export class BoardStream implements Disposable {
  readonly #board: BoardSession;
  readonly #sink: StreamSink;
  #cursor: number;
  /** The history `#cursor` belongs to, or `null` before the first page of a board read from 0. */
  #history: string | null;
  #disposed = false;
  #stopped = false;
  #listener: Listener | null = null;
  #subscription: SubscriptionSession | null = null;
  #syncing = false;
  #again = false;
  #resyncs = 0;
  #cursorAtResync = -1;
  /** When the current subscription went live, or `null` while not live. */
  #liveSince: number | null = null;

  /**
   * Starts reading after `from`, where the board the sink already holds stands, or from the start
   * of the log when `from` is `null`.
   */
  constructor(board: BoardSession, sink: StreamSink, from: Resume | null) {
    this.#board = board;
    this.#sink = sink;
    this.#cursor = from?.cursor ?? 0;
    this.#history = from?.history ?? null;
    void this.#sync();
  }

  /** Called by the current listener with a pushed batch. */
  delivered(listener: Listener, events: readonly RailheadEvent[]): void {
    if (!this.#isCurrent(listener)) return;
    const last = events.at(-1)?.seq;
    if (!this.#apply(events)) return;
    if (last !== undefined && this.#cursor < last) this.#resync();
  }

  /** Called by the current listener when the backend ends its subscription. */
  endedBy(listener: Listener, reason: SubscriptionEnd): void {
    if (!this.#isCurrent(listener)) return;
    switch (reason) {
      case "revoked":
        this.#stop("revoked");
        return;
      case "slow":
      case "restart":
        this.#resync();
        return;
      default:
        unreachable(reason);
    }
  }

  /**
   * Called when the backend releases a listener. Releasing the current one without `ended` leaves
   * nothing to deliver events, so the stream catches up and subscribes again, within the resync
   * bound. A listener the stream already replaced or dropped is ignored.
   */
  releasedBy(listener: Listener): void {
    if (!this.#isCurrent(listener)) return;
    this.#resync();
  }

  [Symbol.dispose](): void {
    this.#disposed = true;
    this.#dropSubscription();
  }

  #isCurrent(listener: Listener): boolean {
    return !this.#disposed && !this.#stopped && this.#listener === listener;
  }

  /** Folds a batch. Returns false when the fold halted and the stream stopped. */
  #apply(events: readonly RailheadEvent[]): boolean {
    if (events.length === 0) return true;
    const applied = this.#sink.onEvents(events);
    this.#cursor = applied.cursor;
    if (applied.halted) {
      this.#stop("halted");
      return false;
    }
    return true;
  }

  #resync(): void {
    // An idle board's cursor never moves, so only a healthy live period tells a backend that
    // restarts now and then from one that drops every subscription it grants.
    const liveSince = this.#liveSince;
    this.#liveSince = null;
    if (liveSince !== null && Date.now() - liveSince >= HEALTHY_LIVE_MS) {
      this.#resyncs = 0;
      this.#cursorAtResync = -1;
    }
    if (this.#cursor === this.#cursorAtResync) {
      this.#resyncs += 1;
      if (this.#resyncs > MAX_RESYNCS_WITHOUT_PROGRESS) {
        this.#stop("failed");
        return;
      }
    } else {
      this.#resyncs = 1;
      this.#cursorAtResync = this.#cursor;
    }
    this.#dropSubscription();
    if (this.#syncing) {
      this.#again = true;
      return;
    }
    void this.#sync();
  }

  async #sync(): Promise<void> {
    this.#syncing = true;
    try {
      do {
        this.#again = false;
        await this.#syncOnce();
      } while (this.#again && !this.#disposed && !this.#stopped);
    } catch {
      if (!this.#disposed) this.#stop("failed");
    } finally {
      this.#syncing = false;
    }
  }

  async #syncOnce(): Promise<void> {
    this.#sink.onPhase({ kind: "catching_up" });
    const stop = await this.#catchUp();
    if (this.#disposed || this.#stopped) return;
    if (stop !== null) {
      this.#stop(stop);
      return;
    }
    const listener = new Listener(this);
    this.#listener = listener;
    const result = await withDeadline(
      this.#board.subscribe(this.#cursor, listener, this.#history ?? undefined),
      (late) => {
        if (late.ok) late.value[Symbol.dispose]();
      },
    );
    if (!this.#isCurrent(listener)) {
      if (result.ok) result.value[Symbol.dispose]();
      return;
    }
    if (!result.ok) {
      this.#stop(stopFor(result.code));
      return;
    }
    this.#subscription = result.value;
    this.#liveSince = Date.now();
    this.#sink.onPhase({ kind: "live" });
  }

  /**
   * Pages from the cursor up to the head the first page reports; events appended after that
   * arrive through the subscription. Returns why the stream must stop, or `null`.
   */
  async #catchUp(): Promise<StreamStop | null> {
    let head: number | null = null;
    for (;;) {
      const page = await withDeadline(
        this.#board.readEvents(this.#cursor, MAX_EVENT_PAGE, this.#history ?? undefined),
      );
      if (this.#disposed || this.#stopped) return null;
      if (!page.ok) return stopFor(page.code);
      // The backend refuses a cursor from another history, so a page from one is a broken backend.
      if (this.#history !== null && page.value.history !== this.#history) return "failed";
      this.#history = page.value.history;
      if (head === null) {
        head = page.value.head;
        this.#sink.onRepo(page.value.repo, page.value.history);
      }
      const before = this.#cursor;
      if (!this.#apply(page.value.events)) return null;
      if (this.#cursor >= head) return null;
      // Below the head, a page that moves nothing would be read again forever.
      if (this.#cursor <= before) return "failed";
    }
  }

  #stop(reason: StreamStop): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#dropSubscription();
    this.#sink.onPhase({ kind: "stopped", reason });
  }

  #dropSubscription(): void {
    this.#listener = null;
    const subscription = this.#subscription;
    this.#subscription = null;
    subscription?.[Symbol.dispose]();
  }
}

const unreachable = (value: never): never => {
  throw new Error(`unhandled board stream variant: ${JSON.stringify(value)}`);
};
