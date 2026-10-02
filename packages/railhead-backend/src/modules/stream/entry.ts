// Stream: live delivery of a repository's events to board subscribers. A subscription is a
// convenience over the durable log, never delivery the board relies on: the board's persisted
// cursor and `readEvents` are what survive a restart or hibernation. Until its task installs the
// module, every subscription is refused with `unavailable` and the board reads by paging.

import type { SubscriptionEnd } from "@railhead/shared/board-api";
import type { RailheadEvent } from "@railhead/shared/events";
import { fail, type PortResult } from "../../contracts/result";
import type { ModuleFactory } from "../../repo/composeRepo";

/** The subscriber's side, as the Repo receives it across the Worker's RPC boundary. */
export interface StreamListener {
  /** Receives the next events after the cursor, in order and gapless. */
  events(events: RailheadEvent[]): Promise<void>;
  /** Called once when the subscription ends. */
  ended(reason: SubscriptionEnd): Promise<void>;
}

/** A live subscription. */
export interface StreamSubscription {
  /** Ends the subscription; no listener call follows the returned promise. */
  cancel(): Promise<void>;
}

/** Live subscriptions to one repository's log. */
export interface StreamPort {
  /** Delivers every event after `cursor` to `listener` until cancelled or ended. */
  subscribe(cursor: number, listener: StreamListener): Promise<PortResult<StreamSubscription>>;
}

/** Builds the stream module of one repository. */
export const stream: ModuleFactory<StreamPort> = () => ({
  subscribe: async () => fail("unavailable", "The stream module is not available."),
});
