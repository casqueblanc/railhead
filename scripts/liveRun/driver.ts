// The live slice driver behind `pnpm live-run`: every owner step of the three-agent slice on a
// qualification instance, signed with the software owner key (`scripts/ownerKey/`), then the swarm
// and the qualification harness. It runs the steps in order and stops at the first failure, naming
// the step.
//
// A rerun repeats nothing that already happened: a key file that exists is not enrolled again, the
// seed reads main first, an issue already filed under its title is not filed again, and an agent
// whose home already holds its joined identity gets no invite and no join. An owner write whose
// answer is lost is never repeated here; the next run reads the instance first.
//
// The driver confirms only a join it started: the pending join must name the agent id `rh join`
// stored in the driver's own home for that agent, the agent's name, the invite the driver created
// for it, and the fingerprint of the key that home registered. Anything else is refused, not
// confirmed.
//
// Nothing here prints a token, a key, an invite URL or a join code. `rh join` gets the invite in
// `RAILHEAD_INVITE`, never on its command line, and its output, which holds the code, is read for
// its error code alone; its diagnostics are discarded. Every wait is bounded by `DriverLimits`.

import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { RepoSegment } from "../../packages/railhead-shared/src/agent-api.ts";
import type {
  ActionChallenge,
  BoardResult,
  EnrollmentChallenge,
  OwnerAction,
  OwnerActionResult,
  PasskeyAssertion,
  PasskeyRegistration,
  PendingJoin,
} from "../../packages/railhead-shared/src/board-api.ts";
import type { UserId } from "../../packages/railhead-shared/src/events.ts";
import { failureReport, run as runSeed } from "../demoSeed/cli.ts";
import { readFileAt, resolveCommit } from "../demoSeed/history.ts";
import {
  LIVE_LIMITS,
  LiveTarget,
  type BoardLogSession,
  type DemoSeedSession,
  type LiveSession,
} from "../demoSeed/liveTarget.ts";
import { parseManifest, SeedRefusal, type SeedManifest } from "../demoSeed/manifest.ts";
import { DEMO_REF } from "../demoSeed/reconcile.ts";
import { keyHost, OwnerKeyRefusal, register, sign } from "../ownerKey/ownerKey.ts";

/** The manifest's path in the source repository, as the seed reads it. */
const MANIFEST_PATH = "fixtures/demo/seed.json";

/** The instance whose owner keeps a hardware passkey; the driver never runs against it. */
const DEMO_HOST = "railhead.dev";

/**
 * The head the ownership probe prepares a seed for. No bundle can hold it, so the challenge, which
 * the driver never signs, could not seed anything even if it were performed.
 */
const PROBE_HEAD = "0".repeat(40);

/** The largest identity or enrollment record read from an agent home, in bytes. */
const MAX_RECORD_BYTES = 64 * 1024;

/** The files of an agent's store entry the qualification harness's credential helper reads. */
const STORE_FILES = ["identity.json", "key", "session"] as const;

/** The swarm scenario's seed: fixed, so a rerun resumes the same plan. */
const SCENARIO_SEED = 348;

/** The steps, in order. A failure names the step it stopped at. */
export type Step = "enroll" | "seed" | "issues" | "invite" | "join" | "swarm" | "slice" | "gate";

/** The run stopped at `step`. Its message never holds a secret. */
export class StepFailure extends Error {
  override readonly name = "StepFailure";
  /** The step that failed. */
  readonly step: Step;

  constructor(step: Step, message: string, options?: ErrorOptions) {
    super(message, options);
    this.step = step;
  }
}

/** The run was refused before any step: an argument or the origin. */
export class DriverRefusal extends Error {
  override readonly name = "DriverRefusal";
}

/** The owner's actions on the demo repository, after `OwnerApi`. */
export interface OwnerSession extends Disposable {
  prepare(action: OwnerAction): PromiseLike<BoardResult<ActionChallenge>>;
  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
  ): PromiseLike<BoardResult<OwnerActionResult>>;
}

/** The demo repository's board, after `BoardApi`. */
export interface DriverBoard extends BoardLogSession {
  pendingJoins(): PromiseLike<BoardResult<PendingJoin[]>>;
  owner(): PromiseLike<OwnerSession>;
}

/** The owner's enrollment, after `OwnerEnrollmentApi`. */
export interface EnrollmentSession extends Disposable {
  prepare(bootstrapToken: string): PromiseLike<BoardResult<EnrollmentChallenge>>;
  complete(
    challengeId: string,
    registration: PasskeyRegistration,
  ): PromiseLike<BoardResult<{ ownerId: UserId }>>;
}

/** The parts of `RailheadApi` the driver calls; the real stub is one without a cast. */
export interface DriverSession extends LiveSession {
  ownerEnrollment(): PromiseLike<EnrollmentSession>;
  demoSeed(): PromiseLike<DemoSeedSession>;
  openBoard(org: RepoSegment, repo: RepoSegment): PromiseLike<BoardResult<DriverBoard>>;
}

/** A child process to start. */
export interface ProcessSpec {
  /** The executable. */
  readonly command: string;
  readonly args: readonly string[];
  /** Variables added to the driver's environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Where its standard output goes; kept in memory when absent. */
  readonly stdoutFile?: string;
  /** `discard` for a process whose diagnostics may hold a join code; `show` passes them through. */
  readonly stderr: "discard" | "show";
}

/** A started child process. */
export interface Running {
  /** Settles when it exits, with its exit code (`null` when a signal ended it). */
  readonly exited: Promise<{ readonly code: number | null; readonly stdout: string }>;
  /** Ends it; harmless once it has exited. */
  kill(): void;
}

/** How long the driver waits, in milliseconds. */
export interface DriverLimits {
  /** One RPC call. */
  readonly callMs: number;
  /** For `rh join` to store the identity it joined as. */
  readonly joinStartMs: number;
  /** For the instance to list a join, and for `rh join` to finish once confirmed. */
  readonly joinMs: number;
  /** Between two reads of a join's state. */
  readonly pollMs: number;
  /** The whole swarm run. */
  readonly swarmMs: number;
  /** One qualification harness command. */
  readonly qualifyMs: number;
}

/** The limits a run uses. */
export const DRIVER_LIMITS: DriverLimits = {
  callMs: 30_000,
  joinStartMs: 60_000,
  joinMs: 120_000,
  pollMs: 1_000,
  swarmMs: 30 * 60_000,
  qualifyMs: 10 * 60_000,
};

/** What the driver reaches outside itself; tests pass fakes. */
export interface DriverDeps {
  openSession(origin: string): DriverSession;
  start(spec: ProcessSpec): Running;
  /** The bootstrap token, read only when the key must be enrolled. */
  bootstrapToken(): string;
  log(line: string): void;
  readonly limits: DriverLimits;
}

/** One run's settings, already validated by `parseOptions`. */
export interface DriverOptions {
  readonly origin: string;
  readonly ownerKey: string;
  readonly agents: number;
  readonly revision: string;
  /** The repository the seed and the manifest are read from. */
  readonly sourceRoot: string;
  /** The binding report the gate judges with the slice report. */
  readonly binding: string;
  /** Homes, clones and reports; outside any checkout. */
  readonly runDir: string;
  readonly rh: string;
  readonly swarm: string;
  /** `scripts/qualify-slice.mjs`. */
  readonly qualify: string;
}

/** The gate's verdict and the reports it judged. */
export interface Verdict {
  readonly passed: boolean;
  readonly binding: string;
  readonly slice: string;
}

/** The local name and invite name of agent `index`, as `railhead-swarm` names it. */
export function agentName(index: number): string {
  return `swarm-${String(index).padStart(2, "0")}`;
}

/**
 * Refuses an origin the driver must not act on: anything the seed would not send an assertion to,
 * and `railhead.dev` or a subdomain, whose owner keeps a hardware passkey.
 */
export function assertQualificationOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch (error) {
    throw new DriverRefusal(`${JSON.stringify(origin)} is not a URL.`, { cause: error });
  }
  if (url.hostname === DEMO_HOST || url.hostname.endsWith(`.${DEMO_HOST}`)) {
    throw new DriverRefusal(
      `The live run never acts on ${url.hostname}; use a qualification instance.`,
    );
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const scheme = url.protocol === "https:" || (url.protocol === "http:" && local);
  const bare =
    url.username === "" &&
    url.password === "" &&
    (url.pathname === "/" || url.pathname === "") &&
    url.search === "" &&
    url.hash === "";
  if (!scheme || !bare) {
    throw new DriverRefusal(
      `--origin must be an https origin alone, or http on localhost; refusing ${JSON.stringify(origin)}.`,
    );
  }
  return url.origin;
}

/** Runs every step and returns the gate's verdict. Throws `StepFailure` at the first failure. */
export async function drive(options: DriverOptions, deps: DriverDeps): Promise<Verdict> {
  const origin = assertQualificationOrigin(options.origin);
  const names = Array.from({ length: options.agents }, (_, index) => agentName(index));
  const homes = join(options.runDir, "homes");
  mkdirSync(homes, { recursive: true, mode: 0o700 });

  await runStep("enroll", () => enroll(origin, options.ownerKey, deps));
  const manifest = await runStep("seed", () => seed(origin, options, deps));
  await runStep("issues", () => fileIssues(origin, options.ownerKey, manifest, deps));
  const invites = await runStep("invite", () =>
    invite(origin, options.ownerKey, names, homes, deps),
  );
  await runStep("join", () => joinAll(origin, options, invites, homes, deps));
  const clones = await runStep("swarm", () => runSwarm(origin, options, homes, names, deps));
  const slice = await runStep("slice", () => runSlice(origin, options, homes, names, clones, deps));
  return runStep("gate", () => runGate(origin, options, slice, deps));
}

/** Runs `body` as `name`, turning any failure into a `StepFailure` naming it. */
async function runStep<T>(name: Step, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof StepFailure) throw error;
    throw new StepFailure(name, messageOf(error), { cause: error });
  }
}

/** A failure's sentence. A defect's message is shown too: nothing here puts a secret in one. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "the step failed";
}

// =======================================================================================
// 1. Enroll

async function enroll(origin: string, ownerKey: string, deps: DriverDeps): Promise<void> {
  const host = new URL(origin).hostname;
  using session = deps.openSession(origin);
  if (existsSync(ownerKey)) {
    const keyFor = keyHost(ownerKey);
    if (keyFor !== host) throw new Error(`${ownerKey} signs for ${keyFor}, not for ${host}.`);
    // A challenge lists the owner's credentials. The probe is prepared, never signed, and expires.
    using demo = await within(session.demoSeed(), deps.limits.callMs, "demoSeed");
    const probe = valueOf(
      await within(
        demo.prepare({ kind: "demo.seed", head: PROBE_HEAD }),
        deps.limits.callMs,
        "demoSeed.prepare",
      ),
      "demoSeed.prepare",
    );
    if (!probe.allowCredentials.includes(credentialIdOf(ownerKey))) {
      throw new Error(
        `${ownerKey} is not the owner of ${host}: the instance does not list its credential.`,
      );
    }
    deps.log(`enroll: ${ownerKey} is already the owner of ${host}; skipped`);
    return;
  }
  const token = deps.bootstrapToken();
  using enrollment = await within(session.ownerEnrollment(), deps.limits.callMs, "ownerEnrollment");
  const prepared = valueOf(
    await within(enrollment.prepare(token), deps.limits.callMs, "ownerEnrollment.prepare"),
    "ownerEnrollment.prepare",
  );
  if (prepared.rpId !== host) {
    throw new Error(`The instance enrolls for ${prepared.rpId}, not for ${host}.`);
  }
  const registration = register(ownerKey, prepared);
  const completed = valueOf(
    await within(
      enrollment.complete(prepared.challengeId, registration),
      deps.limits.callMs,
      "ownerEnrollment.complete",
    ),
    "ownerEnrollment.complete",
  );
  deps.log(`enroll: ${ownerKey} enrolled as owner ${completed.ownerId}`);
}

/** The credential id in the key file `keyHost` already accepted. */
function credentialIdOf(ownerKey: string): string {
  const parsed: unknown = JSON.parse(readFileSync(ownerKey, "utf8"));
  const id = isRecord(parsed) ? parsed.credentialId : undefined;
  if (typeof id !== "string") throw new Error(`${ownerKey} names no credential.`);
  return id;
}

// =======================================================================================
// 2. Seed

async function seed(
  origin: string,
  options: DriverOptions,
  deps: DriverDeps,
): Promise<SeedManifest> {
  const argv = [
    "seed",
    "--target",
    origin,
    "--owner-key",
    options.ownerKey,
    "--revision",
    options.revision,
    "--source-root",
    options.sourceRoot,
  ];
  let lines: string[];
  try {
    lines = await runSeed(argv, deps.openSession);
  } catch (error) {
    const report = failureReport(error);
    throw new Error([...report.stderr, ...report.stdout].join("; "), { cause: error });
  }
  // Main's head and the seed's own line alone: the issue blocks hold repository text.
  for (const line of lines.filter((l) => l.startsWith("main ") || l.includes("seed repository"))) {
    deps.log(`seed: ${line}`);
  }
  const commit = resolveCommit(options.sourceRoot, options.revision);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileAt(options.sourceRoot, commit, MANIFEST_PATH));
  } catch (error) {
    if (error instanceof SeedRefusal) throw error;
    throw new SeedRefusal(`The manifest at ${commit}:${MANIFEST_PATH} is not JSON.`, {
      cause: error,
    });
  }
  return parseManifest(manifest);
}

// =======================================================================================
// 3. Issues

async function fileIssues(
  origin: string,
  ownerKey: string,
  manifest: SeedManifest,
  deps: DriverDeps,
): Promise<void> {
  using session = deps.openSession(origin);
  const titles = new Set(manifest.issues.map((issue) => issue.title));
  const limits = { ...LIVE_LIMITS, readMs: deps.limits.callMs };
  const scan = await new LiveTarget(session, { kind: "prepare" }, limits).scan(DEMO_REF, titles);
  const filed = new Set(scan.issues.map((issue) => issue.title));
  using board = await openDemoBoard(session, deps);
  for (const [index, issue] of manifest.issues.entries()) {
    if (filed.has(issue.title)) {
      deps.log(`issues: seed issue ${index + 1} is already filed; skipped`);
      continue;
    }
    const result = await ownerAction(
      board,
      ownerKey,
      { kind: "issue.file", title: issue.title, body: issue.body },
      deps,
    );
    if (result.kind !== "issue.file") throw unexpected("issue.file", result.kind);
    deps.log(`issues: filed seed issue ${index + 1} as ${result.issueId}`);
  }
}

// =======================================================================================
// 4. Invites

/** An invite for one agent. Its URL holds the invite's secret and never leaves memory. */
interface Invite {
  readonly name: string;
  readonly inviteId: string;
  readonly inviteUrl: string;
}

/** Where agent `name`'s store entry is in its home. */
function storeEntry(homes: string, name: string): string {
  return join(homes, name, "agents", name);
}

/**
 * Whether agent `name` has joined: its home holds its identity and no unfinished enrollment.
 * A home holding an unfinished enrollment cannot resume, since the invite's secret was never
 * stored, so it stops the run.
 */
function hasJoined(homes: string, name: string): boolean {
  const entry = storeEntry(homes, name);
  const identity = existsSync(join(entry, "identity.json"));
  const enrolling = existsSync(join(entry, "enrollment.json"));
  if (identity && !enrolling) return true;
  if (!identity && !enrolling && !existsSync(join(entry, "key"))) return false;
  throw new Error(
    `${join(homes, name)} holds an unfinished join of ${name}; remove that directory and run again.`,
  );
}

async function invite(
  origin: string,
  ownerKey: string,
  names: readonly string[],
  homes: string,
  deps: DriverDeps,
): Promise<Invite[]> {
  const needed = names.filter((name) => {
    if (!hasJoined(homes, name)) return true;
    deps.log(`invite: ${name} has joined; skipped`);
    return false;
  });
  if (needed.length === 0) return [];
  using session = deps.openSession(origin);
  using board = await openDemoBoard(session, deps);
  const invites: Invite[] = [];
  for (const name of needed) {
    const result = await ownerAction(board, ownerKey, { kind: "invite.create", name }, deps);
    if (result.kind !== "invite.create") throw unexpected("invite.create", result.kind);
    invites.push({ name, inviteId: result.inviteId, inviteUrl: result.inviteUrl });
    deps.log(`invite: created ${result.inviteId} for ${name}`);
  }
  return invites;
}

// =======================================================================================
// 5. Joins

async function joinAll(
  origin: string,
  options: DriverOptions,
  invites: readonly Invite[],
  homes: string,
  deps: DriverDeps,
): Promise<void> {
  if (invites.length === 0) return;
  using session = deps.openSession(origin);
  using board = await openDemoBoard(session, deps);
  for (const entry of invites) await joinOne(board, options, entry, homes, deps);
}

async function joinOne(
  board: DriverBoard,
  options: DriverOptions,
  invited: Invite,
  homes: string,
  deps: DriverDeps,
): Promise<void> {
  const { name } = invited;
  const home = join(homes, name);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const waitSeconds = Math.ceil((deps.limits.joinStartMs + deps.limits.joinMs) / 1000);
  const child = deps.start({
    command: options.rh,
    args: ["--json", "join", "--name", name, "--wait", String(waitSeconds)],
    env: { RAILHEAD_HOME: home, RAILHEAD_INVITE: invited.inviteUrl },
    stderr: "discard",
  });
  try {
    const joined = await joinedAs(home, name, child, deps);
    const pending = await pendingJoinOf(board, joined.agentId, child, deps);
    if (pending.name !== name || pending.inviteId !== invited.inviteId) {
      throw new Error(
        `The pending join of ${joined.agentId} is for ${JSON.stringify(pending.name)} with ${pending.inviteId}, not ${name} with ${invited.inviteId}; not confirmed.`,
      );
    }
    if (pending.keyFingerprint !== joined.fingerprint) {
      throw new Error(
        `The pending join of ${name} (${joined.agentId}) has key ${pending.keyFingerprint}, not the key ${home} registered (${joined.fingerprint}); not confirmed.`,
      );
    }
    const result = await ownerAction(
      board,
      options.ownerKey,
      { kind: "agent.confirm", agentId: joined.agentId, code: pending.code },
      deps,
    );
    if (result.kind !== "agent.confirm") throw unexpected("agent.confirm", result.kind);
    const exited = await within(child.exited, deps.limits.joinMs, `rh join for ${name}`);
    if (exited.code !== 0) throw rhFailed(name, exited);
    deps.log(`join: confirmed ${name} as ${joined.agentId}`);
  } finally {
    child.kill();
  }
}

/** The agent id `rh join` stored in `home` and the fingerprint of the key it registered. */
async function joinedAs(
  home: string,
  name: string,
  child: Running,
  deps: DriverDeps,
): Promise<{ agentId: string; fingerprint: string }> {
  const entry = join(home, "agents", name);
  const deadline = Date.now() + deps.limits.joinStartMs;
  let ended = false;
  const watch = child.exited.then((exited) => {
    ended = true;
    return exited;
  });
  for (;;) {
    const identity = readRecord(join(entry, "identity.json"));
    const enrollment = readRecord(join(entry, "enrollment.json"));
    if (identity !== undefined && enrollment !== undefined) {
      const { agentId } = identity;
      const { publicKey } = enrollment;
      if (typeof agentId !== "string" || typeof publicKey !== "string") {
        throw new Error(`${entry} holds a malformed identity or enrollment.`);
      }
      return { agentId, fingerprint: fingerprintOf(publicKey) };
    }
    if (ended) throw rhFailed(name, await watch);
    if (Date.now() >= deadline) {
      throw new Error(
        `rh join for ${name} stored no identity within ${deps.limits.joinStartMs} ms.`,
      );
    }
    await sleep(deps.limits.pollMs);
  }
}

/** The instance's pending join for `agentId`, asked for until it appears. */
async function pendingJoinOf(
  board: DriverBoard,
  agentId: string,
  child: Running,
  deps: DriverDeps,
): Promise<PendingJoin> {
  const deadline = Date.now() + deps.limits.joinMs;
  let ended = false;
  void child.exited.then(() => {
    ended = true;
  });
  for (;;) {
    const joins = valueOf(
      await within(board.pendingJoins(), deps.limits.callMs, "pendingJoins"),
      "pendingJoins",
    );
    const found = joins.find((pending) => pending.agentId === agentId);
    if (found !== undefined) return found;
    if (ended) throw new Error(`rh join for ${agentId} ended before the instance listed it.`);
    if (Date.now() >= deadline) {
      throw new Error(
        `The instance listed no pending join for ${agentId} within ${deps.limits.joinMs} ms.`,
      );
    }
    await sleep(deps.limits.pollMs);
  }
}

/** The OpenSSH SHA256 fingerprint of an `ssh-ed25519 <base64>` public key, as the backend writes it. */
export function fingerprintOf(publicKey: string): string {
  const match = /^ssh-ed25519 ([A-Za-z0-9+/]+={0,2})$/.exec(publicKey.trim());
  if (match?.[1] === undefined) throw new Error("The registered key is not an ssh-ed25519 key.");
  const blob = Buffer.from(match[1], "base64");
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** Why `rh join` failed: its exit and error code, never its message, which may hold the code. */
function rhFailed(name: string, exited: { code: number | null; stdout: string }): Error {
  let code = "no error code";
  try {
    const envelope: unknown = JSON.parse(exited.stdout);
    if (isRecord(envelope) && isRecord(envelope.error) && typeof envelope.error.code === "string") {
      code = `error ${envelope.error.code}`;
    }
  } catch {
    // Output that is not one JSON envelope has no code to report.
  }
  return new Error(`rh join for ${name} exited with ${String(exited.code)} (${code}).`);
}

// =======================================================================================
// 6. Swarm, slice and gate

async function runSwarm(
  origin: string,
  options: DriverOptions,
  homes: string,
  names: readonly string[],
  deps: DriverDeps,
): Promise<string[]> {
  for (const name of names) {
    if (!hasJoined(homes, name)) throw new Error(`${name} has not joined.`);
  }
  const scenario = join(options.runDir, "scenario.json");
  writeFileSync(
    scenario,
    `${JSON.stringify({
      seed: SCENARIO_SEED,
      origin,
      repository: `${DEMO_REF.org}/${DEMO_REF.repo}`,
      agents: names.length,
      rounds: 1,
      mix: { disjoint: 1, sameFileHunks: 0, overlapping: 0 },
    })}\n`,
  );
  const clonesDir = join(options.runDir, "clones");
  const events = join(options.runDir, "reports", "swarm.jsonl");
  mkdirSync(join(options.runDir, "reports"), { recursive: true });
  const child = deps.start({
    command: options.swarm,
    args: ["--scenario", scenario, "--homes", homes, "--rh", options.rh, "--clones-dir", clonesDir],
    env: {},
    stdoutFile: events,
    stderr: "show",
  });
  try {
    const exited = await within(child.exited, deps.limits.swarmMs, "railhead-swarm");
    if (exited.code !== 0) {
      throw new Error(
        `railhead-swarm exited with ${String(exited.code)}; its events are in ${events}.`,
      );
    }
  } finally {
    child.kill();
  }
  deps.log(`swarm: every agent landed its task; events in ${events}`);
  return names.map((name) => {
    const dir = join(clonesDir, name);
    const clones = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const [only, ...more] = clones;
    if (only === undefined || more.length > 0) {
      throw new Error(
        `${dir} holds ${clones.length} clones; the slice takes exactly one per agent.`,
      );
    }
    return join(dir, only.name);
  });
}

async function runSlice(
  origin: string,
  options: DriverOptions,
  homes: string,
  names: readonly string[],
  clones: readonly string[],
  deps: DriverDeps,
): Promise<string> {
  const home = sliceHome(options.runDir, homes, names);
  const report = join(options.runDir, "reports", "slice.json");
  const repo = `${DEMO_REF.org}/${DEMO_REF.repo}`;
  const args = [options.qualify, "slice", "--origin", origin, "--repo", repo];
  for (const clone of clones) args.push("--clone", clone);
  args.push("--out", report);
  const exited = await runNode(args, { RAILHEAD_HOME: home }, deps);
  // A failed check still writes the report, which the gate judges again.
  if (!existsSync(report)) {
    throw new Error(`qualify-slice slice exited with ${String(exited.code)} and wrote no report.`);
  }
  deps.log(`slice: report in ${report}${exited.code === 0 ? "" : " (a check failed)"}`);
  return report;
}

/**
 * One `RAILHEAD_HOME` holding every agent's store entry, for the harness, which asks each clone's
 * credential helper under one environment. `rh` refuses a linked store directory, so the entries are
 * copied, with the store's own modes.
 */
function sliceHome(runDir: string, homes: string, names: readonly string[]): string {
  const home = join(runDir, "slice-home");
  for (const name of names) {
    const target = join(home, "agents", name);
    mkdirSync(join(home, "agents"), { recursive: true, mode: 0o700 });
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const file of STORE_FILES) {
      const from = join(storeEntry(homes, name), file);
      if (!existsSync(from)) continue;
      copyFileSync(from, join(target, file));
      chmodSync(join(target, file), 0o600);
    }
  }
  return home;
}

async function runGate(
  origin: string,
  options: DriverOptions,
  slice: string,
  deps: DriverDeps,
): Promise<Verdict> {
  const output = join(options.runDir, "reports", "gate.txt");
  const exited = await runNode(
    [options.qualify, "gate", "--origin", origin, options.binding, slice],
    {},
    deps,
    output,
  );
  if (exited.code !== 0 && exited.code !== 1) {
    throw new Error(`qualify-slice gate exited with ${String(exited.code)}; see ${output}.`);
  }
  return { passed: exited.code === 0, binding: options.binding, slice };
}

/** Runs `node` with `args` within the harness's limit. */
async function runNode(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  deps: DriverDeps,
  stdoutFile?: string,
): Promise<{ code: number | null; stdout: string }> {
  const child = deps.start({
    command: process.execPath,
    args,
    env,
    stderr: "show",
    ...(stdoutFile === undefined ? {} : { stdoutFile }),
  });
  try {
    return await within(child.exited, deps.limits.qualifyMs, `qualify-slice ${args[1] ?? ""}`);
  } finally {
    child.kill();
  }
}

// =======================================================================================
// Owner actions and RPC

async function openDemoBoard(session: DriverSession, deps: DriverDeps): Promise<DriverBoard> {
  const opened = await within(
    session.openBoard(DEMO_REF.org, DEMO_REF.repo),
    deps.limits.callMs,
    "openBoard",
  );
  return valueOf(opened, "openBoard");
}

/**
 * Prepares `action`, signs its challenge with the owner key and performs it once. A failure or a
 * lost answer is not repeated: the next run reads the instance before acting again.
 */
async function ownerAction(
  board: DriverBoard,
  ownerKey: string,
  action: OwnerAction,
  deps: DriverDeps,
): Promise<OwnerActionResult> {
  using owner = await within(board.owner(), deps.limits.callMs, "owner");
  const challenge = valueOf(
    await within(owner.prepare(action), deps.limits.callMs, `${action.kind} prepare`),
    `${action.kind} prepare`,
  );
  let signed: ReturnType<typeof sign>;
  try {
    signed = sign(ownerKey, challenge);
  } catch (error) {
    if (error instanceof OwnerKeyRefusal) throw new Error(error.message, { cause: error });
    throw error;
  }
  const performed = await within(
    owner.perform(signed.challengeId, signed.assertion),
    deps.limits.callMs,
    `${action.kind} perform`,
  );
  return valueOf(performed, `${action.kind} perform`);
}

function valueOf<T>(result: BoardResult<T>, call: string): T {
  if (result.ok) return result.value;
  throw new Error(`${call} failed with ${result.code}: ${result.message}`);
}

function unexpected(expected: string, kind: string): Error {
  return new Error(`The instance answered ${expected} with a ${kind} result.`);
}

/** `promise`, or a failure once `ms` pass. The call is not cancelled; its owner disposes it. */
async function within<T>(promise: PromiseLike<T>, ms: number, call: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${call} did not answer within ${ms} ms.`)), ms);
  });
  try {
    return await Promise.race([Promise.resolve(promise), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The JSON object in `path`, or `undefined` while it does not exist. */
function readRecord(path: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (text.length > MAX_RECORD_BYTES) throw new Error(`${path} is too large.`);
  // `rh` writes each record whole with a rename, so a partial file is not expected.
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error(`${path} is not a record.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
