// A controllable in-memory main repository for tests of main's ref: its binding calls and its Git
// receive-pack endpoint. It models what #158's qualification measured against live Artifacts:
// receive-pack is a compare-and-swap (`stale ref` when the expected commit is not main) that does
// not refuse a non-fast-forward; the update's token is checked when the request body completes; a
// token listing shows the 30 newest active tokens and counts active ones only. Switches add the
// failures the live service showed or may show: a body completed late, an update that applies and
// then never answers, a refused token, an unreadable report and failing binding calls. It proves
// nothing about the deployed service's timing.

import { ReceivePackHeadParser } from "../git/pktLine";
import type { MainRefHandle, MainRefNamespace } from "./mainRef";
import { FakeArtifactsError } from "./fake";

/** The size of the binding's token page, as measured. */
const TOKEN_PAGE = 30;

/** One token the fake has minted. */
export interface FakeMainToken {
  /** The token's id. */
  readonly id: string;
  /** Its secret value. */
  readonly plaintext: string;
  /** What it allows. */
  readonly scope: "read" | "write";
  /** When it was minted, in fake-clock milliseconds. */
  readonly createdAtMs: number;
  /** When it stops working, in fake-clock milliseconds. */
  readonly expiresAtMs: number;
  /** Whether it was revoked. */
  revoked: boolean;
}

/** How the next receive-pack request behaves. */
export type PushFault =
  /** The body completes only once the test releases it, whatever the client does meanwhile. */
  | "complete-late"
  /** The update applies, then the response never comes until the client aborts. */
  | "apply-then-hang"
  /** The report refuses main for a reason other than a stale expected commit. */
  | "decline"
  /** The answer is not a receive-pack report. */
  | "server-error";

/** A binding call the fake can make fail once. */
export type FailingCall = "get" | "log" | "listTokens" | "info" | "createToken" | "revokeToken";

/** One step the fake saw, in order: a binding call by name, or `receive-pack`. */
export type FakeStep = FailingCall | "receive-pack" | "applied";

/** A fake main repository, reachable by name through the namespace and by its Git remote. */
export class FakeMainRepo implements MainRefNamespace {
  /** The repository's name. */
  readonly name: string;
  /** Its Git remote. */
  readonly remote: string;
  /** Each commit's parents, in Git order. */
  readonly commits = new Map<string, string[]>();
  /** Every token minted for it, revoked or not. */
  readonly tokens: FakeMainToken[] = [];
  /** Every step seen, in order. */
  readonly steps: FakeStep[] = [];
  /** Every receive-pack body received, as sent. */
  readonly bodies: Uint8Array[] = [];
  /** Handles opened and not yet disposed. */
  openHandles = 0;
  /** Main's commit. */
  main: string;
  #now: number;
  #nextId = 1;
  #pushFault: PushFault | null = null;
  #failing = new Set<FailingCall>();
  #lateBody: { reached: () => void; release: Promise<void> } | null = null;
  #pending: Promise<unknown> = Promise.resolve();

  /** `history` lists commits oldest first, each a first-parent child of the one before. */
  constructor(name: string, history: readonly string[], now = 1_000_000) {
    this.name = name;
    this.remote = `https://fake.artifacts.invalid/${name}.git`;
    history.forEach((hash, index) => {
      const parent = history[index - 1];
      this.commits.set(hash, parent === undefined ? [] : [parent]);
    });
    const tip = history.at(-1);
    if (tip === undefined) throw new Error("a fake main needs a commit");
    this.main = tip;
    this.#now = now;
  }

  /** The fake's clock, to pass to the ref as its `clock`. */
  readonly clock = (): number => this.#now;

  /** Moves the clock forward. */
  advance(ms: number): void {
    this.#now += ms;
  }

  /** Adds a commit with `parents`. */
  commit(hash: string, parents: readonly string[]): void {
    this.commits.set(hash, [...parents]);
  }

  /** Mints a token directly, as another holder of the repository would. */
  mintFor(scope: "read" | "write", ttlSeconds: number): FakeMainToken {
    return this.#mint(scope, ttlSeconds);
  }

  /** Moves main as another writer's forced push would, without any check. */
  forcePush(hash: string): void {
    this.main = hash;
  }

  /** Makes the next receive-pack request misbehave as `fault`. */
  failNextPush(fault: PushFault): void {
    this.#pushFault = fault;
  }

  /** Makes the next call of `call` throw `INTERNAL_ERROR`. */
  failNext(call: FailingCall): void {
    this.#failing.add(call);
  }

  /**
   * For a `complete-late` push: `reached` resolves once the request is held, and `release`
   * completes its body.
   */
  holdBody(): { reached: Promise<void>; release: () => void } {
    let reach: (() => void) | undefined;
    let release: (() => void) | undefined;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    this.#lateBody = {
      reached: () => reach?.(),
      release: new Promise<void>((resolve) => {
        release = resolve;
      }),
    };
    return { reached, release: () => release?.() };
  }

  /** Settles once every receive-pack request the fake received has finished on its side. */
  settled(): Promise<unknown> {
    return this.#pending;
  }

  /** The write tokens that are neither revoked nor expired. */
  liveWriteTokens(): FakeMainToken[] {
    return this.tokens.filter((token) => token.scope === "write" && this.#live(token));
  }

  async get(name: string): Promise<MainRefHandle> {
    this.#step("get");
    if (name !== this.name) throw new FakeArtifactsError("NOT_FOUND");
    this.openHandles += 1;
    return this.#handle();
  }

  /** The Git endpoint: answers receive-pack requests for this repository. */
  readonly upstream = (request: Request): Promise<Response> => {
    const exchange = this.#receivePack(request);
    this.#pending = Promise.all([this.#pending, exchange.catch(() => undefined)]);
    return exchange;
  };

  async #receivePack(request: Request): Promise<Response> {
    this.steps.push("receive-pack");
    const fault = this.#pushFault;
    this.#pushFault = null;
    if (request.method !== "POST" || request.url !== `${this.remote}/git-receive-pack`) {
      return new Response("not found", { status: 404 });
    }
    const body = new Uint8Array(await request.arrayBuffer());
    this.bodies.push(body);
    if (fault === "complete-late") {
      const held = this.#lateBody;
      if (held === null) throw new Error("holdBody was not called");
      held.reached();
      await held.release;
    }
    // Artifacts checks the token when the body completes, not when the request starts.
    const bearer = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    const token = this.tokens.find((candidate) => candidate.plaintext === bearer);
    if (token === undefined || token.scope !== "write" || !this.#live(token)) {
      return new Response("forbidden", { status: 403 });
    }
    if (fault === "server-error") return new Response("unavailable", { status: 502 });
    const status = this.#apply(body, fault === "decline");
    if (fault === "apply-then-hang") {
      await new Promise<never>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          reject(request.signal.reason);
        });
      });
    }
    return new Response(report(status), {
      headers: { "content-type": "application/x-git-receive-pack-result" },
    });
  }

  /** Applies the one ref command in `body` and returns its status line. */
  #apply(body: Uint8Array, decline: boolean): string {
    const parsed = new ReceivePackHeadParser().push(body);
    if (parsed.kind !== "complete") return "ng refs/heads/main malformed";
    const [update] = parsed.head.updates;
    const pack = body.subarray(parsed.head.headBytes);
    if (update === undefined || parsed.head.updates.length !== 1 || pack.length !== 32) {
      return "ng refs/heads/main malformed";
    }
    if (decline) return `ng ${update.ref} pre-receive hook declined`;
    if (update.ref !== "refs/heads/main") return `ng ${update.ref} unexpected ref`;
    if (update.oldId !== this.main) return `ng ${update.ref} stale ref`;
    if (!this.commits.has(update.newId)) return `ng ${update.ref} missing object`;
    // No fast-forward check: live Artifacts applies a rewind or an unrelated commit.
    this.main = update.newId;
    this.steps.push("applied");
    return `ok ${update.ref}`;
  }

  #live(token: FakeMainToken): boolean {
    return !token.revoked && token.expiresAtMs > this.#now;
  }

  #step(call: FailingCall): void {
    this.steps.push(call);
    if (this.#failing.delete(call)) throw new FakeArtifactsError("INTERNAL_ERROR");
  }

  #mint(scope: "read" | "write", ttlSeconds: number): FakeMainToken {
    const token: FakeMainToken = {
      id: `tok_${this.#nextId}`,
      plaintext: `secret-${this.#nextId}-${crypto.randomUUID()}`,
      scope,
      createdAtMs: this.#now,
      expiresAtMs: this.#now + ttlSeconds * 1000,
      revoked: false,
    };
    this.#nextId += 1;
    this.tokens.push(token);
    return token;
  }

  #handle(): MainRefHandle {
    let disposed = false;
    const live = (): void => {
      if (disposed) throw new Error("fake main handle used after dispose");
    };
    return {
      [Symbol.dispose]: () => {
        if (!disposed) this.openHandles -= 1;
        disposed = true;
      },
      createToken: async (scope = "write", ttl = 86_400) => {
        live();
        this.#step("createToken");
        if (!Number.isInteger(ttl) || ttl < 60 || ttl > 31_536_000) {
          throw new FakeArtifactsError("INVALID_TTL");
        }
        const token = this.#mint(scope, ttl);
        return {
          id: token.id,
          plaintext: token.plaintext,
          scope,
          expiresAt: new Date(token.expiresAtMs).toISOString(),
        };
      },
      listTokens: async () => {
        live();
        this.#step("listTokens");
        const active = this.tokens
          .filter((token) => this.#live(token))
          .toReversed()
          .map((token) => ({
            id: token.id,
            scope: token.scope,
            state: "active" as const,
            createdAt: new Date(token.createdAtMs).toISOString(),
            expiresAt: new Date(token.expiresAtMs).toISOString(),
          }));
        return { tokens: active.slice(0, TOKEN_PAGE), total: active.length };
      },
      revokeToken: async (tokenOrId) => {
        live();
        this.#step("revokeToken");
        const token = this.tokens.find(
          (candidate) => candidate.id === tokenOrId || candidate.plaintext === tokenOrId,
        );
        if (token === undefined) return false;
        token.revoked = true;
        return true;
      },
      info: async () => {
        live();
        this.#step("info");
        const at = new Date(1_000_000).toISOString();
        return {
          id: this.name,
          name: this.name,
          description: null,
          defaultBranch: "main",
          createdAt: at,
          // Measured static on live Artifacts, whatever moved main.
          updatedAt: at,
          lastPushAt: null,
          source: null,
          readOnly: false,
          remote: this.remote,
        };
      },
      log: async (opts) => {
        live();
        this.#step("log");
        const ref = opts?.ref ?? "HEAD";
        let hash: string | undefined =
          ref === "HEAD" || ref === "main" || ref === "refs/heads/main" ? this.main : ref;
        const limit = opts?.limit ?? 50;
        const history: ArtifactsCommitMetadata[] = [];
        while (hash !== undefined && history.length < limit) {
          const parents = this.commits.get(hash);
          if (parents === undefined) break;
          history.push(commitMetadata(hash, parents));
          hash = parents[0];
        }
        return history;
      },
    };
  }
}

function commitMetadata(hash: string, parents: string[]): ArtifactsCommitMetadata {
  return {
    hash,
    treeHash: hash,
    message: "fake commit",
    author: { name: "fake", email: "fake@example.invalid" },
    committer: { name: "fake", email: "fake@example.invalid" },
    parents,
    authoredAt: 0,
    committedAt: 0,
  };
}

/** A plain receive-pack report: `unpack ok`, one status line and a flush. */
function report(status: string): Uint8Array {
  const encoder = new TextEncoder();
  const line = (text: string): string =>
    `${(encoder.encode(text).length + 4).toString(16).padStart(4, "0")}${text}`;
  return encoder.encode(`${line("unpack ok\n")}${line(`${status}\n`)}0000`);
}
