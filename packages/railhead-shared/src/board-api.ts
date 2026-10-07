// The board's Cap'n Web capabilities: what the board may read and which human actions it may ask
// for, over the one RPC session at `API_PATH`.
//
// Reading: the board's state is a fold over the repository's event log, computed in the browser. The
// backend serves the log, not a second state: a snapshot is a page of events up to a cursor, and a
// subscription delivers every event after a cursor. A cursor is the `seq` of the last event the
// board applied, or 0 before the first. So the board loads by paging `readEvents` until it reaches
// `head`, then subscribes from its cursor; an event appended in between is delivered by the
// subscription, never lost. On reconnecting it subscribes again from its cursor, drops events at
// or below it, and pages over any gap. A subscription does not survive the backend hibernating or
// the socket closing; the persisted cursor is what survives.
//
// Acting: every human-only action (invite or confirm an agent, file an issue, decide, approve a held
// check) is one passkey assertion bound to that exact action. The board asks for a challenge naming
// the action, the browser's authenticator signs it, and the backend performs the action only if the
// assertion is for that challenge and is used once. There is no owner session that can perform an action without
// a fresh assertion, and no method that takes an actor or appends an arbitrary event.
//
// Every interface here is implemented by a class carrying `@validateRpc()`. A missing backend module
// answers with the `unavailable` failure; it never reports success.

import type { RpcTarget } from "capnweb";
import type {
  AgentId,
  CheckResult,
  CheckRunId,
  CommitSha,
  DecisionId,
  InviteId,
  IssueId,
  RailheadEvent,
  RepoId,
  UserId,
} from "./events.ts";

/** Largest event page `readEvents` returns. */
export const MAX_EVENT_PAGE = 256;

/** Most events the backend sends in one `BoardListener.events` call. */
export const MAX_PUSH_BATCH = 64;

/**
 * Most events a subscription may have sent and not yet seen acknowledged by the listener's promise.
 * Past this the backend ends the subscription with `slow`, and the board pages and resubscribes.
 */
export const MAX_UNACKNOWLEDGED_EVENTS = 1024;

/** How long an action challenge stays valid after it is issued, in milliseconds. */
export const ACTION_CHALLENGE_TTL_MS = 2 * 60_000;

/** How long an invite stays usable after it is created, in milliseconds. */
export const INVITE_TTL_MS = 15 * 60_000;

// =======================================================================================
// Failures

/** Why a board call failed. */
export type BoardErrorCode =
  /** The input broke an invariant its type cannot state. */
  | "invalid_request"
  /** No such repository, or it is not visible to this session. */
  | "not_found"
  /**
   * The cursor belongs to another log: it is ahead of the log's head, or it was read under a
   * history the owner has since reset.
   */
  | "cursor_ahead"
  /** The passkey assertion did not verify, or was for another challenge or origin. */
  | "proof_invalid"
  /** The action challenge expired or was already used. */
  | "proof_expired"
  /** The action no longer applies: the code differs, the version moved, the agent is gone. */
  | "action_stale"
  /** The owner's passkey is already enrolled, or the bootstrap token is wrong. */
  | "bootstrap_closed"
  /** A limit on invites, issues or questions was reached. */
  | "quota_exceeded"
  /**
   * Earlier work the call depends on has not settled yet, so the call was refused before it changed
   * anything. Try again shortly.
   */
  | "busy"
  /** The backend module that serves this call is not installed. Nothing happened. */
  | "unavailable"
  /** The backend failed; the call may be repeated. */
  | "internal";

/** Every `BoardErrorCode`, as keys. The `satisfies` fails to compile until a new code is added. */
export const BOARD_ERROR_CODES = {
  invalid_request: true,
  not_found: true,
  cursor_ahead: true,
  proof_invalid: true,
  proof_expired: true,
  action_stale: true,
  bootstrap_closed: true,
  quota_exceeded: true,
  busy: true,
  unavailable: true,
  internal: true,
} as const satisfies Record<BoardErrorCode, true>;

/** Whether `code` is a `BoardErrorCode`. Inherited keys such as `toString` are not. */
export function isBoardErrorCode(code: string): code is BoardErrorCode {
  return Object.hasOwn(BOARD_ERROR_CODES, code);
}

/** A failed board call. */
export interface BoardFailure {
  /** Always `false`. */
  ok: false;
  /** What went wrong. */
  code: BoardErrorCode;
  /** One sentence for the person watching, written by the backend. */
  message: string;
}

/** The result of a board call: its value, or why it failed. */
export type BoardResult<T> = { ok: true; value: T } | BoardFailure;

// =======================================================================================
// Reading the log

/** A page of the log. */
export interface EventPage {
  /** The repository. */
  repo: RepoId;
  /** The events after the requested cursor, in `seq` order, gapless, at most the limit. */
  events: RailheadEvent[];
  /** The cursor to ask from next: the last returned `seq`, or the requested cursor if none. */
  cursor: number;
  /** The `seq` of the newest event in the log when the page was read, or 0 for an empty log. */
  head: number;
  /**
   * The history the log belongs to. A reset of the repository starts a new history whose `seq`
   * numbers start again at 1, so a cursor is meaningful only together with the history it was
   * read under.
   */
  history: string;
}

/** Why the backend ended a subscription. After any of these the board pages and resubscribes. */
export type SubscriptionEnd =
  /** The listener fell more than `MAX_UNACKNOWLEDGED_EVENTS` behind. */
  | "slow"
  /** The backend is restarting or hibernating. */
  | "restart"
  /**
   * The session lost access to the repository, or the owner reset it and its history is gone. Do
   * not resubscribe from the old cursor.
   */
  | "revoked";

/** A pending join the owner may confirm: the code the agent's terminal shows. */
export interface PendingJoin {
  /** The agent that joined. */
  agentId: AgentId;
  /** The invite it used. */
  inviteId: InviteId;
  /** The name fixed by the invite. */
  name: string;
  /** The OpenSSH SHA256 fingerprint of its key. */
  keyFingerprint: string;
  /** The six-digit code to match against the agent's terminal. */
  code: string;
  /** When it joined. */
  joinedAt: number;
}

/** The most bytes of a check run's output `checkDetail` returns, taken from its end. */
export const MAX_CHECK_DETAIL_LOG_BYTES = 16 * 1024;

/** Where a check run stands, as the backend's checks module recorded it. */
export type CheckDetailState =
  /** The candidate edits these protected paths, so nothing ran; a person must approve it. */
  | { kind: "held"; paths: string[] }
  /** A sandbox was admitted and the run asked for; no report has arrived. */
  | { kind: "started"; deadline: number }
  /** The run reported. */
  | {
      kind: "reported";
      /** The outcome. `error` means the check could not run. */
      result: CheckResult;
      /** When the run finished. */
      finishedAt: number;
      /**
       * The end of the run's output, at most `MAX_CHECK_DETAIL_LOG_BYTES` of UTF-8. Untrusted text:
       * render it as text, never as markup or links.
       */
      logTail: string;
      /** Whether earlier output was left out of `logTail`. */
      logCut: boolean;
    };

/** One check run, as the backend recorded it: what ran, on which commit, and what came of it. */
export interface CheckDetail {
  /** The run. */
  checkRunId: CheckRunId;
  /** The exact commit checked. */
  candidate: CommitSha;
  /** The main commit the candidate was composed on, and the definition was read from. */
  expectedMain: CommitSha;
  /** SHA-256 of the trusted definition's bytes, 64 lowercase hexadecimal characters. */
  definitionDigest: string;
  /**
   * The shell command the definition on `expectedMain` gave the run, or `null` for a run recorded
   * before the backend kept commands. Repository content: render it as text.
   */
  command: string | null;
  /** Where it stands. */
  state: CheckDetailState;
}

/** The board's side of a subscription. The board passes an `RpcTarget` implementing it. */
export interface BoardListener extends RpcTarget {
  /**
   * Receives the next events after the subscription's cursor, in order and gapless, at most
   * `MAX_PUSH_BATCH`. The backend sends the next batch only after this promise settles.
   */
  events(events: RailheadEvent[]): Promise<void>;
  /** Called once when the backend ends the subscription. */
  ended(reason: SubscriptionEnd): Promise<void>;
}

/** A live subscription. Disposing the stub ends it. */
export interface BoardSubscription extends RpcTarget {
  /** Ends the subscription; no listener call follows the returned promise. */
  cancel(): Promise<void>;
}

/** Read access to one repository's log, and the entry point for its owner's actions. */
export interface BoardApi extends RpcTarget {
  /**
   * Reads up to `limit` events after `cursor`, with `limit` from 1 to `MAX_EVENT_PAGE`. `history`
   * is the `EventPage.history` the cursor was read under; when it is given and is no longer the
   * log's history, the call fails with `cursor_ahead`.
   */
  readEvents(cursor: number, limit: number, history?: string): Promise<BoardResult<EventPage>>;
  /**
   * Delivers every event after `cursor` to `listener` until cancelled or ended. `history` is
   * checked as `readEvents` checks it.
   */
  subscribe(
    cursor: number,
    listener: BoardListener,
    history?: string,
  ): Promise<BoardResult<BoardSubscription>>;
  /** The joins waiting for the owner, oldest first. */
  pendingJoins(): Promise<BoardResult<PendingJoin[]>>;
  /**
   * What the backend recorded for the check run a `train.check` event names. It fails with
   * `invalid_request` for a malformed id, and with `not_found` for a run the backend never started
   * or no longer keeps: it keeps a bounded number of runs, so an old run's detail can be gone while
   * its event remains.
   */
  checkDetail(checkRunId: CheckRunId): Promise<BoardResult<CheckDetail>>;
  /** The owner's passkey actions for this repository. */
  owner(): Promise<OwnerApi>;
}

// =======================================================================================
// Owner actions

/** A human-only action, named exactly as the passkey assertion is bound to it. */
export type OwnerAction =
  /** Create a single-use invite for an agent named `name`. */
  | { kind: "invite.create"; name: string }
  /** Confirm a pending agent after matching its code. */
  | { kind: "agent.confirm"; agentId: AgentId; code: string }
  /** Revoke an agent; its next call fails. */
  | { kind: "agent.revoke"; agentId: AgentId }
  /** File an issue for agents to work on. */
  | { kind: "issue.file"; title: string; body: string }
  /**
   * Answer the question that opened `decisionId`, or replace its current answer. `expectedVersion` is the version being
   * replaced, `null` for the first answer; a stale value fails with `action_stale` rather than
   * recording a second version.
   */
  | {
      kind: "decision.record";
      decisionId: DecisionId;
      option: string;
      expectedVersion: number | null;
    }
  /**
   * Run the candidate's own check definition for the one attempt held on `candidate` because it
   * edits protected check paths. `digest` is the `train.held` digest of that definition. The
   * attempt must still be held on that candidate with that digest, or the action fails with
   * `action_stale`; it never approves another attempt or definition.
   */
  | { kind: "check.approve"; checkRunId: CheckRunId; candidate: CommitSha; digest: string };

/** What a performed action produced, tagged like its action. */
export type OwnerActionResult =
  /** The invite. The URL carries its secret, is shown once and is never stored. */
  | { kind: "invite.create"; inviteId: InviteId; inviteUrl: string; expiresAt: number }
  /** The confirmed agent. */
  | { kind: "agent.confirm"; agentId: AgentId }
  /** The revoked agent. */
  | { kind: "agent.revoke"; agentId: AgentId }
  /** The filed issue. */
  | { kind: "issue.file"; issueId: IssueId }
  /** The recorded decision version. */
  | { kind: "decision.record"; decisionId: DecisionId; version: number }
  /** The approved attempt, which the train runs next. */
  | { kind: "check.approve"; checkRunId: CheckRunId };

/** A WebAuthn request the browser passes to `navigator.credentials.get`. */
export interface ActionChallenge {
  /** The challenge to quote when performing the action. */
  challengeId: string;
  /** The WebAuthn challenge bytes, base64url without padding. They commit to the action. */
  challenge: string;
  /** The relying party: the exact host of the fixed origin. */
  rpId: string;
  /** The owner's credential ids, base64url without padding. */
  allowCredentials: string[];
  /** When the challenge stops being usable. */
  expiresAt: number;
}

/** A WebAuthn assertion, each binary field base64url without padding. */
export interface PasskeyAssertion {
  /** The credential id. */
  credentialId: string;
  /** `response.clientDataJSON`. */
  clientDataJson: string;
  /** `response.authenticatorData`. */
  authenticatorData: string;
  /** `response.signature`. */
  signature: string;
  /** `response.userHandle`, or `null` when the authenticator returned none. */
  userHandle: string | null;
}

/** A WebAuthn registration the browser passes to `navigator.credentials.create`. */
export interface EnrollmentChallenge {
  /** The challenge to quote when completing enrollment. */
  challengeId: string;
  /** The WebAuthn challenge bytes, base64url without padding. */
  challenge: string;
  /** The relying party: the exact host of the fixed origin. */
  rpId: string;
  /** The user handle to register, base64url without padding. */
  userHandle: string;
  /** When the challenge stops being usable. */
  expiresAt: number;
}

/** A WebAuthn attestation, each binary field base64url without padding. */
export interface PasskeyRegistration {
  /** The new credential id. */
  credentialId: string;
  /** `response.clientDataJSON`. */
  clientDataJson: string;
  /** `response.attestationObject`. */
  attestationObject: string;
}

/** The owner's actions on one repository. Each one needs its own passkey assertion. */
export interface OwnerApi extends RpcTarget {
  /** Issues a challenge bound to `action`. The action is checked again when it is performed. */
  prepare(action: OwnerAction): Promise<BoardResult<ActionChallenge>>;
  /** Performs the action the challenge names, if `assertion` verifies for it; at most once. */
  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
  ): Promise<BoardResult<OwnerActionResult>>;
}

/** Enrollment of the instance owner's passkey, open only until it first succeeds. */
export interface OwnerEnrollmentApi extends RpcTarget {
  /**
   * Starts enrolling the owner's passkey on a fresh instance. `bootstrapToken` is the one-time
   * value the operator configured at deploy; a wrong token and a closed enrollment both fail with
   * `bootstrap_closed`.
   */
  prepare(bootstrapToken: string): Promise<BoardResult<EnrollmentChallenge>>;
  /** Completes enrollment with the authenticator's registration, and closes enrollment. */
  complete(
    challengeId: string,
    registration: PasskeyRegistration,
  ): Promise<BoardResult<{ ownerId: UserId }>>;
}

/** The organisation of the demo repository the board opens by default. */
export const DEMO_ORG = "demo";

/** The name of the demo repository the board opens by default. */
export const DEMO_REPO = "upload-app";

/** The largest Git bundle, in bytes, a demo seed accepts. */
export const MAX_DEMO_BUNDLE_BYTES = 8 * 1024 * 1024;

/** An owner action on the demo repository, approved with the owner passkey like an `OwnerAction`. */
export type DemoSeedAction =
  /**
   * Create `demo/upload-app` if it is missing, and import the bundle whose main is `head` as its
   * main. A repeat with the same head succeeds. A main at another head fails with `action_stale`,
   * and so does any seed after a reset that did not finish, until a reset finishes.
   */
  | { kind: "demo.seed"; head: CommitSha }
  /** Delete `demo/upload-app` and its Artifacts repositories. Nothing else is touched. */
  | { kind: "demo.reset" };

/** What a demo seed action did. */
export type DemoSeedResult =
  /** The demo repository and the head its main holds. */
  | { kind: "demo.seed"; repo: RepoId; head: CommitSha }
  /** Whether there was a demo repository to delete. */
  | { kind: "demo.reset"; deleted: boolean };

/** The demo repository as it stands. */
export interface DemoSeedState {
  /** Its identifier. */
  repo: RepoId;
  /** The head of its main, or `null` before a main was imported. */
  main: CommitSha | null;
}

/** Seeding and resetting the demo repository. Each action needs its own owner passkey assertion. */
export interface DemoSeedApi extends RpcTarget {
  /** The demo repository, or `null` when it does not exist. */
  read(): Promise<BoardResult<DemoSeedState | null>>;
  /** Issues a challenge bound to `action`. */
  prepare(action: DemoSeedAction): Promise<BoardResult<ActionChallenge>>;
  /**
   * Performs the action the challenge names, if `assertion` verifies for it; at most once.
   * `bundle` is the Git bundle holding main for `demo.seed`, at most `MAX_DEMO_BUNDLE_BYTES`, and
   * `null` for `demo.reset`.
   */
  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
    bundle: Uint8Array | null,
  ): Promise<BoardResult<DemoSeedResult>>;
}
