import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { ClaimView } from "@railhead/shared/agent-api";
import type { CommitSha, DecisionRef, RailheadEvent } from "@railhead/shared/events";
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
import { createDecisions } from "../src/modules/decisions/decisions";
import { createTrain, type Train } from "../src/modules/train/scheduler";
import {
  composeRepo,
  RESUME_RETRY_MS,
  resumeAll,
  type RepoContext,
  type RepoPorts,
} from "../src/repo/composeRepo";
import { EventLog, MAX_REPLAY_EVENTS } from "../src/repo/eventLog";
import {
  ADAPTATION_ACTOR,
  createAdaptation,
  MAX_ANNOUNCE_PER_CALL,
  MAX_SETTLE_PER_CALL,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  type AdaptationPort,
  type AdaptationReaders,
  type LandedDependency,
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
const AGENT = "agt_atlas01";
const OWNER = "usr_lemarier";

function sha(digit: string): CommitSha {
  return digit.repeat(40);
}

function ref(version: number): DecisionRef {
  return { decisionId: DECISION, version };
}

/** What a claim that depended on `version` of the decision snapshots when it lands. */
function dep(version: number, option = "chunk"): LandedDependency {
  return { decisionId: DECISION, version, option };
}

function acceptanceCheck(
  version: number,
  option: string,
  source = MAIN,
  decisionId = DECISION,
): CheckDefinition {
  return {
    name: `accept-${option}`,
    source,
    digest: "d".repeat(64),
    acceptance: { decision: { decisionId, version }, option },
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
  counts(): { landings: number; adaptations: number };
  /** Every time the module asked the Repo's alarm for, oldest first. */
  wakes: number[];
  /** The Repo's event log. */
  log: EventLog;
  /** Every event in the Repo's log, oldest first. */
  events(): RailheadEvent[];
  /** The clock's current time. */
  now(): number;
  /** Moves the clock forward. */
  advance(ms: number): void;
}

async function withAdaptation<R>(
  body: (harness: Harness) => R | Promise<R>,
  stub = env.REPO.getByName(crypto.randomUUID()),
  world = new World(),
): Promise<R> {
  return runInDurableObject(stub, async (_instance, state) => {
    let now = 1_000;
    const wakes: number[] = [];
    const log = EventLog.open(state.storage, REPO_ID, () => now);
    const port = createAdaptation({
      storage: state.storage,
      log,
      readers: () => world.readers(),
      clock: () => (now += 1),
      wake: (at) => wakes.push(at),
    });
    const count = (table: string): number =>
      state.storage.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    return body({
      adaptation: port,
      world,
      counts: () => ({
        landings: count("adaptation_landings"),
        adaptations: count("adaptations"),
      }),
      wakes,
      log,
      events: () => log.replay(0, MAX_REPLAY_EVENTS).events,
      now: () => now,
      advance: (ms) => {
        now += ms;
      },
    });
  });
}

describe("recordLanding", () => {
  it("adapts a claim whose landed commit passed the current version's option", async () => {
    await withAdaptation(({ adaptation, counts }) => {
      expect(adaptation.recordLanding(INTENT)).toEqual({
        intentId: INTENT,
        outcome: "adapted",
        claims: [{ claimId: ATLAS, decisions: [dep(1)] }],
        tries: 0,
      });
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
      expect(counts()).toEqual({ landings: 1, adaptations: 1 });
      // A repeat settles nothing again and writes nothing more.
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("adapted");
      expect(counts()).toEqual({ landings: 1, adaptations: 1 });
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
        { claimId: ATLAS, decisions: [dep(1)] },
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
      expect(counts()).toEqual({ landings: 0, adaptations: 0 });
    });
  });
});

/** The `claim.adapted` events in `events`, as claim, intent and decision version. */
function announced(
  events: RailheadEvent[],
): { claimId: string; intentId: string; version: number }[] {
  return events.flatMap((event) => {
    if (event.type !== "claim.adapted") return [];
    expect(event.actor).toEqual(ADAPTATION_ACTOR);
    expect(event.data.decision.decisionId).toBe(DECISION);
    const { claimId, intentId, decision } = event.data;
    return [{ claimId, intentId, version: decision.version }];
  });
}

describe("claim.adapted", () => {
  it("announces only the claim that depended on the decision in a two-claim batch", async () => {
    await withAdaptation(async ({ adaptation, world, wakes, events, now }) => {
      world.intents.set(INTENT, intentOf({ pins: [pinOf(ATLAS), pinOf(BIRCH)] }));
      world.versions.set(BIRCH, []);
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("adapted");
      // The landing runs inside the train's transaction, so it appends nothing and asks the alarm
      // to run at once.
      expect(events()).toEqual([]);
      expect(wakes.at(-1)).toBeLessThanOrEqual(now());

      await adaptation.resume();
      expect(announced(events())).toEqual([{ claimId: ATLAS, intentId: INTENT, version: 1 }]);
      expect(adaptation.adapted(BIRCH, DECISION)).toBe(false);

      // A later alarm announces nothing twice and asks for no wake.
      const asked = wakes.length;
      await adaptation.resume();
      expect(events()).toHaveLength(1);
      expect(wakes).toHaveLength(asked);

      // A supersession leaves the fact in the log; readers compare it with the current version.
      world.supersede("reject");
      await adaptation.resume();
      expect(events()).toHaveLength(1);
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
    });
  });

  it("announces nothing for a landing that adapted no claim", async () => {
    await withAdaptation(async ({ adaptation, world, events }) => {
      world.versions.set(ATLAS, []);
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("no_dependent_claim");
      await adaptation.resume();
      expect(events()).toEqual([]);
    });
  });

  it("announces at most a bounded number per alarm and asks to run again for the rest", async () => {
    await withAdaptation(async ({ adaptation, world, wakes, events, now }) => {
      const claims = Array.from(
        { length: MAX_ANNOUNCE_PER_CALL + 1 },
        (_, n) => `clm_many${String(n).padStart(3, "0")}`,
      );
      for (const claimId of claims) world.versions.set(claimId, [ref(1)]);
      world.intents.set(INTENT, intentOf({ pins: claims.map((claimId) => pinOf(claimId)) }));
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("adapted");

      await adaptation.resume();
      expect(announced(events())).toHaveLength(MAX_ANNOUNCE_PER_CALL);
      expect(wakes.at(-1)).toBeLessThanOrEqual(now());

      await adaptation.resume();
      expect(announced(events()).map((event) => event.claimId)).toEqual(claims);
    });
  });

  it("keeps an adaptation unannounced when the log transaction fails, then announces it", async () => {
    await withAdaptation(async ({ adaptation, log, events }) => {
      adaptation.recordLanding(INTENT);
      const failing = vi.spyOn(log, "transaction").mockImplementationOnce(() => {
        throw new TypeError("storage busy");
      });
      await expect(adaptation.resume()).rejects.toThrow("storage busy");
      failing.mockRestore();
      expect(events()).toEqual([]);
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);

      await adaptation.resume();
      expect(announced(events())).toEqual([{ claimId: ATLAS, intentId: INTENT, version: 1 }]);
    });
  });

  it("announces an adaptation recorded before the Repo restarted", async () => {
    const stub = env.REPO.getByName(crypto.randomUUID());
    const world = new World();
    await withAdaptation(({ adaptation }) => adaptation.recordLanding(INTENT), stub, world);
    await evictDurableObject(stub);
    await withAdaptation(
      async ({ adaptation, events }) => {
        await adaptation.resume();
        expect(announced(events())).toEqual([{ claimId: ATLAS, intentId: INTENT, version: 1 }]);
      },
      stub,
      world,
    );
  });
});

describe("retained dependencies of merged claims", () => {
  it("keeps the versions a claim landed on after its requirements become unreadable", async () => {
    await withAdaptation(({ adaptation, world }) => {
      // The check has not reported when the landing is first read: the claims are captured anyway.
      world.outcomes.delete(ATTEMPT);
      expect(adaptation.recordLanding(INTENT)).toMatchObject({
        outcome: null,
        claims: [{ claimId: ATLAS, decisions: [dep(1)] }],
      });
      // The claim merged, so the decisions module no longer answers for it; settling reads only
      // the snapshot, so even a different answer would not change the outcome.
      world.versions.set(ATLAS, []);
      world.outcomes.set(ATTEMPT, { attempt: attemptOf(), report: reportOf() });
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("adapted");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
    });
  });

  it("never adapts a claim that depended on the version only after it landed", async () => {
    await withAdaptation(({ adaptation, world }) => {
      world.versions.set(ATLAS, []);
      world.outcomes.delete(ATTEMPT);
      expect(adaptation.recordLanding(INTENT)).toMatchObject({
        outcome: null,
        claims: [{ claimId: ATLAS, decisions: [] }],
      });
      world.versions.set(ATLAS, [ref(1)]);
      world.outcomes.set(ATTEMPT, { attempt: attemptOf(), report: reportOf() });
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("no_dependent_claim");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(false);
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
      await withAdaptation(({ adaptation, world, counts, advance }) => {
        adaptation.owe(INTENT, [pinOf(ATLAS)]);
        world.failure = new TypeError("storage gone");
        expect(adaptation.recordLanding(INTENT)).toMatchObject({
          outcome: null,
          claims: [{ claimId: ATLAS, decisions: [dep(1)] }],
          tries: 1,
        });
        // The throw rolled back everything the settlement wrote; only the pending row is kept.
        expect(counts()).toEqual({ landings: 1, adaptations: 0 });
        expect(errors).toHaveBeenCalledWith(
          JSON.stringify({ event: "adaptation.settle_failed", intent: INTENT, error: "TypeError" }),
        );

        world.failure = null;
        advance(RETRY_BASE_MS);
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
      adaptation.owe(INTENT, [pinOf(ATLAS)]);
      world.decisions.delete(DECISION);
      expect(adaptation.recordLanding(INTENT)).toMatchObject({ outcome: null, tries: 1 });
      world.decisions.set(DECISION, { version: 1, option: "chunk" });
      expect(adaptation.recordLanding(INTENT)?.outcome).toBe("adapted");
    });
  });

  it("keeps retrying through a long outage with a capped backoff, then adapts", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withAdaptation(async ({ adaptation, world, wakes, now, advance }) => {
        adaptation.owe(INTENT, [pinOf(ATLAS)]);
        world.intents.delete(INTENT);
        // More tries than any former give-up limit, alternating a missing intent and a reader that
        // throws.
        for (let attempt = 1; attempt <= 24; attempt += 1) {
          world.failure = attempt % 2 === 0 ? new TypeError("storage gone") : null;
          await adaptation.resume();
          world.failure = null;
          expect(adaptation.landing(INTENT)).toMatchObject({ outcome: null, tries: attempt });
          // The next try is never further away than the cap.
          expect(wakes.at(-1)).toBeLessThanOrEqual(now() + RETRY_MAX_MS);
          advance(RETRY_MAX_MS);
        }

        world.intents.set(INTENT, intentOf());
        await adaptation.resume();
        expect(adaptation.landing(INTENT)).toMatchObject({ outcome: "adapted", tries: 24 });
        expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("settles at most a bounded number of pending landings per call", async () => {
    await withAdaptation(({ adaptation, world, advance }) => {
      const ids = Array.from(
        { length: MAX_SETTLE_PER_CALL + 2 },
        (_, n) => `int_pending${String(n).padStart(3, "0")}`,
      );
      const authorized = { status: "authorized", attempts: 0, main: null } as const;
      for (const id of ids) world.intents.set(id, intentOf({ intentId: id, ...authorized }));
      for (const id of ids) adaptation.recordLanding(id);
      for (const id of ids) world.intents.set(id, intentOf({ intentId: id }));
      advance(RETRY_MAX_MS);
      // The call settles its own landing and only the least recently due others.
      adaptation.recordLanding(INTENT);
      const settled = ids.filter((id) => adaptation.landing(id)?.outcome === "adapted");
      expect(settled).toHaveLength(MAX_SETTLE_PER_CALL - 1);
      expect(adaptation.landing(INTENT)?.outcome).toBe("adapted");
    });
  });
});

describe("owe and resume", () => {
  it("owes a landing due now, and the alarm settles it", async () => {
    await withAdaptation(async ({ adaptation, counts, wakes, now }) => {
      adaptation.owe(INTENT, [pinOf(ATLAS)]);
      adaptation.owe(INTENT, [pinOf(ATLAS)]);
      expect(adaptation.landing(INTENT)).toMatchObject({
        outcome: null,
        tries: 0,
        claims: [{ claimId: ATLAS, decisions: [dep(1)] }],
      });
      expect(counts()).toEqual({ landings: 1, adaptations: 0 });
      expect(wakes.at(-1)).toBeLessThanOrEqual(now());
      await adaptation.resume();
      expect(adaptation.landing(INTENT)?.outcome).toBe("adapted");
      expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
    });
  });

  it("throws when a reader throws while owing, writing nothing", async () => {
    await withAdaptation(({ adaptation, world, counts, wakes }) => {
      world.failure = new TypeError("storage gone");
      expect(() => adaptation.owe(INTENT, [pinOf(ATLAS)])).toThrow("storage gone");
      expect(counts()).toEqual({ landings: 0, adaptations: 0 });
      expect(wakes).toEqual([]);
    });
  });

  it("owes a landing with no pins, which settles with no dependent claim", async () => {
    await withAdaptation(async ({ adaptation }) => {
      adaptation.owe(INTENT, []);
      expect(adaptation.landing(INTENT)?.claims).toEqual([]);
      await adaptation.resume();
      expect(adaptation.landing(INTENT)?.outcome).toBe("no_dependent_claim");
    });
  });

  it("refuses to owe an id that is not an intent, writing nothing", async () => {
    await withAdaptation(({ adaptation, counts, wakes }) => {
      for (const id of ["", "clm_claim001", "int_bad id!"]) {
        expect(() => adaptation.owe(id, [pinOf(ATLAS)])).toThrow(
          "the landing does not name an intent",
        );
      }
      // An intent neither owed nor recorded cannot be settled.
      expect(adaptation.recordLanding("int_unknown01")).toBeNull();
      expect(counts()).toEqual({ landings: 0, adaptations: 0 });
      expect(wakes).toEqual([]);
    });
  });

  it("backs off a pending landing and retries it only once it is due", async () => {
    await withAdaptation(async ({ adaptation, world, wakes, now, advance }) => {
      adaptation.owe(INTENT, [pinOf(ATLAS)]);
      world.decisions.delete(DECISION);
      await adaptation.resume();
      expect(adaptation.landing(INTENT)).toMatchObject({ outcome: null, tries: 1 });
      const due = wakes.at(-1);
      expect(due).toBeGreaterThanOrEqual(now() + RETRY_BASE_MS - 2);

      world.decisions.set(DECISION, { version: 1, option: "chunk" });
      // Not due yet: nothing is read again.
      await adaptation.resume();
      expect(adaptation.landing(INTENT)).toMatchObject({ outcome: null, tries: 1 });

      advance(RETRY_BASE_MS);
      await adaptation.resume();
      expect(adaptation.landing(INTENT)?.outcome).toBe("adapted");
      // Nothing is pending, so no further wake is asked for.
      const asked = wakes.length;
      await adaptation.resume();
      expect(wakes).toHaveLength(asked);
    });
  });

  it("retries a minute after the alarm's resume throws once, and adapts on that wake", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await withAdaptation(async ({ adaptation, wakes, now, advance }) => {
        adaptation.owe(INTENT, [pinOf(ATLAS)]);
        let failing = true;
        const modules = [
          {
            module: "adaptation" as const,
            resume: async () => {
              if (failing) {
                failing = false;
                throw new TypeError("storage busy");
              }
              await adaptation.resume();
            },
          },
        ];
        const context = { repoId: REPO_ID, clock: now, wake: (at: number) => wakes.push(at) };

        await resumeAll(context, modules);
        const retryAt = now() + RESUME_RETRY_MS;
        expect(wakes.at(-1)).toBe(retryAt);
        expect(errors).toHaveBeenCalledWith(
          JSON.stringify({
            event: "repo.resume_failed",
            repo: REPO_ID,
            module: "adaptation",
            error: "TypeError",
            retryAt,
          }),
        );
        expect(adaptation.landing(INTENT)).toMatchObject({ outcome: null, tries: 0 });

        advance(RESUME_RETRY_MS);
        await resumeAll(context, modules);
        expect(adaptation.landing(INTENT)?.outcome).toBe("adapted");
        expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("settles at most a bounded number of due landings per alarm", async () => {
    await withAdaptation(async ({ adaptation, world }) => {
      const ids = Array.from(
        { length: MAX_SETTLE_PER_CALL + 1 },
        (_, n) => `int_pending${String(n).padStart(3, "0")}`,
      );
      for (const id of ids) {
        world.intents.set(id, intentOf({ intentId: id, status: "authorized", main: null }));
        adaptation.owe(id, [pinOf(ATLAS)]);
      }
      await adaptation.resume();
      const tried = ids.filter((id) => (adaptation.landing(id)?.tries ?? 0) > 0);
      expect(tried).toHaveLength(MAX_SETTLE_PER_CALL);
    });
  });
});

/** The Repo context of one `runInDurableObject` body, with a clock that starts at `start`. */
function repoContext(
  storage: DurableObjectStorage,
  start: number,
): { context: RepoContext; wakes: number[] } {
  let now = start;
  const wakes: number[] = [];
  const log = EventLog.open(storage, REPO_ID, () => now);
  return {
    context: {
      repoId: REPO_ID,
      storage,
      log,
      clock: () => (now += 1),
      env,
      wake: (at) => wakes.push(at),
    },
    wakes,
  };
}

/** ATLAS held at generation 1 by `AGENT`, as the claims module reports it. */
const HELD: ClaimView = {
  claimId: ATLAS,
  issueId: "iss_issue001",
  generation: 1,
  base: MAIN,
  state: "working",
  readyCommit: null,
  originUrl: "https://railhead.test/acme/demo/claims/clm_claim001.git",
  upstreamUrl: "https://railhead.test/acme/demo.git",
  task: { title: "Upload", body: "" },
};

/** Claims ports in which ATLAS is held at generation 1. */
function holding(claims: RepoPorts["claims"]): RepoPorts["claims"] {
  return {
    ...claims,
    pin: async () => ok(pinOf(ATLAS)),
    activeClaim: async () => ok(HELD),
    currentGeneration: (claimId) => (claimId === ATLAS ? 1 : null),
  };
}

/**
 * Records, through the real decisions module, a decision ATLAS asked for and its first version
 * choosing `chunk`, and returns the decision's id.
 */
async function decideChunk(stub: DurableObjectStub): Promise<string> {
  return runInDurableObject(stub, async (_instance, state) => {
    const { context } = repoContext(state.storage, 500);
    const composed = composeRepo(context);
    const ports = (): RepoPorts => ({ ...composed, claims: holding(composed.claims) });
    const decisions = createDecisions(context, ports);
    const agent = { kind: "agent", agentId: AGENT, ownerId: OWNER, repoId: REPO_ID } as const;
    const asked = await decisions.ask(agent, ATLAS, {
      generation: 1,
      requestId: "req_upload0000000001",
      text: "Should uploads above 10 MB be rejected or chunked?",
      options: [
        { key: "reject", label: "Reject them" },
        { key: "chunk", label: "Upload them in chunks" },
      ],
      scope: ["src/upload.ts"],
    });
    if (!asked.ok) throw new Error(`ask failed: ${asked.code}`);
    const { decisionId } = asked.value;
    const recorded = await decisions.record({
      kind: "human",
      userId: OWNER,
      repoId: REPO_ID,
      grantId: "chl_grant0001",
      action: { kind: "decision.record", decisionId, option: "chunk", expectedVersion: null },
    });
    if (!recorded.ok) throw new Error(`record failed: ${recorded.code}`);
    return decisionId;
  });
}

/**
 * A train over fakes that lands one pin, with the given adaptation. With `decisionId`, the real
 * decisions module answers, ATLAS is held, and the check accepts that decision.
 */
async function land(
  stub: DurableObjectStub,
  world: World,
  adaptationOf: (context: RepoContext, ports: () => RepoPorts) => AdaptationPort,
  decisionId: string | null = null,
): Promise<{
  states: string[];
  landing: ReturnType<AdaptationPort["landing"]>;
  intent: MergeIntentRecord | null;
  wakes: number[];
}> {
  return runInDurableObject(stub, async (_instance, state) => {
    let now = 1_000;
    const wakes: number[] = [];
    const log = EventLog.open(state.storage, REPO_ID, () => now);
    const context: RepoContext = {
      repoId: REPO_ID,
      storage: state.storage,
      log,
      clock: () => (now += 1),
      env,
      wake: (at) => wakes.push(at),
    };
    const composed = composeRepo(context);
    let main = MAIN;
    const started: CheckAttempt[] = [];
    const intents = new Map<string, MergeIntentRecord>();
    let current: RepoPorts = composed;
    const ports = (): RepoPorts => current;
    current = {
      ...composed,
      claims:
        decisionId === null
          ? { ...composed.claims, pin: async () => ok(pinOf(ATLAS)) }
          : holding(composed.claims),
      decisions:
        decisionId === null
          ? {
              ...composed.decisions,
              requirements: async () => ok([ref(1)]),
              currentVersions: (claimId) => world.versions.get(claimId) ?? null,
              currentDecision: (id) => world.decisions.get(id) ?? null,
            }
          : createDecisions(context, ports),
      merge: {
        compose: async () => ok({ kind: "clean", candidate: LANDED }),
        discard: async () => ok({ removed: 0 }),
      },
      checks: {
        definitions: async (source) =>
          ok([acceptanceCheck(1, "chunk", source, decisionId ?? DECISION)]),
        start: async (attempt) => {
          started.push(attempt);
          return ok({ attemptId: attempt.attemptId });
        },
        report: unavailableChecks.report,
        detail: unavailableChecks.detail,
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
    await train.recordCheck(reportOf({ attemptId: attempt.attemptId }));
    return {
      states: train.entries(8).map((entry) => entry.state),
      landing: port.landing(INTENT),
      intent: intents.get(INTENT) ?? null,
      wakes,
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
      claims: [{ claimId: ATLAS, decisions: [dep(1)] }],
    });
  });

  it("lands the batch when settling throws, and the alarm adapts it after a restart", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stub = env.REPO.getByName(crypto.randomUUID());
      const world = new World();
      const throwing = await land(stub, world, (context, ports) => ({
        ...adaptationModule(context, ports),
        recordLanding: () => {
          throw new TypeError("adaptation is broken");
        },
      }));
      expect(throwing.states).toEqual(["landed"]);
      // The landing owed its adaptation with the claim's dependencies snapshotted.
      expect(throwing.landing).toEqual({
        intentId: INTENT,
        outcome: null,
        claims: [{ claimId: ATLAS, decisions: [dep(1)] }],
        tries: 0,
      });
      expect(throwing.wakes.length).toBeGreaterThan(0);
      expect(errors).toHaveBeenCalledWith(
        JSON.stringify({ event: "train.adaptation_failed", repo: REPO_ID, error: "TypeError" }),
      );

      // The claim merges, so its requirements read as unknown, and the Repo restarts; its alarm
      // resumes the owed landing from storage alone.
      world.versions.delete(ATLAS);
      await evictDurableObject(stub);
      await withAdaptation(
        async ({ adaptation, advance }) => {
          // The alarm fires at the time the landing asked for, after the restarted clock.
          advance(Math.max(...throwing.wakes));
          await adaptation.resume();
          expect(adaptation.landing(INTENT)?.outcome).toBe("adapted");
          expect(adaptation.adapted(ATLAS, DECISION)).toBe(true);
        },
        stub,
        world,
      );
    } finally {
      errors.mockRestore();
    }
  });

  it("adapts from the landing's snapshot after the claim merged and the Repo restarted", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const stub = env.REPO.getByName(crypto.randomUUID());
      const decisionId = await decideChunk(stub);
      const throwing = await land(
        stub,
        new World(),
        (context, ports) => ({
          ...adaptationModule(context, ports),
          recordLanding: () => {
            throw new TypeError("adaptation is broken");
          },
        }),
        decisionId,
      );
      expect(throwing.states).toEqual(["landed"]);
      expect(throwing.landing).toEqual({
        intentId: INTENT,
        outcome: null,
        claims: [{ claimId: ATLAS, decisions: [{ decisionId, version: 1, option: "chunk" }] }],
        tries: 0,
      });
      const intent = throwing.intent;
      if (intent === null) throw new Error("the intent was not recorded");

      await evictDurableObject(stub);
      await runInDurableObject(stub, async (_instance, state) => {
        // The restarted Repo's claims module has no current generation for ATLAS, as for a
        // merged claim; only the intent, which the fake authorization kept in memory, is replayed.
        const { context } = repoContext(state.storage, Math.max(...throwing.wakes));
        const composed = composeRepo(context);
        const ports: RepoPorts = {
          ...composed,
          authorization: {
            ...composed.authorization,
            record: (intentId) => (intentId === INTENT ? intent : null),
          },
        };
        expect(ports.claims.currentGeneration(ATLAS)).toBeNull();
        expect(ports.decisions.currentVersions(ATLAS)).toBeNull();
        const adaptation = adaptationModule(context, () => ports);
        await adaptation.resume();
        expect(adaptation.landing(INTENT)?.outcome).toBe("adapted");
        expect(adaptation.adapted(ATLAS, decisionId)).toBe(true);
      });
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the batch unlanded when the adaptation cannot be owed", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const refused = await land(
        env.REPO.getByName(crypto.randomUUID()),
        new World(),
        (context, ports) => ({
          ...adaptationModule(context, ports),
          owe: () => {
            throw new TypeError("storage refused");
          },
        }),
      );
      // The landing rolled back with it; the train lands the batch again on a later drive.
      expect(refused.states).toEqual(["batched"]);
      expect(refused.landing).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps a settlement it cannot decide pending, owed in the landing", async () => {
    const world = new World();
    world.decisions.delete(DECISION);
    const pending = await land(env.REPO.getByName(crypto.randomUUID()), world, adaptationModule);
    expect(pending.states).toEqual(["landed"]);
    expect(pending.landing).toMatchObject({ outcome: null, tries: 1 });
  });
});
