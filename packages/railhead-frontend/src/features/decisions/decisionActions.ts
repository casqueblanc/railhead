// The human action the questions queue offers, as typed callbacks the page supplies.
//
// The queue never reaches the backend itself. The page that composes it passes either a callback
// that records a decision (through the owner's passkey action) or the reason it cannot, and the
// queue shows that reason beside every action it blocks.

import type { DecisionId } from "@railhead/shared/events";
import type { StreamStatus } from "../board/boardState";

/** Answer a decision for the first time, or replace its current answer. */
export interface RecordDecisionRequest {
  decisionId: DecisionId;
  /** The chosen option's key. */
  option: string;
  /** The version being replaced, or `null` for the first answer. A stale value must be refused. */
  expectedVersion: number | null;
}

/** What became of a request. `message` is shown to the person as plain text. */
export type RecordDecisionOutcome = { ok: true; version: number } | { ok: false; message: string };

/** Why the page cannot record decisions right now. */
export type DecisionsUnavailableReason =
  /** The connection to the backend is lost. */
  | "offline"
  /** The backend has no decisions module installed. */
  | "module_unavailable"
  /** This browser has no owner passkey for the repository. */
  | "no_passkey";

/** The page's decision action: available with its callback, or unavailable with a reason. */
export type DecisionActions =
  | {
      kind: "available";
      onRecordDecision: (request: RecordDecisionRequest) => Promise<RecordDecisionOutcome>;
    }
  | { kind: "unavailable"; reason: DecisionsUnavailableReason };

/** Why an answer cannot be recorded from this board, including a board that is not up to date. */
export type DecisionBlock =
  | { kind: "unavailable"; reason: DecisionsUnavailableReason }
  /** The board is missing events, so it may not show the current answer. */
  | { kind: "behind" }
  /** The board stopped reading the log. */
  | { kind: "halted" };

/** The action as one card sees it. */
export type DecisionCardAction =
  | {
      kind: "available";
      onRecordDecision: (request: RecordDecisionRequest) => Promise<RecordDecisionOutcome>;
    }
  | { kind: "blocked"; block: DecisionBlock };

/**
 * Resolves the page's action against the board's stream. A board with a gap or a halted fold may
 * not show the current answer, so recording from it is blocked even when the callback exists.
 */
export const cardAction = (actions: DecisionActions, stream: StreamStatus): DecisionCardAction => {
  switch (stream.kind) {
    case "halted":
      return { kind: "blocked", block: { kind: "halted" } };
    case "gap":
      return { kind: "blocked", block: { kind: "behind" } };
    case "consistent":
      break;
    default:
      return unreachable(stream);
  }
  switch (actions.kind) {
    case "available":
      return { kind: "available", onRecordDecision: actions.onRecordDecision };
    case "unavailable":
      return { kind: "blocked", block: { kind: "unavailable", reason: actions.reason } };
    default:
      return unreachable(actions);
  }
};

/** The sentence shown beside a blocked action. */
export const blockMessage = (block: DecisionBlock): string => {
  switch (block.kind) {
    case "behind":
      return "Answering is blocked while the board catches up with missing events.";
    case "halted":
      return "Answering is blocked because the board stopped reading the log. Reload the board.";
    case "unavailable":
      switch (block.reason) {
        case "offline":
          return "Answering is blocked while the board is offline. Reconnect to answer.";
        case "module_unavailable":
          return "Answering is unavailable: this Railhead has no decisions module installed.";
        case "no_passkey":
          return "Answering needs the owner's passkey, and this browser has none for the repository.";
        default:
          return unreachable(block.reason);
      }
    default:
      return unreachable(block);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled decision action variant: ${JSON.stringify(value)}`);
};
