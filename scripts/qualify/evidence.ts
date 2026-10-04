// Judges what `scripts/qualify-slice.mjs` observed against A40's acceptance (#63). Pure functions:
// the harness does every request and Git call, then hands the observations here, so the rules are
// tested without Cloudflare (`evidence.test.ts`).
//
// Everything judged here came from outside: the probe's answers, a deployed instance's public event
// log and Git's output. It is treated as untrusted JSON. A detail line names only identifiers,
// commit ids and counts the harness needs to cite, never event text or token values.

import { createHash } from "node:crypto";

/** One acceptance check and its outcome. */
export interface Check {
  /** Stable id, such as `listing.page`. */
  id: string;
  /** Whether it held. */
  outcome: "pass" | "fail";
  /** What was observed, without untrusted text or secrets. */
  detail: string;
}

/** An Artifacts token as the binding and the Git host present it. */
export const ARTIFACTS_TOKEN = /art_v1_[A-Za-z0-9]{16,}/;

/** The Artifacts Git remote of a live account: a 32-hex account id under `artifacts.cloudflare.net`. */
const LIVE_REMOTE = /^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/[^/]+\/[^/]+\.git$/;

const SHA = /^[0-9a-f]{40}$/;

/** Hosts a deployed instance never has: loopback, private ranges and reserved test names. */
const NOT_LIVE_HOST =
  /^(?:localhost|.*\.localhost|.*\.invalid|.*\.test|.*\.example|.*\.local|\[.*\]|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0)$/;

function check(id: string, pass: boolean, detail: string): Check {
  return { id, outcome: pass ? "pass" : "fail", detail };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function sha(value: unknown): string | null {
  return typeof value === "string" && SHA.test(value) ? value : null;
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : null;
}

/**
 * Why `origin` cannot be a deployed instance, or `null` when it can: an HTTPS origin on a public
 * host. A local dev server or a fake never satisfies the live gate.
 */
export function originProblem(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return "not a URL";
  }
  if (url.protocol !== "https:") return "not HTTPS";
  if (url.username !== "" || url.password !== "") return "carries credentials";
  if (NOT_LIVE_HOST.test(url.hostname)) return "not a public host";
  return null;
}

/** Why `remote` is not a live Artifacts Git remote, or `null` when it is. */
export function remoteProblem(remote: unknown): string | null {
  if (typeof remote !== "string") return "missing";
  return LIVE_REMOTE.test(remote) ? null : "not on a live Artifacts Git host";
}

// --- #161: the binding's token listing ----------------------------------------------------------

interface ListingPage {
  ids: string[];
  createdAt: string[];
  total: number;
}

function listingPage(value: unknown): ListingPage | null {
  const page = record(value);
  const ids = strings(page?.ids);
  const total = page?.total;
  if (page === null || ids === null || typeof total !== "number") return null;
  const tokens = Array.isArray(page.tokens) ? page.tokens : [];
  const createdAt = tokens.map((token) => text(record(token)?.createdAt) ?? "");
  return { ids, createdAt, total };
}

/** The page size the adapter's bound relies on (`TOKEN_PAGE_SIZE`). */
export const TOKEN_PAGE_SIZE = 30;

/** Judges the probe's `listing` observation against the #161 checks. */
export function judgeListing(observed: unknown): Check[] {
  const obs = record(observed);
  const full = listingPage(obs?.full);
  const afterRevoke = listingPage(obs?.afterRevoke);
  const afterExpiry = listingPage(obs?.afterExpiry);
  const minted = strings(obs?.minted);
  const revoked = text(obs?.revoked);
  const short = record(obs?.shortLived);
  const shortId = text(short?.id);
  const shortExpires = Date.parse(text(short?.expiresAt) ?? "");
  const listedAt = Date.parse(text(obs?.afterExpiryAt) ?? "");
  const withOptions = Array.isArray(obs?.withOptions) ? obs.withOptions.map(listingPage) : null;
  if (
    full === null ||
    afterRevoke === null ||
    afterExpiry === null ||
    minted === null ||
    revoked === null ||
    shortId === null ||
    withOptions === null
  ) {
    return [check("listing.shape", false, "the probe's listing observation is malformed")];
  }
  const live = minted.length;
  const newestFirst = minted.toReversed().slice(0, TOKEN_PAGE_SIZE);
  const createdDescending = full.createdAt.every(
    (at, index) => index === 0 || Date.parse(at) <= Date.parse(full.createdAt[index - 1] ?? ""),
  );
  return [
    check(
      "listing.page",
      full.ids.length === TOKEN_PAGE_SIZE && full.total === live && live > TOKEN_PAGE_SIZE,
      `${live} live tokens: page held ${full.ids.length}, total ${full.total}`,
    ),
    check(
      "listing.order",
      createdDescending && full.ids.every((id, index) => id === newestFirst[index]),
      createdDescending ? "page compared with mint order" : "createdAt not descending",
    ),
    check(
      "listing.revoked",
      !afterRevoke.ids.includes(revoked) && afterRevoke.total === live - 1,
      `after one revoke: total ${afterRevoke.total}, revoked id listed: ${afterRevoke.ids.includes(revoked)}`,
    ),
    check(
      "listing.expired",
      Number.isFinite(shortExpires) &&
        listedAt > shortExpires &&
        !afterExpiry.ids.includes(shortId) &&
        afterExpiry.total === live - 1,
      `listed ${listedAt - shortExpires} ms after expiry: total ${afterExpiry.total}, expired id listed: ${afterExpiry.ids.includes(shortId)}`,
    ),
    check(
      "listing.no-options",
      withOptions.length > 0 &&
        withOptions.every(
          (page) =>
            page !== null &&
            page.total === afterRevoke.total &&
            page.ids.join() === afterRevoke.ids.join(),
        ),
      `${withOptions.length} listings with paging or state options compared with the plain one`,
    ),
  ];
}

/**
 * Judges the binding's `total` against the REST route's active count for the same repository, both
 * read once nothing was minting. `restTotal` is `null` when the REST call failed or was not made.
 */
export function judgeRestActive(bindingTotal: unknown, restTotal: number | null): Check {
  return check(
    "listing.rest-active",
    typeof bindingTotal === "number" && restTotal !== null && bindingTotal === restTotal,
    `binding total ${String(bindingTotal)}, REST state=active total_count ${String(restTotal)}`,
  );
}

// --- #158: main's ref --------------------------------------------------------------------------

function portResult(value: unknown): { ok: boolean; code: string | null; value: unknown } | null {
  const result = record(value);
  if (result === null || typeof result.ok !== "boolean") return null;
  return { ok: result.ok, code: text(result.code), value: result.value };
}

interface AdapterStep {
  result: { ok: boolean; code: string | null; value: unknown };
  main: string | null;
  liveWriteTokens: number;
}

function adapterStep(value: unknown): AdapterStep | null {
  const step = record(value);
  const result = portResult(step?.result);
  const live = step?.liveWriteTokens;
  if (step === null || result === null || typeof live !== "number") return null;
  return { result, main: sha(step.main), liveWriteTokens: live };
}

function updateKind(step: AdapterStep): string | null {
  return step.result.ok ? text(record(step.result.value)?.kind) : null;
}

function rawLine(value: unknown): { status: number; line: string | null } | null {
  const raw = record(value);
  if (raw === null || typeof raw.status !== "number") return null;
  return { status: raw.status, line: text(raw.line) };
}

/** The commits the harness pushed to the probe's main before the cases ran. */
export interface MainRefCommits {
  /** Main's tip after setup; `c4` is its parent. */
  c4: string;
  c5: string;
  /** Children of c5 and n1: the first-parent path main moves along. */
  n1: string;
  n2: string;
  /** An orphan commit sharing no history with main. */
  unrelated: string;
  /** Children of n2, raced from n2. */
  race: string[];
  /** One child of each race commit, in the same order. */
  after: string[];
  /** A child of `unrelated`, for the fence and eviction cases. */
  u2: string;
}

/** What the harness recorded for each #158 case, in the order it ran them. */
export interface MainRefObservations {
  /** The probe repository's Git remote. */
  remote: unknown;
  /** Adapter update c5 → c4 (a rewind). */
  rewind: unknown;
  /** Adapter update c5 → unrelated. */
  unrelatedUpdate: unknown;
  /** Adapter update c5 → n1. */
  forward: unknown;
  /** Adapter update c5 → n1 again, now stale. */
  stale: unknown;
  /** Adapter update n1 → n2 whose response was lost, then a raw repeat. */
  lostResponse: unknown;
  /** Raw updates from n2 to each race commit at once. */
  race: unknown;
  /** Adapter update while the harness's own write token is live. */
  foreignToken: unknown;
  /** Adapter update after the harness force-pushed main to `unrelated` and revoked its token. */
  foreignPush: unknown;
  /** Raw update held open while its token was revoked. */
  fence: unknown;
  /** Main read at least a token lifetime after an evicted in-flight update. */
  eviction: unknown;
}

/** Judges the #158 main-ref observations. */
export function judgeMainRef(commits: MainRefCommits, obs: MainRefObservations): Check[] {
  const checks: Check[] = [];
  const remote = remoteProblem(obs.remote);
  checks.push(check("main.live", remote === null, remote ?? "live Artifacts remote"));

  for (const [id, value, label] of [
    ["main.refuses-rewind", obs.rewind, "c5 → c4"],
    ["main.refuses-unrelated", obs.unrelatedUpdate, "c5 → unrelated"],
  ] as const) {
    const step = adapterStep(value);
    checks.push(
      check(
        id,
        step !== null &&
          !step.result.ok &&
          step.result.code === "invalid_request" &&
          step.main === commits.c5 &&
          step.liveWriteTokens === 0,
        step === null
          ? "malformed"
          : `${label}: ${step.result.ok ? "accepted" : step.result.code}, main ${step.main}, live write tokens ${step.liveWriteTokens}`,
      ),
    );
  }

  const forward = adapterStep(obs.forward);
  checks.push(
    check(
      "main.updates",
      forward !== null &&
        updateKind(forward) === "updated" &&
        forward.main === commits.n1 &&
        forward.liveWriteTokens === 0,
      forward === null ? "malformed" : `c5 → n1: ${updateKind(forward)}, main ${forward.main}`,
    ),
  );

  const stale = adapterStep(obs.stale);
  const staleActual = stale?.result.ok ? sha(record(stale.result.value)?.actual) : null;
  checks.push(
    check(
      "main.compare-and-swap",
      stale !== null &&
        updateKind(stale) === "rejected" &&
        staleActual === commits.n1 &&
        stale.main === commits.n1,
      stale === null ? "malformed" : `stale c5 → n1: ${updateKind(stale)}, main ${stale.main}`,
    ),
  );

  const lost = adapterStep(obs.lostResponse);
  const repeat = rawLine(record(obs.lostResponse)?.repeat);
  checks.push(
    check(
      "main.lost-response",
      lost !== null &&
        updateKind(lost) === "uncertain" &&
        lost.main === commits.n2 &&
        lost.liveWriteTokens === 0 &&
        repeat !== null &&
        repeat.line === "ng refs/heads/main stale ref",
      lost === null
        ? "malformed"
        : `n1 → n2 with its answer lost: ${updateKind(lost) ?? lost.result.code}, main ${lost.main}; repeat: ${repeat?.line ?? "no status line"}`,
    ),
  );

  const race = record(obs.race);
  const updates = Array.isArray(race?.updates) ? race.updates.map(rawLine) : [];
  const landed = updates.flatMap((update, index) =>
    update?.line === "ok refs/heads/main" ? [commits.race[index]] : [],
  );
  const staleCount = updates.filter(
    (update) => update?.line === "ng refs/heads/main stale ref",
  ).length;
  const winner = landed[0] ?? null;
  checks.push(
    check(
      "main.race",
      updates.length === commits.race.length &&
        landed.length === 1 &&
        staleCount === updates.length - 1 &&
        sha(race?.main) === winner,
      `${updates.length} concurrent updates from n2: ${landed.length} ok, ${staleCount} stale ref, main ${sha(race?.main)}`,
    ),
  );

  const foreignToken = adapterStep(obs.foreignToken);
  checks.push(
    check(
      "main.refuses-foreign-token",
      foreignToken !== null &&
        !foreignToken.result.ok &&
        foreignToken.result.code === "unavailable" &&
        foreignToken.main === winner,
      foreignToken === null
        ? "malformed"
        : `with another write token live: ${foreignToken.result.ok ? "accepted" : foreignToken.result.code}, main ${foreignToken.main}`,
    ),
  );

  const foreignPush = adapterStep(obs.foreignPush);
  const pushedActual = foreignPush?.result.ok
    ? sha(record(foreignPush.result.value)?.actual)
    : null;
  checks.push(
    check(
      "main.detects-foreign-push",
      foreignPush !== null &&
        updateKind(foreignPush) === "rejected" &&
        pushedActual === commits.unrelated &&
        foreignPush.main === commits.unrelated &&
        foreignPush.liveWriteTokens === 0,
      foreignPush === null
        ? "malformed"
        : `after a forced push: ${updateKind(foreignPush) ?? foreignPush.result.code}, reported ${pushedActual}, main ${foreignPush.main}`,
    ),
  );

  const fence = record(obs.fence);
  const answered = rawLine(fence?.answered);
  checks.push(
    check(
      "main.revoke-fence",
      fence?.revoked === true &&
        answered !== null &&
        answered.line !== "ok refs/heads/main" &&
        sha(fence.main) === commits.unrelated,
      `body completed after revoke: HTTP ${answered?.status}, ${answered?.line ?? "no status line"}, main ${sha(fence?.main)}`,
    ),
  );

  const eviction = record(obs.eviction);
  checks.push(
    check(
      "main.eviction",
      eviction?.evicted === true &&
        sha(eviction.main) === commits.unrelated &&
        eviction.liveWriteTokens === 0 &&
        typeof eviction.waitedMs === "number" &&
        eviction.waitedMs >= 60_000,
      `evicted: ${String(eviction?.evicted)}, main ${sha(eviction?.main)} after ${String(eviction?.waitedMs)} ms, live write tokens ${String(eviction?.liveWriteTokens)}`,
    ),
  );
  return checks;
}

// --- The slice on a deployed instance ----------------------------------------------------------

/** What the harness read from one agent's clone of its claim. */
export interface CloneObservation {
  /** `remote.origin.url`, as Git resolves it. */
  originUrl: string;
  /** `railhead.identity`. */
  identity: string;
  /** Whether `git ls-remote origin` succeeded through the instance. */
  reachable: boolean;
  /** How many Artifacts-token-shaped strings the clone's Git files and helper output held. */
  tokensFound: number;
}

/** The HTTP status of each request the instance must refuse. */
export interface DenialObservation {
  /** A receive-pack request creating a branch on main's remote, with an agent's session. */
  pushToMainStatus: number;
  /** An advertisement of another agent's claim, with an agent's session. */
  otherClaimStatus: number;
  /** An unauthenticated advertisement of a claim remote. */
  anonymousStatus: number;
}

/** Everything the harness gathered from a deployed instance. */
export interface SliceObservations {
  /** The instance's HTTPS origin. */
  origin: string;
  /** `<org>/<name>`. */
  repo: string;
  /** The slice's events from the public log, as `sliceEvents` reduces them. */
  events: unknown[];
  /** How many events the whole log held. */
  eventCount: number;
  /** How many events of the whole log held an Artifacts token. */
  logTokens: number;
  clones: CloneObservation[];
  /** Main's commit as `git ls-remote` of the main remote reported it. */
  remoteMain: string | null;
  denials: DenialObservation;
}

type IdField = "agent" | "claim" | "checkRun" | "intent" | "sha" | "word" | "claims";

const ID_FIELD: Record<Exclude<IdField, "sha" | "word" | "claims">, RegExp> = {
  agent: /^agt_[A-Za-z0-9]{6,64}$/,
  claim: /^clm_[A-Za-z0-9]{6,64}$/,
  checkRun: /^chk_[A-Za-z0-9]{6,64}$/,
  intent: /^int_[A-Za-z0-9]{6,64}$/,
};

const WORD = /^[a-z_]{1,32}$/;
const REPO_ID = /^rep_[A-Za-z0-9]{6,64}$/;

/** The fields the slice is judged on, for each event type it reads. */
const SLICE_EVENT_FIELDS: Readonly<Record<string, Readonly<Record<string, IdField>>>> = {
  "agent.confirmed": { agentId: "agent" },
  "claim.opened": { claimId: "claim", agentId: "agent" },
  "train.check": { checkRunId: "checkRun", candidate: "sha", result: "word" },
  "train.intent": {
    intentId: "intent",
    checkRunId: "checkRun",
    expectedMain: "sha",
    candidate: "sha",
    claims: "claims",
  },
  "train.main": { intentId: "intent", outcome: "word", main: "sha" },
  "claim.merged": { claimId: "claim", commit: "sha" },
};

function idField(kind: IdField, value: unknown): unknown {
  switch (kind) {
    case "sha":
      return sha(value);
    case "word":
      return typeof value === "string" && WORD.test(value) ? value : null;
    case "claims": {
      const claims = strings(value);
      return claims !== null && claims.every((claim) => ID_FIELD.claim.test(claim)) ? claims : null;
    }
    case "agent":
    case "claim":
    case "checkRun":
    case "intent":
      return typeof value === "string" && ID_FIELD[kind].test(value) ? value : null;
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

/** One event the slice is judged on: its position, time, log and validated ids only. */
export interface SliceEvent {
  seq: number;
  at: number;
  repo: string;
  type: string;
  data: Record<string, unknown>;
}

/**
 * The events of `events` the slice is judged on, each reduced to its position, time, log and the
 * ids, commits and outcomes the checks read, so a report holds no event text. An event with a field
 * that is missing or not shaped like its id is left out.
 */
export function sliceEvents(events: readonly unknown[]): SliceEvent[] {
  return events.flatMap((event) => {
    const value = record(event);
    const type = text(value?.type);
    const fields = type === null ? undefined : SLICE_EVENT_FIELDS[type];
    const data = record(value?.data);
    const seq = value?.seq;
    const at = value?.at;
    const repo = text(value?.repo);
    if (
      type === null ||
      fields === undefined ||
      data === null ||
      !Number.isSafeInteger(seq) ||
      typeof seq !== "number" ||
      typeof at !== "number" ||
      !Number.isFinite(at) ||
      repo === null ||
      !REPO_ID.test(repo)
    ) {
      return [];
    }
    const kept = Object.entries(fields).map(([key, kind]) => [key, idField(kind, data[key])]);
    if (kept.some(([, field]) => field === null)) return [];
    return [{ seq, at, repo, type, data: Object.fromEntries(kept) }];
  });
}

/** How many of `events` hold an Artifacts token anywhere. */
export function eventsWithToken(events: readonly unknown[]): number {
  return events.filter((event) => ARTIFACTS_TOKEN.test(JSON.stringify(event))).length;
}

interface LoggedEvent {
  type: string;
  data: Record<string, unknown>;
}

function loggedEvents(events: unknown[]): LoggedEvent[] {
  return events.flatMap((event) => {
    const value = record(event);
    const type = text(value?.type);
    const data = record(value?.data);
    return type === null || data === null ? [] : [{ type, data }];
  });
}

/** The exact commits a landed batch rests on. */
export interface LandedBatch {
  intentId: string;
  checkRunId: string;
  expectedMain: string;
  candidate: string;
  main: string;
  claims: string[];
}

/** Every batch of two or more claims that passed its check and moved main to its candidate. */
export function landedBatches(events: unknown[]): LandedBatch[] {
  const logged = loggedEvents(events);
  const passed = new Map<string, string>();
  for (const { type, data } of logged) {
    const run = text(data.checkRunId);
    const candidate = sha(data.candidate);
    if (type === "train.check" && data.result === "pass" && run !== null && candidate !== null) {
      passed.set(run, candidate);
    }
  }
  const updated = new Map<string, string>();
  for (const { type, data } of logged) {
    const intent = text(data.intentId);
    const main = sha(data.main);
    if (type === "train.main" && data.outcome === "updated" && intent !== null && main !== null) {
      updated.set(intent, main);
    }
  }
  const merged = new Set(
    logged.flatMap(({ type, data }) =>
      type === "claim.merged" ? [`${text(data.claimId)}@${sha(data.commit)}`] : [],
    ),
  );
  return logged.flatMap(({ type, data }) => {
    if (type !== "train.intent") return [];
    const intentId = text(data.intentId);
    const checkRunId = text(data.checkRunId);
    const candidate = sha(data.candidate);
    const expectedMain = sha(data.expectedMain);
    const claims = strings(data.claims) ?? [];
    if (intentId === null || checkRunId === null || candidate === null || expectedMain === null) {
      return [];
    }
    const main = updated.get(intentId);
    const landedAll = claims.every((claim) => merged.has(`${claim}@${candidate}`));
    return claims.length >= 2 &&
      passed.get(checkRunId) === candidate &&
      main === candidate &&
      landedAll
      ? [{ intentId, checkRunId, expectedMain, candidate, main, claims }]
      : [];
  });
}

/**
 * The claim `url` names when it is exactly a claim remote of `repo` (`<org>/<name>`) on
 * `origin`'s HTTPS origin, or `null`. Every destination the harness sends a credential to passes
 * this first.
 */
export function claimOfRemote(origin: string, repo: string, url: string): string | null {
  let base: URL;
  let parsed: URL;
  try {
    base = new URL(origin);
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || parsed.href !== url) return null;
  const prefix = `${base.origin}/git/${repo}/claims/`;
  if (!url.startsWith(prefix) || !url.endsWith(".git")) return null;
  const claim = url.slice(prefix.length, -".git".length);
  return ID_FIELD.claim.test(claim) ? claim : null;
}

/** Judges a slice run on a deployed instance. */
export function judgeSlice(obs: SliceObservations): Check[] {
  const checks: Check[] = [];
  const origin = originProblem(obs.origin);
  checks.push(check("slice.live", origin === null, origin ?? "public HTTPS origin"));

  const logged = loggedEvents(obs.events);
  const confirmed = new Set(
    logged.flatMap(({ type, data }) => (type === "agent.confirmed" ? [text(data.agentId)] : [])),
  );
  const holder = new Map<string, string>();
  for (const { type, data } of logged) {
    const claim = text(data.claimId);
    const agent = text(data.agentId);
    if (type === "claim.opened" && claim !== null && agent !== null) holder.set(claim, agent);
  }
  const cloneClaims = obs.clones.map((clone) =>
    claimOfRemote(obs.origin, obs.repo, clone.originUrl),
  );
  const cloneAgents = cloneClaims.map((claim) => (claim === null ? null : holder.get(claim)));
  const distinctClaims = new Set(cloneClaims.filter((claim) => claim !== null));
  const distinctAgents = new Set(cloneAgents.filter((agent) => agent !== undefined));
  checks.push(
    check(
      "slice.agents",
      obs.clones.length >= 3 &&
        distinctAgents.size === obs.clones.length &&
        [...distinctAgents].every((agent) => agent !== null && confirmed.has(agent)) &&
        obs.clones.every((clone, index) => clone.identity === cloneAgents[index]),
      `${obs.clones.length} clones held by ${distinctAgents.size} distinct confirmed agents`,
    ),
  );
  checks.push(
    check(
      "slice.forks",
      obs.clones.length >= 3 &&
        distinctClaims.size === obs.clones.length &&
        obs.clones.every((clone) => clone.reachable),
      `${distinctClaims.size} distinct claim remotes, ${obs.clones.filter((clone) => clone.reachable).length} reachable over Git`,
    ),
  );

  const batches = landedBatches(obs.events).filter((batch) =>
    batch.claims.some((claim) => distinctClaims.has(claim)),
  );
  const batch = batches.at(-1);
  checks.push(
    check(
      "slice.batch",
      batch !== undefined,
      batch === undefined
        ? "no batch of two or more claims passed its check and moved main to its candidate"
        : `intent ${batch.intentId}: ${batch.claims.length} claims, check ${batch.checkRunId} passed on ${batch.candidate}, main ${batch.expectedMain} → ${batch.main}`,
    ),
  );

  const lastMain = logged.flatMap(({ type, data }) =>
    type === "train.main" && data.outcome === "updated" ? [sha(data.main)] : [],
  );
  const logMain = lastMain.at(-1) ?? null;
  checks.push(
    check(
      "slice.main",
      logMain !== null && obs.remoteMain === logMain,
      `log's last landing ${logMain}, Git reports main at ${obs.remoteMain}`,
    ),
  );

  const logTokens = obs.logTokens + eventsWithToken(obs.events);
  const cloneTokens = obs.clones.reduce((sum, clone) => sum + clone.tokensFound, 0);
  checks.push(
    check(
      "slice.no-token",
      logTokens === 0 && cloneTokens === 0,
      `Artifacts tokens found: ${logTokens} in the event log, ${cloneTokens} in agent clones`,
    ),
  );

  const { pushToMainStatus, otherClaimStatus, anonymousStatus } = obs.denials;
  checks.push(
    check(
      "slice.proxy-denial",
      pushToMainStatus === 403 &&
        (otherClaimStatus === 403 || otherClaimStatus === 404) &&
        anonymousStatus === 401,
      `push to main HTTP ${pushToMainStatus}, other agent's claim HTTP ${otherClaimStatus}, anonymous HTTP ${anonymousStatus}`,
    ),
  );
  return checks;
}

/** Whether there was a check and every one passed. */
export function gatePasses(checks: readonly Check[]): boolean {
  return checks.length > 0 && checks.every((item) => item.outcome === "pass");
}

// --- Reports and the gate ----------------------------------------------------------------------
//
// The gate does not trust a report's own outcomes. It judges each report again from the
// observations it recorded, and from where and when they were collected: the probe Worker's host,
// the run's start and end, the repositories, token ids and times Artifacts assigned, and the event
// log's positions and times. A report that leaves out a case, or one built by hand from outcomes
// alone, fails.

/** Every check a binding report must pass, in the order it is judged. */
export const BINDING_CHECK_IDS = [
  "binding.provenance",
  "listing.live",
  "listing.page",
  "listing.order",
  "listing.revoked",
  "listing.expired",
  "listing.no-options",
  "listing.rest-active",
  "main.live",
  "main.refuses-rewind",
  "main.refuses-unrelated",
  "main.updates",
  "main.compare-and-swap",
  "main.lost-response",
  "main.race",
  "main.refuses-foreign-token",
  "main.detects-foreign-push",
  "main.revoke-fence",
  "main.eviction",
] as const;

/** Every check a slice report must pass, in the order it is judged. */
export const SLICE_CHECK_IDS = [
  "slice.provenance",
  "slice.live",
  "slice.agents",
  "slice.forks",
  "slice.batch",
  "slice.main",
  "slice.no-token",
  "slice.proxy-denial",
] as const;

/** The host `probe-config` deploys the probe on: its Worker name on a workers.dev subdomain. */
const PROBE_HOST = /^railhead-qual-probe\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev$/;

/** Why `url` is not the probe `probe-config` deploys, or `null` when it is. */
export function probeProblem(url: string): string | null {
  const problem = originProblem(url);
  if (problem !== null) return problem;
  return PROBE_HOST.test(new URL(url).hostname)
    ? null
    : "not the railhead-qual-probe Worker on workers.dev";
}

/** How many tokens the probe's listing case mints (`LISTING_TOKENS` in the probe). */
const LISTING_TOKENS = 31;
/** The shortest a binding run can take: the 60 s token's expiry, then the eviction's wait. */
const MIN_BINDING_MS = 120_000;
/** The longest a binding run can take. */
const MAX_BINDING_MS = 2 * 3_600_000;
/** How far the operator's clock and Cloudflare's may disagree. */
const CLOCK_SKEW_MS = 120_000;
const PROBE_REPO_ID = /^rep_[0-9a-f]{64}$/;

/** The Artifacts name the probe gives `repoId`'s main, as `mainRepoName` derives it. */
function probeRepoName(repoId: string): string {
  return `rh-m-${createHash("sha256").update(repoId).digest("hex").slice(0, 32)}`;
}

/** A throwaway repository the probe created, as the binding report records it. */
export interface ProbeRepository {
  /** The random repository id the probe chose. */
  repoId: string;
  /** Its Artifacts name. */
  name: string;
  /** Its Git remote, as Artifacts assigned it. */
  remote: string;
}

function probeRepository(value: unknown): ProbeRepository | null {
  const repo = record(value);
  const repoId = text(repo?.repoId);
  const name = text(repo?.name);
  const remote = text(repo?.remote);
  return repoId === null || name === null || remote === null ? null : { repoId, name, remote };
}

function mainRefCommits(value: unknown): MainRefCommits | null {
  const commits = record(value);
  const one = (key: string) => sha(commits?.[key]);
  const many = (key: string) => {
    const list = strings(commits?.[key]);
    return list !== null && list.every((id) => SHA.test(id)) ? list : null;
  };
  const [c4, c5, n1, n2, unrelated, u2] = ["c4", "c5", "n1", "n2", "unrelated", "u2"].map(one);
  const race = many("race");
  const after = many("after");
  if (
    c4 == null ||
    c5 == null ||
    n1 == null ||
    n2 == null ||
    unrelated == null ||
    u2 == null ||
    race === null ||
    after === null
  ) {
    return null;
  }
  return { c4, c5, n1, n2, unrelated, race, after, u2 };
}

/** Every token time a listing observation names, in milliseconds. */
function listedTimes(listing: Record<string, unknown> | null): number[] {
  const pages = [
    listing?.full,
    listing?.afterRevoke,
    listing?.afterExpiry,
    ...(Array.isArray(listing?.withOptions) ? listing.withOptions : []),
  ];
  return pages.flatMap((page) => {
    const tokens = record(page)?.tokens;
    return Array.isArray(tokens)
      ? tokens.map((token) => Date.parse(text(record(token)?.createdAt) ?? ""))
      : [Number.NaN];
  });
}

/** A remote without its repository name: the account's Git host and namespace. */
function accountOf(remote: string): string {
  return remote.slice(0, remote.lastIndexOf("/"));
}

function bindingProvenance(
  report: Record<string, unknown>,
  repositories: { listing: ProbeRepository; main: ProbeRepository },
  commits: MainRefCommits,
  observations: Record<string, unknown>,
  now: number,
): Check {
  const problems: string[] = [];
  const probe = text(report.probe);
  if (probe === null || !PROBE_HOST.test(probe)) problems.push("probe host");
  const started = Date.parse(text(report.startedAt) ?? "");
  const finished = Date.parse(text(report.finishedAt) ?? "");
  const took = finished - started;
  if (
    !Number.isFinite(took) ||
    took < MIN_BINDING_MS ||
    took > MAX_BINDING_MS ||
    finished > now + CLOCK_SKEW_MS
  ) {
    problems.push("run times");
  }
  const within = (at: number, from = started) =>
    Number.isFinite(at) && at >= from - CLOCK_SKEW_MS && at <= finished + CLOCK_SKEW_MS;

  const { listing, main } = repositories;
  if (
    [listing, main].some(
      (repo) =>
        !PROBE_REPO_ID.test(repo.repoId) ||
        repo.name !== probeRepoName(repo.repoId) ||
        remoteProblem(repo.remote) !== null ||
        !repo.remote.endsWith(`/${repo.name}.git`),
    ) ||
    listing.repoId === main.repoId ||
    accountOf(listing.remote) !== accountOf(main.remote)
  ) {
    problems.push("repositories");
  }

  const all = [
    commits.c4,
    commits.c5,
    commits.n1,
    commits.n2,
    commits.unrelated,
    commits.u2,
    ...commits.race,
    ...commits.after,
  ];
  if (
    new Set(all).size !== all.length ||
    commits.race.length < 2 ||
    commits.after.length !== commits.race.length
  ) {
    problems.push("commits");
  }

  const observed = record(observations.listing);
  const minted = strings(observed?.minted) ?? [];
  const shortExpires = Date.parse(text(record(observed?.shortLived)?.expiresAt) ?? "");
  if (
    minted.length !== LISTING_TOKENS ||
    new Set(minted).size !== minted.length ||
    !listedTimes(observed).every((at) => within(at)) ||
    !within(shortExpires, started + 60_000) ||
    !within(Date.parse(text(observed?.afterExpiryAt) ?? ""))
  ) {
    problems.push("token ids and times");
  }

  const waited = record(observations.eviction)?.waitedMs;
  if (typeof waited !== "number" || waited > took) problems.push("eviction wait");
  return check(
    "binding.provenance",
    problems.length === 0,
    problems.length === 0
      ? `probe on workers.dev, ${Math.round(took / 1000)} s run, repositories and token times inside it`
      : `not a live collection: ${problems.join(", ")}`,
  );
}

/**
 * Judges a binding report as `qualify-slice.mjs binding` writes it: where and when it was collected,
 * then every #161 and #158 case from the observations it recorded.
 */
export function judgeBinding(report: unknown, now: number): Check[] {
  const body = record(report);
  const repositories = record(body?.repositories);
  const listing = probeRepository(repositories?.listing);
  const main = probeRepository(repositories?.main);
  const commits = mainRefCommits(body?.commits);
  const obs = record(body?.observations);
  if (body === null || listing === null || main === null || commits === null || obs === null) {
    return [check("binding.shape", false, "the binding report is malformed or incomplete")];
  }
  const listingLive = remoteProblem(listing.remote);
  const rest = obs.restActive;
  return [
    bindingProvenance(body, { listing, main }, commits, obs, now),
    check("listing.live", listingLive === null, listingLive ?? "live Artifacts remote"),
    ...judgeListing(obs.listing),
    judgeRestActive(
      record(record(obs.listing)?.afterExpiry)?.total,
      typeof rest === "number" ? rest : null,
    ),
    ...judgeMainRef(commits, {
      remote: main.remote,
      rewind: obs.rewind,
      unrelatedUpdate: obs.unrelatedUpdate,
      forward: obs.forward,
      stale: obs.stale,
      lostResponse: obs.lostResponse,
      race: obs.race,
      foreignToken: obs.foreignToken,
      foreignPush: obs.foreignPush,
      fence: obs.fence,
      eviction: obs.eviction,
    }),
  ];
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function sliceObservations(value: unknown): SliceObservations | null {
  const obs = record(value);
  const origin = text(obs?.origin);
  const repo = text(obs?.repo);
  const events = Array.isArray(obs?.events) ? obs.events : null;
  const eventCount = count(obs?.eventCount);
  const logTokens = count(obs?.logTokens);
  const denials = record(obs?.denials);
  const statuses = [denials?.pushToMainStatus, denials?.otherClaimStatus, denials?.anonymousStatus];
  const [pushToMainStatus, otherClaimStatus, anonymousStatus] = statuses.map(count);
  const clones = Array.isArray(obs?.clones)
    ? obs.clones.map((item) => {
        const clone = record(item);
        const originUrl = text(clone?.originUrl);
        const identity = text(clone?.identity);
        const tokensFound = count(clone?.tokensFound);
        return originUrl === null ||
          identity === null ||
          typeof clone?.reachable !== "boolean" ||
          tokensFound === null
          ? null
          : { originUrl, identity, reachable: clone.reachable, tokensFound };
      })
    : null;
  if (
    origin === null ||
    repo === null ||
    events === null ||
    eventCount === null ||
    logTokens === null ||
    pushToMainStatus == null ||
    otherClaimStatus == null ||
    anonymousStatus == null ||
    clones === null ||
    clones.includes(null) ||
    (obs?.remoteMain !== null && sha(obs?.remoteMain) === null)
  ) {
    return null;
  }
  return {
    origin,
    repo,
    events,
    eventCount,
    logTokens,
    clones: clones.flatMap((clone) => (clone === null ? [] : [clone])),
    remoteMain: sha(obs?.remoteMain),
    denials: { pushToMainStatus, otherClaimStatus, anonymousStatus },
  };
}

const REPO_PATH = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\/[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function sliceProvenance(readAtText: unknown, obs: SliceObservations, now: number): Check {
  const problems: string[] = [];
  const readAt = Date.parse(text(readAtText) ?? "");
  if (!Number.isFinite(readAt) || readAt > now + CLOCK_SKEW_MS) problems.push("read time");
  if (!REPO_PATH.test(obs.repo)) problems.push("repository");
  const events = sliceEvents(obs.events);
  const logs = new Set(events.map((event) => event.repo));
  const ordered = events.every((event, index) => {
    const before = events[index - 1];
    return (
      event.seq >= 1 &&
      event.seq <= obs.eventCount &&
      event.at <= readAt + CLOCK_SKEW_MS &&
      (before === undefined || (event.seq > before.seq && event.at >= before.at))
    );
  });
  if (events.length !== obs.events.length || logs.size !== 1 || !ordered) {
    problems.push("event log positions and times");
  }
  return check(
    "slice.provenance",
    problems.length === 0,
    problems.length === 0
      ? `${events.length} slice events of ${obs.eventCount} read from one log`
      : `not a live collection: ${problems.join(", ")}`,
  );
}

/**
 * Judges a slice report as `qualify-slice.mjs slice` writes it: where and when the log was read,
 * then the slice from the observations it recorded.
 */
export function judgeSliceReport(report: unknown, now: number): Check[] {
  const body = record(report);
  const obs = sliceObservations(body?.observations);
  if (body === null || obs === null) {
    return [check("slice.shape", false, "the slice report is malformed or incomplete")];
  }
  return [sliceProvenance(body.readAt, obs, now), ...judgeSlice(obs)];
}

/**
 * Judges one report for the gate: its kind's checks from the recorded observations, then whether
 * every required check was judged and whether the outcomes the report recorded are the ones its
 * observations give.
 */
export function judgeReport(report: unknown, now: number): Check[] {
  const body = record(report);
  const kind = text(body?.kind);
  let checks: Check[];
  let required: readonly string[];
  if (kind === "binding") {
    checks = judgeBinding(report, now);
    required = BINDING_CHECK_IDS;
  } else if (kind === "slice") {
    checks = judgeSliceReport(report, now);
    required = SLICE_CHECK_IDS;
  } else {
    return [check("report.kind", false, "neither a binding nor a slice report")];
  }
  const ids = checks.map((item) => item.id);
  const recorded = Array.isArray(body?.checks) ? body.checks.map(record) : [];
  const complete = ids.length === required.length && required.every((id, i) => ids[i] === id);
  const same =
    recorded.length === checks.length &&
    checks.every(
      (item, index) => recorded[index]?.id === item.id && recorded[index]?.outcome === item.outcome,
    );
  return [
    ...checks,
    check(
      "report.complete",
      complete,
      `${ids.length} of ${required.length} required checks judged`,
    ),
    check(
      "report.recorded",
      same,
      same ? "recorded outcomes match the observations" : "recorded outcomes differ",
    ),
  ];
}
