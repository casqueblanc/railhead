// Keeps a folded board current from one repository's log over one session, following the
// snapshot-plus-cursor contract in `@railhead/shared/board-api`: page `readEvents` from the cursor
// up to the head, subscribe from the cursor, and on a gap or a `slow` or `restart` end, page over
// the gap and subscribe again. The stream never holds board state; its sink folds and reports the
// cursor, which is what a later session resumes from.

import { RpcTarget } from "capnweb";
import {
  MAX_EVENT_PAGE,
  type BoardErrorCode,
  type BoardListener,
  type SubscriptionEnd,
} from "@railhead/shared/board-api";
import type { RailheadEvent, RepoId } from "@railhead/shared/events";
import type { BoardSession, SubscriptionSession } from "./apiSession";

/** Resyncs in a row that may leave the cursor where it was before the stream gives up. */
export const MAX_RESYNCS_WITHOUT_PROGRESS = 5;

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
  /** The backend failed or kept failing to deliver; a new session may recover. */
  | "failed";

/** What the stream is doing. */
export type StreamPhase =
  | { kind: "catching_up" }
  | { kind: "live" }
  | { kind: "stopped"; reason: StreamStop };

/** Where the stream sends what it reads. Called only while the stream is not disposed. */
export interface StreamSink {
  /** The log's repository, from the first page, before any of its events are applied. */
  onRepo(repo: RepoId): void;
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

/** The board's side of one subscription. It forwards only while it is the current one. */
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
}

/** Keeps one board current over one session until disposed or stopped. */
export class BoardStream implements Disposable {
  readonly #board: BoardSession;
  readonly #sink: StreamSink;
  #cursor: number;
  #disposed = false;
  #stopped = false;
  #listener: Listener | null = null;
  #subscription: SubscriptionSession | null = null;
  #syncing = false;
  #again = false;
  #resyncs = 0;
  #cursorAtResync = -1;

  /** Starts reading after `cursor`, the cursor of the board the sink already holds. */
  constructor(board: BoardSession, sink: StreamSink, cursor: number) {
    this.#board = board;
    this.#sink = sink;
    this.#cursor = cursor;
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
    const result = await this.#board.subscribe(this.#cursor, listener);
    if (!this.#isCurrent(listener)) {
      if (result.ok) result.value[Symbol.dispose]();
      return;
    }
    if (!result.ok) {
      this.#stop(stopFor(result.code));
      return;
    }
    this.#subscription = result.value;
    this.#sink.onPhase({ kind: "live" });
  }

  /**
   * Pages from the cursor up to the head the first page reports; events appended after that
   * arrive through the subscription. Returns why the stream must stop, or `null`.
   */
  async #catchUp(): Promise<StreamStop | null> {
    let head: number | null = null;
    for (;;) {
      const page = await this.#board.readEvents(this.#cursor, MAX_EVENT_PAGE);
      if (this.#disposed || this.#stopped) return null;
      if (!page.ok) return stopFor(page.code);
      if (head === null) {
        head = page.value.head;
        this.#sink.onRepo(page.value.repo);
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
