// The board's Cap'n Web capabilities, served over the session at `API_PATH`.
//
// The root object grants nothing by itself: `openBoard` returns read access to one repository and
// the entry point to its owner's passkey actions, and each method forwards to that repository's
// `Repo` over the private binding. No method takes an actor or an event. A module's refusal becomes
// the board failure with the same code; a code the board does not define becomes `internal`.
//
// None of these objects holds state beyond the repository it names, so nothing is lost when the
// Repo is evicted or hibernates: the next call reaches a Repo rebuilt from storage, and a board
// resumes from the cursor it persisted.

import { RpcTarget, type RpcStub } from "capnweb";
import { RpcTarget as WorkersRpcTarget } from "cloudflare:workers";
import { validateRpc } from "capnweb-validate";
import { isRepoSegment, type RepoSegment } from "@railhead/shared/agent-api";
import type { RailheadApi } from "@railhead/shared/api";
import type {
  ActionChallenge,
  BoardApi,
  BoardErrorCode,
  BoardListener,
  BoardResult,
  BoardSubscription,
  EnrollmentChallenge,
  EventPage,
  OwnerAction,
  OwnerActionResult,
  OwnerApi,
  OwnerEnrollmentApi,
  PasskeyAssertion,
  PasskeyRegistration,
  PendingJoin,
  SubscriptionEnd,
} from "@railhead/shared/board-api";
import type { RailheadEvent, UserId } from "@railhead/shared/events";
import type { PortResult } from "../contracts/result";
import { parseEvent } from "../contracts/wireShape";
import { ownerEnrollment, type OwnerEnrollmentPort } from "../modules/owner/entry";
import type { StreamListener, StreamSubscription } from "../modules/stream/entry";
import { repoObjectName, type Repo } from "../repo/RepoObject";

type RepoStub = DurableObjectStub<Repo>;

/** The root of every RPC session. */
@validateRpc<RailheadApi>()
export class RailheadApiImpl extends RpcTarget implements RailheadApi {
  readonly #env: Env;

  constructor(env: Env) {
    super();
    this.#env = env;
  }

  async ping(): Promise<void> {}

  async openBoard(org: RepoSegment, repo: RepoSegment): Promise<BoardResult<BoardApi>> {
    if (!isRepoSegment(org) || !isRepoSegment(repo)) {
      return { ok: false, code: "invalid_request", message: "Not a repository name." };
    }
    const stub = this.#env.REPO.getByName(repoObjectName(org, repo));
    if ((await stub.describe()) === null) {
      return { ok: false, code: "not_found", message: "No such repository." };
    }
    return { ok: true, value: new BoardApiImpl(stub) };
  }

  async ownerEnrollment(): Promise<OwnerEnrollmentApi> {
    return new OwnerEnrollmentApiImpl(ownerEnrollment(this.#env));
  }
}

/** Read access to one repository's log, and the entry point for its owner's actions. */
@validateRpc<BoardApi>()
class BoardApiImpl extends RpcTarget implements BoardApi {
  readonly #repo: RepoStub;

  constructor(repo: RepoStub) {
    super();
    this.#repo = repo;
  }

  async readEvents(cursor: number, limit: number): Promise<BoardResult<EventPage>> {
    const result = await this.#repo.readEvents(cursor, limit);
    if (!result.ok) return toBoard(result);
    // Workers RPC widens tuple types in transit, so each event's shape is established again.
    const page = result.value;
    return {
      ok: true,
      value: {
        repo: page.repo,
        events: page.events.map(parseEvent),
        cursor: page.cursor,
        head: page.head,
      },
    };
  }

  async subscribe(
    cursor: number,
    listener: RpcStub<BoardListener>,
  ): Promise<BoardResult<BoardSubscription>> {
    // The listener stub is released when this call returns unless it is kept, so the bridge keeps
    // its own duplicate and releases it when the subscription ends.
    const bridge = new ListenerBridge(listener.dup());
    const result = await this.#repo.subscribe(cursor, bridge);
    if (!result.ok) {
      bridge.release();
      return toBoard(result);
    }
    return { ok: true, value: new SubscriptionImpl(result.value, bridge) };
  }

  async pendingJoins(): Promise<BoardResult<PendingJoin[]>> {
    return toBoard(await this.#repo.pendingJoins());
  }

  async owner(): Promise<OwnerApi> {
    return new OwnerApiImpl(this.#repo);
  }
}

/** The owner's passkey actions on one repository. */
@validateRpc<OwnerApi>()
class OwnerApiImpl extends RpcTarget implements OwnerApi {
  readonly #repo: RepoStub;

  constructor(repo: RepoStub) {
    super();
    this.#repo = repo;
  }

  async prepare(action: OwnerAction): Promise<BoardResult<ActionChallenge>> {
    return toBoard(await this.#repo.prepareOwnerAction(action));
  }

  async perform(
    challengeId: string,
    assertion: PasskeyAssertion,
  ): Promise<BoardResult<OwnerActionResult>> {
    return toBoard(await this.#repo.performOwnerAction(challengeId, assertion));
  }
}

/** The instance owner's passkey enrollment. */
@validateRpc<OwnerEnrollmentApi>()
class OwnerEnrollmentApiImpl extends RpcTarget implements OwnerEnrollmentApi {
  readonly #port: OwnerEnrollmentPort;

  constructor(port: OwnerEnrollmentPort) {
    super();
    this.#port = port;
  }

  async prepare(bootstrapToken: string): Promise<BoardResult<EnrollmentChallenge>> {
    return toBoard(await this.#port.prepare(bootstrapToken));
  }

  async complete(
    challengeId: string,
    registration: PasskeyRegistration,
  ): Promise<BoardResult<{ ownerId: UserId }>> {
    return toBoard(await this.#port.complete(challengeId, registration));
  }
}

/** Carries a board listener across the Worker's RPC boundary into the Repo. */
class ListenerBridge extends WorkersRpcTarget implements StreamListener {
  #listener: RpcStub<BoardListener> | null;

  constructor(listener: RpcStub<BoardListener>) {
    super();
    this.#listener = listener;
  }

  async events(events: RailheadEvent[]): Promise<void> {
    await this.#live().events(events);
  }

  async ended(reason: SubscriptionEnd): Promise<void> {
    try {
      await this.#live().ended(reason);
    } finally {
      this.release();
    }
  }

  /** Releases the board's listener stub. */
  release(): void {
    this.#listener?.[Symbol.dispose]();
    this.#listener = null;
  }

  #live(): RpcStub<BoardListener> {
    if (this.#listener === null) throw new Error("the subscription has ended");
    return this.#listener;
  }
}

/** A board subscription backed by the Repo's stream subscription. */
@validateRpc<BoardSubscription>()
class SubscriptionImpl extends RpcTarget implements BoardSubscription {
  readonly #subscription: StreamSubscription;
  readonly #bridge: ListenerBridge;

  constructor(subscription: StreamSubscription, bridge: ListenerBridge) {
    super();
    this.#subscription = subscription;
    this.#bridge = bridge;
  }

  async cancel(): Promise<void> {
    try {
      await this.#subscription.cancel();
    } finally {
      this.#bridge.release();
      dispose(this.#subscription);
    }
  }

  // Disposing the board's stub ends the subscription: the Repo side is cancelled now rather than
  // at its next delivery, and the listener is released.
  [Symbol.dispose](): void {
    this.#subscription
      .cancel()
      .catch((error: unknown) => {
        // Only the error's name: its message may carry data from the Repo.
        console.error(
          "stream subscription cancel failed",
          error instanceof Error ? error.name : "unknown",
        );
      })
      .finally(() => dispose(this.#subscription));
    this.#bridge.release();
  }
}

function dispose(value: object): void {
  const fn: unknown = Reflect.get(value, Symbol.dispose);
  if (typeof fn === "function") fn.call(value);
}

const BOARD_ERROR_CODES = {
  invalid_request: true,
  not_found: true,
  cursor_ahead: true,
  proof_invalid: true,
  proof_expired: true,
  action_stale: true,
  bootstrap_closed: true,
  quota_exceeded: true,
  unavailable: true,
  internal: true,
} as const satisfies Record<BoardErrorCode, true>;

function isBoardErrorCode(code: string): code is BoardErrorCode {
  return Object.hasOwn(BOARD_ERROR_CODES, code);
}

/** A port's result as a board result. */
export function toBoard<T>(result: PortResult<T>): BoardResult<T> {
  if (result.ok) return result;
  if (isBoardErrorCode(result.code)) {
    return { ok: false, code: result.code, message: result.message };
  }
  return { ok: false, code: "internal", message: "The backend failed." };
}
