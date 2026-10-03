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
// the client has sent everything; otherwise the exchange is ended and the push refused. Here and
// below, the push's generation stands for its whole fence: the generation and the claim's working
// episode, which a pin and a reopening each raise, so a push granted before ready never outlives a
// reopening at the same generation.
//
// A push must ask for a report, since without one nothing it did could be recorded. It is recorded
// as `claim.pushed` only for the refs the upstream itself reported updated, once its response has
// ended, and only if the claim is still working at the push's generation then. The
// gateway reads a push's response to its end whether or not the client keeps reading it, so a client
// that stops reading or goes away after its push was applied does not lose the record; a client
// that falls more than a bounded buffer behind loses its response instead. A refused,
// failed, cut-off or unreadable push records nothing, nor does one that outlived its claim.
//
// A push the upstream applied is recorded even when its response gives no record. Before its last
// bytes are sent, the push is saved in storage as pending, with its claim, generation and refs, and
// the Repo's alarm is asked for once the exchange must have ended, in the same transaction. The
// bytes wait until storage confirms that alarm, asked for a second time if the first write failed;
// if the push cannot be saved or its alarm set, the bytes are withheld and the row dropped, so no
// applied push is ever pending without a wake to record it. A restarted gateway asks again for the
// wake its pending pushes need. Its report settles it: the record and the pending row are written in one
// transaction, and a complete refusal drops it. A push the report does not settle, because the
// outcome is unknown or the record failed, is left to the alarm. Finding a branch at the commit the
// push sent proves nothing on its own: a stale push Git refused can find the fork already there. So
// before a push is released, the gateway reads the branches it names, and keeps that read only if
// no other push to the fork was in flight or released meanwhile; each fork counts the pushes
// released to it. The alarm records a branch read at the push's old id then and at its new id now,
// with no push released to the fork since, while the claim is still working at the push's
// generation. Otherwise it records nothing and logs the outcome as unknown. This assumes the
// gateway is the fork's only writer once its claim is working. A pending push whose claim moved on
// is dropped and logged as `git_push_unrecorded`; that a claim can move on after its push's last
// bytes were sent is #159. So is a push saved before pushes were fenced to an episode: its claim
// may have been pinned and reopened at the same generation since, which its row cannot show.
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
import { atomically, migrate, type RepoStorage } from "../repo/storage";
import {
  readReceivePackHead,
  receivePackRefusal,
  uploadPackError,
  describeHeadFailure,
  type PushHead,
  type ReceivePackHead,
  type RefUpdate,
} from "./pktLine";
import { AdvertisedRefsReader } from "./refAdvertisement";
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
  /** The repository's storage, where pushes wait for their record. */
  readonly storage: RepoStorage;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly clock: () => number;
  /**
   * Asks the Repo's alarm to run `resume` no later than `at`, issuing the write at once so it commits
   * with the transaction that asks for it. Resolves `true` once storage holds an alarm no later than
   * `at`, `false` if the write failed; never rejects.
   */
  readonly wake: (at: number) => Promise<boolean>;
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
 * client further behind than this is dropped, while the gateway reads on to the report.
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
const UNSAVED = "the push could not be saved for its record";

/** The migration owner name of the gateway's own table. */
const GIT_OWNER = "git_gateway";
/** Released schema steps of the gateway's table. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE git_pending_push (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    repo TEXT NOT NULL,
    updates TEXT NOT NULL,
    due_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL
  ) STRICT`,
  "CREATE INDEX git_pending_push_due ON git_pending_push (due_at)",
  // How many pushes each fork has had released to it, and each pending push's place in that count
  // with the fork's branches as read before it was released, or NULL when no read can stand for them.
  "CREATE TABLE git_fork_release (repo TEXT PRIMARY KEY, released INTEGER NOT NULL) STRICT",
  "ALTER TABLE git_pending_push ADD COLUMN release INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE git_pending_push ADD COLUMN prior TEXT",
  // The claim's working episode the push was granted in. A row saved before this step has none and
  // is fenced to the first episode.
  "ALTER TABLE git_pending_push ADD COLUMN episode INTEGER NOT NULL DEFAULT 1",
  // That first episode is also the episode of a claim that was pinned and reopened at the same
  // generation before the claims module counted episodes, so it cannot stand for a row saved before
  // the episode step. Every row present now is marked unfenced and dropped without being recorded.
  "ALTER TABLE git_pending_push ADD COLUMN unfenced INTEGER NOT NULL DEFAULT 0",
  "UPDATE git_pending_push SET unfenced = 1",
];
/** How many pending pushes one alarm reconciles; the alarm is asked for again for the rest. */
const RECONCILE_BATCH = 8;
/** How many times a pending push's fork is read before it is dropped and logged. */
const RECONCILE_ATTEMPTS = 5;
/** The wait before reading a fork again, doubled after each failed read. */
const RECONCILE_RETRY_MS = 60_000;
/** The largest ref advertisement read back from a fork, in bytes. */
const MAX_ADVERTISEMENT_BYTES = 1024 * 1024;
const ADVERTISE_UPLOAD_PACK: Route = { service: "git-upload-pack", phase: "advertise" };

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
    migrate(context.storage, GIT_OWNER, MIGRATIONS);
    // A wake asked for with a pending push may have failed to reach storage; ask again. A failure is
    // logged by the Repo, and the next push or start asks again.
    const next = this.#nextDue();
    if (next !== null) void context.wake(next);
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
    if (head.updates.length === 0) {
      // Git probes with a bare flush before streaming a push larger than `http.postBuffer`, and
      // fails the push unless the probe gets a 200. It updates nothing, so it reaches no upstream.
      deadline.clear();
      await parsed.body.cancel();
      return gitResult(route.service, new Uint8Array(0));
    }
    if (reportFraming(head.capabilities) === "none") {
      // Git would take a push it sent without asking for a report as applied, so it is refused as an
      // HTTP error rather than in a report the client never asked for.
      deadline.clear();
      await parsed.body.cancel();
      return text(403, "railhead: pushes must request report-status");
    }
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
      return pushRefusal(
        head,
        "railhead: push refused; nothing was updated",
        (update) => reasons.get(update) ?? "refused with the rest of this push",
      );
    }
    let pending: number | null = null;
    let observed: Observed | null = null;
    return this.#forward(request, route, grant, {
      head,
      body: parsed.body,
      deadline,
      admit: () => this.#readmit(route, access, grant, head),
      observe: async () => {
        observed = await this.#observe(grant.repo, head);
      },
      release: async () => {
        let saved: Saved | null;
        try {
          saved = this.#save(principal, fence, grant.repo, head, observed);
        } catch (error) {
          logPush("git_push_unsaved", fence, { error: errorName(error) });
          return "unsaved";
        }
        if (saved === null) return "claim_changed";
        // Without a wake, a push whose report is lost would stay pending with nothing to record it.
        if (!(await saved.armed) && !(await this.#context.wake(saved.dueAt))) {
          logPush("git_push_unarmed", fence, {});
          this.#drop(saved.id, fence);
          return "unsaved";
        }
        // The claim may have moved on while the alarm was written.
        if (!this.#working(fence)) {
          this.#drop(saved.id, fence);
          return "claim_changed";
        }
        pending = saved.id;
        return "released";
      },
      record: (updated) => {
        if (pending !== null) this.#recordPush(pending, principal, fence, head, updated);
      },
      refused: () => {
        if (pending !== null) this.#drop(pending, fence);
      },
      unknown: () => {
        logUnrecorded(fence, "outcome_unknown");
      },
    });
  }

  /**
   * Reads the branches of `repo` that a push names before it is released, for reconciliation to
   * tell whether the push moved them. The read stands for the fork at the push's release only if no
   * push was in flight to the fork when it began and none is released before this one, which
   * `#save` checks. Returns `null` when a push was in flight or the fork could not be read; the push
   * goes ahead either way.
   */
  async #observe(repo: ArtifactsRepoName, head: ReceivePackHead): Promise<Observed | null> {
    const inFlight = this.#context.storage.sql
      .exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM git_pending_push WHERE repo = ?",
        repo,
      )
      .one().count;
    if (inFlight > 0) return null;
    const released = this.#released(repo);
    const refs = await this.#readRefs(
      repo,
      head.updates.map((update) => update.ref),
    );
    return refs === null ? null : { released, refs };
  }

  /** How many pushes have been released to `repo`. */
  #released(repo: string): number {
    const row = this.#context.storage.sql
      .exec<{ released: number }>("SELECT released FROM git_fork_release WHERE repo = ?", repo)
      .toArray()[0];
    return row?.released ?? 0;
  }

  /**
   * Saves a push about to be released as pending, counts its release to the fork, and asks the alarm
   * for it once the exchange must have ended, in one transaction, if the claim is still working at
   * the push's generation. The fork's branches `observed` before are kept only if no other push was
   * released to the fork since they were read. Returns the pending row with its alarm write, or
   * `null` when the claim changed.
   */
  #save(
    principal: AgentPrincipal,
    fence: Fence,
    repo: ArtifactsRepoName,
    head: ReceivePackHead,
    observed: Observed | null,
  ): Saved | null {
    const updates = head.updates.flatMap(pushedRef);
    const dueAt = this.#context.clock() + this.#limits.maxDurationMs;
    return atomically(this.#context.storage, () => {
      if (!this.#working(fence)) return null;
      const { sql } = this.#context.storage;
      const before = this.#released(repo);
      const prior =
        observed === null || observed.released !== before
          ? null
          : JSON.stringify(
              Object.fromEntries(
                updates.map((update) => [update.ref, observed.refs.get(update.ref) ?? null]),
              ),
            );
      sql.exec(
        `INSERT INTO git_fork_release (repo, released) VALUES (?, ?)
         ON CONFLICT (repo) DO UPDATE SET released = excluded.released`,
        repo,
        before + 1,
      );
      const row = sql
        .exec<{ id: number }>(
          `INSERT INTO git_pending_push
             (claim_id, generation, episode, agent_id, repo, updates, due_at, attempts, release,
              prior)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?) RETURNING id`,
          fence.claimId,
          fence.generation,
          fence.episode,
          principal.agentId,
          repo,
          JSON.stringify(updates),
          dueAt,
          before + 1,
          prior,
        )
        .one();
      return { id: row.id, dueAt, armed: this.#context.wake(dueAt) };
    });
  }

  /** Whether the push's claim is still working at the push's generation and episode. */
  #working(fence: Fence): boolean {
    const { claims } = this.#context.ports();
    return (
      claims.workingGeneration(fence.claimId) === fence.generation &&
      claims.workingEpisode(fence.claimId) === fence.episode
    );
  }

  /** Drops a pending push its complete report refused. If that fails, the alarm finds nothing moved. */
  #drop(pending: number, fence: Fence): void {
    try {
      atomically(this.#context.storage, () => {
        this.#context.storage.sql.exec("DELETE FROM git_pending_push WHERE id = ?", pending);
      });
    } catch (error) {
      logPush("git_push_drop_failed", fence, { error: errorName(error) });
    }
  }

  /**
   * Reconciles the pending pushes that are due: each one's report never settled it. Asks the alarm
   * again for the earliest one left, even when reconciling one failed.
   */
  async resume(): Promise<void> {
    try {
      const due = this.#context.storage.sql
        .exec<PendingRow>(
          `SELECT id, claim_id, generation, episode, agent_id, repo, updates, attempts, release,
             prior, unfenced
           FROM git_pending_push WHERE due_at <= ? ORDER BY due_at, id LIMIT ?`,
          this.#context.clock(),
          RECONCILE_BATCH,
        )
        .toArray();
      for (const row of due) {
        try {
          await this.#reconcile(row);
        } catch (error) {
          this.#retryLater(row, error);
        }
      }
    } finally {
      const next = this.#nextDue();
      // A failed write is logged by the Repo, whose alarm handler then throws to be retried.
      if (next !== null) await this.#context.wake(next);
    }
  }

  /**
   * Reads the fork of one pending push back and records each ref the push is proven to have moved:
   * read at the push's old id just before its release and found at its new id now, with no other
   * push released to the fork since. Finding a ref at the new id alone proves nothing, since a stale
   * push that was refused can find the fork already there. Without that before-read, or once another
   * push was released after this one, nothing is recorded and the outcome is logged as unknown. A
   * push whose claim moved on is dropped, and so is one saved before pushes were fenced to an episode.
   */
  async #reconcile(row: PendingRow): Promise<void> {
    const fence = pendingFence(row);
    const updates = parsePushedRefs(row.updates);
    const prior = row.prior === null ? null : parsePrior(row.prior);
    if (updates === null || prior === undefined) {
      this.#drop(row.id, fence);
      logUnrecorded(fence, "unreadable_record");
      return;
    }
    if (row.unfenced !== 0) {
      this.#drop(row.id, fence);
      logUnrecorded(fence, "unfenced");
      return;
    }
    if (!this.#working(fence)) {
      this.#drop(row.id, fence);
      logUnrecorded(fence, "claim_changed");
      return;
    }
    const unproven: Unproven | null =
      prior === null
        ? "unobserved"
        : this.#released(row.repo) !== row.release
          ? "later_push"
          : null;
    if (prior === null || unproven !== null) {
      if (this.#settle(row.id, row.agent_id, fence, [], null) !== "settled") {
        logUnrecorded(fence, "outcome_unknown", unproven ?? "unobserved");
      }
      return;
    }
    const refs = await this.#readRefs(
      row.repo,
      updates.map((update) => update.ref),
    );
    if (refs === null) {
      this.#retryLater(row, null);
      return;
    }
    // A ref read at the push's old id can have moved only by this push; one read elsewhere refused it.
    const applied = updates.filter(
      (update) => prior.get(update.ref) === update.from && refs.get(update.ref) === update.to,
    );
    // Another push released while the fork was read could have made that move; the count is checked
    // again in the transaction that records it.
    const outcome = this.#settle(row.id, row.agent_id, fence, applied, {
      repo: row.repo,
      release: row.release,
    });
    switch (outcome) {
      case "recorded":
        logPush("git_push_reconciled", fence, {
          recorded: applied.length,
          skipped: updates.length - applied.length,
        });
        return;
      case "claim_changed":
        if (applied.length > 0) logUnrecorded(fence, "claim_changed");
        return;
      case "later_push":
        logUnrecorded(fence, "outcome_unknown", "later_push");
        return;
      case "settled":
        return;
      default:
        return unreachable(outcome);
    }
  }

  /**
   * Counts a failed reconciliation of `row` and waits longer before the next one; drops and logs
   * the push once `RECONCILE_ATTEMPTS` reads have failed.
   */
  #retryLater(row: PendingRow, error: unknown): void {
    const fence = pendingFence(row);
    if (error !== null) logPush("git_push_reconcile_failed", fence, { error: errorName(error) });
    const attempts = row.attempts + 1;
    if (attempts >= RECONCILE_ATTEMPTS) {
      this.#drop(row.id, fence);
      logUnrecorded(fence, "reconcile_failed");
      return;
    }
    atomically(this.#context.storage, () => {
      this.#context.storage.sql.exec(
        "UPDATE git_pending_push SET attempts = ?, due_at = ? WHERE id = ?",
        attempts,
        this.#context.clock() + RECONCILE_RETRY_MS * 2 ** row.attempts,
        row.id,
      );
    });
  }

  #nextDue(): number | null {
    const row = this.#context.storage.sql
      .exec<{ due_at: number | null }>("SELECT MIN(due_at) AS due_at FROM git_pending_push")
      .toArray()[0];
    return row?.due_at ?? null;
  }

  /**
   * Reads which commits `wanted` branches of `repo` point at, from its upload-pack advertisement,
   * within the headers wait. Returns `null` when the advertisement could not be read whole.
   */
  async #readRefs(
    repo: ArtifactsRepoName,
    wanted: readonly string[],
  ): Promise<ReadonlyMap<string, string> | null> {
    const { tokenTtlMs, maxDurationMs, headersTimeoutMs } = this.#limits;
    const token = await this.#context
      .ports()
      .artifacts.token(repo, "read", Math.max(tokenTtlMs, 2 * maxDurationMs));
    if (!token.ok) return null;
    const remote = await this.#context.remote(repo);
    if (!remote.ok) return null;
    const url = upstreamUrl(remote.value, ADVERTISE_UPLOAD_PACK);
    if (url === null) {
      logFailure(ADVERTISE_UPLOAD_PACK, "bad_remote");
      return null;
    }
    const deadline = new Deadline(headersTimeoutMs);
    try {
      const response = await untilAborted(
        this.#context.upstream(
          new Request(url, {
            headers: { authorization: `Bearer ${token.value.value}` },
            redirect: "manual",
            signal: deadline.signal,
          }),
        ),
        deadline.signal,
      );
      if (
        response.status !== 200 ||
        response.headers.get("content-type") !== "application/x-git-upload-pack-advertisement" ||
        response.body === null
      ) {
        await response.body?.cancel().catch(() => undefined);
        logFailure(ADVERTISE_UPLOAD_PACK, `status_${response.status}`);
        return null;
      }
      const reader = new AdvertisedRefsReader(wanted);
      const body = response.body
        .pipeThrough(inspected(MAX_ADVERTISEMENT_BYTES, deadline, null, () => undefined))
        .getReader();
      for (;;) {
        const { done, value } = await body.read();
        if (done) break;
        reader.push(value);
      }
      const read = reader.end();
      if (read.kind === "read") return read.refs;
      logFailure(ADVERTISE_UPLOAD_PACK, "unreadable");
      return null;
    } catch {
      logFailure(ADVERTISE_UPLOAD_PACK, deadline.expired ? "timeout" : "unreachable");
      return null;
    } finally {
      deadline.abort();
    }
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
      return pushRefusal(head, `railhead: ${current.message}`, () => current.message);
    }
    if (sameGrant(current.value, grant)) return null;
    return claimChanged(head);
  }

  /**
   * Answers a push refused by the claims module in Git's own report, read from its head. Git's
   * probe gets the refusal as an HTTP error, as does a push that asked for no report.
   */
  async #refusePush(request: Request, message: string): Promise<Response> {
    if (request.body === null) return text(403, `railhead: ${message}`);
    const deadline = new Deadline(this.#limits.maxDurationMs);
    const parsed = await this.#readHead(request.body, deadline);
    deadline.clear();
    if (parsed.kind !== "complete") return text(403, `railhead: ${message}`);
    await parsed.body.cancel();
    return pushRefusal(parsed.head, `railhead: ${message}`, () => message);
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
    await push?.observe();
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
      body === null ? null : limited(body, maxBody, deadline, push?.release ?? null, awaitHeaders);
    // Once a push's last bytes are sent, the upstream may have applied it: an exchange that then
    // ends without a readable report leaves the fork to reconciliation.
    let settled = false;
    const outcomeUnknown = (): void => {
      if (settled || push === null || sent?.released !== true) return;
      settled = true;
      push.unknown();
    };
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
      if (sent?.withheld === "claim_changed" && push !== null) return claimChanged(push.head);
      if (sent?.withheld === "unsaved") {
        return text(503, `railhead: ${UNSAVED}; nothing was updated`, { "retry-after": "5" });
      }
      const outcome = deadline.expired ? "timeout" : "unreachable";
      logFailure(route, outcome);
      outcomeUnknown();
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
      outcomeUnknown();
      return text(502, "railhead: the repository store refused the request");
    }
    if (response.body === null) {
      deadline.abort();
      outcomeUnknown();
      return text(502, "railhead: the repository store sent no body");
    }

    const report =
      push === null
        ? null
        : new PushReportReader(
            reportFraming(push.head.capabilities),
            push.head.updates.map((update) => update.ref),
          );
    const read = response.body.pipeThrough(
      inspected(this.#limits.maxResponseBytes, deadline, report, () => {
        if (push === null || report === null) return;
        settled = true;
        const outcome = report.end();
        switch (outcome.kind) {
          case "reported":
            push.record(outcome.updated);
            return;
          case "refused":
            push.refused();
            return;
          case "unknown":
            push.unknown();
            return;
          default:
            outcome satisfies never;
        }
      }),
    );
    // A push's response is read to its end by the gateway, not by the client's reads, so its report
    // is recorded even when the client stops reading, and a response cut off by the deadline, the
    // size bound or the upstream is seen too. A client that falls a whole buffer behind is dropped.
    const passed = (
      push === null
        ? read
        : drained(read, PUSH_RESPONSE_BUFFER_BYTES, () => {
            deadline.abort();
            outcomeUnknown();
          })
    ).pipeThrough(masked(textEncoder.encode(token.value.value)));
    return new Response(passed, {
      status: 200,
      headers: { "content-type": expectedType, "cache-control": "no-cache" },
    });
  }

  /**
   * Records each ref the upstream reported updated and settles the pending push, in one
   * transaction. Deletions are refused before a push is forwarded, since `claim.pushed` cannot
   * express one. Nothing is recorded unless the claim is still working at the push's generation when
   * the record is written: a claim that expired, changed hands or went ready while the push was in
   * flight keeps its own history, and the push is logged as `git_push_unrecorded`. A record that
   * fails is tried again up to `RECORD_ATTEMPTS` times in all, unless the event log refused it,
   * which no retry changes. A record left unwritten is logged and stays pending, so the alarm
   * reconciles it. The client's response is not cut short: the upstream has already applied the push.
   */
  #recordPush(
    pending: number,
    principal: AgentPrincipal,
    fence: Fence,
    head: ReceivePackHead,
    updated: ReadonlySet<string>,
  ): void {
    const pushed = head.updates.filter((update) => updated.has(update.ref)).flatMap(pushedRef);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const outcome = this.#settle(pending, principal.agentId, fence, pushed, null);
        if (outcome === "claim_changed" && pushed.length > 0) logUnrecorded(fence, "claim_changed");
        return;
      } catch (error) {
        if (error instanceof EventLogError || attempt >= RECORD_ATTEMPTS) {
          logUnrecorded(fence, "record_failed");
          return;
        }
      }
    }
  }

  /**
   * Settles the pending push `pending` in one transaction: appends `pushed` if the claim is still
   * working at the fence's generation and, when `last` is given, its fork has had no push released
   * after `last.release`; it deletes the row either way. Nothing is written once the row is gone,
   * since whoever settled it first wrote its record.
   */
  #settle(
    pending: number,
    agentId: string,
    fence: Fence,
    pushed: readonly PushedRef[],
    last: { readonly repo: string; readonly release: number } | null,
  ): "recorded" | "claim_changed" | "later_push" | "settled" {
    const { sql } = this.#context.storage;
    return this.#context.log.transaction((tx) => {
      const deleted = sql.exec("DELETE FROM git_pending_push WHERE id = ?", pending).rowsWritten;
      if (deleted === 0) return "settled";
      if (!this.#working(fence)) {
        return "claim_changed";
      }
      if (last !== null && this.#released(last.repo) !== last.release) return "later_push";
      for (const update of pushed) {
        tx.append(
          { kind: "agent", id: agentId },
          {
            type: "claim.pushed",
            data: {
              claimId: fence.claimId,
              generation: fence.generation,
              ref: update.ref,
              from: update.from,
              to: update.to,
            },
          },
        );
      }
      return "recorded";
    }).value;
  }
}

type Fence = NonNullable<GitGrant["fence"]>;

/** The fence a pending push was saved under. */
function pendingFence(row: PendingRow): Fence {
  return { claimId: row.claim_id, generation: row.generation, episode: row.episode };
}

/** One branch a push moves, as a pending push keeps it and `claim.pushed` records it. */
interface PushedRef {
  readonly ref: string;
  readonly from: string | null;
  readonly to: string;
}

/** A pending push as stored. */
interface PendingRow extends Record<string, SqlStorageValue> {
  id: number;
  claim_id: string;
  generation: number;
  episode: number;
  agent_id: string;
  repo: string;
  updates: string;
  attempts: number;
  release: number;
  prior: string | null;
  /** Non-zero for a row saved before pushes were fenced to an episode. */
  unfenced: number;
}

/** The branches a push names as read from its fork before the push was released. */
interface Observed {
  /** How many pushes had been released to the fork when the read began. */
  readonly released: number;
  /** The id of each branch found; a branch not found is absent. */
  readonly refs: ReadonlyMap<string, string>;
}

/** Why reconciliation cannot prove what a pending push moved. */
type Unproven = "unobserved" | "later_push";

/** What a push's release decided. */
type Release = "released" | "claim_changed" | "unsaved";

/** A push saved as pending, and its alarm write. */
interface Saved {
  readonly id: number;
  readonly dueAt: number;
  readonly armed: Promise<boolean>;
}

/** `update` as a pushed ref; a deletion, which is refused before a push is sent, is none. */
function pushedRef(update: RefUpdate): PushedRef[] {
  switch (update.kind) {
    case "create":
      return [{ ref: update.ref, from: null, to: update.newId }];
    case "update":
      return [{ ref: update.ref, from: update.oldId, to: update.newId }];
    case "delete":
      return [];
    default:
      return update.kind satisfies never;
  }
}

/** Reads the refs a pending push saved, or `null` if they are not what `#save` wrote. */
function parsePushedRefs(stored: string): PushedRef[] | null {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const items: unknown[] = value;
  const refs: PushedRef[] = [];
  for (const item of items) {
    if (typeof item !== "object" || item === null) return null;
    const ref: unknown = Reflect.get(item, "ref");
    const from: unknown = Reflect.get(item, "from");
    const to: unknown = Reflect.get(item, "to");
    if (typeof ref !== "string" || !ref.startsWith(BRANCH_PREFIX)) return null;
    if (from !== null && (typeof from !== "string" || !isCommitSha(from))) return null;
    if (typeof to !== "string" || !isCommitSha(to)) return null;
    refs.push({ ref, from, to });
  }
  return refs;
}

/**
 * Reads the branches a pending push saved as read before its release: each branch's id, or `null`
 * where it was absent. Returns `undefined` if they are not what `#save` wrote.
 */
function parsePrior(stored: string): ReadonlyMap<string, string | null> | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prior = new Map<string, string | null>();
  for (const [ref, id] of Object.entries(value)) {
    if (!ref.startsWith(BRANCH_PREFIX)) return undefined;
    if (id !== null && (typeof id !== "string" || !isCommitSha(id))) return undefined;
    prior.set(ref, id);
  }
  return prior;
}

interface PendingPush {
  readonly head: ReceivePackHead;
  /** The whole request body, head included. */
  readonly body: ReadableStream<Uint8Array>;
  /** The push's time limit, running since its body was first read. */
  readonly deadline: Deadline;
  /** Decides the push again against current claim state: `null` to go ahead, or the refusal. */
  readonly admit: () => Promise<Response | null>;
  /** Reads the fork's branches the push names, before anything of it can reach the fork. */
  readonly observe: () => Promise<void>;
  /**
   * Decides whether the push's last bytes may be sent: only while the claim is still working at the
   * push's generation, once the push is saved as pending and storage holds the alarm that records it.
   */
  readonly release: () => Promise<Release>;
  /** Records the refs the upstream reported updated. */
  readonly record: (updated: ReadonlySet<string>) => void;
  /** Drops a push whose complete report said nothing was updated. */
  readonly refused: () => void;
  /** Leaves a push that may have been applied, though nothing says what it updated, to reconciliation. */
  readonly unknown: () => void;
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

/**
 * Whether `current` is the grant `original` was: the same repository, scope, claim, generation and
 * episode.
 */
function sameGrant(current: GitGrant, original: GitGrant): boolean {
  return (
    current.repo === original.repo &&
    current.scope === original.scope &&
    current.fence?.claimId === original.fence?.claimId &&
    current.fence?.generation === original.fence?.generation &&
    current.fence?.episode === original.fence?.episode
  );
}

/** Refuses every ref of a push whose claim changed after it was admitted. */
function claimChanged(head: ReceivePackHead): Response {
  return pushRefusal(head, `railhead: ${CLAIM_CHANGED}`, () => CLAIM_CHANGED);
}

/**
 * Refuses every ref of `head` in Git's report. Git's probe names no ref and a push that asked for
 * no report reads none, so either would take an empty result as success: both get an HTTP 403.
 */
function pushRefusal(
  head: ReceivePackHead,
  message: string,
  reasonFor: (update: RefUpdate) => string,
): Response {
  if (head.updates.length === 0 || reportFraming(head.capabilities) === "none") {
    return text(403, message);
  }
  return gitResult("git-receive-pack", receivePackRefusal(head, message, reasonFor));
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
  // A `claim.pushed` event names the commit a branch moved to, so a deletion could not be recorded.
  if (update.kind === "delete") return "branches cannot be deleted through Railhead";
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
    case "check_held":
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
 * Warns that a push moved, or may have moved, refs in a claim's fork without a `claim.pushed` event.
 * The claim id and generation are Railhead's own; no ref, commit or other text from the push is
 * logged.
 */
function logUnrecorded(
  fence: Fence,
  reason:
    | "claim_changed"
    | "record_failed"
    | "outcome_unknown"
    | "reconcile_failed"
    | "unreadable_record"
    | "unfenced",
  unproven?: Unproven,
): void {
  logPush("git_push_unrecorded", fence, unproven === undefined ? { reason } : { reason, unproven });
}

/** Logs one event about a push: its claim, generation and Railhead's own codes and counts. */
function logPush(event: string, fence: Fence, fields: Record<string, string | number>): void {
  console.warn(
    JSON.stringify({ event, claimId: fence.claimId, generation: fence.generation, ...fields }),
  );
}

/** An error's name, never its message, which may carry text from elsewhere. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function unreachable(value: never): never {
  throw new Error(`unhandled value: ${String(value)}`);
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
 * `ended` once the whole body has passed. With `release`, the body's last `HELD_PUSH_BYTES` bytes
 * are held back until the client has sent everything, and passed on only if `release` allows it
 * then, after which the body is `released`; otherwise the exchange is ended and `withheld` says why.
 */
function limited(
  body: ReadableStream<Uint8Array>,
  max: number,
  deadline: Deadline,
  release: (() => Promise<Release>) | null,
  ended: () => void,
): {
  readonly stream: ReadableStream<Uint8Array>;
  readonly exceeded: boolean;
  readonly withheld: Exclude<Release, "released"> | null;
  readonly released: boolean;
} {
  let seen = 0;
  let exceeded = false;
  let withheld: Exclude<Release, "released"> | null = null;
  let released = false;
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
        if (release === null) {
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
      async flush(controller) {
        if (release !== null) {
          const decision = await release();
          if (decision !== "released") {
            withheld = decision;
            controller.error(new Error(decision === "claim_changed" ? CLAIM_CHANGED : UNSAVED));
            deadline.abort();
            return;
          }
          if (held.length > 0) controller.enqueue(held);
          released = true;
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
    get released() {
      return released;
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
 * Reads `source` to its end whatever its own reader does, holding at most `buffer` unread bytes,
 * plus the chunk that overflows them, for that reader. A reader that falls further behind is
 * dropped: its stream errors, its queue is released, and the rest of `source` is read and
 * discarded, as it is once the reader cancels. Reading `source` never waits for the reader, so
 * whatever `source` carries is seen whether the reader keeps up, stalls or goes away. If `source`
 * errors, `failed` is called once, and a reader still there sees the same error.
 */
function drained(
  source: ReadableStream<Uint8Array>,
  buffer: number,
  failed: () => void,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let gone = false;
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const pump = async (): Promise<void> => {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) {
              if (!gone) controller.close();
              return;
            }
            if (gone) continue;
            if ((controller.desiredSize ?? 0) <= 0) {
              gone = true;
              controller.error(new Error("the client stopped reading the response"));
              continue;
            }
            controller.enqueue(value);
          }
        };
        // `source` errors only when the exchange is cut off, which records nothing; the reader, if
        // still there, sees the same error.
        pump().catch((error: unknown) => {
          failed();
          reader.releaseLock();
          if (!gone) controller.error(error);
        });
      },
      cancel() {
        gone = true;
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
