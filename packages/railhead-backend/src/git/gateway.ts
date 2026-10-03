// The Git smart-HTTP gateway of one repository: it authenticates the agent from the request's own
// credentials, asks the claims module for a grant on every request, advertisement and POST alike,
// and streams the request to the Artifacts repository the grant names with a token minted here.
// A cached token never stands in for that check: the grant is decided before any token is asked for.
//
// Main is read-only through this gateway. A push reaches only the fork of a claim its agent holds,
// only to branches, and only whole: if one ref is refused, the push is refused before the pack is
// read. The request and response bodies stream through without being held; each is bounded in
// bytes, and the whole exchange in time. The upstream's response is passed on only when it is a
// Git result of the expected type; its headers are replaced and the token is masked out of its
// body, so neither a redirect, an error page nor an echo can carry the token to the client.
//
// A push is decided three times: when its request arrives, again once its head has been read and
// before a write token is minted, and again immediately before it is sent upstream. A claim closed or
// passed on while the client held its head back, or while the token was being minted, therefore
// never gets a token minted for it or a push sent under it. The head itself must arrive within its
// own time limit; a client that stalls inside it is cut off and its body released. While the push
// uploads, its last bytes are held back: the upstream cannot finish the pack, or apply any ref,
// without them. They are passed on only if the claim is still working at the push's generation once
// the client has sent everything; otherwise the exchange is ended and the push refused.
//
// A push must ask for a report, since without one nothing it did could be recorded. It is recorded
// as `claim.pushed` only for the refs the upstream itself reported updated, once its response has
// ended, and only if the claim is still working at the push's generation then. The
// gateway reads a push's response to its end whether or not the client keeps reading it, so a client
// that stops reading or goes away after its push was applied does not lose the record. A refused,
// failed, cut-off or unreadable push records nothing, nor does one that outlived its claim. A push
// the upstream applied but that was left unrecorded, because its claim changed or the record failed,
// is logged as `git_push_unrecorded` with its claim and generation, for reconciliation.
//
// Nothing here logs a token, a credential, a repository name or a body.

import { MAX_PATH_LENGTH, isCommitSha } from "@railhead/shared/events";
import type { ArtifactsRepoName } from "../contracts/artifacts";
import type { GitAccess, GitGrant } from "../contracts/claims";
import type { AgentPrincipal } from "../contracts/principals";
import {
  fail,
  ok,
  type PortErrorCode,
  type PortFailure,
  type PortResult,
} from "../contracts/result";
import type { GitPort, GitTarget } from "../modules/git/entry";
import type { RepoPorts } from "../repo/composeRepo";
import { EventLogError, type EventLog } from "../repo/eventLog";
import {
  readReceivePackHead,
  receivePackRefusal,
  uploadPackError,
  describeHeadFailure,
  type PushHead,
  type ReceivePackHead,
  type RefUpdate,
} from "./pktLine";
import { PushReportReader, reportFraming } from "./reportStatus";

/** Bounds on one Git request. A test may tighten them. */
export interface GitGatewayLimits {
  /** The largest upload-pack request body, as sent (possibly gzipped), in bytes. */
  readonly maxFetchRequestBytes: number;
  /** The largest receive-pack request body, head and pack together, in bytes. */
  readonly maxPushBytes: number;
  /** The largest response body passed on from the upstream, in bytes. */
  readonly maxResponseBytes: number;
  /** How long a push's client may take to send the head of its body, its command list. */
  readonly headTimeoutMs: number;
  /**
   * How long the upstream may take to answer with headers once the whole request body has been sent
   * to it. An upload is bounded by `maxDurationMs` instead, so a slow but steady push is not cut off.
   */
  readonly headersTimeoutMs: number;
  /**
   * How long one request may take to the end of its response, counted from the upstream call, or
   * for a push from the first read of its body.
   */
  readonly maxDurationMs: number;
  /**
   * The lifetime of the Artifacts token asked for. The gateway asks for at least twice
   * `maxDurationMs`: the adapter hands back a cached token while half the lifetime asked for
   * remains, so any token it returns outlives the request.
   */
  readonly tokenTtlMs: number;
}

/** The production bounds. Design targets, not measured limits of Artifacts. */
export const GIT_GATEWAY_LIMITS: GitGatewayLimits = {
  maxFetchRequestBytes: 16 * 1024 * 1024,
  // Workers accept request bodies up to 100 MB on most plans.
  maxPushBytes: 100 * 1024 * 1024,
  maxResponseBytes: 512 * 1024 * 1024,
  headTimeoutMs: 30_000,
  headersTimeoutMs: 30_000,
  maxDurationMs: 10 * 60_000,
  tokenTtlMs: 20 * 60_000,
};

/** Resolves the HTTPS remote of an Artifacts repository. */
export type RemoteResolver = (repo: ArtifactsRepoName) => Promise<PortResult<string>>;

/** Sends one request to Artifacts. Production passes the global `fetch`. */
export type Upstream = (request: Request) => Promise<Response>;

/** What the gateway receives from its `Repo`. */
export interface GitGatewayContext {
  /** The event log, for confirmed pushes. */
  readonly log: EventLog;
  /** The ports the gateway calls on each request; never called while the Repo is composed. */
  readonly ports: () => Pick<RepoPorts, "sessions" | "claims" | "artifacts">;
  /** Where each Artifacts repository is served. */
  readonly remote: RemoteResolver;
  /** The outbound call to Artifacts. */
  readonly upstream: Upstream;
}

type Service = "git-upload-pack" | "git-receive-pack";

interface Route {
  readonly service: Service;
  readonly phase: "advertise" | "rpc";
}

const AUTH_REALM = 'Basic realm="Railhead", charset="UTF-8"';
/** The longest `Authorization` header read; an agent's id and session token fit well within it. */
const MAX_AUTHORIZATION_LENGTH = 8 * 1024;
const BRANCH_PREFIX = "refs/heads/";
const FORWARDED_REQUEST_HEADERS = ["accept", "content-encoding", "content-type", "git-protocol"];
const textEncoder = new TextEncoder();
/**
 * How much of a push's response the gateway holds for a client that is not reading it, in bytes. A
 * receive-pack response is progress and a report capped at 64 KiB, so this holds a whole one.
 */
const PUSH_RESPONSE_BUFFER_BYTES = 1024 * 1024;
/**
 * How many of a push's last bytes are held back until its claim is checked once more: a pack's
 * trailing SHA-1 checksum, or the whole command list's end for a push that sends no pack.
 */
const HELD_PUSH_BYTES = 20;
const CLAIM_CHANGED = "the claim changed while this push was being sent";
/** How many times a confirmed push's record is tried before it is left to reconciliation. */
const RECORD_ATTEMPTS = 3;

/** Builds the Git gateway of one repository. */
export function createGitGateway(
  context: GitGatewayContext,
  limits: GitGatewayLimits = GIT_GATEWAY_LIMITS,
): GitPort {
  return new GitGateway(context, limits);
}

class GitGateway implements GitPort {
  readonly #context: GitGatewayContext;
  readonly #limits: GitGatewayLimits;

  constructor(context: GitGatewayContext, limits: GitGatewayLimits) {
    this.#context = context;
    this.#limits = limits;
  }

  async serve(request: Request, target: GitTarget, path: string): Promise<Response> {
    const route = routeOf(request, path);
    if (route instanceof Response) return discarding(request, route);
    const operation = route.service === "git-receive-pack" ? "push" : "fetch";
    // Checked before anyone is asked: no grant can make main writable here.
    if (target.kind === "main" && operation === "push") {
      return discarding(
        request,
        text(403, "railhead: main is read-only; push to your claim's remote instead"),
      );
    }
    if (route.phase === "rpc") {
      const expected = `application/x-${route.service}-request`;
      if (request.headers.get("content-type") !== expected) {
        return discarding(request, text(415, `railhead: expected ${expected}`));
      }
    }

    const principal = await this.#authenticate(request);
    if (!principal.ok) return discarding(request, refusal(route, principal));
    const access: GitAccess = { principal: principal.value, target, operation };
    const grant = await this.#context.ports().claims.authorizeGit(access);
    if (!grant.ok) {
      if (route.phase === "rpc" && route.service === "git-receive-pack" && pushRefusable(grant)) {
        return this.#refusePush(request, grant.message);
      }
      return discarding(request, refusal(route, grant));
    }
    if (!grantFits(grant.value, access)) {
      return discarding(request, text(500, "railhead: the Git grant does not match the request"));
    }

    if (route.phase === "rpc" && route.service === "git-receive-pack") {
      return this.#push(request, route, grant.value, access);
    }
    return this.#forward(request, route, grant.value, null);
  }

  /** Reads the push's head, refuses it whole if any ref is refused, and forwards it otherwise. */
  async #push(
    request: Request,
    route: Route,
    grant: GitGrant,
    access: GitAccess,
  ): Promise<Response> {
    const { fence } = grant;
    const { principal } = access;
    if (fence === null || principal === null) {
      return discarding(request, text(500, "railhead: the Git grant does not match the request"));
    }
    if (request.headers.get("content-encoding") !== null) {
      return discarding(request, text(415, "railhead: compressed pushes are not supported"));
    }
    const tooLarge = declaredTooLarge(request, this.#limits.maxPushBytes);
    if (tooLarge !== null) return discarding(request, tooLarge);
    if (request.body === null) return text(400, "railhead: a push needs a body");
    const deadline = new Deadline(this.#limits.maxDurationMs);
    const parsed = await this.#readHead(request.body, deadline);
    if (parsed.kind === "late") {
      deadline.clear();
      return text(408, "railhead: the push's command list did not arrive in time");
    }
    if (parsed.kind === "broken") {
      deadline.clear();
      return text(400, "railhead: the push's body failed before its command list arrived");
    }
    if (parsed.kind === "refused") {
      deadline.clear();
      return text(400, `railhead: ${describeHeadFailure(parsed.reason)}`);
    }
    const { head } = parsed;
    const reasons = new Map<RefUpdate, string>();
    // A ref named twice could be reported both updated and refused, so its outcome is unknowable.
    const named = new Set<string>();
    for (const update of head.updates) {
      const reason = named.has(update.ref)
        ? "the branch is named more than once in this push"
        : refRefusal(update);
      named.add(update.ref);
      if (reason !== null) reasons.set(update, reason);
    }
    if (reasons.size > 0) {
      deadline.clear();
      await parsed.body.cancel();
      return gitResult(
        route.service,
        receivePackRefusal(
          head,
          "railhead: push refused; nothing was updated",
          (update) => reasons.get(update) ?? "refused with the rest of this push",
        ),
      );
    }
    if (reportFraming(head.capabilities) === "none") {
      // Git would take a push it sent without asking for a report as applied, so it is refused as an
      // HTTP error rather than in a report the client never asked for.
      deadline.clear();
      await parsed.body.cancel();
      return text(403, "railhead: pushes must request report-status");
    }
    return this.#forward(request, route, grant, {
      head,
      body: parsed.body,
      deadline,
      admit: () => this.#readmit(route, access, grant, head),
      current: () =>
        this.#context.ports().claims.workingGeneration(fence.claimId) === fence.generation,
      record: (updated) => {
        this.#recordPush(principal, fence, head, updated);
      },
    });
  }

  /**
   * Asks the claims module again whether the push `grant` was given for may still go ahead, and
   * answers the refusal if not. The grant must be the same: a new generation of the same claim is a
   * different owner's authority, not this request's.
   */
  async #readmit(
    route: Route,
    access: GitAccess,
    grant: GitGrant,
    head: ReceivePackHead,
  ): Promise<Response | null> {
    const current = await this.#context.ports().claims.authorizeGit(access);
    if (!current.ok) {
      if (!pushRefusable(current)) return refusal(route, current);
      const message = `railhead: ${current.message}`;
      return gitResult(
        route.service,
        receivePackRefusal(head, message, () => current.message),
      );
    }
    if (sameGrant(current.value, grant)) return null;
    return claimChanged(head);
  }

  /** Answers a push refused by the claims module in Git's own report, read from its head. */
  async #refusePush(request: Request, message: string): Promise<Response> {
    if (request.body === null) return text(403, `railhead: ${message}`);
    const deadline = new Deadline(this.#limits.maxDurationMs);
    const parsed = await this.#readHead(request.body, deadline);
    deadline.clear();
    if (parsed.kind !== "complete") return text(403, `railhead: ${message}`);
    await parsed.body.cancel();
    return gitResult(
      "git-receive-pack",
      receivePackRefusal(parsed.head, `railhead: ${message}`, () => message),
    );
  }

  /**
   * Reads a push's head within the head time limit and `deadline`. Once either passes, the client's
   * body is cancelled, so a client that stalls inside its head holds nothing open. After the head,
   * the deadline ends the upload through the forwarding pipe instead. A body that errors first,
   * such as a client that disconnected, is `broken`.
   */
  async #readHead(
    body: ReadableStream<Uint8Array>,
    deadline: Deadline,
  ): Promise<PushHead | { readonly kind: "late" } | { readonly kind: "broken" }> {
    const reading = new AbortController();
    const stop = (): void => {
      reading.abort(deadline.signal.reason);
    };
    if (deadline.signal.aborted) stop();
    else deadline.signal.addEventListener("abort", stop, { once: true });
    const headTimer = setTimeout(() => {
      deadline.expire();
    }, this.#limits.headTimeoutMs);
    try {
      return await readReceivePackHead(cancelledOnAbort(body, reading.signal));
    } catch {
      return deadline.expired ? { kind: "late" } : { kind: "broken" };
    } finally {
      clearTimeout(headTimer);
      deadline.signal.removeEventListener("abort", stop);
    }
  }

  async #authenticate(request: Request): Promise<PortResult<AgentPrincipal | null>> {
    const header = request.headers.get("authorization");
    if (header === null) return ok(null);
    const credentials = basicCredentials(header);
    if (credentials === null) {
      return fail("unauthenticated", "Sign in with `rh` as your Git credential helper.");
    }
    const principal = await this.#context.ports().sessions.authenticate(credentials.password);
    if (!principal.ok) return principal;
    // The helper sends the clone's agent as the username; a session of another agent is refused.
    if (principal.value.agentId !== credentials.username) {
      return fail("unauthenticated", "The session is not for the agent this clone belongs to.");
    }
    return principal;
  }

  async #forward(
    request: Request,
    route: Route,
    grant: GitGrant,
    push: PendingPush | null,
  ): Promise<Response> {
    const maxBody =
      route.service === "git-receive-pack"
        ? this.#limits.maxPushBytes
        : this.#limits.maxFetchRequestBytes;
    let body: ReadableStream<Uint8Array> | null = null;
    if (route.phase === "rpc") {
      // A push's declared size was checked before its head was read.
      if (push === null) {
        const tooLarge = declaredTooLarge(request, maxBody);
        if (tooLarge !== null) return discarding(request, tooLarge);
      }
      body = push?.body ?? request.body;
      if (body === null) return text(400, "railhead: a Git request needs a body");
    }
    // A push's deadline started before its head was read.
    const deadline = push?.deadline ?? new Deadline(this.#limits.maxDurationMs);
    const release = async (response: Response): Promise<Response> => {
      deadline.clear();
      await body?.cancel().catch(() => undefined);
      return response;
    };

    // A push's claim may have closed while its head was held back: it is decided again before a
    // token is minted for it, and again after, so a closure during the mint is seen too.
    const before = await push?.admit();
    if (before !== undefined && before !== null) return release(before);
    const ports = this.#context.ports();
    const { tokenTtlMs, maxDurationMs } = this.#limits;
    const ttlMs = Math.max(tokenTtlMs, 2 * maxDurationMs);
    const token = await ports.artifacts.token(grant.repo, grant.scope, ttlMs);
    if (!token.ok) return release(refusal(route, token));
    const remote = await this.#context.remote(grant.repo);
    if (!remote.ok) return release(refusal(route, remote));
    const url = upstreamUrl(remote.value, route);
    if (url === null) {
      logFailure(route, "bad_remote");
      return release(text(502, "railhead: the repository store is misconfigured"));
    }
    // Nothing is awaited between this decision and the upstream call.
    const after = await push?.admit();
    if (after !== undefined && after !== null) return release(after);

    // The upstream may answer only once it has read the whole body, so its headers are waited for
    // from then on; until then the upload is bounded by the deadline alone.
    let answered = false;
    let headersTimer: ReturnType<typeof setTimeout> | undefined;
    const awaitHeaders = (): void => {
      if (answered) return;
      headersTimer = setTimeout(() => {
        deadline.expire();
      }, this.#limits.headersTimeoutMs);
    };
    const sent =
      body === null ? null : limited(body, maxBody, deadline, push?.current ?? null, awaitHeaders);
    if (sent === null) awaitHeaders();
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    headers.set("authorization", `Bearer ${token.value.value}`);
    const upstreamRequest = new Request(url, {
      method: route.phase === "advertise" ? "GET" : "POST",
      headers,
      body: sent?.stream ?? null,
      redirect: "manual",
      signal: deadline.signal,
    });

    let response: Response;
    try {
      response = await untilAborted(this.#context.upstream(upstreamRequest), deadline.signal);
    } catch {
      // The upstream may have failed without reading the upload: end the exchange, which cancels it.
      deadline.abort();
      if (sent?.exceeded === true) {
        return text(413, "railhead: the request is larger than Railhead accepts");
      }
      if (sent?.withheld === true && push !== null) return claimChanged(push.head);
      const outcome = deadline.expired ? "timeout" : "unreachable";
      logFailure(route, outcome);
      return outcome === "timeout"
        ? text(504, "railhead: the repository store did not answer in time")
        : text(502, "railhead: the repository store could not be reached");
    } finally {
      answered = true;
      clearTimeout(headersTimer);
    }

    const expectedType =
      route.phase === "advertise"
        ? `application/x-${route.service}-advertisement`
        : `application/x-${route.service}-result`;
    if (response.status !== 200 || response.headers.get("content-type") !== expectedType) {
      // A redirect, a refusal of Railhead's own token or an error page: none is the client's to see.
      deadline.abort();
      await response.body?.cancel().catch(() => undefined);
      logFailure(route, `status_${response.status}`);
      return text(502, "railhead: the repository store refused the request");
    }
    if (response.body === null) {
      deadline.abort();
      return text(502, "railhead: the repository store sent no body");
    }

    const report =
      push === null ? null : new PushReportReader(reportFraming(push.head.capabilities));
    const read = response.body.pipeThrough(
      inspected(this.#limits.maxResponseBytes, deadline, report, () => {
        if (push !== null && report !== null) {
          const outcome = report.end();
          if (outcome.kind === "reported") push.record(outcome.updated);
        }
      }),
    );
    // A push's response is read to its end by the gateway, not by the client's reads, so its report
    // is recorded even when the client stops reading.
    const passed = (push === null ? read : drained(read, PUSH_RESPONSE_BUFFER_BYTES)).pipeThrough(
      masked(textEncoder.encode(token.value.value)),
    );
    return new Response(passed, {
      status: 200,
      headers: { "content-type": expectedType, "cache-control": "no-cache" },
    });
  }

  /**
   * Records each ref the upstream reported updated; a deleted ref names no commit and is skipped.
   * Nothing is recorded unless the claim is still working at the push's generation when the record
   * is written: a claim that expired, changed hands or went ready while the push was in flight
   * keeps its own history. A record that fails is tried again up to `RECORD_ATTEMPTS` times in
   * all, unless the event log refused it, which no retry changes. Whenever the refs the push moved
   * stay in the fork without a `claim.pushed` event, the `git_push_unrecorded` warning names the
   * claim and generation so the fork can be reconciled. The client's response is not cut short
   * either way: the upstream has already applied the push.
   */
  #recordPush(
    principal: AgentPrincipal,
    fence: { claimId: string; generation: number },
    head: ReceivePackHead,
    updated: ReadonlySet<string>,
  ): void {
    const pushed = head.updates.filter(
      (update) => update.kind !== "delete" && updated.has(update.ref),
    );
    if (pushed.length === 0) return;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const recorded = this.#appendPushed(principal, fence, pushed);
        if (!recorded) logUnrecorded(fence, "claim_changed");
        return;
      } catch (error) {
        if (error instanceof EventLogError || attempt >= RECORD_ATTEMPTS) {
          logUnrecorded(fence, "record_failed");
          return;
        }
      }
    }
  }

  /** Appends `pushed` in one transaction if the claim is still working at the fence's generation. */
  #appendPushed(
    principal: AgentPrincipal,
    fence: { claimId: string; generation: number },
    pushed: readonly RefUpdate[],
  ): boolean {
    return this.#context.log.transaction((tx) => {
      if (this.#context.ports().claims.workingGeneration(fence.claimId) !== fence.generation) {
        return false;
      }
      for (const update of pushed) {
        tx.append(
          { kind: "agent", id: principal.agentId },
          {
            type: "claim.pushed",
            data: {
              claimId: fence.claimId,
              generation: fence.generation,
              ref: update.ref,
              from: update.kind === "create" ? null : update.oldId,
              to: update.newId,
            },
          },
        );
      }
      return true;
    }).value;
  }
}

interface PendingPush {
  readonly head: ReceivePackHead;
  /** The whole request body, head included. */
  readonly body: ReadableStream<Uint8Array>;
  /** The push's time limit, running since its body was first read. */
  readonly deadline: Deadline;
  /** Decides the push again against current claim state: `null` to go ahead, or the refusal. */
  readonly admit: () => Promise<Response | null>;
  /** Whether the claim is still working at the push's generation, read without awaiting. */
  readonly current: () => boolean;
  /** Records the refs the upstream reported updated. */
  readonly record: (updated: ReadonlySet<string>) => void;
}

function routeOf(request: Request, path: string): Route | Response {
  const method = request.method;
  switch (path) {
    case "/info/refs": {
      if (method !== "GET") return methodNotAllowed("GET");
      const service = new URL(request.url).searchParams.get("service");
      if (service !== "git-upload-pack" && service !== "git-receive-pack") {
        return text(403, "railhead: only Git's smart HTTP protocol is served");
      }
      return { service, phase: "advertise" };
    }
    case "/git-upload-pack":
    case "/git-receive-pack":
      if (method !== "POST") return methodNotAllowed("POST");
      return {
        service: path === "/git-upload-pack" ? "git-upload-pack" : "git-receive-pack",
        phase: "rpc",
      };
    default:
      return text(404, "railhead: not a Git smart HTTP route");
  }
}

/** Whether `grant` is the one `access` can use: no write for a fetch, and a push fenced to its fork. */
function grantFits(grant: GitGrant, access: GitAccess): boolean {
  switch (access.operation) {
    case "fetch":
      return grant.scope === "read" && grant.fence === null;
    case "push":
      return (
        access.target.kind === "fork" &&
        grant.scope === "write" &&
        grant.fence !== null &&
        grant.fence.claimId === access.target.claimId
      );
    default:
      return access.operation satisfies never;
  }
}

/** Whether `current` is the grant `original` was: the same repository, scope, claim and generation. */
function sameGrant(current: GitGrant, original: GitGrant): boolean {
  return (
    current.repo === original.repo &&
    current.scope === original.scope &&
    current.fence?.claimId === original.fence?.claimId &&
    current.fence?.generation === original.fence?.generation
  );
}

/** Refuses every ref of a push whose claim changed after it was admitted. */
function claimChanged(head: ReceivePackHead): Response {
  return gitResult(
    "git-receive-pack",
    receivePackRefusal(head, `railhead: ${CLAIM_CHANGED}`, () => CLAIM_CHANGED),
  );
}

/** Why one update of an otherwise authorized push is refused, or `null` to allow it. */
function refRefusal(update: RefUpdate): string | null {
  const { ref } = update;
  if (!ref.startsWith(BRANCH_PREFIX) || ref.length === BRANCH_PREFIX.length) {
    return "only branches under refs/heads/ can be pushed";
  }
  if (textEncoder.encode(ref).length > MAX_PATH_LENGTH) return "the branch name is too long";
  if (update.kind !== "create" && !isCommitSha(update.oldId)) {
    return "only SHA-1 repositories are supported";
  }
  if (update.kind !== "delete" && !isCommitSha(update.newId)) {
    return "only SHA-1 repositories are supported";
  }
  return null;
}

/** Whether a refused grant is one Git should print beside each ref, rather than as an HTTP error. */
function pushRefusable(failure: PortFailure): boolean {
  return statusFor(failure.code) === 403;
}

function basicCredentials(header: string): { username: string; password: string } | null {
  if (header.length > MAX_AUTHORIZATION_LENGTH) return null;
  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(header.trim());
  const encoded = match?.[1];
  if (encoded === undefined) return null;
  let decoded: string;
  try {
    const binary = atob(encoded);
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon <= 0 || colon === decoded.length - 1) return null;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

/** The HTTP status a refusal is answered with. */
function statusFor(code: PortErrorCode): number {
  switch (code) {
    case "unauthenticated":
    case "challenge_invalid":
      return 401;
    case "not_found":
    case "cursor_ahead":
      return 404;
    case "payload_too_large":
      return 413;
    case "unsupported_media_type":
      return 415;
    case "busy":
    case "rate_limited":
    case "unavailable":
      return 503;
    case "internal":
      return 500;
    case "invalid_request":
    case "join_refused":
    case "identity_pending":
    case "identity_revoked":
    case "quota_exceeded":
    case "no_work":
    case "claim_exists":
    case "issue_unavailable":
    case "claim_closed":
    case "stale_generation":
    case "after_ready":
    case "unacked_decision":
    case "commit_not_found":
    case "idempotency_mismatch":
    case "proof_invalid":
    case "proof_expired":
    case "action_stale":
    case "bootstrap_closed":
    case "decision_superseded":
    case "check_mismatch":
    case "check_not_passed":
    case "main_moved":
      return 403;
    default:
      return code satisfies never;
  }
}

/**
 * Answers a refusal as Git expects it at each step: an advertisement or a transient failure as an
 * HTTP error whose text Git prints, a fetch refused at its POST as an `ERR` packet. An
 * unauthenticated request always gets 401, so Git asks the credential helper.
 */
function refusal(route: Route, failure: PortFailure): Response {
  const status = statusFor(failure.code);
  const message = `railhead: ${failure.message}`;
  if (status === 401) {
    return text(401, message, { "www-authenticate": AUTH_REALM });
  }
  if (status === 503) return text(503, message, { "retry-after": "5" });
  if (route.phase === "rpc" && route.service === "git-upload-pack" && status === 403) {
    return gitResult(route.service, uploadPackError(message));
  }
  return text(status, message);
}

function upstreamUrl(remote: string, route: Route): URL | null {
  let base: URL;
  try {
    base = new URL(remote);
  } catch {
    return null;
  }
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    return null;
  }
  const suffix = route.phase === "advertise" ? `info/refs?service=${route.service}` : route.service;
  return new URL(`${base.href.replace(/\/+$/, "")}/${suffix}`);
}

function declaredTooLarge(request: Request, max: number): Response | null {
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared) || Number(declared) <= max) return null;
  return text(413, "railhead: the request is larger than Railhead accepts");
}

function text(status: number, message: string, headers: Record<string, string> = {}): Response {
  // Git prints a text/plain error body as `remote: ...` lines.
  return new Response(`${message}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function gitResult(service: Service, body: Uint8Array): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": `application/x-${service}-result`, "cache-control": "no-cache" },
  });
}

function methodNotAllowed(allow: string): Response {
  return text(405, "railhead: method not allowed", { allow });
}

/** Returns `response` after releasing the request body nobody will read. */
async function discarding(request: Request, response: Response): Promise<Response> {
  await request.body?.cancel().catch(() => undefined);
  return response;
}

/**
 * Warns that a push moved refs in a claim's fork without a `claim.pushed` event. The claim id and
 * generation are Railhead's own; no ref, commit or other text from the push is logged.
 */
function logUnrecorded(
  fence: { claimId: string; generation: number },
  reason: "claim_changed" | "record_failed",
): void {
  console.warn(
    JSON.stringify({
      event: "git_push_unrecorded",
      claimId: fence.claimId,
      generation: fence.generation,
      reason,
    }),
  );
}

function logFailure(route: Route, outcome: string): void {
  // Codes only: never a repository name, a token, a header or a body.
  console.warn(
    JSON.stringify({
      event: "git_upstream_failed",
      service: route.service,
      phase: route.phase,
      outcome,
    }),
  );
}

/**
 * Settles with `work`, or rejects once `signal` aborts. A response that arrives after the abort is
 * released unread.
 */
function untilAborted(work: Promise<Response>, signal: AbortSignal): Promise<Response> {
  let rejectAborted: ((reason: unknown) => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => {
    rejectAborted?.(signal.reason);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  void work.then(
    async (late) => {
      if (signal.aborted) await late.body?.cancel().catch(() => undefined);
    },
    () => undefined,
  );
  return Promise.race([work, aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

/**
 * The time limit of one upstream exchange. Expiring it, or ending the exchange early, aborts the
 * call and errors both bodies, which cancels the client's upload.
 */
class Deadline {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  #expired = false;

  constructor(ms: number) {
    this.#timer = setTimeout(() => {
      this.expire();
    }, ms);
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get expired(): boolean {
    return this.#expired;
  }

  expire(): void {
    if (this.#controller.signal.aborted) return;
    this.#expired = true;
    this.#end(new Error("the Git exchange took too long"));
  }

  /** Ends the exchange after a failure; unlike `expire`, it does not count as a timeout. */
  abort(): void {
    if (this.#controller.signal.aborted) return;
    this.#end(new Error("the Git exchange failed"));
  }

  #end(reason: Error): void {
    clearTimeout(this.#timer);
    this.#controller.abort(reason);
  }

  clear(): void {
    clearTimeout(this.#timer);
  }

  /** Errors `controller`'s stream when the deadline expires or the exchange ends. */
  watch(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (this.#controller.signal.aborted) {
      controller.error(this.#controller.signal.reason);
      return;
    }
    this.#controller.signal.addEventListener(
      "abort",
      () => {
        controller.error(this.#controller.signal.reason);
      },
      { once: true },
    );
  }
}

/**
 * Passes `body` on until `signal` aborts, then errors the result and cancels `body`, releasing a
 * read the client is holding open.
 */
function cancelledOnAbort(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const onAbort = (): void => {
          controller.error(signal.reason);
          reader.cancel(signal.reason).catch(() => undefined);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (signal.aborted) return;
        if (done) controller.close();
        else controller.enqueue(value);
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/**
 * A request body that errors once more than `max` bytes pass or the deadline expires, and calls
 * `ended` once the whole body has passed. With `current`, the body's last `HELD_PUSH_BYTES` bytes
 * are held back until the client has sent everything, and passed on only if `current` still holds
 * then; otherwise the exchange is ended and the body is `withheld`.
 */
function limited(
  body: ReadableStream<Uint8Array>,
  max: number,
  deadline: Deadline,
  current: (() => boolean) | null,
  ended: () => void,
): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly exceeded: boolean;
  readonly withheld: boolean;
} {
  let seen = 0;
  let exceeded = false;
  let withheld = false;
  let held = new Uint8Array(0);
  const stream = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start(controller) {
        deadline.watch(controller);
      },
      transform(chunk, controller) {
        seen += chunk.length;
        if (seen > max) {
          exceeded = true;
          controller.error(new Error("the request body is too large"));
          return;
        }
        if (current === null) {
          controller.enqueue(chunk);
          return;
        }
        if (chunk.length >= HELD_PUSH_BYTES) {
          // The held bytes come before this chunk, which now holds the last ones itself.
          if (held.length > 0) controller.enqueue(held);
          controller.enqueue(chunk.subarray(0, chunk.length - HELD_PUSH_BYTES));
          held = chunk.slice(chunk.length - HELD_PUSH_BYTES);
          return;
        }
        const data = new Uint8Array(held.length + chunk.length);
        data.set(held);
        data.set(chunk, held.length);
        const cut = Math.max(0, data.length - HELD_PUSH_BYTES);
        if (cut > 0) controller.enqueue(data.subarray(0, cut));
        held = data.slice(cut);
      },
      flush(controller) {
        if (current !== null) {
          if (!current()) {
            withheld = true;
            controller.error(new Error(CLAIM_CHANGED));
            deadline.abort();
            return;
          }
          if (held.length > 0) controller.enqueue(held);
        }
        ended();
      },
    }),
  );
  return {
    stream,
    get exceeded() {
      return exceeded;
    },
    get withheld() {
      return withheld;
    },
  };
}

/**
 * Passes the upstream's response on: errors once more than `max` bytes pass or the deadline
 * expires, feeds a push's report reader, and calls `ended` once the whole response has passed.
 */
function inspected(
  max: number,
  deadline: Deadline,
  report: PushReportReader | null,
  ended: () => void,
): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      deadline.watch(controller);
    },
    transform(chunk, controller) {
      seen += chunk.length;
      if (seen > max) {
        deadline.clear();
        controller.error(new Error("the response is too large"));
        return;
      }
      report?.push(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      deadline.clear();
      ended();
    },
    cancel() {
      deadline.clear();
    },
  });
}

/**
 * Reads `source` to its end whatever its own reader does, holding at most `buffer` unread bytes for
 * it. Past that, it waits for the reader to catch up, so a reader that stalls is still bounded by
 * whatever bounds `source`. Once the reader cancels, the rest of `source` is read and dropped.
 */
function drained(source: ReadableStream<Uint8Array>, buffer: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let gone = false;
  let wake: (() => void) | null = null;
  const resume = (): void => {
    wake?.();
    wake = null;
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        // `cancel` sets `gone` while the pump waits.
        const full = (): boolean => !gone && (controller.desiredSize ?? 0) <= 0;
        const pump = async (): Promise<void> => {
          for (;;) {
            while (full()) {
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
            }
            const { done, value } = await reader.read();
            if (done) {
              if (!gone) controller.close();
              return;
            }
            if (!gone) controller.enqueue(value);
          }
        };
        // `source` errors only when the exchange is cut off, which records nothing; the reader, if
        // still there, sees the same error.
        pump().catch((error: unknown) => {
          if (!gone) controller.error(error);
        });
      },
      pull: resume,
      cancel() {
        gone = true;
        resume();
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: buffer }),
  );
}

/**
 * Replaces every occurrence of `secret` with asterisks of the same length, so pkt-line lengths stay
 * valid. It holds back only the bytes that could begin an occurrence split across chunks.
 */
function masked(secret: Uint8Array): TransformStream<Uint8Array, Uint8Array> {
  const keep = secret.length - 1;
  let carry = new Uint8Array(0);
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const data = new Uint8Array(carry.length + chunk.length);
      data.set(carry);
      data.set(chunk, carry.length);
      mask(data, secret);
      const cut = Math.max(0, data.length - keep);
      if (cut > 0) controller.enqueue(data.subarray(0, cut));
      carry = data.slice(cut);
    },
    flush(controller) {
      if (carry.length > 0) controller.enqueue(carry);
    },
  });
}

function mask(data: Uint8Array, secret: Uint8Array): void {
  const first = secret[0];
  if (first === undefined) return;
  let from = data.indexOf(first);
  while (from !== -1 && from + secret.length <= data.length) {
    let match = true;
    for (let offset = 1; offset < secret.length; offset += 1) {
      if (data[from + offset] !== secret[offset]) {
        match = false;
        break;
      }
    }
    if (match) {
      data.fill(0x2a, from, from + secret.length);
      from = data.indexOf(first, from + secret.length);
    } else {
      from = data.indexOf(first, from + 1);
    }
  }
}
