// The Artifacts qualification probe: a throwaway Worker an operator deploys on its own Artifacts
// namespace, so `scripts/qualify-slice.mjs` can run binding-level cases against the live service:
// #161 and #158, recorded for A40, and #350's ref resolution. It is never part of the `railhead` Worker and holds no Railhead
// data: every repository it touches is one it created, named by a random repository id.
//
// Each route runs one case and returns what it observed, not a verdict; the harness judges the
// observations (scripts/qualify/evidence.ts). Main's ref is the production adapter, `createMainRef`,
// so the compare-and-swap, ancestry refusal, foreign-writer refusal and token fence measured here
// are the ones the main writer relies on. Raw receive-pack requests are used only where a case needs
// Artifacts' own behaviour without the adapter in front of it.
//
// Every request needs `Authorization: Bearer <PROBE_SECRET>`. Responses carry token plaintext only
// from `create` and `mint`, which the harness needs for its own Git pushes against the throwaway
// repository; nothing is logged.

import { DurableObject } from "cloudflare:workers";
import { mainRepoName } from "../src/artifacts/adapter";
import { createMainRef, type MainRefHandle, type MainRefNamespace } from "../src/artifacts/mainRef";
import type { PortResult } from "../src/contracts/result";
import type { MainUpdate } from "../src/contracts/train";
import { isCommitSha, type CommitSha, type RepoId } from "@railhead/shared/events";

/** The namespace calls the probe makes. The `ARTIFACTS` binding satisfies it. */
export interface ProbeNamespace extends MainRefNamespace {
  /** Creates a repository with an initial write token. */
  create(name: string): Promise<Pick<ArtifactsCreateRepoResult, "name" | "remote" | "token">>;
  /** Deletes a repository and its tokens. */
  delete(name: string): Promise<boolean>;
}

/** The probe's bindings. */
export interface ProbeEnv {
  /** The qualification namespace, never Railhead's own. */
  ARTIFACTS: ProbeNamespace;
  /** The bearer secret the harness sends. */
  PROBE_SECRET: string;
  /** The object that runs an update and is evicted while it is in flight. */
  EVICTION: Pick<DurableObjectNamespace<EvictionProbe>, "getByName">;
}

/** How many tokens the listing case keeps live at once: one more than a listing page. */
export const LISTING_TOKENS = 31;

/** The shortest token lifetime Artifacts accepts, in seconds. */
const MIN_TTL_SECONDS = 60;

/** One token as a listing showed it. */
export interface ListedToken {
  id: string;
  scope: "read" | "write";
  state: "active" | "expired" | "revoked";
  createdAt: string;
  expiresAt: string;
}

/** One listing: its page and `total`. */
export interface Listing {
  ids: string[];
  tokens: ListedToken[];
  total: number;
}

/** What the token-listing case observed (#161). */
export interface ListingObservation {
  /** The listing with `LISTING_TOKENS` live tokens, newest minted last in `minted`. */
  full: Listing;
  /** Token ids in the order they were minted. */
  minted: string[];
  /** The listing after revoking the newest token. */
  afterRevoke: Listing;
  /** The id that was revoked. */
  revoked: string;
  /** Listings with paging or state options passed anyway, which the binding should ignore. */
  withOptions: Listing[];
  /** The id of a token minted with the shortest lifetime, and its expiry. */
  shortLived: { id: string; expiresAt: string };
  /** The listing taken once that token's expiry had passed. */
  afterExpiry: Listing;
  /** When `afterExpiry` was taken. */
  afterExpiryAt: string;
}

/** A receive-pack status line, or why there was none. */
export interface RawUpdate {
  /** HTTP status of the receive-pack response. */
  status: number;
  /** The ref status line, such as `ok refs/heads/main` or `ng refs/heads/main stale ref`. */
  line: string | null;
}

/** An adapter update's result with main read back after it. */
export interface AdapterUpdate {
  result: PortResult<MainUpdate>;
  /** Main's commit read through the binding after the update settled. */
  main: string | null;
  /** Live write tokens on main after the update settled. */
  liveWriteTokens: number;
}

const encoder = new TextEncoder();

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function pkt(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  return Uint8Array.from([
    ...encoder.encode((bytes.length + 4).toString(16).padStart(4, "0")),
    ...bytes,
  ]);
}

/** A receive-pack body updating main from `expected` to `next`, with an empty pack. */
async function receivePackBody(expected: string, next: string): Promise<Uint8Array> {
  const header = Uint8Array.from([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2, 0, 0, 0, 0]);
  const trailer = new Uint8Array(await crypto.subtle.digest("SHA-1", header));
  return Uint8Array.from([
    ...pkt(`${expected} ${next} refs/heads/main\0report-status\n`),
    ...encoder.encode("0000"),
    ...header,
    ...trailer,
  ]);
}

/** The ref status line of a receive-pack report, read without the subject's parser. */
function statusLine(body: string): string | null {
  return /(?:ok|ng) refs\/heads\/main[^\n]*/.exec(body)?.[0] ?? null;
}

async function listing(repo: MainRefHandle): Promise<Listing> {
  const listed = await repo.listTokens();
  return {
    ids: listed.tokens.map((token) => token.id),
    tokens: listed.tokens.map(({ id, scope, state, createdAt, expiresAt }) => ({
      id,
      scope,
      state,
      createdAt,
      expiresAt,
    })),
    total: listed.total,
  };
}

/** A listing returned from an untyped call, or `null` when it is not shaped like one. */
function parseListing(value: unknown): Listing | null {
  if (typeof value !== "object" || value === null) return null;
  const tokens: unknown = Reflect.get(value, "tokens");
  const total: unknown = Reflect.get(value, "total");
  if (!Array.isArray(tokens) || typeof total !== "number") return null;
  const parsed: ListedToken[] = [];
  for (const token of tokens) {
    if (typeof token !== "object" || token === null) return null;
    const id: unknown = Reflect.get(token, "id");
    const scope: unknown = Reflect.get(token, "scope");
    const state: unknown = Reflect.get(token, "state");
    const createdAt: unknown = Reflect.get(token, "createdAt");
    const expiresAt: unknown = Reflect.get(token, "expiresAt");
    if (
      typeof id !== "string" ||
      (scope !== "read" && scope !== "write") ||
      (state !== "active" && state !== "expired" && state !== "revoked") ||
      typeof createdAt !== "string" ||
      typeof expiresAt !== "string"
    ) {
      return null;
    }
    parsed.push({ id, scope, state, createdAt, expiresAt });
  }
  return { ids: parsed.map((token) => token.id), tokens: parsed, total };
}

async function mainHead(repo: MainRefHandle): Promise<string | null> {
  const [head] = await repo.log({ ref: "main", limit: 1 });
  return head?.hash ?? null;
}

async function liveWriteTokens(repo: MainRefHandle): Promise<number> {
  const listed = await repo.listTokens();
  return listed.tokens.filter((token) => token.scope === "write" && token.state === "active")
    .length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Sends one raw receive-pack update with a fresh write token, then revokes the token. */
async function rawUpdate(repo: MainRefHandle, expected: string, next: string): Promise<RawUpdate> {
  const token = await repo.createToken("write", MIN_TTL_SECONDS);
  try {
    const { remote } = await repo.info();
    const response = await fetch(`${remote}/git-receive-pack`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.plaintext}`,
        "content-type": "application/x-git-receive-pack-request",
      },
      body: await receivePackBody(expected, next),
    });
    return { status: response.status, line: statusLine(await response.text()) };
  } finally {
    await repo.revokeToken(token.id);
  }
}

/**
 * Starts a raw update whose body holds back its last byte. `complete` sends that byte and resolves
 * with the response; `abandon` cancels the body so it never completes.
 */
async function heldUpdate(
  repo: MainRefHandle,
  tokenPlaintext: string,
  expected: string,
  next: string,
) {
  const { remote } = await repo.info();
  const body = await receivePackBody(expected, next);
  const held: { controller: ReadableStreamDefaultController<Uint8Array> | null } = {
    controller: null,
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      held.controller = controller;
      controller.enqueue(body.subarray(0, body.length - 1));
    },
  });
  const response = fetch(`${remote}/git-receive-pack`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokenPlaintext}`,
      "content-type": "application/x-git-receive-pack-request",
    },
    body: stream,
  });
  return {
    async complete(): Promise<RawUpdate> {
      held.controller?.enqueue(body.subarray(body.length - 1));
      held.controller?.close();
      const answered = await response;
      return { status: answered.status, line: statusLine(await answered.text()) };
    },
  };
}

function commitPair(value: unknown): { expected: CommitSha; next: CommitSha } | null {
  if (typeof value !== "object" || value === null) return null;
  const expected: unknown = Reflect.get(value, "expected");
  const next: unknown = Reflect.get(value, "next");
  if (typeof expected !== "string" || typeof next !== "string") return null;
  return isCommitSha(expected) && isCommitSha(next) ? { expected, next } : null;
}

function stringField(value: unknown, key: string, pattern: RegExp): string | null {
  if (typeof value !== "object" || value === null) return null;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" && pattern.test(field) ? field : null;
}

const REPO_ID = /^rep_[0-9a-f]{64}$/;
/** A branch, tag, full ref name or commit id. */
const LOG_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/** A fresh random repository id, so the probe's main is named as Railhead names one. */
function randomRepoId(): RepoId {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `rep_${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Main's ref for the probe repository `repoId`, with the production limits. */
function mainRef(env: ProbeEnv, repoId: RepoId, upstream: (request: Request) => Promise<Response>) {
  return createMainRef({ repoId, namespace: env.ARTIFACTS, upstream, clock: Date.now });
}

/** Runs the adapter's update and reads main back once it settled. */
async function adapterUpdate(
  env: ProbeEnv,
  repoId: RepoId,
  expected: CommitSha,
  next: CommitSha,
  upstream: (request: Request) => Promise<Response>,
): Promise<AdapterUpdate> {
  const result = await mainRef(env, repoId, upstream).update(expected, next);
  using repo = await env.ARTIFACTS.get(await mainRepoName(repoId));
  return { result, main: await mainHead(repo), liveWriteTokens: await liveWriteTokens(repo) };
}

/** The #161 listing sequence on a fresh repository. Takes about 70 seconds. */
async function tokenListing(repo: MainRefHandle): Promise<ListingObservation> {
  // Only the tokens minted here are live: the repository's creation token goes first.
  for (const token of (await repo.listTokens()).tokens) await repo.revokeToken(token.id);
  const minted: string[] = [];
  for (let n = 0; n < LISTING_TOKENS; n += 1) {
    // Distinct creation times, so the order is not decided by ties.
    minted.push((await repo.createToken("read", 3_600)).id);
    await sleep(5);
  }
  const full = await listing(repo);
  const revoked = minted.at(-1) ?? "";
  await repo.revokeToken(revoked);
  const afterRevoke = await listing(repo);
  const withOptions: Listing[] = [];
  for (const options of [{ per_page: 100 }, { page: 2 }, { state: "all" }, { cursor: "x" }]) {
    // The installed types take no argument; the call is made as an untyped one on purpose.
    const listTokens: unknown = Reflect.get(repo, "listTokens");
    if (typeof listTokens !== "function") break;
    const page = parseListing(await Reflect.apply(listTokens, repo, [options]));
    if (page !== null) withOptions.push(page);
  }
  const short = await repo.createToken("read", MIN_TTL_SECONDS);
  await sleep(Math.max(0, Date.parse(short.expiresAt) - Date.now()) + 5_000);
  const afterExpiryAt = new Date().toISOString();
  const afterExpiry = await listing(repo);
  return {
    full,
    minted,
    afterRevoke,
    revoked,
    withOptions,
    shortLived: { id: short.id, expiresAt: short.expiresAt },
    afterExpiry,
    afterExpiryAt,
  };
}

/**
 * Runs an adapter update whose request body never completes, and evicts itself while it is in
 * flight. Only `begin` is called; the object is gone before it could answer.
 */
export class EvictionProbe extends DurableObject<ProbeEnv> {
  async begin(repoId: RepoId, expected: CommitSha, next: CommitSha): Promise<void> {
    const upstream = async (request: Request): Promise<Response> => {
      const body = new Uint8Array(await request.arrayBuffer());
      const held = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(body.subarray(0, body.length - 1));
        },
      });
      // The request is on its way with its last byte held; the object is evicted now.
      setTimeout(() => this.ctx.abort("qualification eviction"), 1_000);
      return fetch(request.url, { method: "POST", headers: request.headers, body: held });
    };
    await mainRef(this.env, repoId, upstream).update(expected, next);
  }
}

async function route(env: ProbeEnv, name: string, body: unknown): Promise<Response> {
  switch (name) {
    case "create": {
      // A throwaway main, named as Railhead names a repository's main.
      const repoId = randomRepoId();
      const created = await env.ARTIFACTS.create(await mainRepoName(repoId));
      return json({ repoId, name: created.name, remote: created.remote, token: created.token });
    }
    case "listing": {
      const repoId = stringField(body, "repoId", REPO_ID);
      if (repoId === null) return json({ error: "repoId" }, 400);
      using repo = await env.ARTIFACTS.get(await mainRepoName(repoId));
      return json(await tokenListing(repo));
    }
    case "tokens": {
      const repoId = stringField(body, "repoId", REPO_ID);
      if (repoId === null) return json({ error: "repoId" }, 400);
      using repo = await env.ARTIFACTS.get(await mainRepoName(repoId));
      return json(await listing(repo));
    }
    case "mint": {
      // A write token for the harness's own forced push, as another writer would hold.
      const repoId = stringField(body, "repoId", REPO_ID);
      if (repoId === null) return json({ error: "repoId" }, 400);
      using repo = await env.ARTIFACTS.get(await mainRepoName(repoId));
      const token = await repo.createToken("write", MIN_TTL_SECONDS * 5);
      return json({ id: token.id, plaintext: token.plaintext });
    }
    case "revoke": {
      const repoId = stringField(body, "repoId", REPO_ID);
      const token = stringField(body, "token", /^.{1,512}$/);
      if (repoId === null || token === null) return json({ error: "repoId, token" }, 400);
      using repo = await env.ARTIFACTS.get(await mainRepoName(repoId));
      return json({ revoked: await repo.revokeToken(token) });
    }
    case "main": {
      const repoId = stringField(body, "repoId", REPO_ID);
      if (repoId === null) return json({ error: "repoId" }, 400);
      using repo = await env.ARTIFACTS.get(await mainRepoName(repoId));
      return json({ main: await mainHead(repo), liveWriteTokens: await liveWriteTokens(repo) });
    }
    case "log": {
      // The commits `log` answers for one ref (#350), as hashes only.
      const repoId = stringField(body, "repoId", REPO_ID);
      const ref = stringField(body, "ref", LOG_REF);
      if (repoId === null || ref === null) return json({ error: "repoId, ref" }, 400);
      using repo = await env.ARTIFACTS.get(await mainRepoName(repoId));
      const commits = await repo.log({ ref, limit: 1 });
      return json({ hashes: commits.map((commit) => commit.hash) });
    }
    case "update": {
      // The production adapter's update, as the main writer calls it.
      const repoId = stringField(body, "repoId", REPO_ID);
      const pair = commitPair(body);
      if (repoId === null || pair === null) return json({ error: "repoId, expected, next" }, 400);
      return json(await adapterUpdate(env, repoId, pair.expected, pair.next, (r) => fetch(r)));
    }
    case "lost-response": {
      // The update reaches Artifacts and its answer is read, then lost before the adapter sees it.
      const repoId = stringField(body, "repoId", REPO_ID);
      const pair = commitPair(body);
      if (repoId === null || pair === null) return json({ error: "repoId, expected, next" }, 400);
      const lost = await adapterUpdate(env, repoId, pair.expected, pair.next, async (request) => {
        await (await fetch(request)).arrayBuffer();
        throw new TypeError("Network connection lost.");
      });
      // Sending the same update again must find main moved: it applied once and only once.
      using repo = await env.ARTIFACTS.get(await mainRepoName(repoId));
      return json({ ...lost, repeat: await rawUpdate(repo, pair.expected, pair.next) });
    }
    case "race": {
      // Several raw updates from one expected commit, sent at once.
      const repoId = stringField(body, "repoId", REPO_ID);
      const expected = stringField(body, "expected", /^[0-9a-f]{40}$/);
      const nexts: unknown =
        typeof body === "object" && body !== null ? Reflect.get(body, "nexts") : null;
      if (
        repoId === null ||
        expected === null ||
        !Array.isArray(nexts) ||
        nexts.length < 2 ||
        nexts.length > 8 ||
        !nexts.every((next) => typeof next === "string" && isCommitSha(next))
      ) {
        return json({ error: "repoId, expected, nexts" }, 400);
      }
      using repo = await env.ARTIFACTS.get(await mainRepoName(repoId));
      const updates = await Promise.all(
        nexts.map((next: string) => rawUpdate(repo, expected, next)),
      );
      return json({ updates, main: await mainHead(repo) });
    }
    case "fence": {
      // Hold an update's body open, revoke its token, then complete the body (#158 revoke fence).
      const repoId = stringField(body, "repoId", REPO_ID);
      const pair = commitPair(body);
      if (repoId === null || pair === null) return json({ error: "repoId, expected, next" }, 400);
      using repo = await env.ARTIFACTS.get(await mainRepoName(repoId));
      const token = await repo.createToken("write", MIN_TTL_SECONDS);
      const held = await heldUpdate(repo, token.plaintext, pair.expected, pair.next);
      await sleep(1_000);
      const revoked = await repo.revokeToken(token.id);
      await sleep(500);
      const answered = await held.complete();
      await sleep(1_000);
      return json({ revoked, answered, main: await mainHead(repo) });
    }
    case "evict": {
      // An adapter update in flight in a Durable Object that is evicted mid-request.
      const repoId = stringField(body, "repoId", REPO_ID);
      const pair = commitPair(body);
      if (repoId === null || pair === null) return json({ error: "repoId, expected, next" }, 400);
      const stub = env.EVICTION.getByName(repoId);
      let evicted = false;
      try {
        await stub.begin(repoId, pair.expected, pair.next);
      } catch {
        evicted = true;
      }
      return json({ evicted });
    }
    case "delete": {
      const repoId = stringField(body, "repoId", REPO_ID);
      if (repoId === null) return json({ error: "repoId" }, 400);
      return json({ deleted: await env.ARTIFACTS.delete(await mainRepoName(repoId)) });
    }
    default:
      return json({ error: "unknown case" }, 404);
  }
}

/** Constant-time comparison of the bearer secret. */
async function authorized(request: Request, secret: string): Promise<boolean> {
  const sent = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
  if (secret.length < 32) return false;
  const [a, b] = await Promise.all(
    [sent, secret].map(async (text) => crypto.subtle.digest("SHA-256", encoder.encode(text))),
  );
  if (a === undefined || b === undefined) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (request.method !== "POST") return json({ error: "POST only" }, 405);
    if (!(await authorized(request, env.PROBE_SECRET))) return json({ error: "forbidden" }, 403);
    const name = new URL(request.url).pathname.replace(/^\//, "");
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      return json({ error: "body must be JSON" }, 400);
    }
    try {
      return await route(env, name, body);
    } catch (error) {
      // The binding's error code only; never a message that could echo repository content.
      const code: unknown =
        typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
      return json({ error: typeof code === "string" ? code : "internal" }, 500);
    }
  },
} satisfies ExportedHandler<ProbeEnv>;
