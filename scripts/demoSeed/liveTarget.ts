// The live `SeedTarget` and `BoardIssues`: a deployed Railhead's `DemoSeedApi` (#149) and board, over
// one Cap'n Web session.
//
// Each write needs its own owner passkey assertion, and the command line has no passkey signer yet
// (#148). So a write runs in one of two ways, chosen by the `Approval` the target is built with:
// `prepare` asks the backend for the challenge bound to the action and stops with `ApprovalNeeded`,
// writing nothing; `signed` performs the action with an assertion the owner already made for such a
// challenge, once. The backend binds a challenge to its action, head included, so an assertion for
// another action or head is refused there, never here.
//
// Every backend call is bounded by a timeout. A write whose answer times out or is lost is not
// repeated here. The next seed reads the target first, so an uncertain seed is reconciled before
// anything is written a second time; a reset reads nothing first, so the owner inspects the
// instance before approving another.
//
// The types come from `@railhead/shared` by relative path and type only: `@railhead/shared` already
// depends on `@railhead/scripts`, and the workspace task graph refuses a cycle. The two runtime
// constants this file needs are restated below, and `liveTarget.test.ts` checks them against it.

import { newWebSocketRpcSession } from "capnweb";
import type { RepoSegment } from "../../packages/railhead-shared/src/agent-api.ts";
import type { RailheadApi } from "../../packages/railhead-shared/src/api.ts";
import type {
  ActionChallenge,
  BoardResult,
  DemoSeedAction,
  DemoSeedResult,
  DemoSeedState,
  EventPage,
  PasskeyAssertion,
} from "../../packages/railhead-shared/src/board-api.ts";
import type { MainBundle } from "./history.ts";
import { SeedRefusal } from "./manifest.ts";
import {
  ActionStale,
  demoRef,
  type BoardIssue,
  type BoardIssues,
  type RepoRef,
  type RepoState,
  type SeedTarget,
} from "./reconcile.ts";

/** Where the backend serves the Cap'n Web session; restates `@railhead/shared`'s `API_PATH`. */
export const API_PATH = "/api";

/** The largest page `readEvents` returns; restates `@railhead/shared`'s `MAX_EVENT_PAGE`. */
export const MAX_EVENT_PAGE = 256;

/** How long one read may take before the run gives up. */
const READ_TIMEOUT_MS = 30_000;
/** How long one write may take, bundle upload included. */
const WRITE_TIMEOUT_MS = 120_000;
/** The most event pages an issue read pages through: about a quarter of a million events. */
const MAX_EVENT_PAGES = 1024;

/** The demo seed's capability, after `DemoSeedApi`. */
export interface DemoSeedSession extends Disposable {
  read(): PromiseLike<BoardResult<DemoSeedState | null>>;
  prepare(action: DemoSeedAction): PromiseLike<BoardResult<ActionChallenge>>;
  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
    bundle: Uint8Array | null,
  ): PromiseLike<BoardResult<DemoSeedResult>>;
}

/** Read access to one repository's log, after `BoardApi`. */
export interface BoardLogSession extends Disposable {
  readEvents(cursor: number, limit: number, history?: string): PromiseLike<BoardResult<EventPage>>;
}

/**
 * The parts of `RailheadApi` the live target calls. `openLiveSession` returns the real stub as one
 * without a cast, so the compiler checks this stays a subset of `@railhead/shared`.
 */
export interface LiveSession extends Disposable {
  demoSeed(): PromiseLike<DemoSeedSession>;
  openBoard(org: RepoSegment, repo: RepoSegment): PromiseLike<BoardResult<BoardLogSession>>;
}

/** How the target approves its one write. */
export type Approval =
  /** Ask for the challenge and stop: nothing can sign it yet (#148). */
  | { readonly kind: "prepare" }
  /** Perform the action with an assertion the owner made for challenge `challengeId`. */
  | {
      readonly kind: "signed";
      readonly challengeId: string;
      readonly assertion: PasskeyAssertion;
    };

/** The target stopped after `prepare`: the action needs this challenge signed with the owner passkey. */
export class ApprovalNeeded extends Error {
  override readonly name = "ApprovalNeeded";
  /** The action the challenge is bound to. */
  readonly action: DemoSeedAction;
  /** The challenge to sign. */
  readonly challenge: ActionChallenge;

  constructor(action: DemoSeedAction, challenge: ActionChallenge) {
    super(`${action.kind} needs the owner passkey to sign challenge ${challenge.challengeId}.`);
    this.action = action;
    this.challenge = challenge;
  }
}

/**
 * The backend failed or did not answer, so a write may or may not have happened. Its message is the
 * backend's own sentence or the timeout, never a stack.
 */
export class BackendFailure extends Error {
  override readonly name = "BackendFailure";
}

/**
 * The WebSocket URL of the RPC session on `origin`, an `https:` origin, or `http:` on the local dev
 * server. Anything else is refused: the owner's assertion and the bundle must not cross plain text
 * to another host.
 */
export function liveApiUrl(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    throw new SeedRefusal(`${JSON.stringify(origin)} is not a URL.`, { cause: error });
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const scheme =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" && local ? "ws:" : "";
  if (scheme === "" || url.username !== "" || url.password !== "") {
    throw new SeedRefusal(
      `--target must be an https origin, or http on localhost; refusing ${JSON.stringify(origin)}.`,
    );
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw new SeedRefusal(`--target must be an origin alone; refusing ${JSON.stringify(origin)}.`);
  }
  return `${scheme}//${url.host}${API_PATH}`;
}

/** Opens a Cap'n Web session with the backend at `origin`. The caller disposes it. */
export function openLiveSession(origin: string): LiveSession {
  return newWebSocketRpcSession<RailheadApi>(liveApiUrl(origin));
}

/**
 * The approval in `value`, the JSON an owner's signer writes: `{ challengeId, assertion }`, the
 * assertion's binary fields base64url without padding.
 */
export function parseSignedApproval(value: unknown): Approval {
  if (!isRecord(value) || !isRecord(value.assertion)) {
    throw new SeedRefusal("The assertion file must hold { challengeId, assertion }.");
  }
  const { challengeId, assertion } = value;
  // The backend checks the id itself; this only keeps a mangled file from reaching it.
  if (typeof challengeId !== "string" || !CHALLENGE_ID.test(challengeId)) {
    throw new SeedRefusal("The assertion file's challengeId is not a challenge id.");
  }
  const { credentialId, clientDataJson, authenticatorData, signature, userHandle } = assertion;
  if (
    !isBase64Url(credentialId) ||
    !isBase64Url(clientDataJson) ||
    !isBase64Url(authenticatorData) ||
    !isBase64Url(signature)
  ) {
    throw new SeedRefusal(
      "The assertion file's credentialId, clientDataJson, authenticatorData and signature must be base64url.",
    );
  }
  if (userHandle !== null && !isBase64Url(userHandle)) {
    throw new SeedRefusal("The assertion file's userHandle must be base64url or null.");
  }
  return {
    kind: "signed",
    challengeId,
    assertion: { credentialId, clientDataJson, authenticatorData, signature, userHandle },
  };
}

/** The demo repository on a live backend. It writes at most once, with the approval it holds. */
export class LiveTarget implements SeedTarget, BoardIssues {
  readonly #session: LiveSession;
  #approval: Approval | null;

  constructor(session: LiveSession, approval: Approval) {
    this.#session = session;
    this.#approval = approval;
  }

  async read(ref: RepoRef): Promise<RepoState | null> {
    demoRef(ref);
    using demo = await within(this.#session.demoSeed(), READ_TIMEOUT_MS, "demoSeed");
    const state = valueOf(await within(demo.read(), READ_TIMEOUT_MS, "demoSeed.read"), "read");
    return state === null ? null : { main: state.main };
  }

  async seed(ref: RepoRef, bundle: MainBundle): Promise<void> {
    demoRef(ref);
    const result = await this.#write({ kind: "demo.seed", head: bundle.head }, bundle.bytes);
    if (result.kind !== "demo.seed" || result.head !== bundle.head) {
      throw new Error(`The backend answered the seed of ${bundle.head} with another result.`);
    }
  }

  async reset(ref: RepoRef): Promise<boolean> {
    demoRef(ref);
    const result = await this.#write({ kind: "demo.reset" }, null);
    if (result.kind !== "demo.reset") {
      throw new Error("The backend answered the reset with another result.");
    }
    return result.deleted;
  }

  /** The repository's filed issues in log order, paging the log from its start. */
  async issues(ref: RepoRef): Promise<readonly BoardIssue[]> {
    const { org, repo } = demoRef(ref);
    const opened = await within(this.#session.openBoard(org, repo), READ_TIMEOUT_MS, "openBoard");
    if (!opened.ok && opened.code === "not_found") return [];
    using board = valueOf(opened, "openBoard");
    const filed: BoardIssue[] = [];
    let cursor = 0;
    let history: string | undefined;
    for (let pages = 0; pages < MAX_EVENT_PAGES; pages += 1) {
      const read = board.readEvents(
        cursor,
        MAX_EVENT_PAGE,
        ...(history === undefined ? [] : [history]),
      );
      const page = valueOf(await within(read, READ_TIMEOUT_MS, "readEvents"), "readEvents");
      history = page.history;
      for (const event of page.events) {
        if (event.type === "issue.filed") {
          filed.push({ title: event.data.title, body: event.data.body });
        }
      }
      if (page.cursor >= page.head) return filed;
      if (page.cursor <= cursor) {
        throw new Error(`The log stopped at ${page.cursor} before its head ${page.head}.`);
      }
      cursor = page.cursor;
    }
    throw new Error(`The log is longer than ${MAX_EVENT_PAGES} pages.`);
  }

  /** Performs `action` with the held approval, which is spent whether or not the call succeeds. */
  async #write(action: DemoSeedAction, bundle: Uint8Array | null): Promise<DemoSeedResult> {
    const approval = this.#approval;
    this.#approval = null;
    if (approval === null) {
      throw new SeedRefusal(`${action.kind} needs another owner passkey assertion.`);
    }
    using demo = await within(this.#session.demoSeed(), READ_TIMEOUT_MS, "demoSeed");
    switch (approval.kind) {
      case "prepare": {
        const prepared = await within(demo.prepare(action), READ_TIMEOUT_MS, "demoSeed.prepare");
        throw new ApprovalNeeded(action, valueOf(prepared, "prepare"));
      }
      case "signed": {
        const { challengeId, assertion } = approval;
        const performed = demo.perform(challengeId, assertion, bundle);
        return valueOf(await within(performed, WRITE_TIMEOUT_MS, "demoSeed.perform"), action.kind);
      }
      default:
        return unreachable(approval);
    }
  }
}

/**
 * The value of a board call, or the error its failure maps to: `action_stale` is `ActionStale`, the
 * reconciler's refusal; a refused request or proof is a `SeedRefusal` with the backend's sentence;
 * anything else is a `BackendFailure`.
 */
function valueOf<T>(result: BoardResult<T>, call: string): T {
  if (result.ok) return result.value;
  const message = `${call} failed with ${result.code}: ${result.message}`;
  switch (result.code) {
    case "action_stale":
      throw new ActionStale(message);
    case "invalid_request":
    case "proof_invalid":
    case "proof_expired":
    case "bootstrap_closed":
    case "quota_exceeded":
    case "not_found":
    case "cursor_ahead":
      throw new SeedRefusal(message);
    case "busy":
    case "unavailable":
    case "internal":
      throw new BackendFailure(message);
    default:
      return unreachable(result.code);
  }
}

/**
 * `promise`, or a `BackendFailure` when the session fails, such as a refused connection, or once
 * `ms` pass. The call is not cancelled; the caller disposes the session.
 */
async function within<T>(promise: PromiseLike<T>, ms: number, call: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new BackendFailure(`${call} did not answer within ${ms} ms.`)),
      ms,
    );
  });
  const answered = Promise.resolve(promise).catch((error: unknown) => {
    const reason = error instanceof Error ? error.message : "the session failed";
    throw new BackendFailure(`${call} failed: ${reason}`, { cause: error });
  });
  try {
    return await Promise.race([answered, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const BASE64URL = /^[A-Za-z0-9_-]{1,8192}$/;
const CHALLENGE_ID = /^[\x21-\x7e]{1,1024}$/;

function isBase64Url(value: unknown): value is string {
  return typeof value === "string" && BASE64URL.test(value);
}

function unreachable(value: never): never {
  throw new Error(`Unhandled ${JSON.stringify(value)}`);
}
