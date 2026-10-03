import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { CommitSha, DecisionRef } from "@railhead/shared/events";
import type { ClaimPin } from "../src/contracts/claims";
import { fail, ok } from "../src/contracts/result";
import type {
  AttemptOutcome,
  CheckAttempt,
  CheckDefinition,
  CheckReport,
  MergeIntentRecord,
} from "../src/contracts/train";
import { unavailableChecks } from "../src/contracts/unavailable";
import { adaptation as adaptationModule } from "../src/modules/adaptation/entry";
import { createTrain, type Train } from "../src/modules/train/scheduler";
import { composeRepo, type RepoContext, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import {
  createAdaptation,
  MAX_SETTLE_PER_CALL,
  MAX_SETTLE_TRIES,
  type AdaptationPort,
  type AdaptationReaders,
} from "../src/train/adaptation/adaptation";

const REPO_ID = "rep_adapt0001";
const MAIN = sha("1");
const LANDED = sha("2");
const OTHER = sha("3");
const DECISION = "dec_upload01";
const ATLAS = "clm_claim001";
const BIRCH = "clm_claim002";
const INTENT = "int_intent001";
const ATTEMPT = "chk_attempt001";

function sha(digit: string): CommitSha {
  return digit.repeat(40);
}

function ref(version: number): DecisionRef {
  return { decisionId: DECISION, version };
}

function acceptanceCheck(version: number, option: string, source = MAIN): CheckDefinition {
  return {
    name: `accept-${option}`,
    source,
    digest: "d".repeat(64),
    acceptance: { decision: ref(version), option },
  };
}

function pinOf(claimId: string, commit = sha("a")): ClaimPin {
  return { claimId, generation: 1, commit };
}

function attemptOf(fields: Partial<CheckAttempt> = {}): CheckAttempt {
  return {
    attemptId: ATTEMPT,
    expectedMain: MAIN,
    candidate: LANDED,
    pins: [pinOf(ATLAS)],
    definition: acceptanceCheck(1, "chunk"),
    decisions: [ref(1)],
    createdAt: 10,
    ...fields,
  };
}

function reportOf(fields: Partial<CheckReport> = {}): CheckReport {
  return {
    attemptId: ATTEMPT,
    candidate: LANDED,
    result: "pass",
    logDigest: "e".repeat(64),
    finishedAt: 20,
    ...fields,
  };
}

function intentOf(fields: Partial<MergeIntentRecord> = {}): MergeIntentRecord {
  return {
    intentId: INTENT,
    expectedMain: MAIN,
    candidate: LANDED,
    pins: [pinOf(ATLAS)],
    decisions: [ref(1)],
    checkAttemptId: ATTEMPT,
    status: "updated",
    attempts: 1,
    main: LANDED,
    authorizedAt: 30,
    updatedAt: 40,
    ...fields,
  };
}

/** What the other modules answer. Each map is read while a landing settles. */
class World {
  readonly intents = new Map<string, MergeIntentRecord>([[INTENT, intentOf()]]);
  readonly outcomes = new Map<string, AttemptOutcome>([
    [ATTEMPT, { attempt: attemptOf(), report: reportOf() }],
  ]);
  /** Each claim's current requirements; a missing claim reads as unknown, as a merged one does. */
  readonly versions = new Map<string, DecisionRef[]>([[ATLAS, [ref(1)]]]);
  readonly decisions = new Map<string, { version: number; option: string }>([
    [DECISION, { version: 1, option: "chunk" }],
  ]);
  /** When set, every reader throws it. */
  failure: Error | null = null;

  readers(): AdaptationReaders {
    const guard = (): void => {
      if (this.failure !== null) throw this.failure;
    };
    return {
      intent: (intentId) => {
        guard();
        return this.intents.get(intentId) ?? null;
      },
      attemptOutcome: (attemptId) => {
        guard();
        return this.outcomes.get(attemptId) ?? null;
      },
      currentVersions: (claimId) => {
        guard();
        return this.versions.get(claimId) ?? null;
      },
      currentDecision: (decisionId) => {
        guard();
        return this.decisions.get(decisionId) ?? null;
      },
    };
  }

  /** Supersedes the decision with `option` as the next version. */
  supersede(option: string): void {
    const current = this.decisions.get(DECISION);
    this.decisions.set(DECISION, { version: (current?.version ?? 0) + 1, option });
  }
}

interface Harness {
  adaptation: AdaptationPort;
  world: World;
  /** Rows in each adaptation table. */
  counts(): { landings: number; claims: number; adaptations: number };
}

async function withAdaptation<R>(
  body: (harness: Harness) => R | Promise<R>,
  stub = env.REPO.getByName(crypto.randomUUID()),
  world = new World(),
): Promise<R> {
  return runInDurableObject(stub, async (_instance, state) => {
    let now = 1_000;
    const port = createAdaptation({
      storage: state.storage,
      readers: () => world.readers(),
      clock: () => (now += 1),
    });
    const count = (table: string): number =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    return body({
      adaptation: port,
      world,
      counts: () => ({
        landings: count("adaptation_landings"),
        claims: count("adaptation_claims"),
        adaptations: count("adaptations"),
      }),
    });
  });
}

describe("recordLanding", () => {
  it("adapts a claim whose landed commit passed the current version's option", async () => {
    await withAdaptation(({ adaptation, counts }) => {
      expect(adaptation.recordLanding(INTENT)).toEqual({
        intentId: INTENT,
        outcome: "adapted",
        claims: [{ claimId: ATLAS, decisions: [ref(1)] }],
        tries: 0,
      });
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
      expect(counts()).toEqual({ landings: 1, claims: 1, adaptations: 1 });
      // A repeat settles nothing again and writes nothing more.
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("adapted");
      expect(counts()).toEqual({ landings: 1, claims: 1, adaptations: 1 });
    });
  });

  it("adapts a reconciled landing only when main was read back at the candidate", async () => {
    await withAdaptation(({ adaptation, world }) => {
      world.intents.set(INTENT, intentOf({ status: "reconciled", main: LANDED }));
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("adapted");
    });
    await withAdaptation(({ adaptation, world }) => {
      world.intents.set(INTENT, intentOf({ status: "reconciled", main: OTHER }));
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("not_landed");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
    });
  });

  it("does not adapt on a pass before land, then adapts once that commit lands", async () => {
    await withAdaptation(({ adaptation, world, counts }) => {
      world.intents.set(INTENT, intentOf({ status: "authorized", attempts: 0, main: null }));
      expect(adaptation.recordLanding(INTENT)).toMatchObject({ outcome: null, tries: 1 });
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
      expect(counts().adaptations).toBe(0);

      world.intents.set(INTENT, intentOf());
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("adapted");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
    });
  });

  it("never adapts a rejected intent, even when a later pass is recorded", async () => {
    await withAdaptation(({ adaptation, world }) => {
      world.intents.set(INTENT, intentOf({ status: "rejected", main: OTHER }));
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("not_landed");
      // Its landing settled; the same intent cannot adapt later.
      world.intents.set(INTENT, intentOf());
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("not_landed");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
    });
  });

  it.each([
    ["the attempt ran on another commit", { attempt: attemptOf({ candidate: OTHER }) }],
    ["the report names another commit", { report: reportOf({ candidate: OTHER }) }],
    ["the report names another attempt", { report: reportOf({ attemptId: "chk_attempt999" }) }],
  ])("refuses a pass when %s", async (_name, change: Partial<AttemptOutcome>) => {
    await withAdaptation(({ adaptation, world, counts }) => {
      world.outcomes.set(ATTEMPT, { attempt: attemptOf(), report: reportOf(), ...change });
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("wrong_candidate");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
      expect(counts().adaptations).toBe(0);
    });
  });

  it.each([
    ["an infrastructure error", "error"],
    ["a failure", "fail"],
  ] as const)("does not adapt on %s", async (_name, result) => {
    await withAdaptation(({ adaptation, world }) => {
      world.outcomes.set(ATTEMPT, { attempt: attemptOf(), report: reportOf({ result }) });
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("check_not_passed");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
    });
  });

  it("does not adapt when no report was recorded or the check proves no decision", async () => {
    await withAdaptation(({ adaptation, world }) => {
      world.outcomes.set(ATTEMPT, { attempt: attemptOf(), report: null });
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("check_not_passed");
    });
    await withAdaptation(({ adaptation, world }) => {
      const definition = { ...acceptanceCheck(1, "chunk"), acceptance: null };
      world.outcomes.set(ATTEMPT, { attempt: attemptOf({ definition }), report: reportOf() });
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("no_acceptance");
    });
  });

  it("refuses a pass for an obsolete version", async () => {
    await withAdaptation(({ adaptation, world }) => {
      world.supersede("reject");
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("obsolete_version");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
    });
  });

  it("refuses a pass for another option than the current version chose", async () => {
    await withAdaptation(({ adaptation, world }) => {
      world.decisions.set(DECISION, { version: 1, option: "reject" });
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("wrong_option");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
    });
  });

  it("adapts only the claims that depended on the proven version", async () => {
    await withAdaptation(({ adaptation, world }) => {
      world.intents.set(INTENT, intentOf({ pins: [pinOf(ATLAS), pinOf(BIRCH)] }));
      world.versions.set(BIRCH, []);
      expect(adaptation.recordLanding(INTENT)?.claims).toEqual([
        { claimId: ATLAS, decisions: [ref(1)] },
        { claimId: BIRCH, decisions: [] },
      ]);
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
      expect(adaptation.adapted(BIRCH, DECISION)).toBe(false);
    });
    await withAdaptation(({ adaptation, world }) => {
      world.versions.set(ATLAS, []);
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("no_dependent_claim");
    });
  });

  it("refuses an id that is not an intent and writes nothing", async () => {
    await withAdaptation(({ adaptation, counts }) => {
      for (const id of ["", "clm_claim001", "int_", "int_bad id!"]) {
        expect(adaptation.recordLanding(id)).toBeNull();
        expect(adaptation.landing(id)).toBeNull();
      }
      expect(counts()).toEqual({ landings: 0, claims: 0, adaptations: 0 });
    });
  });
});

describe("retained dependencies of merged claims", () => {
  it("keeps the versions a claim landed on after its requirements become unreadable", async () => {
    await withAdaptation(({ adaptation, world }) => {
      // The check has not reported when the landing is first read: the claims are captured anyway.
      world.outcomes.delete(ATTEMPT);
      expect(adaptation.recordLanding(INTENT)).toMatchObject({
        outcome: null,
        claims: [{ claimId: ATLAS, decisions: [ref(1)] }],
      });
      // The claim merged, so the decisions module no longer answers for it.
      world.versions.delete(ATLAS);
      world.outcomes.set(ATTEMPT, { attempt: attemptOf(), report: reportOf() });
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("adapted");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
    });
  });

  it("never adapts a claim whose requirements were unknown when it landed", async () => {
    await withAdaptation(({ adaptation, world }) => {
      world.versions.delete(ATLAS);
      expect(adaptation.recordLanding(INTENT)).toMatchObject({
        outcome: "no_dependent_claim",
        claims: [{ claimId: ATLAS, decisions: null }],
      });
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
    });
  });
});

describe("adapted", () => {
  it("drops the adaptation when the decision is superseded, and keeps it across eviction", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    const world = new World();
    await withAdaptation(({ adaptation }) => adaptation.recordLanding(INTENT), stub, world);
    await evictDurableObject(stub);
    await withAdaptation(
      ({ adaptation }) => {
        expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
        expect(adaptation.landing(INTENT)?.outcome).toBe("adapted");
        world.supersede("reject");
        expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
      },
      stub,
      world,
    );
  });

  it("is unknown for invalid ids and a decision without a current version", async () => {
    await withAdaptation(({ adaptation, world }) => {
      adaptation.recordLanding(INTENT);
      expect(adaptation.adapted("iss_issue001", DECISION)).toBeNull();
      expect(adaptation.adapted(ATLAS, "clm_claim001")).toBeNull();
      world.decisions.delete(DECISION);
      expect(adaptation.adapted(ATLAS, DECISION)).toBeNull();
      // A claim that never landed is simply not adapted.
      world.decisions.set(DECISION, { version: 1, option: "chunk" });
      expect(adaptation.adapted(BIRCH, DECISION)).toBe(false);
    });
  });
});

describe("failures", () => {
  it("keeps a landing pending when a reader throws, then settles it at the next landing", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withAdaptation(({ adaptation, world, counts }) => {
        world.failure = new TypeError("storage gone");
        expect(adaptation.recordLanding(INTENT)).toMatchObject({ outcome: null, tries: 1 });
        // The throw rolled back everything the settlement wrote; only the pending row is kept.
        expect(counts()).toEqual({ landings: 1, claims: 0, adaptations: 0 });
        expect(errors).toHaveBeenCalledWith(
          JSON.stringify({ event: "adaptation.settle_failed", intent: INTENT, error: "TypeError" }),
        );

        world.failure = null;
        world.intents.set("int_intent002", intentOf({ intentId: "int_intent002", pins: [] }));
        adaptation.recordLanding("int_intent002");
        expect(adaptation.landing(INTENT)?.outcome).toBe("adapted");
        expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps a landing pending while the decision is unknown", async () => {
    await withAdaptation(({ adaptation, world }) => {
      world.decisions.delete(DECISION);
      expect(adaptation.recordLanding(INTENT)).toMatchObject({ outcome: null, tries: 1 });
      world.decisions.set(DECISION, { version: 1, option: "chunk" });
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("adapted");
    });
  });

  it("settles a landing as unknown after the last try", async () => {
    await withAdaptation(({ adaptation, world }) => {
      world.intents.delete(INTENT);
      for (let attempt = 1; attempt < MAX_SETTLE_TRIES; attempt += 1) {
        expect(adaptation.recordLanding(INTENT)).toMatchObject({ outcome: null, tries: attempt });
      }
      expect(adaptation.recordLanding(INTENT)).toMatchObject({
        outcome: "unknown",
        tries: MAX_SETTLE_TRIES,
      });
      world.intents.set(INTENT, intentOf());
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("unknown");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
    });
  });

  it("settles at most a bounded number of pending landings per call", async () => {
    await withAdaptation(({ adaptation, world }) => {
      const ids = Array.from(
        { length: MAX_SETTLE_PER_CALL + 2 },
        (_, n) => `int_pending${String(n).padStart(3, "0")}`,
      );
      for (const id of ids) adaptation.recordLanding(id);
      for (const id of ids) world.intents.set(id, intentOf({ intentId: id }));
      // The call settles its own landing and only the least recently tried others.
      adaptation.recordLanding(INTENT);
      const settled = ids.filter((id) => adaptation.landing(id)?.outcome === "adapted");
      expect(settled).toHaveLength(MAX_SETTLE_PER_CALL - 1);
      expect(adaptation.landing(INTENT)?.outcome).toBe("adapted");
    });
  });
});

/** A train over fakes that lands one pin, with the given adaptation. */
async function land(
  stub: DurableObjectStub,
  world: World,
  adaptationOf: (context: RepoContext, ports: () => RepoPorts) => AdaptationPort,
): Promise<{ states: string[]; landing: ReturnType<AdaptationPort["landing"]> }> {
  return runInDurableObject(stub, async (_instance, state) => {
    let now = 1_000;
    const log = EventLog.open(state.storage, REPO_ID, () => now);
    const context: RepoContext = {
      repoId: REPO_ID,
      storage: state.storage,
      log,
      clock: () => (now += 1),
      env,
      wake: () => {},
    };
    const composed = composeRepo(context);
    let main = MAIN;
    const started: CheckAttempt[] = [];
    const intents = new Map<string, MergeIntentRecord>();
    let current: RepoPorts = composed;
    const ports = (): RepoPorts => current;
    current = {
      ...composed,
      claims: { ...composed.claims, pin: async () => ok(pinOf(ATLAS)) },
      decisions: {
        ...composed.decisions,
        requirements: async () => ok([ref(1)]),
        currentVersions: (claimId) => world.versions.get(claimId) ?? null,
        currentDecision: (decisionId) => world.decisions.get(decisionId) ?? null,
      },
      merge: { compose: async () => ok({ kind: "clean", candidate: LANDED }) },
      checks: {
        definitions: async (source) => ok([acceptanceCheck(1, "chunk", source)]),
        start: async (attempt) => {
          started.push(attempt);
          return ok({ attemptId: attempt.attemptId });
        },
        report: unavailableChecks.report,
      },
      authorization: {
        authorize: async (attemptId) => {
          const attempt = started.find((a) => a.attemptId === attemptId);
          if (attempt === undefined) return fail("not_found", "No attempt.");
          const record = intentOf({
            checkAttemptId: attemptId,
            status: "authorized",
            attempts: 0,
            main: null,
          });
          intents.set(record.intentId, record);
          return ok(record);
        },
        intent: async () => fail("not_found", "No intent."),
        record: (intentId) => intents.get(intentId) ?? null,
        unsettled: () => [],
        recordWrite: () => null,
      },
      mainWriter: {
        head: async () => ok(main),
        publish: async (intentId) => {
          const record = intents.get(intentId);
          if (record === undefined) return fail("not_found", "No intent.");
          main = record.candidate;
          const landed = { ...record, status: "updated" as const, main, attempts: 1 };
          intents.set(intentId, landed);
          return ok(landed);
        },
      },
    };
    const train: Train = createTrain(context, ports);
    const port = adaptationOf(context, ports);
    current = { ...current, train, adaptation: port };

    expect(await train.enqueue(pinOf(ATLAS))).toEqual(ok({ queued: true }));
    const attempt = started.at(-1);
    if (attempt === undefined) throw new Error("no check was started");
    expect(await train.recordCheck(reportOf({ attemptId: attempt.attemptId }))).toMatchObject({
      ok: true,
    });
    return {
      states: train.entries(8).map((entry) => entry.state),
      landing: port.landing(INTENT),
    };
  });
}

describe("train landing", () => {
  it("records adaptation in the transaction that lands the batch", async () => {
    const result = await land(
      env.REPO.getByName(crypto.randomUUID()),
      new World(),
      adaptationModule,
    );
    expect(result.states).toEqual(["landed"]);
    expect(result.landing).toMatchObject({
      outcome: "adapted",
      claims: [{ claimId: ATLAS, decisions: [ref(1)] }],
    });
  });

  it("lands the batch when adaptation throws, and keeps a failed settlement for retry", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const throwing = await land(env.REPO.getByName(crypto.randomUUID()), new World(), () => ({
        recordLanding: () => {
          throw new TypeError("adaptation is broken");
        },
        adapted: () => null,
        landing: () => null,
      }));
      expect(throwing.states).toEqual(["landed"]);
      expect(errors).toHaveBeenCalledWith(
        JSON.stringify({ event: "train.adaptation_failed", repo: REPO_ID, error: "TypeError" }),
      );

      const world = new World();
      world.decisions.delete(DECISION);
      const pending = await land(env.REPO.getByName(crypto.randomUUID()), world, adaptationModule);
      expect(pending.states).toEqual(["landed"]);
      expect(pending.landing).toMatchObject({ outcome: null, tries: 1 });
    } finally {
      errors.mockRestore();
    }
  });
});
