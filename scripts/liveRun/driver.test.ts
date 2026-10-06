import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { loadManifest } from "../demoSeed/manifest.ts";
import { bootstrapToken, parseOptions, start, TOKEN_ENV } from "./cli.ts";
import {
  agentName,
  drive,
  DriverRefusal,
  fingerprintOf,
  StepFailure,
  type DriverDeps,
  type DriverLimits,
  type DriverOptions,
  type ProcessSpec,
  type Running,
} from "./driver.ts";
import { BOOTSTRAP_TOKEN, FakeInstance, fingerprint, HOST, ORIGIN } from "./fakeInstance.ts";

const root = join(import.meta.dirname, "..", "..");
const manifest = loadManifest(join(root, "fixtures", "demo", "seed.json"));
const scratch = mkdtempSync(join(tmpdir(), "railhead-live-run-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const RH = "/fake/rh";
const SWARM = "/fake/railhead-swarm";
const QUALIFY = "/fake/qualify-slice.mjs";

const LIMITS: DriverLimits = {
  callMs: 5_000,
  joinStartMs: 2_000,
  joinMs: 2_000,
  pollMs: 5,
  swarmMs: 2_000,
  qualifyMs: 2_000,
};

const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Someone",
  GIT_AUTHOR_EMAIL: "someone@example.com",
  GIT_COMMITTER_NAME: "Someone",
  GIT_COMMITTER_EMAIL: "someone@example.com",
};

/** A source repository holding this checkout's demo app and what the seed reads, in one commit. */
function sourceRepo(): string {
  const source = join(scratch, "source");
  for (const path of [
    "demo/upload-app",
    "fixtures/demo/seed.json",
    "fixtures/demo/standalone",
    "scripts/assert-workerd.ts",
  ]) {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    cpSync(join(root, path), join(source, path), {
      recursive: true,
      filter: (from) => !["node_modules", ".wrangler"].includes(basename(from)),
    });
  }
  cpSync(join(root, ".node-version"), join(source, ".node-version"));
  const git = (args: string[]): void => {
    execFileSync("git", ["-C", source, "-c", "commit.gpgsign=false", ...args], { env: gitEnv });
  };
  git(["init", "--quiet"]);
  git(["add", "--all"]);
  git(["commit", "--quiet", "-m", "feat: add the app"]);
  return source;
}

const source = sourceRepo();

/** How the fake `rh join` behaves. */
type JoinMode = "honest" | "registers-another-key";

/** What the fake processes saw. */
interface Calls {
  readonly rh: ProcessSpec[];
  readonly swarm: ProcessSpec[];
  readonly qualify: ProcessSpec[];
}

/** A run's world: the instance, the run directory, the processes and what was printed. */
interface World {
  readonly instance: FakeInstance;
  readonly options: DriverOptions;
  readonly calls: Calls;
  readonly lines: string[];
  deps(overrides?: { join?: JoinMode; swarmExit?: number; gateExit?: number }): DriverDeps;
}

let worlds = 0;

function world(instance = new FakeInstance()): World {
  worlds += 1;
  const dir = join(scratch, `world-${worlds}`);
  mkdirSync(dir);
  const binding = join(dir, "binding.json");
  writeFileSync(binding, "{}\n");
  const options: DriverOptions = {
    origin: ORIGIN,
    ownerKey: join(dir, "owner-key.json"),
    agents: 3,
    revision: "HEAD",
    sourceRoot: source,
    binding,
    runDir: join(dir, "run"),
    rh: RH,
    swarm: SWARM,
    qualify: QUALIFY,
  };
  const calls: Calls = { rh: [], swarm: [], qualify: [] };
  const lines: string[] = [];
  return {
    instance,
    options,
    calls,
    lines,
    deps: (overrides = {}) => ({
      openSession: (origin) => {
        assert.equal(origin, ORIGIN);
        return instance.session();
      },
      start: (spec) => {
        switch (spec.command) {
          case RH:
            calls.rh.push(spec);
            return fakeJoin(instance, spec, overrides.join ?? "honest");
          case SWARM:
            calls.swarm.push(spec);
            return fakeSwarm(spec, overrides.swarmExit ?? 0);
          case process.execPath:
            calls.qualify.push(spec);
            return fakeQualify(spec, overrides.gateExit ?? 0);
          default:
            throw new Error(`unexpected process ${spec.command}`);
        }
      },
      bootstrapToken: () => BOOTSTRAP_TOKEN,
      log: (line) => lines.push(line),
      limits: LIMITS,
    }),
  };
}

function exited(code: number | null, stdout = ""): Running {
  return { exited: Promise.resolve({ code, stdout }), kill: () => {} };
}

/** `bytes` as an SSH wire string: its length, then the bytes. */
function sshField(bytes: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** `ssh-ed25519 <base64>` for a new key. */
function sshPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const blob = Buffer.concat([sshField(Buffer.from("ssh-ed25519")), sshField(raw)]);
  return `ssh-ed25519 ${blob.toString("base64")}`;
}

function arg(spec: ProcessSpec, flag: string): string {
  const value = spec.args[spec.args.indexOf(flag) + 1];
  assert.ok(spec.args.includes(flag) && value !== undefined, `${flag} missing`);
  return value;
}

/**
 * `rh join` as the driver runs it: it stores the enrollment and the identity in its home, joins
 * the instance and waits until the owner confirms the agent, then stores a session and exits 0.
 * With `registers-another-key` the instance receives a key other than the one the home holds.
 */
function fakeJoin(instance: FakeInstance, spec: ProcessSpec, mode: JoinMode): Running {
  const home = spec.env.RAILHEAD_HOME;
  const invite = spec.env.RAILHEAD_INVITE;
  assert.ok(home !== undefined && invite !== undefined);
  // The invite's secret never reaches the command line.
  assert.ok(spec.args.every((a) => !a.includes(invite) && !a.includes("#")));
  const name = arg(spec, "--name");
  const entry = join(home, "agents", name);
  mkdirSync(entry, { recursive: true, mode: 0o700 });
  const publicKey = sshPublicKey();
  writeFileSync(join(entry, "key"), "a private key\n", { mode: 0o600 });
  const inviteId = new URL(invite).pathname.split("/").at(-1);
  writeFileSync(
    join(entry, "enrollment.json"),
    JSON.stringify({ origin: ORIGIN, repo: "demo/upload-app", inviteId, publicKey }),
  );
  const registered = mode === "honest" ? publicKey : sshPublicKey();
  const { agentId } = instance.join(invite, registered);
  writeFileSync(
    join(entry, "identity.json"),
    JSON.stringify({ name, agentId, origin: ORIGIN, repo: "demo/upload-app" }),
  );
  const state = { killed: false };
  const done = (async () => {
    while (!state.killed) {
      if (instance.confirmed(agentId)) {
        rmSync(join(entry, "enrollment.json"));
        writeFileSync(join(entry, "session"), "a session\n", { mode: 0o600 });
        return { code: 0, stdout: JSON.stringify({ ok: true, data: { agentId } }) };
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return { code: null, stdout: "" };
  })();
  return {
    exited: done,
    kill: () => {
      state.killed = true;
    },
  };
}

/** `railhead-swarm` keeping one clone per agent in `--clones-dir`. */
function fakeSwarm(spec: ProcessSpec, code: number): Running {
  const clones = arg(spec, "--clones-dir");
  const scenario: unknown = JSON.parse(readFileSync(arg(spec, "--scenario"), "utf8"));
  assert.ok(typeof scenario === "object" && scenario !== null && "agents" in scenario);
  const { agents } = scenario;
  assert.ok(typeof agents === "number");
  for (let index = 0; index < agents; index += 1) {
    const name = agentName(index);
    assert.ok(existsSync(join(arg(spec, "--homes"), name, "agents", name, "identity.json")));
    mkdirSync(join(clones, name, `upload-app-clm_${index}`), { recursive: true });
  }
  assert.ok(spec.stdoutFile !== undefined);
  writeFileSync(spec.stdoutFile, '{"type":"summary","simulated":true}\n');
  return exited(code);
}

/** `qualify-slice.mjs slice` writing its report, and `gate` exiting with `gateExit`. */
function fakeQualify(spec: ProcessSpec, gateExit: number): Running {
  assert.equal(spec.args[0], QUALIFY);
  if (spec.args[1] === "slice") {
    writeFileSync(arg(spec, "--out"), '{"kind":"slice"}\n');
    return exited(0);
  }
  assert.equal(spec.args[1], "gate");
  if (spec.stdoutFile !== undefined) writeFileSync(spec.stdoutFile, "gate output\n");
  return exited(gateExit);
}

/** Every title the board's log holds for a filed issue, in order. */
function filedTitles(instance: FakeInstance): string[] {
  return instance.backend.events.flatMap((event) =>
    event.type === "issue.filed" ? [event.data.title] : [],
  );
}

/** Text no output line may hold: invite URLs and secrets, join codes and the owner's private key. */
function secrets(w: World): string[] {
  const invites = [...w.instance.invites].flatMap(([id, { secret }]) => [secret, `${id}#`]);
  const codes = w.instance.joins.map((entry) => entry.code);
  const key: unknown = JSON.parse(readFileSync(w.options.ownerKey, "utf8"));
  assert.ok(typeof key === "object" && key !== null && "privateKey" in key);
  const { privateKey } = key;
  assert.ok(typeof privateKey === "object" && privateKey !== null && "d" in privateKey);
  assert.ok(typeof privateKey.d === "string");
  return [...invites, ...codes, privateKey.d, BOOTSTRAP_TOKEN];
}

test("a run enrolls, seeds, files, invites, joins, runs the swarm and prints the gate verdict", async () => {
  const w = world();
  const verdict = await drive(w.options, w.deps());

  assert.deepEqual(verdict, {
    passed: true,
    binding: w.options.binding,
    slice: join(w.options.runDir, "reports", "run-1", "slice.json"),
  });
  assert.ok(w.instance.owner !== null);
  assert.ok(w.instance.backend.main !== null);
  assert.deepEqual(w.instance.backend.performed, ["demo.seed"]);
  assert.deepEqual(
    filedTitles(w.instance),
    manifest.issues.map((issue) => issue.title),
  );
  assert.deepEqual(
    [...w.instance.invites.values()].map((invite) => invite.name),
    ["swarm-00", "swarm-01", "swarm-02"],
  );
  assert.ok(w.instance.joins.every((entry) => entry.confirmed));
  assert.deepEqual(w.instance.performed, [
    "issue.file",
    "issue.file",
    "issue.file",
    "invite.create",
    "invite.create",
    "invite.create",
    "agent.confirm",
    "agent.confirm",
    "agent.confirm",
  ]);

  // The swarm ran on the joined homes and kept its clones for the harness.
  const [swarm] = w.calls.swarm;
  assert.ok(swarm !== undefined);
  assert.equal(arg(swarm, "--homes"), join(w.options.runDir, "homes"));
  assert.equal(arg(swarm, "--rh"), RH);
  const scenario: unknown = JSON.parse(readFileSync(arg(swarm, "--scenario"), "utf8"));
  assert.deepEqual(scenario, {
    seed: 348,
    origin: ORIGIN,
    repository: "demo/upload-app",
    agents: 3,
    rounds: 1,
    mix: { disjoint: 1, sameFileHunks: 0, overlapping: 0 },
  });

  const [slice, gate] = w.calls.qualify;
  assert.ok(slice !== undefined && gate !== undefined);
  const clones = ["swarm-00", "swarm-01", "swarm-02"].map((name, index) =>
    join(w.options.runDir, "clones", "run-1", name, `upload-app-clm_${index}`),
  );
  assert.deepEqual(slice.args, [
    QUALIFY,
    "slice",
    "--origin",
    ORIGIN,
    "--repo",
    "demo/upload-app",
    ...clones.flatMap((clone) => ["--clone", clone]),
    "--out",
    join(w.options.runDir, "reports", "run-1", "slice.json"),
  ]);
  // The harness's credential helper reads every agent from one home of copied store entries.
  const sliceHome = slice.env.RAILHEAD_HOME;
  assert.equal(sliceHome, join(w.options.runDir, "slice-home"));
  for (const name of ["swarm-00", "swarm-01", "swarm-02"]) {
    const entry = join(sliceHome, "agents", name);
    assert.deepEqual(readdirSync(entry).toSorted(), ["identity.json", "key", "session"]);
    assert.equal(statSync(entry).mode & 0o777, 0o700);
    assert.equal(statSync(join(entry, "key")).mode & 0o777, 0o600);
  }
  assert.deepEqual(gate.args, [
    QUALIFY,
    "gate",
    "--origin",
    ORIGIN,
    w.options.binding,
    join(w.options.runDir, "reports", "run-1", "slice.json"),
  ]);

  const printed = w.lines.join("\n");
  for (const secret of secrets(w)) assert.ok(!printed.includes(secret));
});

test("a rerun files, invites and confirms nothing twice", async () => {
  const w = world();
  await drive(w.options, w.deps());
  const performed = [...w.instance.performed];
  const enrollments = w.instance.enrollmentsPrepared;

  const verdict = await drive(w.options, w.deps());

  assert.equal(verdict.passed, true);
  // The gate judges the slice report this run wrote, never the first run's.
  const report = join(w.options.runDir, "reports", "run-2", "slice.json");
  assert.equal(verdict.slice, report);
  const [slice, gate] = w.calls.qualify.slice(-2);
  assert.ok(slice !== undefined && gate !== undefined);
  assert.equal(arg(slice, "--out"), report);
  assert.equal(gate.args.at(-1), report);
  assert.equal(w.instance.enrollmentsPrepared, enrollments);
  assert.deepEqual(w.instance.backend.performed, ["demo.seed"]);
  assert.deepEqual(w.instance.performed, performed);
  assert.equal(filedTitles(w.instance).length, 3);
  assert.equal(w.instance.invites.size, 3);
  assert.equal(w.calls.rh.length, 3);
  assert.ok(w.lines.some((line) => /^enroll: .* is already the owner of /.test(line)));
  assert.equal(w.lines.filter((line) => line.endsWith("is already filed; skipped")).length, 3);
  assert.equal(w.lines.filter((line) => line.endsWith("has joined; skipped")).length, 3);
});

test("a rerun after a failed step goes on from where it stopped", async () => {
  const w = world();
  await assert.rejects(drive(w.options, w.deps({ swarmExit: 1 })), StepFailure);
  const performed = [...w.instance.performed];

  const verdict = await drive(w.options, w.deps());

  assert.equal(verdict.passed, true);
  assert.deepEqual(w.instance.performed, performed);
  // Each swarm run keeps its clones apart, and the slice reads the latest run's.
  const [first, second] = w.calls.swarm;
  assert.ok(first !== undefined && second !== undefined);
  assert.equal(arg(first, "--clones-dir"), join(w.options.runDir, "clones", "run-1"));
  assert.equal(arg(second, "--clones-dir"), join(w.options.runDir, "clones", "run-2"));
  const slice = w.calls.qualify.at(-2);
  assert.ok(slice !== undefined);
  assert.equal(
    arg(slice, "--clone"),
    join(w.options.runDir, "clones", "run-2", "swarm-00", "upload-app-clm_0"),
  );
});

test("a join whose key fingerprint differs from the home's key is refused, not confirmed", async () => {
  const w = world();
  const failure = await drive(w.options, w.deps({ join: "registers-another-key" })).then(
    () => assert.fail("the run passed"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof StepFailure);
  assert.equal(failure.step, "join");
  assert.match(
    failure.message,
    /has key SHA256:.*, not the key .* registered .*; not confirmed\.$/,
  );
  assert.ok(!w.instance.performed.includes("agent.confirm"));
  assert.ok(w.instance.joins.every((entry) => !entry.confirmed));
  assert.equal(w.calls.swarm.length, 0);
});

test("a pending join the driver did not start is never confirmed", async () => {
  const instance = new FakeInstance();
  const w = world(instance);
  // Someone else joins with an invite of their own once the instance is seeded and filed.
  const deps = w.deps();
  const foreign: { agentId?: string } = {};
  const startProcess = deps.start;
  deps.start = (spec) => {
    if (spec.command === RH && foreign.agentId === undefined) {
      const [, other] = [...instance.invites.keys()];
      assert.ok(other !== undefined);
      // The second invite's agent joins before the driver runs its `rh join`, with another key.
      foreign.agentId = instance.join(
        `${ORIGIN}/join/demo/upload-app/${other}#${instance.invites.get(other)?.secret ?? ""}`,
        sshPublicKey(),
      ).agentId;
    }
    return startProcess(spec);
  };
  const failure = await drive(w.options, deps).then(
    () => assert.fail("the run passed"),
    (error: unknown) => error,
  );
  assert.ok(foreign.agentId !== undefined);
  assert.equal(instance.confirmed(foreign.agentId), false);
  // The driver's own first agent was confirmed; the second's invite was spent by the stranger.
  assert.ok(failure instanceof StepFailure);
  assert.equal(failure.step, "join");
  assert.equal(instance.joins.filter((entry) => entry.confirmed).length, 1);
});

test("railhead.dev and its subdomains are refused before anything is sent", async () => {
  for (const origin of [
    "https://railhead.dev",
    "https://board.railhead.dev",
    "https://railhead.dev.",
  ]) {
    const w = world();
    let opened = 0;
    const deps = w.deps();
    const failure = await drive(
      { ...w.options, origin },
      {
        ...deps,
        openSession: (o) => {
          opened += 1;
          return deps.openSession(o);
        },
      },
    ).then(
      () => assert.fail("the run passed"),
      (error: unknown) => error,
    );
    assert.ok(failure instanceof DriverRefusal);
    assert.match(failure.message, /never acts on .*railhead\.dev|must not end its host with a dot/);
    assert.equal(opened, 0);
    assert.ok(!existsSync(w.options.ownerKey));
  }
});

test("a failed step stops the run and names the step", async () => {
  const wrongToken = world();
  const failure = await drive(wrongToken.options, {
    ...wrongToken.deps(),
    bootstrapToken: () => "not-the-token",
  }).then(
    () => assert.fail("the run passed"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof StepFailure);
  assert.equal(failure.step, "enroll");
  assert.match(failure.message, /bootstrap_closed/);
  assert.equal(wrongToken.instance.backend.performed.length, 0);

  const swarmFails = world();
  const stopped = await drive(swarmFails.options, swarmFails.deps({ swarmExit: 1 })).then(
    () => assert.fail("the run passed"),
    (error: unknown) => error,
  );
  assert.ok(stopped instanceof StepFailure);
  assert.equal(stopped.step, "swarm");
  assert.match(stopped.message, /^railhead-swarm exited with 1; its events are in /);
  assert.equal(swarmFails.calls.qualify.length, 0);
});

test("a key that is not the instance's owner is refused at enroll", async () => {
  const first = world();
  await drive(first.options, first.deps());
  const second = world();
  await drive(second.options, second.deps());
  const performed = [...second.instance.performed];

  const failure = await drive(
    { ...second.options, ownerKey: first.options.ownerKey },
    second.deps(),
  ).then(
    () => assert.fail("the run passed"),
    (error: unknown) => error,
  );

  assert.ok(failure instanceof StepFailure);
  assert.equal(failure.step, "enroll");
  assert.match(failure.message, /is not the owner of railhead\.mashin\.workers\.dev/);
  assert.deepEqual(second.instance.performed, performed);
});

test("a gate failure is a verdict, printed with both reports", async () => {
  const w = world();
  const verdict = await drive(w.options, w.deps({ gateExit: 1 }));
  assert.deepEqual(verdict, {
    passed: false,
    binding: w.options.binding,
    slice: join(w.options.runDir, "reports", "run-1", "slice.json"),
  });
  assert.equal(
    readFileSync(join(w.options.runDir, "reports", "run-1", "gate.txt"), "utf8"),
    "gate output\n",
  );
});

test("a home holding an unfinished join stops the run at invite", async () => {
  const w = world();
  const entry = join(w.options.runDir, "homes", "swarm-01", "agents", "swarm-01");
  mkdirSync(entry, { recursive: true });
  writeFileSync(join(entry, "enrollment.json"), "{}");
  const failure = await drive(w.options, w.deps()).then(
    () => assert.fail("the run passed"),
    (error: unknown) => error,
  );
  assert.ok(failure instanceof StepFailure);
  assert.equal(failure.step, "invite");
  assert.match(failure.message, /holds an unfinished join of swarm-01; remove that directory/);
  assert.equal(w.instance.invites.size, 0);
});

test("fingerprintOf matches the backend's form and refuses another key type", () => {
  const key = sshPublicKey();
  assert.equal(fingerprintOf(key), fingerprint(key));
  assert.match(fingerprintOf(key), /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.throws(() => fingerprintOf("ssh-rsa AAAA"), /not an ssh-ed25519 key/);
});

function assertRefused(args: string[], pattern: RegExp): void {
  assert.throws(
    () => parseOptions(args),
    (error: unknown) => {
      assert.ok(error instanceof DriverRefusal);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

test("parseOptions refuses a bad origin, agent count or run directory", () => {
  const binding = join(scratch, "binding.json");
  writeFileSync(binding, "{}\n");
  const base = ["--owner-key", join(scratch, "k.json"), "--binding", binding];
  const run = ["--run-dir", join(scratch, "run")];
  assertRefused(
    [...base, ...run, "--origin", "https://railhead.dev", "--agents", "3"],
    /never acts on/,
  );
  assertRefused(
    [...base, ...run, "--origin", "http://example.com", "--agents", "3"],
    /https origin/,
  );
  assertRefused([...base, ...run, "--origin", ORIGIN, "--agents", "0"], /from 3 to 64/);
  assertRefused([...base, ...run, "--origin", ORIGIN, "--agents", "2"], /from 3 to 64/);
  assertRefused([...base, ...run, "--origin", ORIGIN, "--agents", "3.5"], /from 3 to 64/);
  assertRefused(
    [...base, "--origin", ORIGIN, "--agents", "3", "--run-dir", join(root, "run")],
    /inside the Git checkout/,
  );
  assertRefused(
    ["--origin", ORIGIN, "--owner-key", "k", "--agents", "3"],
    /--binding FILE is required/,
  );
  assertRefused([...base, ...run, "--origin", ORIGIN, "--agents", "3", "--bogus"], /bogus/);

  const options = parseOptions([...base, ...run, "--origin", `${ORIGIN}/`, "--agents", "3"]);
  assert.equal(options.origin, ORIGIN);
  assert.equal(options.agents, 3);
  assert.equal(new URL(options.origin).hostname, HOST);
});

test("the bootstrap token comes from its file, else the environment, and is required", () => {
  const file = join(scratch, "token");
  writeFileSync(file, "from-file\n");
  assert.equal(bootstrapToken(file, { [TOKEN_ENV]: "from-env" }), "from-file");
  assert.equal(bootstrapToken(undefined, { [TOKEN_ENV]: "from-env" }), "from-env");
  assert.throws(() => bootstrapToken(undefined, {}), /--bootstrap-token FILE or set/);
  assert.throws(() => bootstrapToken(undefined, { [TOKEN_ENV]: "  " }), /bootstrap token/);
});

test("start keeps a child's output, or writes it to a private file, and reports its exit", async () => {
  const kept = start({
    command: process.execPath,
    args: ["-e", "process.stdout.write(process.env.LIVE_RUN_TEST ?? ''); process.exit(3)"],
    env: { LIVE_RUN_TEST: "from the driver" },
    stderr: "discard",
  });
  assert.deepEqual(await kept.exited, { code: 3, stdout: "from the driver" });

  const file = join(scratch, "start-output.txt");
  const written = start({
    command: process.execPath,
    args: ["-e", "process.stdout.write('to the file')"],
    env: {},
    stdoutFile: file,
    stderr: "discard",
  });
  assert.deepEqual(await written.exited, { code: 0, stdout: "" });
  assert.equal(readFileSync(file, "utf8"), "to the file");
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const missing = start({
    command: join(scratch, "no-such-binary"),
    args: [],
    env: {},
    stderr: "discard",
  });
  assert.deepEqual(await missing.exited, { code: null, stdout: "" });

  const endless = start({
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    env: {},
    stderr: "discard",
  });
  endless.kill();
  assert.deepEqual(await endless.exited, { code: null, stdout: "" });
});
