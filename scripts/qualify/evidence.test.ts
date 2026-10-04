import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  BINDING_CHECK_IDS,
  SLICE_CHECK_IDS,
  claimOfRemote,
  gatePasses,
  judgeBinding,
  judgeListing,
  judgeMainRef,
  judgeReport,
  judgeRestActive,
  judgeSlice,
  judgeSliceReport,
  landedBatches,
  originProblem,
  probeProblem,
  remoteProblem,
  sliceEvents,
  type Check,
} from "./evidence.ts";
import {
  CLAIMS,
  COMMITS,
  JUDGED_AT,
  LIVE_REMOTE,
  ORIGIN,
  REPO,
  at,
  event,
  liveBindingReport,
  liveListing,
  liveMainRef,
  liveSlice,
  liveSliceReport,
  sha,
  sliceLog,
  updated,
} from "./reportFixtures.ts";

/** The outcome of each check, by id. */
function outcomes(checks: readonly Check[]): Record<string, string> {
  return Object.fromEntries(checks.map((item) => [item.id, item.outcome]));
}

/** The provenance outcome of the live binding report after `change`. */
function bindingProvenance(change: (report: ReturnType<typeof liveBindingReport>) => void) {
  const report = liveBindingReport();
  change(report);
  return outcomes(judgeBinding(report, JUDGED_AT))["binding.provenance"];
}

/** The provenance outcome of the live slice report after `change`. */
function sliceProvenance(change: (report: ReturnType<typeof liveSliceReport>) => void) {
  const report = liveSliceReport();
  change(report);
  return outcomes(judgeSliceReport(report, JUDGED_AT))["slice.provenance"];
}

/** A report as the harness writes it: its observations and the outcomes judged from them. */
function written<T extends { kind: string }>(report: T) {
  return { ...report, checks: judgeReport(report, JUDGED_AT).slice(0, -2) };
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
      "https://localhost.:8787",
      "https://box.local.",
      "https://railhead.test.",
      "https://169.254.169.254",
      "https://0.1.2.3",
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
      new RegExp(`check chk_000002 passed on ${sha("d")}, main ${sha("c")} → ${sha("d")}`),
    );
  });

  test("finds only batches of two or more claims whose check passed on the landed candidate", () => {
    assert.deepEqual(
      landedBatches(sliceLog()).map((batch) => [batch.intentId, batch.claims.length]),
      [["int_000002", 2]],
    );
    const failedCheck = sliceLog().map((logged) =>
      logged.type === "train.check" && logged.data.checkRunId === "chk_000002"
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
    observed.logTokens = 1;
    observed.denials = { pushToMainStatus: 200, otherClaimStatus: 404, anonymousStatus: 401 };
    let checks = outcomes(judgeSlice(observed));
    assert.equal(checks["slice.no-token"], "fail");
    assert.equal(checks["slice.proxy-denial"], "fail");

    const inClone = liveSlice();
    const [clone] = inClone.clones;
    if (clone !== undefined) clone.tokensFound = 1;
    inClone.denials = { pushToMainStatus: 403, otherClaimStatus: 200, anonymousStatus: 401 };
    checks = outcomes(judgeSlice(inClone));
    assert.equal(checks["slice.no-token"], "fail");
    assert.equal(checks["slice.proxy-denial"], "fail");
  });

  test("fails when every landing held a single claim", () => {
    const observed = liveSlice();
    observed.events = sliceLog().slice(0, 10);
    observed.remoteMain = sha("c");
    assert.equal(outcomes(judgeSlice(observed))["slice.batch"], "fail");
  });

  test("reads a claim only from a claim remote of the repository on the instance's own origin", () => {
    const remote = `${ORIGIN}/git/${REPO}/claims/clm_ab12cd.git`;
    assert.equal(claimOfRemote(ORIGIN, REPO, remote), "clm_ab12cd");
    for (const url of [
      "https://evil.example/git/acme/upload-app/claims/clm_ab12cd.git",
      `${ORIGIN}/git/acme/other/claims/clm_ab12cd.git`,
      `${ORIGIN}/git/${REPO}.git`,
      `${ORIGIN.replace("https:", "http:")}/git/${REPO}/claims/clm_ab12cd.git`,
      `${ORIGIN}/git/${REPO}/claims/clm_ab12cd.git/../../x.git`,
      `${ORIGIN}/git/${REPO}/claims/clm_a.git`,
      "not a url",
    ]) {
      assert.equal(claimOfRemote(ORIGIN, REPO, url), null, url);
    }
  });
});

describe("sliceEvents", () => {
  test("keeps the slice's events with their ids, commits, positions and times, and no text", () => {
    const filed = event(30, "issue.filed", { issueId: "iss_000001", title: "t", body: "b" });
    const kept = sliceEvents([...sliceLog(), filed]);
    assert.equal(kept.length, sliceLog().length);
    assert.deepEqual(kept[0], {
      seq: 1,
      at: Date.UTC(2026, 9, 1, 10, 0, 1),
      repo: "rep_board1",
      type: "agent.confirmed",
      data: { agentId: "agt_atlas1" },
    });
    const opened = sliceLog()[3];
    const withExtra = {
      ...opened,
      data: { ...opened?.data, issueId: "iss_000001", base: sha("1") },
    };
    assert.deepEqual(sliceEvents([withExtra])[0]?.data, {
      claimId: CLAIMS[0],
      agentId: "agt_atlas1",
    });
  });

  test("drops an event whose id, commit or position is malformed", () => {
    const [confirmed] = sliceLog();
    assert.deepEqual(
      sliceEvents([
        { ...confirmed, data: { agentId: "usr_000001" } },
        { ...confirmed, seq: "1" },
        { ...confirmed, repo: "x" },
        event(1, "claim.merged", { claimId: CLAIMS[0], commit: "HEAD" }),
        null,
      ]),
      [],
    );
  });
});

describe("judgeBinding and judgeSliceReport", () => {
  test("pass a live-collected report and judge every required case", () => {
    const binding = judgeBinding(liveBindingReport(), JUDGED_AT);
    assert.deepEqual(
      binding.map((item) => item.id),
      [...BINDING_CHECK_IDS],
    );
    assert.ok(gatePasses(binding), JSON.stringify(binding.filter((c) => c.outcome === "fail")));
    const slice = judgeSliceReport(liveSliceReport(), JUDGED_AT);
    assert.deepEqual(
      slice.map((item) => item.id),
      [...SLICE_CHECK_IDS],
    );
    assert.ok(gatePasses(slice), JSON.stringify(slice.filter((c) => c.outcome === "fail")));
  });

  test("fail a binding report missing any one case's observation", () => {
    const keys = Object.keys(liveBindingReport().observations);
    assert.equal(keys.length, 12);
    for (const key of keys) {
      const report = liveBindingReport();
      const observations: Record<string, unknown> = { ...report.observations };
      delete observations[key];
      assert.equal(
        gatePasses(judgeBinding({ ...report, observations }, JUDGED_AT)),
        false,
        `without ${key}`,
      );
    }
    for (const key of ["repositories", "commits", "observations"] as const) {
      const report: Record<string, unknown> = liveBindingReport();
      delete report[key];
      assert.deepEqual(outcomes(judgeBinding(report, JUDGED_AT)), { "binding.shape": "fail" });
    }
  });

  test("fail a binding report not collected through the deployed probe in one live run", () => {
    assert.equal(
      bindingProvenance(() => undefined),
      "pass",
    );
    assert.equal(
      bindingProvenance((report) => {
        report.probe = "localhost:8787";
      }),
      "fail",
    );
    assert.equal(
      bindingProvenance((report) => {
        report.probe = "railhead.mashin.workers.dev";
      }),
      "fail",
    );
    // Shorter than the 60 s token and the eviction wait the run sits through.
    assert.equal(
      bindingProvenance((report) => {
        report.finishedAt = at(30);
      }),
      "fail",
    );
    // Collected after the moment it is judged.
    assert.equal(
      bindingProvenance((report) => {
        report.startedAt = "2026-10-03T09:00:00.000Z";
        report.finishedAt = "2026-10-03T09:05:00.000Z";
      }),
      "fail",
    );
    // A repository whose Artifacts name is not derived from its id, or a remote on another account.
    assert.equal(
      bindingProvenance((report) => {
        report.repositories = {
          ...report.repositories,
          main: { ...report.repositories.main, name: "rh-m-1" },
        };
      }),
      "fail",
    );
    assert.equal(
      bindingProvenance((report) => {
        report.repositories = {
          ...report.repositories,
          main: {
            ...report.repositories.main,
            remote: report.repositories.main.remote.replace("0123", "9999"),
          },
        };
      }),
      "fail",
    );
    // Token times Artifacts assigned outside the run, and a token count the probe never mints.
    assert.equal(
      bindingProvenance((report) => {
        const [token] = report.observations.listing.full.tokens;
        if (token !== undefined) token.createdAt = "2026-09-01T09:00:00.000Z";
      }),
      "fail",
    );
    assert.equal(
      bindingProvenance((report) => {
        report.observations.listing.minted = report.observations.listing.minted.slice(1);
      }),
      "fail",
    );
    // An eviction wait longer than the whole run.
    assert.equal(
      bindingProvenance((report) => {
        report.observations.eviction = { ...(liveMainRef().eviction as object), waitedMs: 300_000 };
      }),
      "fail",
    );
  });

  test("fail a slice report whose log positions, times or events are not a live read", () => {
    assert.equal(
      sliceProvenance(() => undefined),
      "pass",
    );
    assert.equal(
      sliceProvenance((report) => {
        report.observations.events = sliceLog().toReversed();
      }),
      "fail",
    );
    assert.equal(
      sliceProvenance((report) => {
        report.observations.eventCount = 5;
      }),
      "fail",
    );
    assert.equal(
      sliceProvenance((report) => {
        report.readAt = "2026-10-01T09:00:00.000Z";
      }),
      "fail",
    );
    assert.equal(
      sliceProvenance((report) => {
        report.observations.events = [
          ...sliceLog(),
          event(30, "issue.filed", { issueId: "iss_000001", title: "t", body: "b" }),
        ];
      }),
      "fail",
    );
    assert.equal(
      sliceProvenance((report) => {
        report.observations.events = sliceLog().map((logged, index) =>
          index === 0 ? { ...logged, repo: "rep_other1" } : logged,
        );
      }),
      "fail",
    );
    assert.deepEqual(
      outcomes(judgeSliceReport({ kind: "slice", readAt: at(0), observations: {} }, JUDGED_AT)),
      { "slice.shape": "fail" },
    );
  });
});

describe("judgeReport", () => {
  test("passes a complete live-collected report whose recorded outcomes match", () => {
    for (const report of [written(liveBindingReport()), written(liveSliceReport())]) {
      const checks = judgeReport(report, JUDGED_AT);
      assert.ok(gatePasses(checks), JSON.stringify(checks.filter((c) => c.outcome === "fail")));
      assert.deepEqual(
        checks.slice(-2).map((item) => item.id),
        ["report.complete", "report.recorded"],
      );
    }
  });

  test("fails a hand-built report that states passing checks without observations", () => {
    for (const kind of ["binding", "slice"]) {
      const required = kind === "binding" ? BINDING_CHECK_IDS : SLICE_CHECK_IDS;
      const report = {
        kind,
        checks: required.map((id) => ({ id, outcome: "pass", detail: "" })),
      };
      const checks = outcomes(judgeReport(report, JUDGED_AT));
      assert.equal(checks[`${kind}.shape`], "fail", kind);
      assert.equal(checks["report.complete"], "fail", kind);
      assert.equal(checks["report.recorded"], "fail", kind);
    }
    assert.deepEqual(outcomes(judgeReport({ kind: "simulated" }, JUDGED_AT)), {
      "report.kind": "fail",
    });
    assert.deepEqual(outcomes(judgeReport(null, JUDGED_AT)), { "report.kind": "fail" });
  });

  test("fails a report whose recorded outcomes are not the ones its observations give", () => {
    const report = written(liveBindingReport());
    report.observations = { ...report.observations, race: { updates: [], main: COMMITS.n2 } };
    const checks = outcomes(judgeReport(report, JUDGED_AT));
    assert.equal(checks["main.race"], "fail");
    assert.equal(checks["report.recorded"], "fail");

    const reordered = written(liveSliceReport());
    reordered.checks = reordered.checks.toReversed();
    assert.equal(outcomes(judgeReport(reordered, JUDGED_AT))["report.recorded"], "fail");
  });

  test("fails a fake's Artifacts remote and a simulator's origin even with every other part live", () => {
    const binding = written(liveBindingReport());
    binding.repositories = {
      ...binding.repositories,
      listing: {
        ...binding.repositories.listing,
        remote: "https://fake.artifacts.invalid/rh-m-1.git",
      },
    };
    assert.equal(outcomes(judgeReport(binding, JUDGED_AT))["listing.live"], "fail");
    const slice = written(liveSliceReport());
    slice.observations = { ...slice.observations, origin: "http://localhost:8787" };
    assert.equal(outcomes(judgeReport(slice, JUDGED_AT))["slice.live"], "fail");
  });
});

describe("probeProblem", () => {
  test("accepts only the probe Worker probe-config deploys", () => {
    assert.equal(probeProblem("https://railhead-qual-probe.mashin.workers.dev/"), null);
    for (const url of [
      "http://railhead-qual-probe.mashin.workers.dev",
      "https://railhead-qual-probe.mashin.workers.dev.evil.dev",
      "https://railhead.mashin.workers.dev",
      "https://localhost:8787",
      "nope",
    ]) {
      assert.notEqual(probeProblem(url), null, url);
    }
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
