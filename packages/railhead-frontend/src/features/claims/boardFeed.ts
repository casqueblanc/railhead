// What a board section is showing, derived from the folded board and the connection that feeds it.
//
// The claim lanes and the train outcomes both render from this, so they agree on whether the board
// is current. A board that is behind the log or stopped keeps showing what it last applied, and
// says so; it never presents that state as live.

import type { BoardFault, BoardState } from "../board/boardState";

/** The input a board section renders from. The page that owns the session builds it. */
export type BoardFeed =
  /** No board yet: the session is opening or the first events are loading. */
  | { kind: "loading" }
  /** No board could be loaded. */
  | { kind: "failed" }
  /**
   * A folded board. `connection` is `lost` while the session is down. `recovered` is true once a
   * reconnect or a replay has caught the board up again, until the page clears it.
   */
  | { kind: "board"; board: BoardState; connection: "live" | "lost"; recovered: boolean };

/** Why a board is behind the log. */
export type StaleReason =
  | { kind: "disconnected" }
  /** Events `expected` through `through` have not arrived. */
  | { kind: "gap"; expected: number; through: number };

/** What a section shows. Every state that carries a board renders its content. */
export type FeedView =
  | { kind: "loading" }
  | { kind: "failed" }
  /** The fold stopped on an event it could not apply; content is the board before that event. */
  | { kind: "halted"; board: BoardState; fault: BoardFault }
  | { kind: "stale"; board: BoardState; reason: StaleReason }
  | { kind: "recovered"; board: BoardState }
  | { kind: "live"; board: BoardState };

/**
 * Derives what to show. A halted fold outranks everything else, because reconnecting cannot repair
 * it; a lost connection outranks a gap, because a gap cannot close while the session is down.
 */
export const feedView = (feed: BoardFeed): FeedView => {
  switch (feed.kind) {
    case "loading":
    case "failed":
      return feed;
    case "board": {
      const { board } = feed;
      const { stream } = board;
      if (stream.kind === "halted") return { kind: "halted", board, fault: stream.fault };
      if (feed.connection === "lost") {
        return { kind: "stale", board, reason: { kind: "disconnected" } };
      }
      if (stream.kind === "gap") {
        return {
          kind: "stale",
          board,
          reason: { kind: "gap", expected: stream.expected, through: stream.through },
        };
      }
      return feed.recovered ? { kind: "recovered", board } : { kind: "live", board };
    }
    default:
      return unreachable(feed);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled board feed: ${JSON.stringify(value)}`);
};
