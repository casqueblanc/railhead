import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  claimOfRemote,
  gatePasses,
  judgeListing,
  judgeMainRef,
  judgeRestActive,
  judgeSlice,
  landedBatches,
  originProblem,
  remoteProblem,
  type Check,
  type MainRefCommits,
  type MainRefObservations,
  type SliceObservations,
} from "./evidence.ts";

const LIVE_REMOTE =
  "https://0123456789abcdef0123456789abcdef.artifacts.cloudflare.net/git/qual/rh-m-1.git";
const sha = (digit: string): string => digit.repeat(40);

/** The outcome of each check, by id. */
function outcomes(checks: readonly Check[]): Record<string, string> {
  return Object.fromEntries(checks.map((item) => [item.id, item.outcome]));
}

/** A time on the day of the #161 run, `index` seconds past 09:00 UTC. */
function at(index: number): string {
  return new Date(Date.UTC(2026, 9, 4, 9, 0, index)).toISOString();
}

/** A listing observation as live Artifacts produced it on #161: 31 live tokens, page of 30. */
function liveListing() {
  const minted = Array.from({ length: 31 }, (_, index) => `tok_${String(index).padStart(2, "0")}`);
  const page = (ids: string[]) => ({
    ids,
    tokens: ids.map((id) => ({
      id,
      scope: "read",
      state: "active",
      createdAt: at(minted.indexOf(id)),
      expiresAt: at(3_600),
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
    shortLived: { id: "tok_short", expiresAt: at(120) },
    afterExpiry: { ...page(afterRevoke), total: 30 },
    afterExpiryAt: at(125),
  };
}

const COMMITS: MainRefCommits = {
  c4: sha("4"),
  c5: sha("5"),
  n1: sha("6"),
  n2: sha("7"),
  unrelated: sha("8"),
  race: [sha("a"), sha("b"), sha("c")],
  after: [sha("d"), sha("e"), sha("f")],
  u2: sha("9"),
};

const updated = (main: string) => ({
  result: { ok: true, value: { kind: "updated" } },
  main,
  liveWriteTokens: 0,
});

/** An adapter refusal with main read back. */
function refused(code: string, main: string) {
  return { result: { ok: false, code, message: "refused" }, main, liveWriteTokens: 0 };
}

/** Main-ref observations matching the behaviour #158 measured and its adopted spec. */
function liveMainRef(): MainRefObservations {
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

const ORIGIN = "https://railhead.mashin.workers.dev";
const CLAIMS = ["clm_aaaa", "clm_bbbb", "clm_cccc"];
const AGENTS = ["agt_atlas", "agt_birch", "agt_cedar"];

function event(type: string, data: Record<string, unknown>) {
  return {
    v: 1,
    seq: 0,
    at: 0,
    repo: "rep_x",
    actor: { kind: "system", id: "sys_train" },
    type,
    data,
  };
}

/** A slice log: three agents, atlas lands alone, birch and cedar land together. */
function sliceLog() {
  const [atlas, birch, cedar] = CLAIMS;
  return [
    ...AGENTS.map((agentId) => event("agent.confirmed", { agentId })),
    ...CLAIMS.map((claimId, index) => event("claim.opened", { claimId, agentId: AGENTS[index] })),
    event("train.check", { checkRunId: "chk_1", candidate: sha("c"), result: "pass" }),
    event("train.intent", {
      intentId: "int_1",
      checkRunId: "chk_1",
      expectedMain: sha("2"),
      candidate: sha("c"),
      claims: [atlas],
    }),
    event("train.main", { intentId: "int_1", outcome: "updated", main: sha("c") }),
    event("claim.merged", { claimId: atlas, commit: sha("c") }),
    event("train.check", { checkRunId: "chk_2", candidate: sha("d"), result: "pass" }),
    event("train.intent", {
      intentId: "int_2",
      checkRunId: "chk_2",
      expectedMain: sha("c"),
      candidate: sha("d"),
      claims: [birch, cedar],
    }),
    event("train.main", { intentId: "int_2", outcome: "updated", main: sha("d") }),
    event("claim.merged", { claimId: birch, commit: sha("d") }),
    event("claim.merged", { claimId: cedar, commit: sha("d") }),
  ];
}

function liveSlice(): SliceObservations {
  return {
    origin: ORIGIN,
    events: sliceLog(),
    clones: CLAIMS.map((claim, index) => ({
      originUrl: `${ORIGIN}/git/acme/upload-app/claims/${claim}.git`,
      identity: AGENTS[index] ?? "",
      reachable: true,
      tokensFound: 0,
    })),
    remoteMain: sha("d"),
    denials: { pushToMain: "refused", otherClaim: "refused", anonymousStatus: 401 },
  };
}

describe("the live gate's origin and remote rules", () => {
  test("accepts a public HTTPS origin and a live Artifacts remote", () => {
    assert.equal(originProblem(ORIGIN), null);
    assert.equal(originProblem("https://railhead.dev"), null);
    assert.equal(remoteProblem(LIVE_REMOTE), null);
  });

  test("refuses local, reserved and plain-HTTP origins", () => {
    for (const origin of [
      "http://railhead.dev",
      "https://localhost:8787",
      "https://127.0.0.1",
      "https://10.0.0.4",
      "https://railhead.invalid",
      "https://box.local",
      "https://[::1]",
      "https://user:pw@railhead.dev",
      "not a url",
    ]) {
      assert.notEqual(originProblem(origin), null, origin);
    }
  });

  test("refuses a fake Artifacts remote, such as the test fakes report", () => {
    assert.notEqual(remoteProblem("https://fake.artifacts.invalid/rh-m-1.git"), null);
    assert.notEqual(remoteProblem("https://artifacts.invalid/rh-m-1.git"), null);
    assert.notEqual(remoteProblem(`${LIVE_REMOTE}/extra`), null);
    assert.notEqual(remoteProblem(undefined), null);
  });
});

describe("judgeListing (#161)", () => {
  test("passes the behaviour live Artifacts showed", () => {
    const checks = judgeListing(liveListing());
    assert.deepEqual(outcomes(checks), {
      "listing.page": "pass",
      "listing.order": "pass",
      "listing.revoked": "pass",
      "listing.expired": "pass",
      "listing.no-options": "pass",
    });
  });

  test("fails a page that is not 30 or a total that counts revoked tokens", () => {
    const observed = liveListing();
    observed.full.ids = observed.full.ids.slice(0, 29);
    observed.afterRevoke.total = 31;
    const checks = outcomes(judgeListing(observed));
    assert.equal(checks["listing.page"], "fail");
    assert.equal(checks["listing.revoked"], "fail");
  });

  test("fails an oldest-first page and a listing taken before the expiry", () => {
    const observed = liveListing();
    observed.full.ids = observed.full.ids.toReversed();
    observed.full.tokens = observed.full.tokens.toReversed();
    observed.afterExpiryAt = observed.shortLived.expiresAt;
    const checks = outcomes(judgeListing(observed));
    assert.equal(checks["listing.order"], "fail");
    assert.equal(checks["listing.expired"], "fail");
  });

  test("fails a binding that honours a paging option", () => {
    const observed = liveListing();
    observed.withOptions = [{ ...observed.afterRevoke, ids: observed.minted.slice(0, 30) }];
    assert.equal(outcomes(judgeListing(observed))["listing.no-options"], "fail");
  });

  test("refuses a malformed observation as one failed check", () => {
    assert.deepEqual(outcomes(judgeListing({ full: "x" })), { "listing.shape": "fail" });
    assert.deepEqual(outcomes(judgeListing(null)), { "listing.shape": "fail" });
  });
});

describe("judgeRestActive (#161)", () => {
  test("passes equal counts and fails a mismatch, a missing REST answer or a malformed total", () => {
    assert.equal(judgeRestActive(30, 30).outcome, "pass");
    assert.equal(judgeRestActive(30, 31).outcome, "fail");
    assert.equal(judgeRestActive(30, null).outcome, "fail");
    assert.equal(judgeRestActive("30", 30).outcome, "fail");
  });
});

describe("judgeMainRef (#158)", () => {
  test("passes the measured compare-and-swap and the adapter's guarantees", () => {
    const checks = judgeMainRef(COMMITS, liveMainRef());
    assert.deepEqual(
      checks.map((item) => item.id),
      [
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
      ],
    );
    assert.ok(gatePasses(checks), JSON.stringify(checks.filter((item) => item.outcome === "fail")));
  });

  test("fails when the adapter sends a rewind instead of refusing it", () => {
    const observed = liveMainRef();
    observed.rewind = updated(COMMITS.c4);
    assert.equal(outcomes(judgeMainRef(COMMITS, observed))["main.refuses-rewind"], "fail");
  });

  test("fails a race where two updates landed or none did", () => {
    const observed = liveMainRef();
    observed.race = {
      updates: [
        { status: 200, line: "ok refs/heads/main" },
        { status: 200, line: "ok refs/heads/main" },
        { status: 200, line: "ng refs/heads/main stale ref" },
      ],
      main: COMMITS.race[1],
    };
    assert.equal(outcomes(judgeMainRef(COMMITS, observed))["main.race"], "fail");
    observed.race = { updates: [], main: COMMITS.n2 };
    assert.equal(outcomes(judgeMainRef(COMMITS, observed))["main.race"], "fail");
  });

  test("fails a lost response that applied twice, a fence that let the body land and a short eviction wait", () => {
    const observed = liveMainRef();
    observed.lostResponse = {
      result: { ok: true, value: { kind: "uncertain" } },
      main: COMMITS.n2,
      liveWriteTokens: 0,
      repeat: { status: 200, line: "ok refs/heads/main" },
    };
    observed.fence = {
      revoked: true,
      answered: { status: 200, line: "ok refs/heads/main" },
      main: COMMITS.u2,
    };
    observed.eviction = {
      evicted: true,
      main: COMMITS.unrelated,
      liveWriteTokens: 0,
      waitedMs: 30_000,
    };
    const checks = outcomes(judgeMainRef(COMMITS, observed));
    assert.equal(checks["main.lost-response"], "fail");
    assert.equal(checks["main.revoke-fence"], "fail");
    assert.equal(checks["main.eviction"], "fail");
  });

  test("fails a fake's remote, so a simulated run cannot pass", () => {
    const observed = liveMainRef();
    observed.remote = "https://fake.artifacts.invalid/rh-m-1.git";
    const checks = judgeMainRef(COMMITS, observed);
    assert.equal(outcomes(checks)["main.live"], "fail");
    assert.equal(gatePasses(checks), false);
  });

  test("fails a foreign push the adapter overwrote, and a token left live", () => {
    const observed = liveMainRef();
    observed.foreignPush = { ...updated(COMMITS.after[1] ?? ""), liveWriteTokens: 1 };
    assert.equal(outcomes(judgeMainRef(COMMITS, observed))["main.detects-foreign-push"], "fail");
  });
});

describe("judgeSlice", () => {
  test("passes three agents whose second batch landed two claims", () => {
    const checks = judgeSlice(liveSlice());
    assert.ok(gatePasses(checks), JSON.stringify(checks.filter((item) => item.outcome === "fail")));
    assert.match(
      checks.find((item) => item.id === "slice.batch")?.detail ?? "",
      new RegExp(`check chk_2 passed on ${sha("d")}, main ${sha("c")} → ${sha("d")}`),
    );
  });

  test("finds only batches of two or more claims whose check passed on the landed candidate", () => {
    assert.deepEqual(
      landedBatches(sliceLog()).map((batch) => [batch.intentId, batch.claims.length]),
      [["int_2", 2]],
    );
    const failedCheck = sliceLog().map((logged) =>
      logged.type === "train.check" && logged.data.checkRunId === "chk_2"
        ? { ...logged, data: { ...logged.data, result: "fail" } }
        : logged,
    );
    assert.deepEqual(landedBatches(failedCheck), []);
    assert.deepEqual(landedBatches([null, 3, "x", { type: "train.intent" }]), []);
  });

  test("fails a local origin, two clones of one agent and a main that differs from the log", () => {
    const observed = liveSlice();
    observed.origin = "http://localhost:8787";
    const [first] = observed.clones;
    if (first !== undefined) observed.clones[1] = { ...first };
    observed.remoteMain = sha("e");
    const checks = outcomes(judgeSlice(observed));
    assert.equal(checks["slice.live"], "fail");
    assert.equal(checks["slice.agents"], "fail");
    assert.equal(checks["slice.forks"], "fail");
    assert.equal(checks["slice.main"], "fail");
  });

  test("fails on any Artifacts token in the log or a clone, and on a proxy that let a request through", () => {
    const observed = liveSlice();
    observed.events = [
      ...observed.events,
      event("issue.filed", { body: "art_v1_0123456789abcdefXYZ" }),
    ];
    observed.denials = { pushToMain: "accepted", otherClaim: "refused", anonymousStatus: 401 };
    const checks = outcomes(judgeSlice(observed));
    assert.equal(checks["slice.no-token"], "fail");
    assert.equal(checks["slice.proxy-denial"], "fail");
  });

  test("fails when every landing held a single claim", () => {
    const observed = liveSlice();
    observed.events = sliceLog().slice(0, 10);
    observed.remoteMain = sha("c");
    assert.equal(outcomes(judgeSlice(observed))["slice.batch"], "fail");
  });

  test("reads a claim only from a remote on the instance's own origin", () => {
    assert.equal(claimOfRemote(ORIGIN, `${ORIGIN}/git/acme/app/claims/clm_ab12.git`), "clm_ab12");
    assert.equal(
      claimOfRemote(ORIGIN, "https://evil.example/git/acme/app/claims/clm_ab12.git"),
      null,
    );
    assert.equal(claimOfRemote(ORIGIN, `${ORIGIN}/git/acme/app.git`), null);
  });
});

describe("gatePasses", () => {
  test("needs at least one check and no failure", () => {
    assert.equal(gatePasses([]), false);
    assert.equal(gatePasses([{ id: "a", outcome: "pass", detail: "" }]), true);
    assert.equal(
      gatePasses([
        { id: "a", outcome: "pass", detail: "" },
        { id: "b", outcome: "fail", detail: "" },
      ]),
      false,
    );
  });
});
