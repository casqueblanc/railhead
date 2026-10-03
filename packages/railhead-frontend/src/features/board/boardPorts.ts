// The ports the board page is composed from.
//
// The page never holds an RPC stub. One binding (`liveConnection.ts`) owns the session and hands the
// page plain data and plain callbacks; a test or a replay hands it fixture data the same way. Each
// leaf feature gets only the ports its slot names, and a feature whose module is not installed, in
// the browser or on the backend, renders an explicit unavailable state instead of a guess.

import type { ComponentType } from "react";
import type {
  ActionChallenge,
  BoardResult,
  EnrollmentChallenge,
  OwnerAction,
  OwnerActionResult,
  PasskeyAssertion,
  PasskeyRegistration,
} from "@railhead/shared/board-api";
import type { UserId } from "@railhead/shared/events";
import type { ConnectionStatus } from "../../rpc/useApiConnection";
import type { BoardFeed } from "../claims/boardFeed";
import type { DecisionActions } from "../decisions/decisionActions";

/** The board's read port: the folded log, or why this Railhead cannot serve one. */
export type BoardRead =
  | { kind: "available"; feed: BoardFeed }
  /** The backend answers but serves no board for this repository. */
  | { kind: "unavailable" };

/** Why the owner's passkey actions cannot be requested right now. */
export type OwnerUnavailableReason =
  /** The connection to the backend is lost. */
  | "offline"
  /** The backend has no module serving owner actions. */
  | "module_unavailable";

/**
 * The owner's passkey actions as plain callbacks. Each action is prepared, signed by the browser's
 * authenticator and performed once; the port never performs an action without an assertion.
 */
export type OwnerPort =
  | {
      kind: "available";
      /** Asks for a challenge bound to `action`. */
      onPrepareAction: (action: OwnerAction) => Promise<BoardResult<ActionChallenge>>;
      /** Performs the action the challenge names, if the assertion verifies for it. */
      onPerformAction: (
        challengeId: string,
        assertion: PasskeyAssertion,
      ) => Promise<BoardResult<OwnerActionResult>>;
    }
  | { kind: "unavailable"; reason: OwnerUnavailableReason };

/**
 * The instance owner's passkey enrollment as plain callbacks, after `OwnerEnrollmentApi`. The
 * backend keeps it open only until the first enrollment succeeds.
 */
export type EnrollmentPort =
  | {
      kind: "available";
      /** Asks for a registration challenge with the operator's one-time bootstrap token. */
      onPrepareEnrollment: (bootstrapToken: string) => Promise<BoardResult<EnrollmentChallenge>>;
      /** Enrolls the authenticator's registration for the challenge, and closes enrollment. */
      onCompleteEnrollment: (
        challengeId: string,
        registration: PasskeyRegistration,
      ) => Promise<BoardResult<{ ownerId: UserId }>>;
    }
  | { kind: "unavailable"; reason: OwnerUnavailableReason };

/** Everything the board page is composed from. */
export interface BoardPorts {
  /** Whether the one backend session answers. */
  connection: ConnectionStatus;
  /** Replaces a lost session. */
  onReconnect: () => void;
  board: BoardRead;
  decisions: DecisionActions;
  owner: OwnerPort;
  enrollment: EnrollmentPort;
}

/** What every leaf slot receives: the board it renders from. */
export interface BoardSlotProps {
  feed: BoardFeed;
}

/** What a slot that performs owner actions receives. */
export interface OwnerSlotProps extends BoardSlotProps {
  owner: OwnerPort;
  enrollment: EnrollmentPort;
}

/**
 * A feature's fixed entry point. The page renders `Component` in the feature's slot, or an
 * unavailable state while the feature has none.
 */
export type FeatureEntry<Props> =
  | { kind: "available"; Component: ComponentType<Props> }
  | { kind: "unavailable" };

/**
 * Shows a lost session in the feed the sections render from. A retained board becomes stale with a
 * Reconnect control, and a board still loading becomes failed with a retry, since neither can
 * progress until the session is replaced.
 */
const feedOnLostSession = (feed: BoardFeed): BoardFeed => {
  switch (feed.kind) {
    case "loading":
      return { kind: "failed" };
    case "failed":
      return feed;
    case "board":
      return feed.connection === "lost" ? feed : { ...feed, connection: "lost" };
    default:
      return unreachable(feed);
  }
};

/**
 * Withdraws the actions while the session or the board's feed is lost, whatever the binding last
 * reported, so nothing offers to act on a board that cannot reach the backend. An action that is
 * already unavailable keeps its own reason. A lost session also marks the feed lost, so every
 * section says the board is stale and offers to reconnect.
 */
export const gateOnConnection = (ports: BoardPorts): BoardPorts => {
  const feedLost =
    ports.board.kind === "available" &&
    ports.board.feed.kind === "board" &&
    ports.board.feed.connection === "lost";
  if (ports.connection !== "lost" && !feedLost) return ports;
  return {
    ...ports,
    board:
      ports.connection === "lost" && ports.board.kind === "available"
        ? { kind: "available", feed: feedOnLostSession(ports.board.feed) }
        : ports.board,
    decisions:
      ports.decisions.kind === "available"
        ? { kind: "unavailable", reason: "offline" }
        : ports.decisions,
    owner:
      ports.owner.kind === "available" ? { kind: "unavailable", reason: "offline" } : ports.owner,
    enrollment:
      ports.enrollment.kind === "available"
        ? { kind: "unavailable", reason: "offline" }
        : ports.enrollment,
  };
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled board feed: ${JSON.stringify(value)}`);
};
