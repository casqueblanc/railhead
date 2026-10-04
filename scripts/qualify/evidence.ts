// Judges what `scripts/qualify-slice.mjs` observed against A40's acceptance (#63). Pure functions:
// the harness does every request and Git call, then hands the observations here, so the rules are
// tested without Cloudflare (`evidence.test.ts`).
//
// Everything judged here came from outside: the probe's answers, a deployed instance's public event
// log and Git's output. It is treated as untrusted JSON. A detail line names only identifiers,
// commit ids and counts the harness needs to cite, never event text or token values.

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
  /** `remote.origin.url`. */
  originUrl: string;
  /** `railhead.identity`. */
  identity: string;
  /** Whether `git ls-remote origin` succeeded through the instance. */
  reachable: boolean;
  /** How many Artifacts-token-shaped strings the clone's Git files and helper output held. */
  tokensFound: number;
}

/** Whether the instance refused what an agent must never be able to do through it. */
export interface DenialObservation {
  /** `git push` of a branch to main's remote with an agent's credential. */
  pushToMain: "refused" | "accepted";
  /** `git ls-remote` of another agent's claim with an agent's credential. */
  otherClaim: "refused" | "accepted";
  /** HTTP status of an unauthenticated advertisement of a claim remote. */
  anonymousStatus: number;
}

/** Everything the harness gathered from a deployed instance. */
export interface SliceObservations {
  origin: string;
  /** The repository's whole public event log, as read from the board session. */
  events: unknown[];
  clones: CloneObservation[];
  /** Main's commit as `git ls-remote` of the main remote reported it. */
  remoteMain: string | null;
  denials: DenialObservation;
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

/** The claim a clone's origin URL names on `origin`, or `null`. */
export function claimOfRemote(origin: string, url: string): string | null {
  const base = new URL(origin).origin;
  if (!url.startsWith(`${base}/git/`)) return null;
  return /\/claims\/(clm_[0-9a-f]+)\.git$/.exec(url)?.[1] ?? null;
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
  const cloneClaims = obs.clones.map((clone) => claimOfRemote(obs.origin, clone.originUrl));
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
      distinctClaims.size === obs.clones.length && obs.clones.every((clone) => clone.reachable),
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

  const logTokens = obs.events.filter((event) =>
    ARTIFACTS_TOKEN.test(JSON.stringify(event)),
  ).length;
  const cloneTokens = obs.clones.reduce((sum, clone) => sum + clone.tokensFound, 0);
  checks.push(
    check(
      "slice.no-token",
      logTokens === 0 && cloneTokens === 0,
      `Artifacts tokens found: ${logTokens} in the event log, ${cloneTokens} in agent clones`,
    ),
  );

  checks.push(
    check(
      "slice.proxy-denial",
      obs.denials.pushToMain === "refused" &&
        obs.denials.otherClaim === "refused" &&
        obs.denials.anonymousStatus === 401,
      `push to main ${obs.denials.pushToMain}, other agent's claim ${obs.denials.otherClaim}, anonymous HTTP ${obs.denials.anonymousStatus}`,
    ),
  );
  return checks;
}

/** Whether there was a check and every one passed. */
export function gatePasses(checks: readonly Check[]): boolean {
  return checks.length > 0 && checks.every((item) => item.outcome === "pass");
}
