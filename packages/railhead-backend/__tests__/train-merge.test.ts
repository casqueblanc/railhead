import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaimPin } from "../src/contracts/claims";
import { fail, ok, type PortResult } from "../src/contracts/result";
import { MERGE_PUSH_WINDOW_MS, type MergePort } from "../src/contracts/train";
import { MAX_ACTIVE_SANDBOXES, SlotTable } from "../src/sandbox/admission";
import {
  createSandboxPort,
  type SandboxCommand,
  type SandboxDriver,
  type SandboxPort,
} from "../src/sandbox/entry";
import type { BoundedOutput } from "../src/sandbox/output";
import { CANDIDATE_REF_PREFIX, type SandboxPolicy } from "../src/sandbox/policy";
import {
  FETCH_DEPTHS,
  MAX_COMPOSE_PINS,
  MAX_CONFLICT_PATHS,
  MERGE_SANDBOX_LIFETIME_MS,
  MERGE_TIMEOUT_MS,
  createMerge,
  type MergeDeps,
} from "../src/train/merge/compose";
import {
  MAX_PATH_LENGTH,
  MAX_REGION_LENGTH,
  MAX_REGIONS,
} from "../src/train/classification/classify";
import {
  discardCommand,
  fetchCommand,
  parseBinary,
  parseCommit,
  parseDiscarded,
  parsePartner,
  parseRegions,
  parseRemote,
  pushCommand,
  regionsCommand,
  remoteUrl,
} from "../src/train/merge/script";

const HOST = "0123456789abcdef0123456789abcdef.artifacts.cloudflare.net";
const LOCATION = { host: HOST, namespace: "railhead" };
const MAIN_REPO = "rh-m-main";
const MAIN = "a".repeat(40);
const CANDIDATE = "c".repeat(40);
const PIN_A: ClaimPin = { claimId: "clm_aaaaaa01", generation: 1, commit: "1".repeat(40) };
const PIN_B: ClaimPin = { claimId: "clm_bbbbbb02", generation: 3, commit: "2".repeat(40) };
const PIN_C: ClaimPin = { claimId: "clm_cccccc03", generation: 2, commit: "3".repeat(40) };
const OID = (n: number) => n.toString(16).padStart(40, "0");

/** What a scripted command prints: an exit code and its streams. */
type Reply = Partial<BoundedOutput> & { exitCode: number };

/** Which step a command is, recognized by the Git command it runs. */
type StepName = "init" | "fetch" | "merge" | "partner" | "binary" | "regions" | "push" | "discard";

function stepOf(command: string): StepName {
  if (command.includes("git push --porcelain --prune")) return "discard";
  if (command.includes("git init")) return "init";
  if (command.includes("git fetch")) return "fetch";
  if (command.includes("try_partner")) return "partner";
  if (command.includes("git diff --numstat")) return "binary";
  if (command.includes("git merge-file")) return "regions";
  if (command.includes("git push")) return "push";
  if (command.includes("git merge -q --no-ff --no-edit")) return "merge";
  throw new Error(`unexpected command: ${command}`);
}

/** A container runtime that answers each step from a script and records what ran. */
class ScriptedDriver {
  readonly policies: SandboxPolicy[] = [];
  readonly commands: SandboxCommand[] = [];
  readonly destroyed: string[] = [];
  readonly replies: Partial<Record<StepName, Reply[]>> = {};
  /** Answers a step from its command, before `replies`. */
  readonly respond: Partial<Record<StepName, (command: string) => Reply>> = {};
  /** Whether a start fails. */
  startFails = false;
  /** Runs before each command, after it is recorded. */
  onExec: (step: StepName) => void = () => undefined;

  readonly driver: SandboxDriver = {
    start: async (_name, policy) => {
      this.policies.push(policy);
      if (this.startFails) throw new Error("scripted start failure");
    },
    exec: async (_name, command) => {
      this.commands.push(command);
      const step = stepOf(command.command);
      this.onExec(step);
      const queue = this.replies[step] ?? [];
      const reply =
        this.respond[step]?.(command.command) ?? (queue.length > 1 ? queue.shift() : queue[0]);
      return { stdout: "", stderr: "", truncated: false, exitCode: 0, ...reply };
    },
    destroy: async (name) => {
      this.destroyed.push(name);
    },
  };

  steps(): StepName[] {
    return this.commands.map((command) => stepOf(command.command));
  }
}

/** The merge port, with each compose given the next attempt `mrg_attempt001`, `002`, … */
interface TestMerge {
  compose(main: string, pins: ClaimPin[]): ReturnType<MergePort["compose"]>;
  discard: MergePort["discard"];
}

interface Harness {
  merge: TestMerge;
  /** The merge port itself, for a compose under an attempt the test names. */
  port: MergePort;
  fake: ScriptedDriver;
  sandbox: SandboxPort;
  advance: (ms: number) => void;
  exists: { calls: string[] };
}

type Overrides = Partial<Pick<MergeDeps, "locate" | "commitExists" | "clock" | "limits">> & {
  /** Wraps the sandbox port the merge sees, to change how its calls answer. */
  wrap?: (port: SandboxPort) => SandboxPort;
};

/** Runs `body` with a merge port over a sandbox port in a fresh Durable Object's storage. */
function withMerge(
  body: (harness: Harness) => Promise<void>,
  { wrap = (port) => port, ...overrides }: Overrides = {},
) {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    let now = 1_000_000;
    const clock = overrides.clock ?? (() => now);
    const fake = new ScriptedDriver();
    const sandbox = createSandboxPort(new SlotTable(state.storage), {
      driver: fake.driver,
      clock,
      timeouts: { startMs: 50, destroyMs: 50, execGraceMs: 50 },
    });
    const exists = { calls: [] as string[] };
    let attempts = 0;
    const port = createMerge({
      sandbox: () => wrap(sandbox),
      locate: async () => LOCATION,
      mainRepo: async () => MAIN_REPO,
      forkRepo: async (claimId) => `rh-f-${claimId.slice(4)}`,
      commitExists: async (repo, commit) => {
        exists.calls.push(`${repo}@${commit}`);
        return ok(false);
      },
      clock,
      limits: { timeoutMs: 15_000, releaseWaitMs: 50 },
      ...overrides,
    });
    const merge: TestMerge = {
      compose: (main, pins) =>
        port.compose(main, pins, `mrg_attempt${String((attempts += 1)).padStart(3, "0")}`),
      discard: (attempt) => port.discard(attempt),
    };
    await body({ merge, port, fake, sandbox, advance: (ms) => (now += ms), exists });
  });
}

/** A budget short enough to run on the real clock, with one whole second for the first step. */
const SHORT = { timeoutMs: 1_500, releaseWaitMs: 200 };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function entries(path: string, stages: [number, string, string][]): string {
  return stages.map(([stage, mode, oid]) => `${mode} ${oid} ${stage}\t${path}\0`).join("");
}

function textConflict(path: string, base: number): string {
  return entries(path, [
    [1, "100644", OID(base)],
    [2, "100644", OID(base + 1)],
    [3, "100644", OID(base + 2)],
  ]);
}

/** One region's three sides, as the regions step prints them. */
interface Sides {
  base: string;
  ours: string;
  theirs: string;
}

const SIDES: Sides = { base: "a\n", ours: "a\nb\n", theirs: "a\nc\n" };

/** The nonce a regions command marks its output with. */
function nonceOf(command: string): string {
  const nonce = /-L ([a-z0-9]+) /.exec(command)?.[1];
  if (nonce === undefined) throw new Error("no nonce in the regions command");
  return nonce;
}

/** What the regions step prints for `files`, each its regions in order or `opaque`. */
function printedRegions(nonce: string, files: readonly (readonly Sides[] | "opaque")[]): string {
  const blocks = files.map((file, index) => {
    const head = `${nonce} file ${index}\n`;
    if (file === "opaque") return `${head}${nonce} opaque\n`;
    const regions = file.map(
      ({ base, ours, theirs }) =>
        `<<<<<<< ${nonce}\n${ours}||||||| ${nonce}\n${base}=======\n${theirs}>>>>>>> ${nonce}\n`,
    );
    return head + regions.join("");
  });
  return `${blocks.join("")}${nonce} end\n`;
}

/** The policy of another attempt holding a sandbox. */
function otherPolicy(n: number): SandboxPolicy {
  return {
    host: HOST,
    namespace: "railhead",
    read: [],
    write: { repo: MAIN_REPO, refPrefix: `${CANDIDATE_REF_PREFIX}chk_other${n}/` },
  };
}

async function expectReleased(harness: Harness): Promise<void> {
  const slots = await harness.sandbox.slots();
  expect(slots).toEqual(ok([]));
  expect(harness.fake.destroyed).toHaveLength(1);
}

describe("compose", () => {
  it("merges a clean pair and publishes it under the attempt's candidate prefix only", async () => {
    await withMerge(async (harness) => {
      const { fake } = harness;
      fake.replies.merge = [{ exitCode: 0, stdout: `${CANDIDATE}\n` }];

      const result = await harness.merge.compose(MAIN, [PIN_A, PIN_B]);

      expect(result).toEqual(ok({ kind: "clean", candidate: CANDIDATE }));
      expect(fake.steps()).toEqual(["init", "fetch", "merge", "push"]);
      // The policy reads main and the forks and writes only the attempt's candidate refs of main.
      expect(fake.policies).toEqual([
        {
          host: HOST,
          namespace: "railhead",
          read: [MAIN_REPO, "rh-f-aaaaaa01", "rh-f-bbbbbb02"],
          write: { repo: MAIN_REPO, refPrefix: `${CANDIDATE_REF_PREFIX}mrg_attempt001/` },
        },
      ]);
      const [, fetch, merge, push] = fake.commands.map((command) => command.command);
      // Each pin is fetched by its exact commit from its own fork, never by a branch.
      expect(fetch).toContain(`/git/railhead/rh-f-aaaaaa01.git' ${PIN_A.commit}`);
      expect(fetch).toContain(`/git/railhead/rh-f-bbbbbb02.git' ${PIN_B.commit}`);
      expect(fetch).toContain(`/git/railhead/${MAIN_REPO}.git' ${MAIN}`);
      expect(fetch).toContain(`--depth=${FETCH_DEPTHS[0]}`);
      expect(fetch).not.toContain("refs/");
      expect(merge?.indexOf(PIN_A.commit)).toBeLessThan(merge?.indexOf(PIN_B.commit) ?? -1);
      expect(push).toContain(`${CANDIDATE}:refs/heads/candidate/mrg_attempt001/merge`);
      for (const { command } of fake.commands) expect(command).not.toContain("refs/heads/main");
      await expectReleased(harness);
    });
  });

  it("deepens the fetch when a pin's history does not reach main's", async () => {
    await withMerge(async (harness) => {
      const { fake } = harness;
      fake.replies.fetch = [{ exitCode: 30 }, { exitCode: 0 }];
      fake.replies.merge = [{ exitCode: 0, stdout: `${CANDIDATE}\n` }];

      const result = await harness.merge.compose(MAIN, [PIN_A]);

      expect(result).toEqual(ok({ kind: "clean", candidate: CANDIDATE }));
      const depths = fake.commands
        .filter((command) => stepOf(command.command) === "fetch")
        .map((command) => /--depth=(\d+)/.exec(command.command)?.[1]);
      expect(depths).toEqual([String(FETCH_DEPTHS[0]), String(FETCH_DEPTHS[1])]);
    });
  });

  it("reports the conflicting pair and its paths for a text conflict", async () => {
    await withMerge(async (harness) => {
      const { fake } = harness;
      // Pin 3 (B) conflicts; C merged cleanly before it, and A is its partner.
      fake.replies.merge = [{ exitCode: 43 }];
      fake.replies.partner = [
        {
          exitCode: 0,
          stdout: `partner 2\n${textConflict("src/app.ts", 1)}${textConflict("a\nb", 10)}`,
        },
      ];
      fake.replies.binary = [{ exitCode: 0, stdout: `0\t1\t1\t${OID(2)} => ${OID(3)}\n1\t\n` }];
      const second: Sides = { base: "x\r\n", ours: "", theirs: "y\r\n" };
      fake.respond.regions = (command) => ({
        exitCode: 0,
        stdout: printedRegions(nonceOf(command), [[SIDES, SIDES], [second]]),
      });

      const result = await harness.merge.compose(MAIN, [PIN_C, PIN_A, PIN_B]);

      expect(result).toEqual(
        ok({
          kind: "conflict",
          pins: [PIN_A, PIN_B],
          paths: ["src/app.ts", "a\nb"],
          regions: [
            { path: "src/app.ts", ...SIDES },
            { path: "src/app.ts", ...SIDES },
            { path: "a\nb", ...second },
          ],
        }),
      );
      expect(fake.steps()).toEqual(["init", "fetch", "merge", "partner", "binary", "regions"]);
      // Each path's base, ours and theirs blobs, in index order.
      const regions = fake.commands[5]?.command ?? "";
      expect(regions).toContain(`regions 0 ${OID(1)} ${OID(2)} ${OID(3)}`);
      expect(regions).toContain(`regions 1 ${OID(10)} ${OID(11)} ${OID(12)}`);
      const partner = fake.commands[3]?.command ?? "";
      // Partners are main, then each earlier pin, in order.
      expect(partner).toContain(`try_partner 0 ${MAIN} ${PIN_B.commit}`);
      expect(partner).toContain(`try_partner 2 ${PIN_A.commit} ${PIN_B.commit}`);
      expect(fake.commands.some((command) => command.command.includes("git push"))).toBe(false);
      await expectReleased(harness);
    });
  });

  it.each([
    {
      name: "more paths than the classifier takes regions",
      paths: MAX_REGIONS + 1,
      reply: null,
    },
    {
      name: "a path longer than the classifier takes",
      paths: 1,
      long: true,
      reply: null,
    },
    {
      name: "more regions than the classifier takes",
      paths: 1,
      reply: (nonce: string) => ({
        exitCode: 0,
        stdout: printedRegions(nonce, [Array.from({ length: MAX_REGIONS + 1 }, () => SIDES)]),
      }),
    },
    {
      name: "a side longer than the classifier takes",
      paths: 1,
      reply: (nonce: string) => ({
        exitCode: 0,
        stdout: printedRegions(nonce, [[{ ...SIDES, theirs: "x".repeat(MAX_REGION_LENGTH + 1) }]]),
      }),
    },
    {
      name: "a path whose blobs could forge a separator",
      paths: 2,
      reply: (nonce: string) => ({
        exitCode: 0,
        stdout: printedRegions(nonce, [[SIDES], "opaque"]),
      }),
    },
    {
      name: "a listing cut short",
      paths: 1,
      reply: (nonce: string) => ({
        exitCode: 0,
        stdout: printedRegions(nonce, [[SIDES]]),
        truncated: true,
      }),
    },
    {
      name: "a regions step that failed",
      paths: 1,
      reply: () => ({ exitCode: 2 }),
    },
  ])("reports the conflict without its text for $name", async ({ paths, long, reply }) => {
    const names = Array.from({ length: paths }, (_, i) =>
      long === true ? "d/".repeat(MAX_PATH_LENGTH / 2) + `f${i}` : `f${i}`,
    );
    await withMerge(async (harness) => {
      const { fake } = harness;
      fake.replies.merge = [{ exitCode: 42 }];
      fake.replies.partner = [
        {
          exitCode: 0,
          stdout: `partner 1\n${names.map((n, i) => textConflict(n, i * 3)).join("")}`,
        },
      ];
      fake.replies.binary = [{ exitCode: 0, stdout: names.map((_, i) => `${i}\t\n`).join("") }];
      if (reply !== null) fake.respond.regions = (command) => reply(nonceOf(command));

      expect(await harness.merge.compose(MAIN, [PIN_A, PIN_B])).toEqual(
        ok({ kind: "conflict", pins: [PIN_A, PIN_B], paths: names, regions: [] }),
      );
      expect(fake.steps().includes("regions")).toBe(reply !== null);
      await expectReleased(harness);
    });
  });

  it.each([
    [
      "a delete on one side",
      entries("gone.txt", [
        [1, "100644", OID(1)],
        [2, "100644", OID(2)],
      ]),
    ],
    [
      "a symlink",
      entries("link", [
        [1, "120000", OID(1)],
        [2, "120000", OID(2)],
        [3, "120000", OID(3)],
      ]),
    ],
    [
      "a submodule",
      entries("sub", [
        [1, "160000", OID(1)],
        [2, "160000", OID(2)],
        [3, "160000", OID(3)],
      ]),
    ],
  ])("reports %s as unsupported", async (_name, listing) => {
    await withMerge(async (harness) => {
      harness.fake.replies.merge = [{ exitCode: 42 }];
      harness.fake.replies.partner = [{ exitCode: 0, stdout: `partner 1\n${listing}` }];

      const result = await harness.merge.compose(MAIN, [PIN_A, PIN_B]);

      expect(result).toEqual(ok({ kind: "error", reason: "unsupported" }));
      expect(harness.fake.steps()).not.toContain("binary");
    });
  });

  it("reports a partner merge that left no unmerged entry as infrastructure", async () => {
    await withMerge(async (harness) => {
      harness.fake.replies.merge = [{ exitCode: 42 }];
      harness.fake.replies.partner = [{ exitCode: 0, stdout: "partner 1\n" }];

      expect(await harness.merge.compose(MAIN, [PIN_A, PIN_B])).toEqual(
        ok({ kind: "error", reason: "infrastructure" }),
      );
      expect(harness.fake.steps()).not.toContain("binary");
    });
  });

  it("reports a binary conflict as unsupported", async () => {
    await withMerge(async (harness) => {
      harness.fake.replies.merge = [{ exitCode: 42 }];
      harness.fake.replies.partner = [
        { exitCode: 0, stdout: `partner 1\n${textConflict("x.png", 1)}` },
      ];
      harness.fake.replies.binary = [{ exitCode: 0, stdout: `0\t-\t-\t${OID(2)} => ${OID(3)}\n` }];

      expect(await harness.merge.compose(MAIN, [PIN_A, PIN_B])).toEqual(
        ok({ kind: "error", reason: "unsupported" }),
      );
    });
  });

  it.each([
    ["main itself", "partner 0\n" + textConflict("a.txt", 1)],
    ["no single earlier pin", "partner none\n"],
  ])("reports a conflict with %s as unsupported", async (_name, stdout) => {
    await withMerge(async (harness) => {
      harness.fake.replies.merge = [{ exitCode: 42 }];
      harness.fake.replies.partner = [{ exitCode: 0, stdout }];

      expect(await harness.merge.compose(MAIN, [PIN_A, PIN_B])).toEqual(
        ok({ kind: "error", reason: "unsupported" }),
      );
    });
  });

  it("reports a conflict past the path limit, or a listing cut short, as unsupported", async () => {
    const many = Array.from({ length: MAX_CONFLICT_PATHS + 1 }, (_, i) =>
      textConflict(`f${i}`, i * 3),
    ).join("");
    await withMerge(async (harness) => {
      harness.fake.replies.merge = [{ exitCode: 42 }];
      harness.fake.replies.partner = [
        { exitCode: 0, stdout: `partner 1\n${many}` },
        { exitCode: 0, stdout: `partner 1\n${textConflict("a", 1)}`, truncated: true },
      ];
      expect(await harness.merge.compose(MAIN, [PIN_A, PIN_B])).toEqual(
        ok({ kind: "error", reason: "unsupported" }),
      );
      expect(await harness.merge.compose(MAIN, [PIN_A, PIN_B])).toEqual(
        ok({ kind: "error", reason: "unsupported" }),
      );
    });
  });

  it("reports a missing parent when no fetch depth reaches main's history", async () => {
    await withMerge(async (harness) => {
      harness.fake.replies.fetch = [{ exitCode: 30 }];

      const result = await harness.merge.compose(MAIN, [PIN_A]);

      expect(result).toEqual(ok({ kind: "error", reason: "missing_commit" }));
      expect(harness.fake.steps()).toEqual(["init", ...FETCH_DEPTHS.map(() => "fetch")]);
      await expectReleased(harness);
    });
  });

  it("reports a pin its fork does not hold as a missing commit", async () => {
    await withMerge(async (harness) => {
      // Target 2 is the second pin.
      harness.fake.replies.fetch = [{ exitCode: 12 }];

      const result = await harness.merge.compose(MAIN, [PIN_A, PIN_B]);

      expect(result).toEqual(ok({ kind: "error", reason: "missing_commit" }));
      expect(harness.exists.calls).toEqual([`rh-f-bbbbbb02@${PIN_B.commit}`]);
    });
  });

  it("reports a failed fetch of main's commit as infrastructure, without asking Artifacts", async () => {
    await withMerge(async (harness) => {
      // Target 0 is main's commit; the lookup would say it is missing.
      harness.fake.replies.fetch = [{ exitCode: 10 }];

      expect(await harness.merge.compose(MAIN, [PIN_A])).toEqual(
        ok({ kind: "error", reason: "infrastructure" }),
      );
      expect(harness.exists.calls).toEqual([]);
      await expectReleased(harness);
    });
  });

  it("reports a Git error in the fetch step as infrastructure, without deepening", async () => {
    await withMerge(async (harness) => {
      // What the fetch step exits with when `git merge-base` fails for any reason but no ancestor.
      harness.fake.replies.fetch = [{ exitCode: 2 }];

      expect(await harness.merge.compose(MAIN, [PIN_A])).toEqual(
        ok({ kind: "error", reason: "infrastructure" }),
      );
      expect(harness.fake.steps()).toEqual(["init", "fetch"]);
      expect(harness.exists.calls).toEqual([]);
    });
  });

  it("reports a merge step that failed without a conflict as infrastructure", async () => {
    await withMerge(async (harness) => {
      harness.fake.replies.merge = [{ exitCode: 2 }];

      expect(await harness.merge.compose(MAIN, [PIN_A, PIN_B])).toEqual(
        ok({ kind: "error", reason: "infrastructure" }),
      );
      expect(harness.fake.steps()).toEqual(["init", "fetch", "merge"]);
    });
  });

  it("reports a failed fetch of a commit that exists, or cannot be checked, as infrastructure", async () => {
    for (const answer of [ok(true), fail("unavailable", "no artifacts")]) {
      await withMerge(
        async (harness) => {
          harness.fake.replies.fetch = [{ exitCode: 11 }];
          expect(await harness.merge.compose(MAIN, [PIN_A])).toEqual(
            ok({ kind: "error", reason: "infrastructure" }),
          );
        },
        { commitExists: async (): Promise<PortResult<boolean>> => answer },
      );
    }
  });

  it("reports a step cut by its deadline as a timeout", async () => {
    await withMerge(async (harness) => {
      harness.fake.replies.fetch = [{ exitCode: 124 }];

      expect(await harness.merge.compose(MAIN, [PIN_A])).toEqual(
        ok({ kind: "error", reason: "timeout" }),
      );
      await expectReleased(harness);
    });
  });

  it("reports a timeout when the budget runs out between steps, and runs nothing after", async () => {
    await withMerge(async (harness) => {
      harness.fake.onExec = (step) => {
        if (step === "fetch") harness.advance(15_000);
      };

      expect(await harness.merge.compose(MAIN, [PIN_A])).toEqual(
        ok({ kind: "error", reason: "timeout" }),
      );
      expect(harness.fake.steps()).toEqual(["init", "fetch"]);
    });
  });

  it("ends at its deadline when a command answers late, even with success, and releases", async () => {
    // A push the sandbox ran but whose answer arrives after the budget, as the port's grace allows.
    // The delay is kept to wait for that answer to arrive.
    const late: Promise<void>[] = [];
    await withMerge(
      async (harness) => {
        harness.fake.replies.merge = [{ exitCode: 0, stdout: `${CANDIDATE}\n` }];

        const started = Date.now();
        const result = await harness.merge.compose(MAIN, [PIN_A]);
        const elapsed = Date.now() - started;

        expect(result).toEqual(ok({ kind: "error", reason: "timeout" }));
        expect(elapsed).toBeLessThan(SHORT.timeoutMs);
        expect(harness.fake.steps()).toEqual(["init", "fetch", "merge", "push"]);
        await expectReleased(harness);
        // The push's answer, once it arrives, changes nothing.
        expect(late).toHaveLength(1);
        await Promise.all(late);
        await expectReleased(harness);
      },
      {
        clock: Date.now,
        limits: SHORT,
        wrap: (port) => ({
          ...port,
          exec: async (attemptId, command) => {
            const answer = await port.exec(attemptId, command);
            if (!command.command.includes("git push")) return answer;
            const delay = sleep(SHORT.timeoutMs);
            late.push(delay);
            await delay;
            return answer;
          },
        }),
      },
    );
  });

  it("ends at its deadline when a missing commit's lookup answers late, and releases", async () => {
    // The delay is kept to wait for the lookup's answer to arrive.
    const late: Promise<void>[] = [];
    await withMerge(
      async (harness) => {
        harness.fake.replies.fetch = [{ exitCode: 11 }];

        const started = Date.now();
        const result = await harness.merge.compose(MAIN, [PIN_A]);
        const elapsed = Date.now() - started;

        expect(result).toEqual(ok({ kind: "error", reason: "timeout" }));
        expect(elapsed).toBeLessThan(SHORT.timeoutMs);
        await expectReleased(harness);
        expect(late).toHaveLength(1);
        await Promise.all(late);
        await expectReleased(harness);
      },
      {
        clock: Date.now,
        limits: SHORT,
        commitExists: async () => {
          const delay = sleep(SHORT.timeoutMs);
          late.push(delay);
          await delay;
          return ok(false);
        },
      },
    );
  });

  it("gives each step only the seconds left", async () => {
    await withMerge(async (harness) => {
      harness.fake.replies.merge = [{ exitCode: 0, stdout: `${CANDIDATE}\n` }];
      harness.fake.onExec = () => harness.advance(3_000);

      expect(await harness.merge.compose(MAIN, [PIN_A])).toEqual(
        ok({ kind: "clean", candidate: CANDIDATE }),
      );
      const budgets = harness.fake.commands.map(
        (command) => /\+ (\d+) \)\)/.exec(command.command)?.[1],
      );
      // The budget less the release wait: 15 s - 50 ms.
      expect(budgets).toEqual(["14", "11", "8", "5"]);
      expect(harness.fake.commands.map((command) => command.timeoutMs)).toEqual([
        14_950, 11_950, 8_950, 5_950,
      ]);
    });
  });

  it("reports a failed push or an unreadable merge result as infrastructure", async () => {
    await withMerge(async (harness) => {
      harness.fake.replies.merge = [
        { exitCode: 0, stdout: `${CANDIDATE}\n` },
        { exitCode: 0, stdout: "not a commit\n" },
      ];
      harness.fake.replies.push = [{ exitCode: 2 }];
      expect(await harness.merge.compose(MAIN, [PIN_A])).toEqual(
        ok({ kind: "error", reason: "infrastructure" }),
      );
      expect(await harness.merge.compose(MAIN, [PIN_A])).toEqual(
        ok({ kind: "error", reason: "infrastructure" }),
      );
      expect(harness.fake.destroyed).toHaveLength(2);
    });
  });

  it("refuses invalid input before admitting a sandbox", async () => {
    await withMerge(async (harness) => {
      const many = Array.from({ length: MAX_COMPOSE_PINS + 1 }, (_, i) => ({
        ...PIN_A,
        claimId: `clm_pin${String(i).padStart(5, "0")}`,
      }));
      const cases: [string, ClaimPin[]][] = [
        ["A".repeat(40), [PIN_A]],
        [MAIN, []],
        [MAIN, many],
        [MAIN, [{ ...PIN_A, commit: "1".repeat(39) }]],
        [MAIN, [{ ...PIN_A, claimId: "agt_aaaaaa01" }]],
        [MAIN, [{ ...PIN_A, commit: `${"1".repeat(39)}'` }]],
      ];
      for (const [main, pins] of cases) {
        const result = await harness.merge.compose(main, pins);
        expect(result.ok ? null : result.code).toBe("invalid_request");
      }
      for (const attempt of ["chk_attempt9", "mrg_a/b", ""]) {
        const result = await harness.port.compose(MAIN, [PIN_A], attempt);
        expect(result.ok ? null : result.code).toBe("invalid_request");
      }
      expect(harness.fake.policies).toEqual([]);
      expect(harness.fake.commands).toEqual([]);
    });
  });

  it("refuses without a sandbox when the Git remote cannot be found", async () => {
    await withMerge(
      async (harness) => {
        const result = await harness.merge.compose(MAIN, [PIN_A]);
        expect(result.ok ? null : result.code).toBe("unavailable");
        expect(harness.fake.policies).toEqual([]);
      },
      { locate: async () => null },
    );
  });

  it("refuses when the sandbox does not start, and releases its slot", async () => {
    await withMerge(async (harness) => {
      harness.fake.startFails = true;

      const result = await harness.merge.compose(MAIN, [PIN_A]);

      expect(result.ok ? null : result.code).toBe("unavailable");
      expect(harness.fake.commands).toEqual([]);
      await expectReleased(harness);
    });
  });

  it("refuses as busy, and leaves no queued attempt, when every sandbox is taken", async () => {
    await withMerge(async (harness) => {
      for (let n = 0; n < MAX_ACTIVE_SANDBOXES; n += 1) {
        await harness.sandbox.admit(`chk_other${n}00`, otherPolicy(n), 60_000);
      }

      const result = await harness.merge.compose(MAIN, [PIN_A]);

      expect(result.ok ? null : result.code).toBe("busy");
      const slots = await harness.sandbox.slots();
      expect(slots.ok && slots.value.map((slot) => slot.attemptId)).not.toContain("mrg_attempt001");
      expect(harness.fake.commands).toEqual([]);
    });
  });
});

describe("discard", () => {
  const PREFIX = `${CANDIDATE_REF_PREFIX}mrg_attempt9/`;

  it("deletes an attempt's candidate refs from a sandbox that may delete only those", async () => {
    await withMerge(async (harness) => {
      const { fake } = harness;
      fake.replies.discard = [{ exitCode: 0, stdout: "discarded 1\n" }];

      expect(await harness.merge.discard("mrg_attempt9")).toEqual(ok({ removed: 1 }));

      // The sandbox fetches nothing and holds no write grant: only deletes under this prefix.
      expect(fake.policies).toEqual([
        {
          host: HOST,
          namespace: "railhead",
          read: [],
          write: null,
          discard: { repo: MAIN_REPO, refPrefix: PREFIX },
        },
      ]);
      const [command] = fake.commands.map((c) => c.command);
      expect(command).toContain(`'${PREFIX}*:${PREFIX}*'`);
      expect(command).toContain("--prune");
      // Its grant fetches nothing, so the command never lists refs through upload-pack.
      expect(command).not.toContain("ls-remote");
      expect(command).not.toContain("fetch");
      expect(command).not.toContain("refs/heads/main");
      await expectReleased(harness);
    });
  });

  it("runs beside a compose slot of the same attempt that was never freed", async () => {
    await withMerge(async (harness) => {
      // The compose's slot still holds a sandbox under its write grant.
      const held = await harness.sandbox.admit("mrg_attempt9", otherPolicy(9), 60_000);
      expect(held.ok).toBe(true);
      harness.fake.replies.discard = [{ exitCode: 0, stdout: "discarded 1\n" }];

      expect(await harness.merge.discard("mrg_attempt9")).toEqual(ok({ removed: 1 }));
      const slots = await harness.sandbox.slots();
      expect(slots.ok && slots.value.map((slot) => slot.attemptId)).toEqual(["mrg_attempt9"]);
    });
  });

  it("succeeds with nothing removed when the prefix is already empty", async () => {
    await withMerge(async (harness) => {
      harness.fake.replies.discard = [{ exitCode: 0, stdout: "discarded 0\n" }];
      expect(await harness.merge.discard("mrg_attempt9")).toEqual(ok({ removed: 0 }));
    });
  });

  it.each([
    ["a failed step", { exitCode: 2 }],
    ["a step cut by its deadline", { exitCode: 124 }],
    ["output it does not print", { exitCode: 0, stdout: "discarded one\n" }],
  ])("refuses as unavailable after %s, and releases", async (_name, reply) => {
    await withMerge(async (harness) => {
      harness.fake.replies.discard = [reply];
      const result = await harness.merge.discard("mrg_attempt9");
      expect(result.ok ? null : result.code).toBe("unavailable");
      await expectReleased(harness);
    });
  });

  it("refuses an attempt that is not a merge attempt before admitting a sandbox", async () => {
    await withMerge(async (harness) => {
      for (const attempt of ["chk_attempt9", "mrg_", "mrg_../main", "mrg_a/b", "", "mrg_x"]) {
        const result = await harness.merge.discard(attempt);
        expect(result.ok ? null : result.code).toBe("invalid_request");
      }
      expect(harness.fake.policies).toEqual([]);
    });
  });

  it("refuses without a sandbox when the Git remote cannot be found", async () => {
    await withMerge(
      async (harness) => {
        const result = await harness.merge.discard("mrg_attempt9");
        expect(result.ok ? null : result.code).toBe("unavailable");
        expect(harness.fake.policies).toEqual([]);
      },
      { locate: async () => null },
    );
  });

  it("refuses as busy when every sandbox is taken", async () => {
    await withMerge(async (harness) => {
      for (let n = 0; n < MAX_ACTIVE_SANDBOXES; n += 1) {
        await harness.sandbox.admit(`chk_other${n}00`, otherPolicy(n), 60_000);
      }
      const result = await harness.merge.discard("mrg_attempt9");
      expect(result.ok ? null : result.code).toBe("busy");
      expect(harness.fake.commands).toEqual([]);
    });
  });

  it("stops publishing within the window after which the train discards", () => {
    expect(MERGE_TIMEOUT_MS + MERGE_SANDBOX_LIFETIME_MS).toBeLessThanOrEqual(MERGE_PUSH_WINDOW_MS);
  });
});

describe("merge script", () => {
  it("builds a discard only for one candidate prefix", () => {
    const url = remoteUrl(LOCATION, MAIN_REPO);
    expect(discardCommand(url, `${CANDIDATE_REF_PREFIX}mrg_x1/`, 5)).toContain("--prune");
    for (const prefix of [
      "refs/heads/",
      CANDIDATE_REF_PREFIX,
      `${CANDIDATE_REF_PREFIX}mrg_x1`,
      `${CANDIDATE_REF_PREFIX}a/b/`,
      `${CANDIDATE_REF_PREFIX}x'y/`,
    ]) {
      expect(() => discardCommand(url, prefix, 5)).toThrow();
    }
  });

  it("reads how many refs a discard deleted", () => {
    expect(parseDiscarded("discarded 0\n")).toBe(0);
    expect(parseDiscarded("discarded 12\n")).toBe(12);
    expect(parseDiscarded("discarded 01\n")).toBeNull();
    expect(parseDiscarded("discarded 1")).toBeNull();
    expect(parseDiscarded("")).toBeNull();
  });

  it("builds remotes only from names the policy accepts", () => {
    expect(remoteUrl(LOCATION, "rh-f-x")).toBe(`https://${HOST}/git/railhead/rh-f-x.git`);
    expect(() => remoteUrl(LOCATION, "a b")).toThrow();
    expect(() => remoteUrl({ ...LOCATION, host: "evil/host" }, "r")).toThrow();
    expect(() => remoteUrl({ ...LOCATION, namespace: "" }, "r")).toThrow();
  });

  it("reads a remote URL only for the repository it names", () => {
    expect(parseRemote(`https://${HOST}/git/railhead/${MAIN_REPO}.git`, MAIN_REPO)).toEqual(
      LOCATION,
    );
    expect(parseRemote(`https://${HOST}/git/railhead/other.git`, MAIN_REPO)).toBeNull();
    expect(parseRemote(`http://${HOST}/git/railhead/${MAIN_REPO}.git`, MAIN_REPO)).toBeNull();
    expect(parseRemote(`https://u@${HOST}/git/railhead/${MAIN_REPO}.git`, MAIN_REPO)).toBeNull();
    expect(parseRemote("", MAIN_REPO)).toBeNull();
  });

  it("refuses to build a command with an unchecked value", () => {
    const target = { url: remoteUrl(LOCATION, "r"), commit: MAIN };
    expect(() => fetchCommand([target, { ...target, commit: "HEAD" }], 16, 10)).toThrow();
    expect(() => fetchCommand([target, target], 0, 10)).toThrow();
    expect(() => fetchCommand([target], 16, 10)).toThrow();
    expect(() => fetchCommand([target, target], 16, 0)).toThrow();
    expect(() => pushCommand(target.url, CANDIDATE, "refs/heads/main", 10)).toThrow();
    expect(() => pushCommand(target.url, CANDIDATE, "refs/heads/candidate/../main", 10)).toThrow();
  });

  it("builds a regions command only for a checked nonce and object IDs", () => {
    const blobs = { base: OID(1), ours: OID(2), theirs: OID(3) };
    const nonce = "0123456789abcdef";
    expect(regionsCommand(nonce, [blobs], 5)).toContain(`regions 0 ${OID(1)} ${OID(2)} ${OID(3)}`);
    for (const bad of ["short", "0123456789ABCDEF", "0123456789abcdef'x", ""]) {
      expect(() => regionsCommand(bad, [blobs], 5)).toThrow();
    }
    expect(() => regionsCommand(nonce, [{ ...blobs, ours: "HEAD" }], 5)).toThrow();
  });

  it("reads regions whose text holds marker-like lines without the nonce", () => {
    const nonce = "0123456789abcdef";
    const forged: Sides = {
      base: "<<<<<<< 0123456789abcdee\n",
      ours: `${nonce} end\n>>>>>>> other\n`,
      theirs: "||||||| x\n",
    };
    expect(parseRegions(printedRegions(nonce, [[forged, SIDES]]), nonce, 1)).toEqual([
      { file: 0, ...forged },
      { file: 0, ...SIDES },
    ]);
    // CRLF marker lines, as Git writes them in a file that uses CRLF.
    const crlf = printedRegions(nonce, [[SIDES]]).replace(
      /(<{7}|\|{7}|={7}|>{7})( [a-z0-9]+)?\n/g,
      "$1$2\r\n",
    );
    expect(parseRegions(crlf, nonce, 1)).toEqual([{ file: 0, ...SIDES }]);
  });

  it("rejects regions output that is opaque, incomplete or not what the command prints", () => {
    const nonce = "0123456789abcdef";
    const good = printedRegions(nonce, [[SIDES], [SIDES]]);
    expect(parseRegions(good, nonce, 2)).toHaveLength(2);
    expect(parseRegions(good, nonce, 3)).toBeNull();
    expect(parseRegions(good, "fedcba9876543210", 2)).toBeNull();
    expect(parseRegions(printedRegions(nonce, [[SIDES], "opaque"]), nonce, 2)).toBeNull();
    expect(parseRegions(printedRegions(nonce, [[], [SIDES]]), nonce, 2)).toBeNull();
    expect(parseRegions(printedRegions(nonce, [[SIDES], []]), nonce, 2)).toBeNull();
    expect(parseRegions(good.replace(`${nonce} end\n`, ""), nonce, 2)).toBeNull();
    expect(
      parseRegions(good.replace(`>>>>>>> ${nonce}\n${nonce} end`, `${nonce} end`), nonce, 2),
    ).toBeNull();
    expect(parseRegions(good.replace(`${nonce} file 1`, `${nonce} file 2`), nonce, 2)).toBeNull();
    expect(parseRegions("", nonce, 0)).toBeNull();
  });

  it("parses unmerged entries whose paths hold newlines and status-like text", () => {
    const tricky = "x\npartner none\n";
    expect(parsePartner(`partner 3\n${textConflict(tricky, 1)}`)).toEqual({
      kind: "partner",
      index: 3,
      entries: [1, 2, 3].map((stage) => ({
        mode: "100644",
        object: OID(stage),
        stage,
        path: tricky,
      })),
    });
    expect(parsePartner("partner none\n")).toEqual({ kind: "none" });
  });

  it("rejects partner output that is not what the command prints", () => {
    expect(parsePartner("")).toBeNull();
    expect(parsePartner("partner 01\n")).toBeNull();
    expect(parsePartner(`partner 1\n${textConflict("a", 1).slice(0, -1)}`)).toBeNull();
    expect(parsePartner(`partner 1\n100644 ${OID(1)} 4\ta\0`)).toBeNull();
    expect(parsePartner(`junk\npartner 1\n`)).toBeNull();
  });

  it("reads binary pairs and refuses a count or order that does not match", () => {
    const text = `0\t2\t1\t${OID(1)} => ${OID(2)}\n`;
    const binary = `1\t-\t-\t${OID(3)} => ${OID(4)}\n`;
    expect(parseBinary(text + binary, 2)).toEqual(new Set([1]));
    expect(parseBinary("0\t\n", 1)).toEqual(new Set());
    expect(parseBinary(text, 2)).toBeNull();
    expect(parseBinary(binary + text, 2)).toBeNull();
    expect(parseBinary(text.trimEnd(), 1)).toBeNull();
  });

  it("reads exactly one commit", () => {
    expect(parseCommit(`${CANDIDATE}\n`)).toBe(CANDIDATE);
    expect(parseCommit(`${CANDIDATE}\n${CANDIDATE}\n`)).toBeNull();
    expect(parseCommit("")).toBeNull();
  });
});
