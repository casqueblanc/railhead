// Observations and reports shaped as the live harness collects them, for `evidence.test.ts` and
// `qualify-slice.test.ts`. They are test inputs only: built by hand, they stand for what a live run
// records, so each test changes one part and asserts which checks that part decides.

import type { MainRefCommits, MainRefObservations, SliceObservations } from "./evidence.ts";

export const LIVE_REMOTE =
  "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/qual/rh-m-1.git";

export const sha = (digit: string): string => digit.repeat(40);

/** A time on the day of the recorded run, `seconds` past 09:00 UTC. */
export function at(seconds: number): string {
  return new Date(Date.UTC(2026, 9, 1, 9, 0, seconds)).toISOString();
}

/** A listing observation as live Artifacts produced it on #161: 31 live tokens, page of 30. */
export function liveListing() {
  const minted = Array.from({ length: 31 }, (_, index) => `tok_${String(index).padStart(2, "0")}`);
  const page = (ids: string[]) => ({
    ids,
    tokens: ids.map((id) => ({
      id,
      scope: "read",
      state: "active",
      createdAt: at(minted.indexOf(id) + 1),
      expiresAt: at(3_601),
    })),
  });
  const full = minted.toReversed().slice(0, 30);
  const afterRevoke = minted.slice(0, 30).toReversed();
  return {
    full: { ...page(full), total: 31 },
    minted,
    afterRevoke: { ...page(afterRevoke), total: 30 },
    revoked: "tok_30",
    withOptions: [{ ...page(afterRevoke), total: 30 }],
    shortLived: { id: "tok_short", expiresAt: at(100) },
    afterExpiry: { ...page(afterRevoke), total: 30 },
    afterExpiryAt: at(105),
  };
}

export const COMMITS: MainRefCommits = {
  c4: sha("4"),
  c5: sha("5"),
  n1: sha("6"),
  n2: sha("7"),
  unrelated: sha("8"),
  race: [sha("a"), sha("b"), sha("c")],
  after: [sha("d"), sha("e"), sha("f")],
  u2: sha("9"),
};

export const updated = (main: string) => ({
  result: { ok: true, value: { kind: "updated" } },
  main,
  liveWriteTokens: 0,
});

/** An adapter refusal with main read back. */
export function refused(code: string, main: string) {
  return { result: { ok: false, code, message: "refused" }, main, liveWriteTokens: 0 };
}

/** Main-ref observations matching the behaviour #158 measured and its adopted spec. */
export function liveMainRef(): MainRefObservations {
  return {
    remote: LIVE_REMOTE,
    rewind: refused("invalid_request", COMMITS.c5),
    unrelatedUpdate: refused("invalid_request", COMMITS.c5),
    forward: updated(COMMITS.n1),
    stale: {
      result: { ok: true, value: { kind: "rejected", actual: COMMITS.n1 } },
      main: COMMITS.n1,
      liveWriteTokens: 0,
    },
    lostResponse: {
      result: { ok: true, value: { kind: "uncertain" } },
      main: COMMITS.n2,
      liveWriteTokens: 0,
      repeat: { status: 200, line: "ng refs/heads/main stale ref" },
    },
    race: {
      updates: [
        { status: 200, line: "ng refs/heads/main stale ref" },
        { status: 200, line: "ok refs/heads/main" },
        { status: 200, line: "ng refs/heads/main stale ref" },
      ],
      main: COMMITS.race[1],
    },
    foreignToken: refused("unavailable", COMMITS.race[1] ?? ""),
    foreignPush: {
      result: { ok: true, value: { kind: "rejected", actual: COMMITS.unrelated } },
      main: COMMITS.unrelated,
      liveWriteTokens: 0,
    },
    fence: { revoked: true, answered: { status: 403, line: null }, main: COMMITS.unrelated },
    eviction: { evicted: true, main: COMMITS.unrelated, liveWriteTokens: 0, waitedMs: 75_000 },
  };
}

const ACCOUNT_GIT = "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/qual";

/** Two probe repositories, each named from its id as the probe's `mainRepoName` names it. */
export const PROBE_REPOSITORIES = {
  listing: {
    repoId: `rep_${"ab".repeat(32)}`,
    name: "rh-m-6be8a8907ffd4faa88852ec6d1efcfdd",
    remote: `${ACCOUNT_GIT}/rh-m-6be8a8907ffd4faa88852ec6d1efcfdd.git`,
  },
  main: {
    repoId: `rep_${"cd".repeat(32)}`,
    name: "rh-m-a280cc87910000e13ec930ecbca0636a",
    remote: `${ACCOUNT_GIT}/rh-m-a280cc87910000e13ec930ecbca0636a.git`,
  },
};

/** A binding report as `qualify-slice.mjs binding` writes it, before its checks are added. */
export function liveBindingReport() {
  const { remote: _remote, ...mainRef } = liveMainRef();
  return {
    kind: "binding",
    probe: "railhead-qual-probe.mashin.workers.dev",
    startedAt: at(0),
    finishedAt: at(200),
    repositories: PROBE_REPOSITORIES,
    commits: COMMITS,
    observations: { listing: liveListing(), restActive: 30, ...mainRef },
  };
}

export const ORIGIN = "https://railhead.mashin.workers.dev";
export const REPO = "acme/upload-app";
export const CLAIMS = ["clm_aaaaaa", "clm_bbbbbb", "clm_cccccc"];
export const AGENTS = ["agt_atlas1", "agt_birch1", "agt_cedar1"];

/** One event as the board's `readEvents` returns it. */
export function event(seq: number, type: string, data: Record<string, unknown>) {
  return {
    v: 1,
    seq,
    at: Date.UTC(2026, 9, 1, 10, 0, seq),
    repo: "rep_board1",
    actor: { kind: "system", id: "sys_train" },
    type,
    data,
  };
}

/** A slice log: three agents, atlas lands alone, birch and cedar land together. */
export function sliceLog() {
  const [atlas, birch, cedar] = CLAIMS;
  const entries: [string, Record<string, unknown>][] = [
    ...AGENTS.map((agentId): [string, Record<string, unknown>] => ["agent.confirmed", { agentId }]),
    ...CLAIMS.map((claimId, index): [string, Record<string, unknown>] => [
      "claim.opened",
      { claimId, agentId: AGENTS[index] },
    ]),
    ["train.check", { checkRunId: "chk_000001", candidate: sha("c"), result: "pass" }],
    [
      "train.intent",
      {
        intentId: "int_000001",
        checkRunId: "chk_000001",
        expectedMain: sha("2"),
        candidate: sha("c"),
        claims: [atlas],
      },
    ],
    ["train.main", { intentId: "int_000001", outcome: "updated", main: sha("c") }],
    ["claim.merged", { claimId: atlas, commit: sha("c") }],
    ["train.check", { checkRunId: "chk_000002", candidate: sha("d"), result: "pass" }],
    [
      "train.intent",
      {
        intentId: "int_000002",
        checkRunId: "chk_000002",
        expectedMain: sha("c"),
        candidate: sha("d"),
        claims: [birch, cedar],
      },
    ],
    ["train.main", { intentId: "int_000002", outcome: "updated", main: sha("d") }],
    ["claim.merged", { claimId: birch, commit: sha("d") }],
    ["claim.merged", { claimId: cedar, commit: sha("d") }],
  ];
  return entries.map(([type, data], index) => event(index + 1, type, data));
}

export function liveSlice(): SliceObservations {
  return {
    origin: ORIGIN,
    repo: REPO,
    events: sliceLog(),
    eventCount: 20,
    logTokens: 0,
    clones: CLAIMS.map((claim, index) => ({
      originUrl: `${ORIGIN}/git/${REPO}/claims/${claim}.git`,
      identity: AGENTS[index] ?? "",
      reachable: true,
      tokensFound: 0,
    })),
    remoteMain: sha("d"),
    denials: { pushToMainStatus: 403, otherClaimStatus: 404, anonymousStatus: 401 },
  };
}

/** A slice report as `qualify-slice.mjs slice` writes it, before its checks are added. */
export function liveSliceReport() {
  return { kind: "slice", readAt: "2026-10-01T11:00:00.000Z", observations: liveSlice() };
}

/** A time after both reports were collected, for judging them. */
export const JUDGED_AT = Date.UTC(2026, 9, 2);
