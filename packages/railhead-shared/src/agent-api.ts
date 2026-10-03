// The agent wire: the HTTP JSON protocol between the `rh` CLI and the backend, version 1.
//
// This module is the single owner of that protocol. It names every route, its request and response
// bodies, the closed set of error codes with their HTTP statuses, the limits, and the bytes an
// agent signs to log in. The Rust CLI decodes the same JSON; `fixtures/protocol/wire/` holds the
// request and response corpus both sides test against.
//
// Encoding rules, shared with `@railhead/shared/events`:
//
// - Field names are camelCase. Every field is always present: absence is `null`, never an omitted
//   key. Readers ignore fields they do not know, and must not store or forward them.
// - Integers are JSON numbers written without a fraction or exponent, between 0 and
//   `Number.MAX_SAFE_INTEGER`. A reader rejects anything larger, because TypeScript cannot
//   represent it exactly. Times are milliseconds since the Unix epoch.
// - Tagged unions carry their tag in a `kind` field, as `InboxEntry` does. Events are the exception
//   and keep their `type` and `data` encoding.
//
// Trust boundary: as for events, a body's shape is established before the `validate*` functions in
// this module run. The backend parses JSON to `unknown` and checks its shape with capnweb-validate's
// generated validator; it never casts parsed JSON to a request type. The functions here check what
// a type cannot state: identifier formats, lengths and ranges.
//
// Authority: the server derives who is calling from the session token, never from a body field. A
// body names only the objects the call acts on, such as a claim and the generation the agent last
// saw, and the server checks that the caller owns them at the time of the call.
//
// Text from agents and people is untrusted. A response never carries an Artifacts token, a key or
// another secret, apart from the session token the session route exists to return.

import {
  MAX_LIST_LENGTH,
  MAX_OPTION_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_PATH_LENGTH,
  MAX_PLAN_LENGTH,
  MAX_QUESTION_LENGTH,
  MIN_OPTIONS,
  isCommitSha,
  isId,
  type AgentId,
  type CheckRunId,
  type ClaimId,
  type CommitSha,
  type DecisionId,
  type IdKind,
  type InboxEntry,
  type InviteId,
  type IssueId,
  type QuestionId,
  type QuestionOption,
  type RepoId,
  type UserId,
} from "./events.ts";

// =======================================================================================
// Version, encoding and limits

/** The agent protocol version. It is the `v1` in every route path. */
export const AGENT_PROTOCOL_VERSION = 1;

/** Path prefix of every agent route: `/agent/v1/{org}/{repo}/...`. */
export const AGENT_PATH_PREFIX = "/agent/v1";

/** The only request content type the agent routes accept for a body. */
export const AGENT_REQUEST_CONTENT_TYPE = "application/json";

/** The content type of every agent response, success or error. */
export const AGENT_RESPONSE_CONTENT_TYPE = "application/json; charset=utf-8";

/** Largest request body the backend reads, in bytes. A larger body is refused unread. */
export const MAX_AGENT_REQUEST_BYTES = 16 * 1024;

/** Largest response body the CLI accepts, in bytes. Paging keeps every response far below it. */
export const MAX_AGENT_RESPONSE_BYTES = 1024 * 1024;

/** How long the CLI waits for one response before giving up, in milliseconds. */
export const AGENT_REQUEST_TIMEOUT_MS = 30_000;

/** Longest a question long-poll holds a request open, in milliseconds. */
export const MAX_LONG_POLL_MS = 25_000;

/**
 * Most UTF-8 bytes a question's scope may take as a JSON array. The scope is copied into the
 * answer's inbox item, so this keeps that item far below the inbox's size limit; half the request
 * body limit leaves room for the question and its options.
 */
export const MAX_SCOPE_BYTES = MAX_AGENT_REQUEST_BYTES / 2;

/** How long a login challenge stays valid after it is issued, in milliseconds. */
export const CHALLENGE_TTL_MS = 60_000;

/** How long a session token stays valid after it is issued, in milliseconds. */
export const SESSION_TTL_MS = 10 * 60_000;

/** Largest session token the CLI stores or sends, in characters. */
export const MAX_SESSION_TOKEN_LENGTH = 4096;

/** Largest inbox page a sync returns. */
export const MAX_INBOX_PAGE = 64;

/** Inbox page size when the request does not name one. */
export const DEFAULT_INBOX_PAGE = 16;

/** Most inbox items piggybacked on one command result. */
export const MAX_PIGGYBACK_ITEMS = 8;

/** Largest armored SSH signature the backend reads, in characters. */
export const MAX_SIGNATURE_LENGTH = 4096;

/** Largest OpenSSH public key line the backend reads, in characters. */
export const MAX_PUBLIC_KEY_LENGTH = 1024;

// =======================================================================================
// Identifiers the agent wire adds to those in `events`

/** A login challenge identifier: `chl_` followed by 16 to 64 letters or digits. Single use. */
export type ChallengeId = string;

/** A client-chosen idempotency key: `req_` followed by 16 to 64 letters or digits. */
export type RequestId = string;

/**
 * The secret half of an invite: 43 base64url characters, 32 random bytes without padding. Only
 * its hash is stored.
 */
export type InviteSecret = string;

/** An organisation or repository name in a route: lowercase letters, digits and inner dashes. */
export type RepoSegment = string;

const CHALLENGE_ID = /^chl_[A-Za-z0-9]{16,64}$/;
const REQUEST_ID = /^req_[A-Za-z0-9]{16,64}$/;
const INVITE_SECRET = /^[A-Za-z0-9_-]{43}$/;
const REPO_SEGMENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const OPTION_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const ED25519_PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{68}$/;
const SSH_SIGNATURE =
  /^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]{1,76}\n)+-----END SSH SIGNATURE-----\n?$/;
const SESSION_TOKEN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** True when `value` is a login challenge identifier. */
export function isChallengeId(value: string): boolean {
  return CHALLENGE_ID.test(value);
}

/** True when `value` is an idempotency key. */
export function isRequestId(value: string): boolean {
  return REQUEST_ID.test(value);
}

/** True when `value` is an organisation or repository name usable in a route. */
export function isRepoSegment(value: string): boolean {
  return REPO_SEGMENT.test(value);
}

// =======================================================================================
// Agent login: the signed challenge and the confirmation code

/** The SSHSIG namespace of every signature an agent makes for Railhead. Git signing uses `git`. */
export const SIGNING_NAMESPACE = "railhead-auth";

/** First line of a login challenge message; the version names the message layout. */
export const LOGIN_MESSAGE_TAG = "railhead-login-v1";

/** First line of a join proof message, which proves the joining agent holds its key. */
export const JOIN_MESSAGE_TAG = "railhead-join-v1";

/**
 * Domain separator of the confirmation code. The code is the first eight bytes of
 * `SHA-256(string(CONFIRM_DOMAIN) || string(public key blob) || string(invite id))`, read as a
 * big-endian unsigned integer, modulo 1,000,000, written as six digits with leading zeros. Here
 * `string(x)` is the SSH wire encoding: a 32-bit big-endian length, then the bytes. The vectors in
 * `fixtures/protocol/wire/auth.json` were computed by an independent implementation.
 */
export const CONFIRM_DOMAIN = "railhead-confirm-v1";

/**
 * The exact text an agent signs to redeem a login challenge, in the `SIGNING_NAMESPACE`.
 *
 * The CLI builds this itself from the origin and repository it is configured for, its own agent id,
 * and the challenge id and expiry the server returned, and refuses a challenge whose `message`
 * differs. So a server cannot get a signature that is valid for another origin or agent.
 */
export function loginMessage(fields: {
  origin: string;
  org: RepoSegment;
  repo: RepoSegment;
  agentId: AgentId;
  challengeId: ChallengeId;
  expiresAt: number;
}): string {
  return [
    LOGIN_MESSAGE_TAG,
    `origin=${fields.origin}`,
    `repo=${fields.org}/${fields.repo}`,
    `agent=${fields.agentId}`,
    `challenge=${fields.challengeId}`,
    `expires=${fields.expiresAt}`,
    "",
  ].join("\n");
}

/**
 * The exact text a joining agent signs, in the `SIGNING_NAMESPACE`, to prove it holds the key it
 * registers. It names no secret: the invite secret travels beside it in the request.
 */
export function joinMessage(fields: {
  origin: string;
  org: RepoSegment;
  repo: RepoSegment;
  inviteId: InviteId;
  publicKey: string;
}): string {
  return [
    JOIN_MESSAGE_TAG,
    `origin=${fields.origin}`,
    `repo=${fields.org}/${fields.repo}`,
    `invite=${fields.inviteId}`,
    `key=${fields.publicKey}`,
    "",
  ].join("\n");
}

// =======================================================================================
// Git remotes and the credential helper
//
// An agent's clone has two remotes on the Railhead origin, never on Artifacts:
//
//   origin    {origin}/git/{org}/{repo}/claims/{claimId}.git   the claim's fork, fetch and push
//   upstream  {origin}/git/{org}/{repo}.git                    main, fetch only
//
// The clone sets `credential.useHttpPath = true`, `credential.helper = "rh credential"` and
// `railhead.identity = <agentId>`. The helper answers Git only for the configured origin and only
// for those two paths, with `username=<agentId>` and `password=<session token>`. It writes nothing
// but the Git credential protocol on stdout; notices go to stderr. It never prints an Artifacts
// token, because it never holds one.

/** The Git config key that binds a clone to the agent identity that claimed it. */
export const GIT_IDENTITY_CONFIG_KEY = "railhead.identity";

/** The path of a claim's fork remote on the Railhead origin. */
export function claimRemotePath(org: RepoSegment, repo: RepoSegment, claimId: ClaimId): string {
  return `/git/${org}/${repo}/claims/${claimId}.git`;
}

/** The path of the main repository's remote on the Railhead origin. */
export function upstreamRemotePath(org: RepoSegment, repo: RepoSegment): string {
  return `/git/${org}/${repo}.git`;
}

// =======================================================================================
// Routes

/** The name of one agent route. */
export type AgentRouteName =
  | "join"
  | "challenge"
  | "session"
  | "status"
  | "work"
  | "claim"
  | "ready"
  | "pin"
  | "inbox"
  | "ack"
  | "ask"
  | "question";

/** How a route authenticates its caller. */
export type AgentRouteAuth =
  /** No session. `join` is authorized by the invite secret, `challenge` and `session` by the key. */
  | "none"
  /** `Authorization: Bearer <session token>`. */
  | "session";

/** One row of the route table. */
export interface AgentRoute {
  /** The HTTP method. */
  method: "GET" | "POST";
  /** The path after `/agent/v1/{org}/{repo}`, with `{name}` placeholders. */
  path: string;
  /** How the caller is authenticated. */
  auth: AgentRouteAuth;
  /**
   * What makes a retry safe. A route that changes state names the identity a repeat is matched on;
   * the repeat returns the recorded result instead of acting twice.
   */
  idempotency: string;
  /** Every error code the route may return, beyond the transport errors every route shares. */
  errors: readonly AgentErrorCode[];
}

/** Errors any route can return: a malformed request, the transport limits, or an unavailable module. */
export const COMMON_ERRORS: readonly AgentErrorCode[] = [
  "invalid_request",
  "unsupported_media_type",
  "payload_too_large",
  "not_found",
  "rate_limited",
  "unavailable",
  "internal",
];

/** Errors every session route can return in addition to `COMMON_ERRORS`. */
export const SESSION_ERRORS: readonly AgentErrorCode[] = [
  "unauthenticated",
  "identity_pending",
  "identity_revoked",
];

/** The agent route table, version 1. Each route's request and response types are below. */
export const AGENT_ROUTES = {
  join: {
    method: "POST",
    path: "/join",
    auth: "none",
    idempotency: "invite and public key: a repeat resumes the same enrollment",
    errors: ["join_refused"],
  },
  challenge: {
    method: "POST",
    path: "/session/challenge",
    auth: "none",
    idempotency: "none needed: each call issues a fresh single-use challenge and changes nothing",
    errors: [],
  },
  session: {
    method: "POST",
    path: "/session",
    auth: "none",
    idempotency: "none: a challenge redeems once; after a lost response, request a new challenge",
    errors: ["challenge_invalid", "identity_pending", "identity_revoked"],
  },
  status: {
    method: "GET",
    path: "/status",
    auth: "session",
    idempotency: "read only",
    errors: [],
  },
  work: {
    method: "POST",
    path: "/work",
    auth: "session",
    idempotency: "the agent: with an active claim, a repeat returns that claim",
    errors: ["no_work", "claim_exists", "busy", "quota_exceeded"],
  },
  claim: {
    method: "POST",
    path: "/claims",
    auth: "session",
    idempotency: "the agent: with an active claim on the same issue, a repeat returns that claim",
    errors: ["claim_exists", "issue_unavailable", "busy", "quota_exceeded"],
  },
  ready: {
    method: "POST",
    path: "/claims/{claimId}/ready",
    auth: "session",
    idempotency: "claim, generation and commit: a repeat returns the recorded pin",
    errors: [
      "stale_generation",
      "after_ready",
      "unacked_decision",
      "commit_not_found",
      "claim_closed",
    ],
  },
  pin: {
    method: "GET",
    path: "/pin",
    auth: "session",
    idempotency: "read only",
    errors: [],
  },
  inbox: {
    method: "GET",
    path: "/inbox",
    auth: "session",
    idempotency: "items are numbered per agent; a repeat returns the same unacknowledged items",
    errors: [],
  },
  ack: {
    method: "POST",
    path: "/inbox/{item}/ack",
    auth: "session",
    idempotency: "agent and item: a repeat returns the first acknowledgement and its plan",
    errors: [],
  },
  ask: {
    method: "POST",
    path: "/claims/{claimId}/questions",
    auth: "session",
    idempotency: "agent and requestId: a repeat returns the same question",
    errors: ["stale_generation", "claim_closed", "idempotency_mismatch", "quota_exceeded"],
  },
  question: {
    method: "GET",
    path: "/questions/{questionId}",
    auth: "session",
    idempotency: "read only; `waitMs` holds the request until an answer or the timeout",
    errors: [],
  },
} as const satisfies Record<AgentRouteName, AgentRoute>;

// =======================================================================================
// Errors

/** Every error the agent routes return. The HTTP status and default retry advice are fixed per code. */
export type AgentErrorCode =
  // Transport and shape
  | "invalid_request"
  | "unsupported_media_type"
  | "payload_too_large"
  | "not_found"
  | "rate_limited"
  // Identity
  | "join_refused"
  | "challenge_invalid"
  | "unauthenticated"
  | "identity_pending"
  | "identity_revoked"
  | "quota_exceeded"
  // Work
  | "no_work"
  | "claim_exists"
  | "issue_unavailable"
  | "claim_closed"
  | "stale_generation"
  | "after_ready"
  | "unacked_decision"
  | "commit_not_found"
  | "idempotency_mismatch"
  // Server
  | "busy"
  | "unavailable"
  | "internal";

/** HTTP status and default retry advice of one error code. */
export interface AgentErrorSpec {
  /** The HTTP status sent with the code. */
  status: number;
  /** Whether repeating the same request may succeed without the agent changing anything. */
  retryable: boolean;
  /** The command the CLI suggests next, or `null` when the message alone says what to do. */
  next: NextCommand | null;
}

/**
 * The fixed status and retry advice of every error code.
 *
 * `join_refused` answers every join failure, whether the invite is unknown, expired, used by
 * another key or the proof is wrong, so a failed join reveals nothing. `unavailable` means a
 * backend module is not installed: the request had no effect, and retrying will not help until the
 * backend changes. `internal` and `busy` are retryable because every state-changing route except
 * `session` is idempotent: the retry reconciles with whatever the first attempt recorded. A
 * `session` redemption may have consumed its challenge before failing, so after `internal` there
 * the CLI requests a new challenge instead of repeating the request. `challenge_invalid` and
 * `unauthenticated` are not retryable as sent: the CLI recovers by logging in again with a new
 * challenge, which changes the request.
 */
export const AGENT_ERRORS = {
  invalid_request: { status: 400, retryable: false, next: null },
  unsupported_media_type: { status: 415, retryable: false, next: null },
  payload_too_large: { status: 413, retryable: false, next: null },
  not_found: { status: 404, retryable: false, next: "status" },
  rate_limited: { status: 429, retryable: true, next: null },
  join_refused: { status: 403, retryable: false, next: null },
  challenge_invalid: { status: 401, retryable: false, next: null },
  unauthenticated: { status: 401, retryable: false, next: null },
  identity_pending: { status: 403, retryable: true, next: "join" },
  identity_revoked: { status: 403, retryable: false, next: null },
  quota_exceeded: { status: 429, retryable: false, next: "status" },
  no_work: { status: 409, retryable: true, next: "work" },
  claim_exists: { status: 409, retryable: false, next: "status" },
  issue_unavailable: { status: 409, retryable: false, next: "work" },
  claim_closed: { status: 409, retryable: false, next: "work" },
  stale_generation: { status: 409, retryable: false, next: "status" },
  after_ready: { status: 409, retryable: false, next: "status" },
  unacked_decision: { status: 409, retryable: false, next: "sync" },
  commit_not_found: { status: 422, retryable: false, next: null },
  idempotency_mismatch: { status: 409, retryable: false, next: null },
  busy: { status: 503, retryable: true, next: null },
  unavailable: { status: 503, retryable: false, next: null },
  internal: { status: 500, retryable: true, next: null },
} as const satisfies Record<AgentErrorCode, AgentErrorSpec>;

/** A command the CLI can suggest, named without the `rh` prefix. */
export type NextCommand = "join" | "work" | "claim" | "sync" | "ack" | "ask" | "ready" | "status";

/** The body of every error response. */
export interface AgentError {
  /** What went wrong. */
  code: AgentErrorCode;
  /** One sentence for the agent to read, written by the backend. Never echoes request text. */
  message: string;
  /** Whether repeating the same request may succeed. */
  retryable: boolean;
  /** How long to wait before a retry, in milliseconds, or `null` for no advice. */
  retryAfterMs: number | null;
  /** The command to run next, or `null`. */
  next: NextCommand | null;
}

// =======================================================================================
// Envelopes

/** Unacknowledged inbox items carried on a command result, so every command shows them first. */
export interface InboxDigest {
  /** The oldest unacknowledged items, at most `MAX_PIGGYBACK_ITEMS`, in item order. */
  items: InboxItem[];
  /** How many unacknowledged items exist in total, including those carried here. */
  pending: number;
}

/** A successful response. `inbox` is `null` on the routes that run before a session exists. */
export interface AgentSuccess<T> {
  /** Always `true`. */
  ok: true;
  /** The route's result. */
  data: T;
  /** Pending inbox items, or `null` on `join`, `challenge` and `session`. */
  inbox: InboxDigest | null;
  /** The command to run next, or `null`. */
  next: NextCommand | null;
}

/** An error response. */
export interface AgentFailure {
  /** Always `false`. */
  ok: false;
  /** What went wrong. */
  error: AgentError;
}

/** Every agent response body. */
export type AgentResponse<T> = AgentSuccess<T> | AgentFailure;

// =======================================================================================
// Shared views

/** Where an agent's enrollment stands. */
export type EnrollmentState =
  /** Joined; waiting for the owner to match the code and confirm with a passkey. */
  | "pending"
  /** Confirmed: the agent can log in. */
  | "confirmed";

/** An agent as it sees itself. */
export interface AgentView {
  /** The agent. */
  agentId: AgentId;
  /** Its display name, fixed by the invite. */
  name: string;
  /** The person who owns it. */
  ownerId: UserId;
  /** Where its enrollment stands. A revoked agent gets `identity_revoked` instead. */
  state: EnrollmentState;
}

/** Where a claim stands. */
export type ClaimState =
  /** The agent is working; pushes to the fork are accepted. */
  | "working"
  /** The agent marked a commit ready; the fork is read only and the commit is pinned. */
  | "ready"
  /** The pinned commit landed on main. */
  | "merged"
  /** The lease ended and the claim waits for a replacement agent. */
  | "expired";

/** A claim as its agent sees it. */
export interface ClaimView {
  /** The claim. */
  claimId: ClaimId;
  /** The issue it works on. */
  issueId: IssueId;
  /** The ownership generation the agent must send back on claim calls. */
  generation: number;
  /** The main commit the fork was created from. */
  base: CommitSha;
  /** Where the claim stands. */
  state: ClaimState;
  /** The pinned commit once ready, otherwise `null`. */
  readyCommit: CommitSha | null;
  /** Absolute URL of the claim's fork remote, on the Railhead origin. */
  originUrl: string;
  /** Absolute URL of the main repository remote, fetch only. */
  upstreamUrl: string;
  /** The durable task: the issue's title and body. Untrusted text. */
  task: { title: string; body: string };
}

/** A decision version as an agent's inbox shows it. Every text field is untrusted. */
export interface DecisionView {
  /** The decision. */
  decisionId: DecisionId;
  /** This version, counting from 1. */
  version: number;
  /** The version this one replaces, or `null` for the first. */
  supersedes: number | null;
  /** The question it answers. */
  questionId: QuestionId;
  /** The question's text. */
  question: string;
  /** The chosen option. */
  option: QuestionOption;
  /** The option the replaced version chose, or `null` for the first. */
  previous: QuestionOption | null;
  /** The repository paths it applies to. */
  scope: string[];
  /** The person who decided. */
  decidedBy: UserId;
  /** When it was recorded. */
  decidedAt: number;
}

/**
 * One inbox item. Its `entry` is the event log's `InboxEntry`; `decision` adds what the CLI prints
 * for a `decision` or `rework` entry and is `null` for a `conflict`.
 */
export interface InboxItem {
  /** The item number: unique per agent, increasing, never reused. `rh ack` names it. */
  item: number;
  /** The claim it concerns. */
  claimId: ClaimId;
  /** When it was queued. */
  queuedAt: number;
  /** What it asks of the agent. */
  entry: InboxEntry;
  /** The decision version for `decision` and `rework` entries, otherwise `null`. */
  decision: DecisionView | null;
}

// =======================================================================================
// Requests and results, route by route

/** `join`: register a key with an invite, or resume that registration. */
export interface JoinRequest {
  /** The invite, from the invite URL. */
  inviteId: InviteId;
  /** The invite's secret, from the invite URL's fragment. */
  inviteSecret: InviteSecret;
  /** The agent's new public key: `ssh-ed25519 <base64 blob>`, with no comment. */
  publicKey: string;
  /** An armored SSHSIG over `joinMessage(...)` with that key, in the `SIGNING_NAMESPACE`. */
  signature: string;
}

/** `join` result: the enrollment this key holds. */
export interface JoinResult {
  /** The agent the invite created. The same on every repeat with the same key. */
  agent: AgentView;
  /** The six-digit code the owner matches on the board. */
  code: string;
  /** When to ask again while pending, in milliseconds. */
  pollAfterMs: number;
}

/** `challenge`: ask for a login challenge. */
export interface ChallengeRequest {
  /** The agent that will sign it. An unknown agent still receives a challenge that cannot redeem. */
  agentId: AgentId;
}

/** `challenge` result. */
export interface ChallengeResult {
  /** The challenge, single use. */
  challengeId: ChallengeId;
  /** When it stops being redeemable. */
  expiresAt: number;
  /** `loginMessage(...)` as the server built it; the CLI compares it with its own. */
  message: string;
}

/** `session`: redeem a signed challenge for a session token. */
export interface SessionRequest {
  /** The agent that signed. */
  agentId: AgentId;
  /** The challenge it signed. */
  challengeId: ChallengeId;
  /** An armored SSHSIG over the challenge message, in the `SIGNING_NAMESPACE`. */
  signature: string;
}

/** `session` result. */
export interface SessionResult {
  /** The bearer token for every session route. It names the agent, owner and repository. */
  token: string;
  /** When it expires; the CLI logs in again before then. */
  expiresAt: number;
  /** The agent it authenticates. */
  agent: AgentView;
  /** The repository it is bound to. */
  repoId: RepoId;
}

/** `status` result. */
export interface StatusResult {
  /** The calling agent. */
  agent: AgentView;
  /** Its active claim, or `null`. */
  claim: ClaimView | null;
}

/** `claim`: claim a named issue. */
export interface ClaimRequest {
  /** The issue. */
  issueId: IssueId;
}

/** `work` and `claim` result. */
export interface ClaimResult {
  /** The claim. */
  claim: ClaimView;
  /** `true` when the agent already held this claim and the call returned it. */
  resumed: boolean;
}

/** `ready`: pin a commit for the train. The claim is in the path. */
export interface ReadyRequest {
  /** The ownership generation the agent last saw. */
  generation: number;
  /** The commit to pin, which must exist in the claim's fork. */
  commit: CommitSha;
}

/** `ready` result. */
export interface ReadyResult {
  /** The claim, now `ready` with its pinned commit. */
  claim: ClaimView;
  /** `true` when this exact pin was already recorded and the call returned it. */
  repeated: boolean;
}

/** Where a batch holding a pin stands. */
export type PinBatchState =
  /** The batch is being composed on main. */
  | "forming"
  /** The batch's candidate is being checked. */
  | "checking"
  /** The candidate edits protected check paths and waits for a person; it is not run meanwhile. */
  | "held"
  /** The check passed; the merge is being authorized and main moved. */
  | "landing";

/** Why the train took a pin out of its queue without landing it. */
export type PinLeaveReason =
  /** The claim's current pin is no longer this generation and commit. */
  | "pin_changed"
  /** The claim's decision requirements could not be read. */
  | "requirements_refused"
  /** The change failed its check when checked alone. */
  | "check_failed"
  /** The change could not be composed alone, such as a missing commit. */
  | "compose_failed"
  /** The pin's batches failed for reasons outside it too many times. */
  | "retries_exhausted"
  /** The change conflicts with another claim's. */
  | "conflict"
  /** Checked alone, the change edits protected check paths and waits for a person. */
  | "check_held";

/** Where a pin stands on the train. Tagged by `kind`. */
export type PinTrainState =
  /** Waiting for a batch. `position` counts from 1, the next pin a batch takes. */
  | { kind: "queued"; position: number }
  /** In the active batch; `checkRunId` names its check run once one is recorded. */
  | { kind: "batched"; batchId: number; batch: PinBatchState; checkRunId: CheckRunId | null }
  /** Merged to main. */
  | { kind: "landed" }
  /** Removed from the train; a new `ready` episode queues the claim again. */
  | { kind: "dropped"; reason: PinLeaveReason }
  /** Out of the queue until a person or a new push returns it. */
  | { kind: "parked"; reason: PinLeaveReason };

/** The train's view of the calling agent's pin. */
export interface PinView {
  /** The claim. */
  claimId: ClaimId;
  /** The ownership generation the pin was recorded under: the claim's current one. */
  generation: number;
  /** The commit the train holds: the one queued, being checked, landed or taken out. */
  commit: CommitSha;
  /** A newer pinned commit waiting for the batch holding `commit` to settle, or `null`. */
  nextCommit: CommitSha | null;
  /** Where it stands. */
  state: PinTrainState;
}

/**
 * `pin` result. It shows only the calling agent's active claim at its current generation, never an
 * older generation's pin, which may have belonged to another agent.
 */
export interface PinResult {
  /** The pin, or `null` when the agent has no ready claim or the train holds no pin for it. */
  pin: PinView | null;
}

/** `inbox` result. The query may carry `limit`, from 1 to `MAX_INBOX_PAGE`. */
export interface InboxResult {
  /** Unacknowledged items, oldest first. Returning them records them as delivered. */
  items: InboxItem[];
  /** How many unacknowledged items exist in total. */
  pending: number;
}

/** `ack`: acknowledge one item with a plan. The item is in the path. */
export interface AckRequest {
  /** What the agent will change, or why the item does not apply. Untrusted text. */
  plan: string;
}

/** `ack` result. */
export interface AckResult {
  /** The item. */
  item: number;
  /** The plan recorded with the first acknowledgement, which a repeat does not replace. */
  plan: string;
  /** When it was first acknowledged. */
  ackedAt: number;
  /** `true` when the item was already acknowledged. */
  repeated: boolean;
}

/** `ask`: ask the owner a question about the claim. The claim is in the path. */
export interface AskRequest {
  /** The ownership generation the agent last saw. */
  generation: number;
  /** The idempotency key; a repeat with the same key returns the same question. */
  requestId: RequestId;
  /** The question. Untrusted text. */
  text: string;
  /** The answers offered, between `MIN_OPTIONS` and `MAX_OPTIONS`, with unique keys. */
  options: QuestionOption[];
  /**
   * The repository paths the answer applies to: 1 to `MAX_LIST_LENGTH` relative paths, none blank,
   * with an empty, `.` or `..` segment, or with a control character, and at most
   * `MAX_SCOPE_BYTES` together. The decision the answer records carries them as its scope.
   */
  scope: string[];
}

/** Where a question stands. */
export type QuestionState = "open" | "answered";

/** `ask` and `question` result. The `question` query may carry `waitMs`, up to `MAX_LONG_POLL_MS`. */
export interface QuestionResult {
  /** The question. */
  questionId: QuestionId;
  /** The decision its answer will record. */
  decisionId: DecisionId;
  /** Where it stands. A long poll that times out returns `open`; that is not an error. */
  state: QuestionState;
  /** The current decision version once answered, otherwise `null`. */
  decision: DecisionView | null;
}

/** The request body type of each route; `null` for routes without a body. */
export interface AgentRequests {
  /** See `JoinRequest`. */
  join: JoinRequest;
  /** See `ChallengeRequest`. */
  challenge: ChallengeRequest;
  /** See `SessionRequest`. */
  session: SessionRequest;
  /** No body. */
  status: null;
  /** No body: `work` takes the next ready issue. */
  work: null;
  /** See `ClaimRequest`. */
  claim: ClaimRequest;
  /** See `ReadyRequest`. */
  ready: ReadyRequest;
  /** No body. */
  pin: null;
  /** No body. */
  inbox: null;
  /** See `AckRequest`. */
  ack: AckRequest;
  /** See `AskRequest`. */
  ask: AskRequest;
  /** No body. */
  question: null;
}

/** The success `data` type of each route. */
export interface AgentResults {
  /** See `JoinResult`. */
  join: JoinResult;
  /** See `ChallengeResult`. */
  challenge: ChallengeResult;
  /** See `SessionResult`. */
  session: SessionResult;
  /** See `StatusResult`. */
  status: StatusResult;
  /** See `ClaimResult`. */
  work: ClaimResult;
  /** See `ClaimResult`. */
  claim: ClaimResult;
  /** See `ReadyResult`. */
  ready: ReadyResult;
  /** See `PinResult`. */
  pin: PinResult;
  /** See `InboxResult`. */
  inbox: InboxResult;
  /** See `AckResult`. */
  ack: AckResult;
  /** See `QuestionResult`. */
  ask: QuestionResult;
  /** See `QuestionResult`. */
  question: QuestionResult;
}

// =======================================================================================
// Validation of request invariants

/**
 * Checks the invariants of a route's request body that its type cannot state, and throws an `Error`
 * naming the first one broken. The body's shape must already be established; see the trust boundary
 * note at the top of this module. A failure is answered with `invalid_request`.
 */
export function validateAgentRequest(request: AgentRequestPair): void {
  switch (request.route) {
    case "join":
      requireId("invite", request.body.inviteId, "inviteId");
      if (!INVITE_SECRET.test(request.body.inviteSecret)) {
        throw new Error("inviteSecret is not an invite secret");
      }
      requirePublicKey(request.body.publicKey);
      requireSignature(request.body.signature);
      return;
    case "challenge":
      requireId("agent", request.body.agentId, "agentId");
      return;
    case "session":
      requireId("agent", request.body.agentId, "agentId");
      if (!isChallengeId(request.body.challengeId)) {
        throw new Error("challengeId is not a challenge identifier");
      }
      requireSignature(request.body.signature);
      return;
    case "claim":
      requireId("issue", request.body.issueId, "issueId");
      return;
    case "ready":
      requirePositiveInteger(request.body.generation, "generation");
      if (!isCommitSha(request.body.commit)) throw new Error("commit is not a commit id");
      return;
    case "ack":
      requireText(request.body.plan, MAX_PLAN_LENGTH, "plan");
      return;
    case "ask":
      requirePositiveInteger(request.body.generation, "generation");
      if (!isRequestId(request.body.requestId)) {
        throw new Error("requestId is not an idempotency key");
      }
      requireText(request.body.text, MAX_QUESTION_LENGTH, "text");
      requireOptions(request.body.options);
      requireScope(request.body.scope);
      return;
    case "work":
    case "status":
    case "pin":
    case "inbox":
    case "question":
      return;
    default:
      return unreachable(request);
  }
}

/** A route paired with a request body of that route's type. */
export type AgentRequestPair = {
  [R in AgentRouteName]: { route: R; body: AgentRequests[R] };
}[AgentRouteName];

/**
 * Parses an inbox `limit` query value. A missing value is the default page; anything but a whole
 * number from 1 to `MAX_INBOX_PAGE` throws.
 */
export function parseInboxLimit(value: string | null): number {
  if (value === null) return DEFAULT_INBOX_PAGE;
  return parseBoundedInteger(value, 1, MAX_INBOX_PAGE, "limit");
}

/**
 * Parses a question `waitMs` query value. A missing value means no wait; anything but a whole
 * number from 0 to `MAX_LONG_POLL_MS` throws.
 */
export function parseWaitMs(value: string | null): number {
  if (value === null) return 0;
  return parseBoundedInteger(value, 0, MAX_LONG_POLL_MS, "waitMs");
}

/** Parses an inbox item number from a route path. Anything but a positive safe integer throws. */
export function parseItemNumber(value: string): number {
  return parseBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER, "item");
}

/** True when `value` has the form of a session token. It says nothing about its signature. */
export function isSessionTokenForm(value: string): boolean {
  return value.length <= MAX_SESSION_TOKEN_LENGTH && SESSION_TOKEN.test(value);
}

function parseBoundedInteger(value: string, min: number, max: number, field: string): number {
  // Digits only: `Number()` would also accept "", " 1", "1e3", "0x10" and "1.0".
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(value)) throw new Error(`${field} is not a whole number`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return parsed;
}

function requirePublicKey(value: string): void {
  if (value.length > MAX_PUBLIC_KEY_LENGTH || !ED25519_PUBLIC_KEY.test(value)) {
    throw new Error("publicKey is not an OpenSSH ssh-ed25519 public key");
  }
}

function requireSignature(value: string): void {
  if (value.length > MAX_SIGNATURE_LENGTH || !SSH_SIGNATURE.test(value)) {
    throw new Error("signature is not an armored SSH signature");
  }
}

function requireOptions(options: QuestionOption[]): void {
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    throw new Error(`options must have between ${MIN_OPTIONS} and ${MAX_OPTIONS} entries`);
  }
  const keys = options.map((option) => option.key);
  if (new Set(keys).size !== keys.length) throw new Error("options has a duplicate entry");
  options.forEach((option, index) => {
    if (!OPTION_KEY.test(option.key)) {
      throw new Error(`options[${index}].key is not a valid option key`);
    }
    requireText(option.label, MAX_OPTION_LABEL_LENGTH, `options[${index}].label`);
  });
}

function requireScope(scope: string[]): void {
  if (scope.length === 0 || scope.length > MAX_LIST_LENGTH) {
    throw new Error(`scope must have between 1 and ${MAX_LIST_LENGTH} entries`);
  }
  scope.forEach((path, index) => {
    if (!isScopePath(path)) throw new Error(`scope[${index}] is not a repository path`);
  });
  if (scopeBytes(scope) > MAX_SCOPE_BYTES) {
    throw new Error(`scope is larger than ${MAX_SCOPE_BYTES} bytes`);
  }
}

// C0, DEL and C1 controls, which JSON escapes to as many as six bytes, and lone surrogates, which
// are not text.
const UNPRINTABLE = /[\p{Cc}\p{Cs}]/u;

/**
 * True when `path` can be a question's scope entry: a relative repository path, not blank, with no
 * empty, `.` or `..` segment and no control character. Blank paths are refused because the inbox
 * refuses blank scope text, so an answer naming one could never be delivered.
 */
export function isScopePath(path: string): boolean {
  if (path.trim() === "" || path.length > MAX_PATH_LENGTH || path.startsWith("/")) return false;
  if (UNPRINTABLE.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** The UTF-8 bytes of `scope` as a JSON array, the size `MAX_SCOPE_BYTES` bounds. */
export function scopeBytes(scope: readonly string[]): number {
  let bytes = 0;
  // JSON.stringify escapes lone surrogates, so every code point here is a whole one.
  for (const char of JSON.stringify(scope)) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function requireId(kind: IdKind, value: string, field: string): void {
  if (!isId(kind, value)) throw new Error(`${field} is not a ${kind} identifier`);
}

function requireText(value: string, max: number, field: string): void {
  if (value.trim() === "") throw new Error(`${field} is empty`);
  if (value.length > max) throw new Error(`${field} is longer than ${max} characters`);
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function unreachable(value: never): never {
  throw new Error(`unhandled agent route: ${JSON.stringify(value)}`);
}
