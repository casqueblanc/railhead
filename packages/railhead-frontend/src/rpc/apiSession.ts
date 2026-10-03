import { newWebSocketRpcSession } from "capnweb";
import { API_PATH, type RailheadApi } from "@railhead/shared/api";
import type { RepoSegment } from "@railhead/shared/agent-api";
import type {
  ActionChallenge,
  BoardListener,
  BoardResult,
  EnrollmentChallenge,
  EventPage,
  OwnerAction,
  OwnerActionResult,
  PasskeyAssertion,
  PasskeyRegistration,
} from "@railhead/shared/board-api";
import type { UserId } from "@railhead/shared/events";

// The parts of the backend's capabilities the board calls, as the Cap'n Web stub of `RailheadApi`
// presents them. `openApiSession` returns the real stub as an `ApiSession` without a cast, so the
// compiler checks that these stay a subset of `@railhead/shared`'s interfaces; tests implement
// them with fakes. Every capability is disposable, and its holder disposes it.

/** A live subscription. Disposing it ends the subscription. */
export interface SubscriptionSession extends Disposable {
  cancel(): PromiseLike<unknown>;
}

/** The owner's passkey actions on one repository, after `OwnerApi`. */
export interface OwnerSession extends Disposable {
  prepare(action: OwnerAction): PromiseLike<BoardResult<ActionChallenge>>;
  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
  ): PromiseLike<BoardResult<OwnerActionResult>>;
}

/** The instance owner's passkey enrollment, after `OwnerEnrollmentApi`. */
export interface EnrollmentSession extends Disposable {
  prepare(bootstrapToken: string): PromiseLike<BoardResult<EnrollmentChallenge>>;
  complete(
    challengeId: string,
    registration: PasskeyRegistration,
  ): PromiseLike<BoardResult<{ ownerId: UserId }>>;
}

/** Read access to one repository's log, after `BoardApi`. */
export interface BoardSession extends Disposable {
  readEvents(cursor: number, limit: number, history?: string): PromiseLike<BoardResult<EventPage>>;
  subscribe(
    cursor: number,
    listener: BoardListener,
    history?: string,
  ): PromiseLike<BoardResult<SubscriptionSession>>;
  owner(): PromiseLike<OwnerSession>;
}

/** One RPC session with the backend, after `RailheadApi`. */
export interface ApiSession extends Disposable {
  /** Resolves once the backend has answered over this session. */
  ping(): PromiseLike<unknown>;
  /** Registers a callback for the session failing, now or later. */
  onRpcBroken(callback: (error: unknown) => void): void;
  openBoard(org: RepoSegment, repo: RepoSegment): PromiseLike<BoardResult<BoardSession>>;
  ownerEnrollment(): PromiseLike<EnrollmentSession>;
}

/** A repository the board can open. */
export interface BoardRepo {
  org: RepoSegment;
  repo: RepoSegment;
}

/**
 * The repository the board at `/` opens. The demo seed tooling (#59) must create exactly this
 * repository; until it exists, the backend answers `not_found` and the board says it has none.
 */
export const DEFAULT_BOARD_REPO: BoardRepo = { org: "demo", repo: "upload-app" };

/** WebSocket URL of the backend's RPC session on the origin that served `location`. */
export const apiUrl = (location: Pick<Location, "protocol" | "host">): string =>
  `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${API_PATH}`;

/** Opens an RPC session with the backend. The caller owns the returned stub and must dispose it. */
export const openApiSession = (): ApiSession =>
  newWebSocketRpcSession<RailheadApi>(apiUrl(window.location));
