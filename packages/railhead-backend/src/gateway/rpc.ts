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
import {
  isBoardErrorCode,
  type ActionChallenge,
  type BoardApi,
  type BoardListener,
  type BoardResult,
  type BoardSubscription,
  type CheckDetail,
  type DemoSeedAction,
  type DemoSeedApi,
  type DemoSeedResult,
  type DemoSeedState,
  type EnrollmentChallenge,
  type EventPage,
  type OwnerAction,
  type OwnerActionResult,
  type OwnerApi,
  type OwnerEnrollmentApi,
  type PasskeyAssertion,
  type PasskeyRegistration,
  type PendingJoin,
  type SubscriptionEnd,
} from "@railhead/shared/board-api";
import type { CheckRunId, RailheadEvent, UserId } from "@railhead/shared/events";
import type { PortResult } from "../contracts/result";
import { parseEvent } from "../contracts/wireShape";
import { demoSeedPort, type DemoSeedPort } from "../modules/demoSeed/entry";
import { ownerEnrollment, type OwnerEnrollmentPort } from "../modules/owner/entry";
import {
  DELIVERY_TIMEOUT_MS,
  release,
  type StreamListener,
  type StreamSubscription,
} from "../modules/stream/entry";
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

  async demoSeed(): Promise<DemoSeedApi> {
    return new DemoSeedApiImpl(demoSeedPort(this.#env));
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

  async readEvents(
    cursor: number,
    limit: number,
    history?: string,
  ): Promise<BoardResult<EventPage>> {
    const result = await this.#repo.readEvents(cursor, limit, history ?? null);
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
        history: page.history,
      },
    };
  }

  async subscribe(
    cursor: number,
    listener: RpcStub<BoardListener>,
    history?: string,
  ): Promise<BoardResult<BoardSubscription>> {
    // The listener stub is released when this call returns unless it is kept, so the bridge keeps
    // its own duplicate and releases it when the subscription ends.
    const bridge = new ListenerBridge(listener.dup());
    const result = await this.#repo.subscribe(cursor, bridge, history ?? null);
    if (!result.ok) {
      bridge.end();
      return toBoard(result);
    }
    return { ok: true, value: new SubscriptionImpl(result.value, bridge) };
  }

  async pendingJoins(): Promise<BoardResult<PendingJoin[]>> {
    return toBoard(await this.#repo.pendingJoins());
  }

  async checkDetail(checkRunId: CheckRunId): Promise<BoardResult<CheckDetail>> {
    return toBoard(await this.#repo.checkDetail(checkRunId));
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

/** The owner's seed and reset of the demo repository. */
@validateRpc<DemoSeedApi>()
class DemoSeedApiImpl extends RpcTarget implements DemoSeedApi {
  readonly #port: DemoSeedPort;

  constructor(port: DemoSeedPort) {
    super();
    this.#port = port;
  }

  async read(): Promise<BoardResult<DemoSeedState | null>> {
    return toBoard(await this.#port.read());
  }

  async prepare(action: DemoSeedAction): Promise<BoardResult<ActionChallenge>> {
    return toBoard(await this.#port.prepare(action));
  }

  async perform(
    challengeId: string,
    assertion: PasskeyAssertion,
    bundle: Uint8Array | null,
  ): Promise<BoardResult<DemoSeedResult>> {
    return toBoard(await this.#port.perform(challengeId, assertion, bundle));
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

/**
 * Carries a board listener across the Worker's RPC boundary into the Repo. It ends when the Repo
 * releases it or tells it the subscription ended, and ending cancels the board calls still in
 * flight, releases the board's listener and runs the subscription's cleanup.
 */
class ListenerBridge extends WorkersRpcTarget implements StreamListener {
  #listener: RpcStub<BoardListener> | null;
  // The board calls in flight. Disposing one cancels it on the board's session.
  readonly #calls = new Set<Disposable>();
  #ended = false;
  #onEnd: (() => void) | null = null;

  constructor(listener: RpcStub<BoardListener>) {
    super();
    this.#listener = listener;
  }

  async events(events: RailheadEvent[]): Promise<void> {
    await this.#call((listener) => listener.events(events));
  }

  async ended(reason: SubscriptionEnd): Promise<void> {
    // Nothing follows the ending, so a delivery still in flight is abandoned now.
    this.#cancelCalls();
    try {
      await this.#call((listener) => listener.ended(reason));
    } finally {
      this.end();
    }
  }

  /** Runs `callback` once the bridge ends, now if it already has. */
  onEnd(callback: () => void): void {
    if (this.#ended) callback();
    else this.#onEnd = callback;
  }

  /** Cancels the board calls in flight, releases the board's listener and runs `onEnd`, once. */
  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#cancelCalls();
    this.#listener?.[Symbol.dispose]();
    this.#listener = null;
    const onEnd = this.#onEnd;
    this.#onEnd = null;
    onEnd?.();
  }

  // The runtime calls this once the Repo releases every stub of the bridge, which it does whenever
  // the subscription ends, including the ends it tells nobody about.
  [Symbol.dispose](): void {
    this.end();
  }

  #cancelCalls(): void {
    const calls = [...this.#calls];
    this.#calls.clear();
    for (const call of calls) call[Symbol.dispose]();
  }

  // Sends one board call, settling when it does, when the bridge ends, or after the delivery
  // timeout, so a board that never answers holds the call no longer than the Repo waits for it.
  async #call(send: (listener: RpcStub<BoardListener>) => Promise<void> & Disposable) {
    if (this.#listener === null) throw new Error("the subscription has ended");
    const call = send(this.#listener);
    this.#calls.add(call);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("the board listener timed out")),
        DELIVERY_TIMEOUT_MS,
      );
    });
    try {
      await Promise.race([call, timedOut]);
    } finally {
      clearTimeout(timer);
      if (this.#calls.delete(call)) call[Symbol.dispose]();
    }
  }
}

/** A board subscription backed by the Repo's stream subscription. */
@validateRpc<BoardSubscription>()
class SubscriptionImpl extends RpcTarget implements BoardSubscription {
  // The Repo's handle, until the subscription ends however it ends. An ended subscription's stub
  // stays valid for the board but holds nothing in the Repo.
  #subscription: StreamSubscription | null;
  readonly #bridge: ListenerBridge;
  #cancelling: Promise<void> | null = null;

  constructor(subscription: StreamSubscription, bridge: ListenerBridge) {
    super();
    this.#subscription = subscription;
    this.#bridge = bridge;
    // The bridge may already have ended, before the Repo's `subscribe` returned.
    bridge.onEnd(() => this.#close());
  }

  async cancel(): Promise<void> {
    this.#cancelling ??= this.#cancelRepo().finally(() => {
      this.#cancelling = null;
      this.#bridge.end();
      this.#close();
    });
    await this.#cancelling;
  }

  // Disposing the board's stub ends the subscription: the listener is released, and releasing the
  // Repo's handle ends the Repo side now rather than at its next delivery.
  [Symbol.dispose](): void {
    this.#bridge.end();
    this.#close();
  }

  async #cancelRepo(): Promise<void> {
    await this.#subscription?.cancel();
  }

  // Releases the Repo's handle, unless a cancel on it is in flight: that cancel releases it when
  // it settles.
  #close(): void {
    if (this.#cancelling !== null) return;
    const subscription = this.#subscription;
    this.#subscription = null;
    if (subscription !== null) release(subscription);
  }
}

/** A port's result as a board result. */
export function toBoard<T>(result: PortResult<T>): BoardResult<T> {
  if (result.ok) return result;
  if (isBoardErrorCode(result.code)) {
    return { ok: false, code: result.code, message: result.message };
  }
  return { ok: false, code: "internal", message: "The backend failed." };
}
