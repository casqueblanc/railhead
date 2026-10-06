// The live `SeedTarget` and `BoardIssues`: a deployed Railhead's `DemoSeedApi` (#149) and board, over
// one Cap'n Web session.
//
// Each write needs its own owner passkey assertion, which the target never makes itself. So a write
// runs in one of two ways, chosen by the `Approval` the target is built with: `prepare` asks the
// backend for the challenge bound to the action and stops with `ApprovalNeeded`, writing nothing;
// `signed` performs the action with an assertion the owner already made for such a challenge, once.
// The backend binds a challenge to its action, head included, so an assertion for another action or
// head is refused there, never here.
//
// Every backend call is bounded by a timeout. A write is not repeated here when its answer times
// out, is lost, or is anything but a success or a refusal the backend makes before acting
// (`PRE_ACTION_REFUSALS`): a reset that fails after deleting some forks answers `internal`. Each
// fails with `WriteUncertain`. The next seed reads the target first, so an uncertain seed is
// reconciled before anything is written a second time; a reset reads nothing first, so the owner
// inspects the instance before approving another.
//
// The board has no issue query, so `scan` replays the log from its start. It keeps only the
// issues whose titles the caller asks for and stops with an incomplete plan past
// `MAX_EVENT_PAGES` pages or `LiveLimits.scanMs`, so a long log cannot hold an operator's run for
// hours or fill its memory.
//
// The types come from `@railhead/shared` by relative path and type only: `@railhead/shared` already
// depends on `@railhead/scripts`, and the workspace task graph refuses a cycle. The two runtime
// constants this file needs are restated below, and `liveTarget.test.ts` checks them against it.

import { newWebSocketRpcSession } from "capnweb";
import type { RepoSegment } from "../../packages/railhead-shared/src/agent-api.ts";
import type { RailheadApi } from "../../packages/railhead-shared/src/api.ts";
import type {
  ActionChallenge,
  BoardErrorCode,
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
  type BoardScan,
  type RepoRef,
  type RepoState,
  type SeedTarget,
} from "./reconcile.ts";

/** Where the backend serves the Cap'n Web session; restates `@railhead/shared`'s `API_PATH`. */
export const API_PATH = "/api";

/** The largest page `readEvents` returns; restates `@railhead/shared`'s `MAX_EVENT_PAGE`. */
export const MAX_EVENT_PAGE = 256;

/** The most event pages an issue read pages through: 16,384 events. */
export const MAX_EVENT_PAGES = 64;

/** How long the live target waits; tests shorten them. */
export interface LiveLimits {
  /** How long one read may take before the run gives up. */
  readonly readMs: number;
  /** How long one write may take, bundle upload included. */
  readonly writeMs: number;
  /** How long reading the whole board log may take. */
  readonly scanMs: number;
  /** The clock `scanMs` is measured on, in milliseconds. */
  readonly now: () => number;
}

/** The limits a run uses. */
export const LIVE_LIMITS: LiveLimits = {
  readMs: 30_000,
  writeMs: 120_000,
  scanMs: 60_000,
  now: Date.now,
};

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
  /** Ask for the challenge and stop, for the owner to sign it. */
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
 * A write was sent and its answer timed out, was lost, was a failure the backend may have answered
 * after acting, or was not the action's result, so it may have happened, in part or whole. It is
 * never repeated here; what the owner does next depends on the action.
 */
export class WriteUncertain extends Error {
  override readonly name = "WriteUncertain";
  /** The action that may have happened. */
  readonly action: DemoSeedAction;

  constructor(action: DemoSeedAction, failure: BackendFailure) {
    super(failure.message, { cause: failure });
    this.action = action;
  }
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
  readonly #limits: LiveLimits;
  #approval: Approval | null;
  /** Whether this target's last `read` found the repository initialized. */
  #readFound = false;

  constructor(session: LiveSession, approval: Approval, limits: LiveLimits = LIVE_LIMITS) {
    this.#session = session;
    this.#approval = approval;
    this.#limits = limits;
  }

  async read(ref: RepoRef): Promise<RepoState | null> {
    demoRef(ref);
    const { readMs } = this.#limits;
    using demo = await within(this.#session.demoSeed(), readMs, "demoSeed");
    const state = valueOf(await within(demo.read(), readMs, "demoSeed.read"), "read");
    this.#readFound = state !== null;
    return state === null ? null : { main: state.main };
  }

  async seed(ref: RepoRef, bundle: MainBundle): Promise<void> {
    demoRef(ref);
    const action: DemoSeedAction = { kind: "demo.seed", head: bundle.head };
    const result = await this.#write(action, bundle.bytes);
    if (result.kind !== "demo.seed" || result.head !== bundle.head) {
      throw new WriteUncertain(
        action,
        new BackendFailure(`The backend answered the seed of ${bundle.head} with another result.`),
      );
    }
  }

  async reset(ref: RepoRef): Promise<boolean> {
    demoRef(ref);
    const action: DemoSeedAction = { kind: "demo.reset" };
    const result = await this.#write(action, null);
    if (result.kind !== "demo.reset") {
      throw new WriteUncertain(
        action,
        new BackendFailure("The backend answered the reset with another result."),
      );
    }
    return result.deleted;
  }

  /**
   * The repository's filed issues titled one of `titles`, in log order, paging the log from its
   * start, and the history they were read from. Other issues are dropped as each page arrives. Every
   * page after the first names the first page's history, so a reset during the scan is refused, not
   * mixed into the result. A repository the board does not find has none, unless this target's
   * `read` found it: then it changed during planning, such as a concurrent reset, and an empty list
   * would report a seed done that is not.
   */
  async scan(ref: RepoRef, titles: ReadonlySet<string>): Promise<BoardScan> {
    const { org, repo } = demoRef(ref);
    const { readMs, scanMs, now } = this.#limits;
    const deadline = now() + scanMs;
    const opened = await within(this.#session.openBoard(org, repo), readMs, "openBoard");
    if (!opened.ok && opened.code === "not_found") {
      if (!this.#readFound) return { issues: [], history: null };
      throw changedDuring(`${org}/${repo}`, "it was read, then the board did not find it");
    }
    using board = valueOf(opened, "openBoard");
    const filed: BoardIssue[] = [];
    let cursor = 0;
    let history: string | undefined;
    for (let pages = 0; pages < MAX_EVENT_PAGES; pages += 1) {
      const left = deadline - now();
      if (left <= 0) throw tooLong(`after ${scanMs} ms`);
      const read = board.readEvents(
        cursor,
        MAX_EVENT_PAGE,
        ...(history === undefined ? [] : [history]),
      );
      const answer = await within(read, Math.min(readMs, left), "readEvents");
      if (!answer.ok && answer.code === "cursor_ahead" && history !== undefined) {
        throw changedDuring(`${org}/${repo}`, "its board history was replaced while it was read");
      }
      const page = valueOf(answer, "readEvents");
      history = page.history;
      for (const event of page.events) {
        if (event.type === "issue.filed" && titles.has(event.data.title)) {
          filed.push({ title: event.data.title, body: event.data.body });
        }
      }
      if (page.cursor >= page.head) return { issues: filed, history };
      if (page.cursor <= cursor) {
        throw new BackendFailure(
          `readEvents stopped at cursor ${page.cursor} before the log's head ${page.head}.`,
        );
      }
      cursor = page.cursor;
    }
    throw tooLong(`past ${MAX_EVENT_PAGES * MAX_EVENT_PAGE} events`);
  }

  /** The board's current history for the repository, from one event; `null` when not found. */
  async history(ref: RepoRef): Promise<string | null> {
    const { org, repo } = demoRef(ref);
    const { readMs } = this.#limits;
    const opened = await within(this.#session.openBoard(org, repo), readMs, "openBoard");
    if (!opened.ok && opened.code === "not_found") return null;
    using board = valueOf(opened, "openBoard");
    return valueOf(await within(board.readEvents(0, 1), readMs, "readEvents"), "readEvents")
      .history;
  }

  /** Performs `action` with the held approval, which is spent whether or not the call succeeds. */
  async #write(action: DemoSeedAction, bundle: Uint8Array | null): Promise<DemoSeedResult> {
    const approval = this.#approval;
    this.#approval = null;
    if (approval === null) {
      throw new SeedRefusal(`${action.kind} needs another owner passkey assertion.`);
    }
    const { readMs, writeMs } = this.#limits;
    using demo = await within(this.#session.demoSeed(), readMs, "demoSeed");
    switch (approval.kind) {
      case "prepare": {
        const prepared = await within(demo.prepare(action), readMs, "demoSeed.prepare");
        throw new ApprovalNeeded(action, valueOf(prepared, "prepare"));
      }
      case "signed": {
        const { challengeId, assertion } = approval;
        let performed: BoardResult<DemoSeedResult>;
        try {
          performed = await within(
            demo.perform(challengeId, assertion, bundle),
            writeMs,
            "demoSeed.perform",
          );
        } catch (error) {
          if (error instanceof BackendFailure) throw new WriteUncertain(action, error);
          throw error;
        }
        if (performed.ok || PRE_ACTION_REFUSALS.has(performed.code)) {
          return valueOf(performed, action.kind);
        }
        throw new WriteUncertain(
          action,
          new BackendFailure(`${action.kind} failed with ${performed.code}: ${performed.message}`),
        );
      }
      default:
        return unreachable(approval);
    }
  }
}

/**
 * The failures `perform` answers before it acts: the challenge or bundle is refused, the target
 * holds something else, or the instance has no Artifacts binding. Any other failure may follow a
 * partial write.
 */
const PRE_ACTION_REFUSALS: ReadonlySet<BoardErrorCode> = new Set<BoardErrorCode>([
  "invalid_request",
  "proof_invalid",
  "proof_expired",
  "action_stale",
  "unavailable",
]);

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

/** The refusal for a repository that changed while a plan read it. */
function changedDuring(name: string, how: string): SeedRefusal {
  return new SeedRefusal(`${name} changed during planning: ${how}; run again.`);
}

/** The refusal for a board log too long to read within the scan's budget. */
function tooLong(limit: string): SeedRefusal {
  return new SeedRefusal(
    `The board log is too long: stopped reading it ${limit}, so the plan is incomplete.`,
  );
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
