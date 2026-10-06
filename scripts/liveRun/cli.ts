// `pnpm live-run --origin ORIGIN --owner-key FILE --agents N --binding FILE [options]`: the live
// three-agent slice on a qualification instance in one command (`driver.ts`).
//
//   --origin ORIGIN         the qualification instance; railhead.dev is refused
//   --owner-key FILE        the software owner key; created by enrollment when it does not exist
//   --agents N              agents to invite and join, 3 to 64
//   --binding FILE          the binding report from `qualify-slice.mjs binding`, for the gate
//   --revision REV          the commit the demo app is seeded from (default HEAD)
//   --bootstrap-token FILE  the owner bootstrap token, when the key must be enrolled; otherwise
//                           RAILHEAD_OWNER_BOOTSTRAP_TOKEN
//   --run-dir DIR           homes, clones and reports (default ~/railhead-live-run/<host>)
//   --rh PATH               the `rh` binary (default rh)
//   --swarm PATH            the `railhead-swarm` binary (default railhead-swarm)
//   --source-root DIR       the repository the seed reads (default this checkout)
//
// Exit codes: 0 the gate passed, 1 the gate failed or a step failed (the step is named), 2 the
// arguments or the origin were refused.

import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { newWebSocketRpcSession } from "capnweb";
import type { RailheadApi } from "../../packages/railhead-shared/src/api.ts";
import { liveApiUrl } from "../demoSeed/liveTarget.ts";
import {
  assertQualificationOrigin,
  drive,
  DRIVER_LIMITS,
  DriverRefusal,
  StepFailure,
  type DriverOptions,
  type DriverSession,
  type ProcessSpec,
  type Running,
} from "./driver.ts";

/** The repository root: the default source of the seed and the home of the harness. */
const ROOT = resolve(import.meta.dirname, "..", "..");

/** The environment variable the bootstrap token may come from. */
export const TOKEN_ENV = "RAILHEAD_OWNER_BOOTSTRAP_TOKEN";

/** Fewest agents: the slice harness takes at least three clones. */
const MIN_AGENTS = 3;

/** Most agents `railhead-swarm` runs. */
const MAX_AGENTS = 64;

/** Parses the command line into the driver's options. Throws `DriverRefusal`. */
export function parseOptions(argv: readonly string[]): DriverOptions & { tokenFile?: string } {
  const { values } = parse(argv);
  const { origin, agents, binding } = values;
  const ownerKey = values["owner-key"];
  if (origin === undefined || ownerKey === undefined || agents === undefined) {
    throw new DriverRefusal("--origin, --owner-key and --agents are required.");
  }
  if (binding === undefined) {
    throw new DriverRefusal(
      "--binding FILE is required: the gate judges a binding report from qualify-slice.mjs binding.",
    );
  }
  const checked = assertQualificationOrigin(origin);
  const count = Number(agents);
  if (
    !/^\d+$/.test(agents) ||
    !Number.isSafeInteger(count) ||
    count < MIN_AGENTS ||
    count > MAX_AGENTS
  ) {
    throw new DriverRefusal(`--agents must be a whole number from ${MIN_AGENTS} to ${MAX_AGENTS}.`);
  }
  if (!existsSync(binding)) throw new DriverRefusal(`--binding ${binding} does not exist.`);
  const runDir = resolve(
    values["run-dir"] ?? join(homedir(), "railhead-live-run", new URL(checked).host),
  );
  assertOutsideCheckout(runDir);
  const tokenFile = values["bootstrap-token"];
  return {
    origin: checked,
    ownerKey: resolve(ownerKey),
    agents: count,
    revision: values.revision,
    sourceRoot: values["source-root"],
    binding: resolve(binding),
    runDir,
    rh: values.rh,
    swarm: values.swarm,
    qualify: join(ROOT, "scripts", "qualify-slice.mjs"),
    ...(tokenFile === undefined ? {} : { tokenFile: resolve(tokenFile) }),
  };
}

/** The command line, as `parseArgs` reads it. */
function parse(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      strict: true,
      options: {
        origin: { type: "string" },
        "owner-key": { type: "string" },
        agents: { type: "string" },
        binding: { type: "string" },
        revision: { type: "string", default: "HEAD" },
        "bootstrap-token": { type: "string" },
        "run-dir": { type: "string" },
        "source-root": { type: "string", default: ROOT },
        rh: { type: "string", default: "rh" },
        swarm: { type: "string", default: "railhead-swarm" },
      },
    });
  } catch (error) {
    throw new DriverRefusal(error instanceof Error ? error.message : "Invalid arguments.", {
      cause: error,
    });
  }
}

/** Refuses a run directory inside a Git checkout: it holds agent keys and the run's sessions. */
function assertOutsideCheckout(dir: string): void {
  let at = dir;
  while (!existsSync(at)) at = dirname(at);
  for (at = realpathSync(at); ; at = dirname(at)) {
    if (existsSync(join(at, ".git"))) {
      throw new DriverRefusal(
        `--run-dir ${dir} is inside the Git checkout ${at}; keep it outside.`,
      );
    }
    if (dirname(at) === at) return;
  }
}

/** The bootstrap token from `file`, or else `RAILHEAD_OWNER_BOOTSTRAP_TOKEN`. */
export function bootstrapToken(file: string | undefined, env: NodeJS.ProcessEnv): string {
  const token = file === undefined ? env[TOKEN_ENV] : readFileSync(file, "utf8");
  const trimmed = token?.trim() ?? "";
  if (trimmed === "") {
    throw new Error(
      `Enrolling the owner key needs the bootstrap token: pass --bootstrap-token FILE or set ${TOKEN_ENV}.`,
    );
  }
  return trimmed;
}

/** Starts a child process with its output kept in memory or written to `stdoutFile`. */
export function start(spec: ProcessSpec): Running {
  const out = spec.stdoutFile === undefined ? "pipe" : openSync(spec.stdoutFile, "w", 0o600);
  const child = spawn(spec.command, [...spec.args], {
    env: { ...process.env, ...spec.env },
    stdio: ["ignore", out, spec.stderr === "show" ? "inherit" : "ignore"],
  });
  if (typeof out === "number") closeSync(out);
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  const exited = new Promise<{ code: number | null; stdout: string }>((done) => {
    child.on("error", (error) => {
      process.stderr.write(`live-run: cannot run ${spec.command}: ${error.message}\n`);
      done({ code: null, stdout: "" });
    });
    child.on("close", (code) => done({ code, stdout: Buffer.concat(chunks).toString("utf8") }));
  });
  return {
    exited,
    kill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    },
  };
}

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Runs the driver with `argv` and returns the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  let options: ReturnType<typeof parseOptions>;
  try {
    options = parseOptions(argv);
  } catch (error) {
    if (!(error instanceof DriverRefusal)) throw error;
    process.stderr.write(`live-run: ${error.message}\n`);
    return 2;
  }
  try {
    const verdict = await drive(options, {
      openSession: (origin): DriverSession =>
        newWebSocketRpcSession<RailheadApi>(liveApiUrl(origin)),
      start,
      bootstrapToken: () => bootstrapToken(options.tokenFile, process.env),
      log,
      limits: DRIVER_LIMITS,
    });
    log(`gate: ${verdict.passed ? "PASS" : "FAIL"}`);
    log(`report binding ${verdict.binding}`);
    log(`report slice ${verdict.slice}`);
    return verdict.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof DriverRefusal) {
      process.stderr.write(`live-run: ${error.message}\n`);
      return 2;
    }
    if (!(error instanceof StepFailure)) throw error;
    process.stderr.write(`live-run: step ${error.step} failed: ${error.message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
