import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { ClaimPin } from "../src/contracts/claims";
import { fail, ok, type PortResult } from "../src/contracts/result";
import type { MergePort } from "../src/contracts/train";
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
  createMerge,
  type MergeDeps,
} from "../src/train/merge/compose";
import {
  fetchCommand,
  parseBinary,
  parseCommit,
  parsePartner,
  parseRemote,
  pushCommand,
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
type StepName = "init" | "fetch" | "merge" | "partner" | "binary" | "push";

function stepOf(command: string): StepName {
  if (command.includes("git init")) return "init";
  if (command.includes("git fetch")) return "fetch";
  if (command.includes("try_partner")) return "partner";
  if (command.includes("git diff --numstat")) return "binary";
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
      const reply = queue.length > 1 ? queue.shift() : queue[0];
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

interface Harness {
  merge: MergePort;
  fake: ScriptedDriver;
  sandbox: SandboxPort;
  advance: (ms: number) => void;
  exists: { calls: string[] };
}

type Overrides = Partial<Pick<MergeDeps, "locate" | "commitExists">>;

/** Runs `body` with a merge port over a sandbox port in a fresh Durable Object's storage. */
function withMerge(body: (harness: Harness) => Promise<void>, overrides: Overrides = {}) {
  const stub = env.REPO.getByName(crypto.randomUUID());
  return runInDurableObject(stub, async (_instance, state) => {
    let now = 1_000_000;
    const clock = () => now;
    const fake = new ScriptedDriver();
    const sandbox = createSandboxPort(new SlotTable(state.storage), {
      driver: fake.driver,
      clock,
      timeouts: { startMs: 50, destroyMs: 50, execGraceMs: 50 },
    });
    const exists = { calls: [] as string[] };
    let attempts = 0;
    const merge = createMerge({
      sandbox: () => sandbox,
      locate: async () => LOCATION,
      mainRepo: async () => MAIN_REPO,
      forkRepo: async (claimId) => `rh-f-${claimId.slice(4)}`,
      commitExists: async (repo, commit) => {
        exists.calls.push(`${repo}@${commit}`);
        return ok(false);
      },
      clock,
      attemptId: () => `mrg_attempt${String((attempts += 1)).padStart(3, "0")}`,
      limits: { timeoutMs: 15_000, releaseWaitMs: 50 },
      ...overrides,
    });
    await body({ merge, fake, sandbox, advance: (ms) => (now += ms), exists });
  });
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
      // The policy reads the forks and writes only the attempt's candidate refs of main.
      expect(fake.policies).toEqual([
        {
          host: HOST,
          namespace: "railhead",
          read: ["rh-f-aaaaaa01", "rh-f-bbbbbb02"],
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

      const result = await harness.merge.compose(MAIN, [PIN_C, PIN_A, PIN_B]);

      expect(result).toEqual(
        ok({ kind: "conflict", pins: [PIN_A, PIN_B], paths: ["src/app.ts", "a\nb"] }),
      );
      expect(fake.steps()).toEqual(["init", "fetch", "merge", "partner", "binary"]);
      const partner = fake.commands[3]?.command ?? "";
      // Partners are main, then each earlier pin, in order.
      expect(partner).toContain(`try_partner 0 ${MAIN} ${PIN_B.commit}`);
      expect(partner).toContain(`try_partner 2 ${PIN_A.commit} ${PIN_B.commit}`);
      expect(fake.commands.some((command) => command.command.includes("git push"))).toBe(false);
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

  it("reports a failed fetch of a commit that exists, or cannot be checked, as infrastructure", async () => {
    for (const answer of [ok(true), fail("unavailable", "no artifacts")]) {
      await withMerge(
        async (harness) => {
          harness.fake.replies.fetch = [{ exitCode: 10 }];
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

  it("gives each step only the seconds left", async () => {
    await withMerge(async (harness) => {
      harness.fake.replies.merge = [{ exitCode: 0, stdout: `${CANDIDATE}\n` }];
      harness.fake.onExec = () => harness.advance(4_000);

      expect(await harness.merge.compose(MAIN, [PIN_A])).toEqual(
        ok({ kind: "clean", candidate: CANDIDATE }),
      );
      const budgets = harness.fake.commands.map(
        (command) => /\+ (\d+) \)\)/.exec(command.command)?.[1],
      );
      expect(budgets).toEqual(["15", "11", "7", "3"]);
      expect(harness.fake.commands.map((command) => command.timeoutMs)).toEqual([
        15_000, 11_000, 7_000, 3_000,
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

describe("merge script", () => {
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
