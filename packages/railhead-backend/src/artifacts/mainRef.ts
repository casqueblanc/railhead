// Main's ref over Artifacts: the `MainRefPort` the main writer moves main with. Artifacts enforces
// none of the guarantees that port states (qualified on #158): any write token can force-move or
// delete main, receive-pack accepts a non-fast-forward update, and an update whose request body is
// still open applies whenever the body completes. Only its compare-and-swap holds: an update whose
// expected commit is stale is refused with `stale ref`. This adapter builds the rest on top of it.
//
// Sole writer. Each update mints its own write token on main with the shortest lifetime Artifacts
// accepts and revokes it once the update has answered or been abandoned. Before minting, it lists
// main's tokens: a live write token it did not mint belongs to another writer, and the update is
// refused and reported. A listing that cannot show every token is treated the same way. A write
// that still happens surfaces as `stale ref` on the next update, which is reported and returned as
// `rejected` without a retry.
//
// The sandbox Git gateway also mints write tokens on main, for a merge composition's candidate
// pushes, and revokes each when its exchange ends (`sandbox/sandboxObject.ts`). An update that
// coincides with one of those pushes is refused as `unavailable`, and the train publishes again on
// its next drive. That refusal is intended: a write token on main can move main, whatever ref its
// holder was allowed to push, so the check must not learn to skip such tokens.
//
// Monotonic main. An update is sent only when `expected` is on `next`'s first-parent history, which
// is how the train composes a candidate on main. With the compare-and-swap, Railhead's own writes
// only move main forward. A rewind by another writer can only be detected, as above.
//
// Bounded lifetime. The request body, about 150 bytes with an empty pack, is sent in one buffered
// write; the request is aborted `requestTimeoutMs` after the call; and the update's token is revoked
// before anything reads main again. Artifacts checks the token when the body completes, so an update
// whose body never completed cannot apply after the revocation. Measured, one whose body had
// completed applied at most about 55 ms after the revocation returned. If the Durable Object dies
// mid-update, the token's own lifetime of one minute ends it instead.
//
// Nothing here logs a token, a repository name, a commit or a response body.

import { isCommitSha, type CommitSha, type RepoId } from "@railhead/shared/events";
import { fail, ok, type PortResult } from "../contracts/result";
import type { MainRefPort, MainUpdate } from "../contracts/train";
import { releaseLate, untilAborted, type Upstream } from "../git/gateway";
import { concat, pktLine } from "../git/pktLine";
import { PushReportReader } from "../git/reportStatus";
import { gitServiceUrl } from "../git/serviceUrl";
import { MAIN_REF_TIMEOUT_MS } from "../modules/mainWriter/mainWriter";
import { boundedCall, mainRepoName, MIN_TOKEN_TTL_MS } from "./adapter";

/** The binding methods main's ref calls on main's repository. `ArtifactsRepo` satisfies it. */
export type MainRefHandle = Disposable &
  Pick<ArtifactsRepo, "createToken" | "listTokens" | "revokeToken" | "log" | "info">;

/** The namespace-level binding main's ref needs. The `ARTIFACTS` binding satisfies it. */
export interface MainRefNamespace {
  /** Opens a repository; throws an `ArtifactsError` such as `NOT_FOUND`. */
  get(name: string): Promise<MainRefHandle>;
}

/** What main's ref receives from its `Repo`. */
export interface MainRefContext {
  /** The repository whose main this ref moves, and no other. */
  readonly repoId: RepoId;
  /** The Artifacts namespace. */
  readonly namespace: MainRefNamespace;
  /** The outbound call to Artifacts' Git endpoint. Production passes the global `fetch`. */
  readonly upstream: Upstream;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly clock: () => number;
}

/** Limits a test may tighten. */
export interface MainRefLimits {
  /** How long after the call to `update` its request is aborted, if still unanswered. */
  readonly requestTimeoutMs: number;
  /** How long one binding call may take. */
  readonly callTimeoutMs: number;
  /** How many commits of `next`'s first-parent history are searched for `expected`. */
  readonly maxAncestry: number;
}

/** The production limits. */
export const MAIN_REF_LIMITS: MainRefLimits = {
  requestTimeoutMs: MAIN_REF_TIMEOUT_MS,
  callTimeoutMs: 10_000,
  maxAncestry: 256,
};

/** The only ref this module writes. */
const MAIN = "refs/heads/main";

/** The longest receive-pack report read: one status line for one ref needs far less. */
const MAX_REPORT_BYTES = 64 * 1024;

/** Builds main's ref for one repository. */
export function createMainRef(
  context: MainRefContext,
  limits: MainRefLimits = MAIN_REF_LIMITS,
): MainRefPort {
  return new ArtifactsMainRef(context, limits);
}

/** What one receive-pack exchange showed. */
type Exchange =
  /** The report says main moved. */
  | "updated"
  /** The report says main did not move. */
  | "not_updated"
  /** The report says the pack was not unpacked, so nothing moved. */
  | "unpack_failed"
  /** Artifacts refused the token before running receive-pack. */
  | "denied"
  /** The deadline passed before the request was sent. */
  | "unsent"
  /** No readable report: the update may or may not have applied. */
  | "uncertain";

class ArtifactsMainRef implements MainRefPort {
  readonly #context: MainRefContext;
  readonly #limits: MainRefLimits;
  // Tokens this ref minted whose revocation has not been confirmed, with their expiry. They are
  // not another writer's, and each update tries to revoke them again first.
  readonly #unrevoked = new Map<string, number>();
  // The update in flight, which settles only once its token is revoked or given up on.
  #updating: Promise<void> | null = null;
  #name: Promise<string> | null = null;

  constructor(context: MainRefContext, limits: MainRefLimits) {
    this.#context = context;
    this.#limits = limits;
  }

  async read(): Promise<PortResult<CommitSha>> {
    // A read that began before an update's token was revoked could show main at the expected
    // commit while that update can still apply, so it waits.
    await this.#updating;
    return this.#withHandle(this.#limits.callTimeoutMs, (handle, remaining) =>
      this.#readMain(handle, remaining),
    );
  }

  update(expected: CommitSha, next: CommitSha): Promise<PortResult<MainUpdate>> {
    if (!isCommitSha(expected) || !isCommitSha(next)) {
      return Promise.resolve(fail("invalid_request", "Both commits must be commit ids."));
    }
    if (this.#updating !== null) {
      return Promise.resolve(fail("busy", "Another update of main is in flight; try again."));
    }
    // Cleared before the caller resumes, so its next update is not refused.
    const run = this.#update(expected, next).finally(() => {
      this.#updating = null;
    });
    this.#updating = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #update(expected: CommitSha, next: CommitSha): Promise<PortResult<MainUpdate>> {
    // Measured from the call: past it the update is dropped unsent, or its request aborted.
    const deadline = AbortSignal.timeout(this.#limits.requestTimeoutMs);
    const endsAt = Date.now() + this.#limits.requestTimeoutMs;
    const remaining = (): number => Math.min(this.#limits.callTimeoutMs, endsAt - Date.now());
    const prepared = await this.#withHandle(this.#limits.requestTimeoutMs, (handle) =>
      this.#prepare(handle, expected, next, remaining),
    );
    if (!prepared.ok) return prepared;
    const { url, token } = prepared.value;
    let exchange: Exchange;
    try {
      exchange =
        remaining() > 0
          ? await this.#send(url, token.plaintext, expected, next, deadline)
          : "unsent";
    } finally {
      await this.#revoke(token.id);
    }
    switch (exchange) {
      case "updated":
        return ok({ kind: "updated" });
      case "not_updated":
        return this.#readRejected(expected);
      case "unpack_failed":
        return fail(
          "internal",
          "Artifacts could not unpack the update of main; main did not move.",
        );
      case "denied":
        return fail("unavailable", "Artifacts refused the update's token; main did not move.");
      case "unsent":
        return fail("unavailable", "The update of main was not sent in time; main did not move.");
      case "uncertain":
        report("main_ref_uncertain");
        return ok({ kind: "uncertain" });
      default:
        return exchange satisfies never;
    }
  }

  /**
   * Checks that the update moves main forward and that no other writer holds a token, then mints
   * the update's token. Refuses without minting when either check fails.
   */
  async #prepare(
    handle: MainRefHandle,
    expected: CommitSha,
    next: CommitSha,
    remaining: () => number,
  ): Promise<PortResult<{ url: URL; token: ArtifactsCreateTokenResult }>> {
    await this.#revokeLeftovers(handle);
    const history = await boundedCall(
      handle.log({ ref: next, limit: this.#limits.maxAncestry }),
      remaining(),
    );
    if (!history.some((commit) => commit.hash === expected)) {
      return fail(
        "invalid_request",
        "The new commit does not descend from main's expected commit; main is never moved back.",
      );
    }
    const listed = await boundedCall(handle.listTokens(), remaining());
    const foreign = listed.tokens.filter(
      (token) =>
        token.scope === "write" && token.state === "active" && !this.#unrevoked.has(token.id),
    );
    const partial = listed.total > listed.tokens.length;
    if (foreign.length > 0 || partial) {
      report("main_ref_foreign_writer", { tokens: foreign.length, partial });
      return fail(
        "unavailable",
        "Another write token for main is live, so main is not moved until it is gone.",
      );
    }
    const info = await boundedCall(handle.info(), remaining());
    const url = gitServiceUrl(info.remote, "git-receive-pack");
    if (url === null) return fail("internal", "Main's repository has no usable Git remote.");
    const token = await boundedCall(
      handle.createToken("write", MIN_TOKEN_TTL_MS / 1000),
      remaining(),
      (late) => {
        void late.then(
          (created) => this.#discardLate(created),
          () => undefined,
        );
      },
    );
    this.#remember(token);
    return ok({ url, token });
  }

  /** Sends one receive-pack request, its whole body in one buffered write, and reads its report. */
  async #send(
    url: URL,
    token: string,
    expected: CommitSha,
    next: CommitSha,
    deadline: AbortSignal,
  ): Promise<Exchange> {
    const request = new Request(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/x-git-receive-pack-request",
        accept: "application/x-git-receive-pack-result",
      },
      body: await receivePackBody(expected, next),
      redirect: "manual",
      signal: deadline,
    });
    let response: Response;
    try {
      const pending = this.#context.upstream(request);
      releaseLate(pending, deadline);
      deadline.throwIfAborted();
      response = await untilAborted(pending, deadline);
    } catch {
      return "uncertain";
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return "denied";
    }
    if (
      response.status !== 200 ||
      response.headers.get("content-type") !== "application/x-git-receive-pack-result" ||
      response.body === null
    ) {
      await response.body?.cancel().catch(() => undefined);
      return "uncertain";
    }
    const reader = new PushReportReader("plain", [MAIN]);
    const body = response.body.getReader();
    let read = 0;
    try {
      for (;;) {
        const chunk = body.read();
        deadline.throwIfAborted();
        const { done, value } = await untilAborted(chunk, deadline);
        if (done) break;
        read += value.length;
        if (read > MAX_REPORT_BYTES) {
          await body.cancel().catch(() => undefined);
          return "uncertain";
        }
        reader.push(value);
      }
    } catch {
      await body.cancel().catch(() => undefined);
      return "uncertain";
    }
    const outcome = reader.end();
    switch (outcome.kind) {
      case "reported":
        return outcome.updated.has(MAIN) ? "updated" : "not_updated";
      case "refused":
        return "unpack_failed";
      case "unknown":
        return "uncertain";
      default:
        return outcome satisfies never;
    }
  }

  /**
   * Reads main after Artifacts reported it not updated. Main elsewhere than `expected` means it
   * moved under the writer, which is reported and returned as `rejected`; at `expected`, the update
   * was refused for another reason.
   */
  async #readRejected(expected: CommitSha): Promise<PortResult<MainUpdate>> {
    const main = await this.#withHandle(this.#limits.callTimeoutMs, (handle, remaining) =>
      this.#readMain(handle, remaining),
    );
    if (!main.ok) return main;
    if (main.value === expected) {
      return fail("internal", "Artifacts refused the update of main; main did not move.");
    }
    report("main_ref_moved");
    return ok({ kind: "rejected", actual: main.value });
  }

  async #readMain(handle: MainRefHandle, remaining: () => number): Promise<PortResult<CommitSha>> {
    const [head] = await boundedCall(handle.log({ ref: "main", limit: 1 }), remaining());
    if (head === undefined || !isCommitSha(head.hash)) {
      return fail("internal", "Main has no commit.");
    }
    return ok(head.hash);
  }

  /** Revokes a token whose mint answered after its timeout. Nobody waits for this. */
  async #discardLate(created: ArtifactsCreateTokenResult): Promise<void> {
    this.#remember(created);
    await this.#revoke(created.id);
  }

  /** Retries the revocations that failed, and forgets tokens that have expired. */
  async #revokeLeftovers(handle: MainRefHandle): Promise<void> {
    const now = this.#context.clock();
    for (const [id, expiresAt] of this.#unrevoked) {
      if (expiresAt <= now) this.#unrevoked.delete(id);
      else if (await this.#revokeWith(handle, id)) this.#unrevoked.delete(id);
    }
  }

  /** Revokes the update's token. A failure keeps it as this ref's until it expires. */
  async #revoke(id: string): Promise<void> {
    const revoked = await this.#withHandle(this.#limits.callTimeoutMs, async (handle) =>
      ok(await this.#revokeWith(handle, id)),
    );
    if (revoked.ok && revoked.value) this.#unrevoked.delete(id);
    else report("main_ref_revoke_failed");
  }

  /** Whether `id` can no longer be used: revoked now, or unknown to Artifacts. */
  async #revokeWith(handle: MainRefHandle, id: string): Promise<boolean> {
    try {
      await boundedCall(handle.revokeToken(id), this.#limits.callTimeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  #remember(token: ArtifactsCreateTokenResult): void {
    const expiresAt = Date.parse(token.expiresAt);
    // A token with no readable expiry is kept for the longest lifetime this ref mints.
    this.#unrevoked.set(
      token.id,
      Number.isNaN(expiresAt) ? this.#context.clock() + MIN_TOKEN_TTL_MS : expiresAt,
    );
  }

  /**
   * Opens main's repository for `body`, bounded by `timeoutMs` overall, and turns a binding failure
   * into a refusal: nothing was sent, so main did not move.
   */
  async #withHandle<T>(
    timeoutMs: number,
    body: (handle: MainRefHandle, remaining: () => number) => Promise<PortResult<T>>,
  ): Promise<PortResult<T>> {
    const endsAt = Date.now() + timeoutMs;
    const remaining = (): number => Math.min(this.#limits.callTimeoutMs, endsAt - Date.now());
    try {
      this.#name ??= mainRepoName(this.#context.repoId);
      const name = await this.#name;
      using handle = await boundedCall(this.#context.namespace.get(name), remaining(), (late) => {
        void late.then(
          (opened) => opened[Symbol.dispose](),
          () => undefined,
        );
      });
      return await body(handle, remaining);
    } catch (error) {
      // The name only: a binding error's message may name the repository.
      report("main_ref_call_failed", { error: error instanceof Error ? error.name : "unknown" });
      return fail("unavailable", "Main's repository could not be reached; main did not move.");
    }
  }
}

/** The receive-pack request: one command for main, `report-status`, a flush and an empty pack. */
async function receivePackBody(expected: CommitSha, next: CommitSha): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const command = encoder.encode(`${expected} ${next} ${MAIN}\0report-status\n`);
  // An empty version 2 pack: the commits are already in the repository.
  const pack = Uint8Array.of(0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0);
  const checksum = new Uint8Array(await crypto.subtle.digest("SHA-1", pack));
  return concat([pktLine(command), encoder.encode("0000"), pack, checksum]);
}

/** Reports what the ref saw, by event name and counts only. */
function report(event: string, fields: Record<string, number | boolean | string> = {}): void {
  console.warn(JSON.stringify({ event, ...fields }));
}
