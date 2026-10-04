import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { judgeReport } from "./qualify/evidence.ts";
import { liveBindingReport, liveSliceReport } from "./qualify/reportFixtures.ts";

const script = join(import.meta.dirname, "qualify-slice.mjs");

/** Runs the harness with `args` and returns its exit code and output. */
function run(
  args: string[],
  { env = {}, execArgv = [] }: { env?: Record<string, string>; execArgv?: string[] } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [...execArgv, script, ...args],
      { timeout: 30_000, env: { ...process.env, ...env } },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

let scratch = "";

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "qualify-slice-test-"));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Writes `report` with the outcomes judged from its observations, as the harness does. */
function written<T extends { kind: string }>(name: string, report: T): string {
  const path = join(scratch, name);
  const checks = judgeReport(report, Date.now()).slice(0, -2);
  writeFileSync(path, JSON.stringify({ ...report, checks }));
  return path;
}

/** Writes `value` as a report file without judging it. */
function raw(name: string, value: unknown): string {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify(value));
  return path;
}

/**
 * Preloaded into the harness: records any HTTP request or WebSocket it opens in `log`, and lets
 * none through.
 */
function networkRecorder(log: string): string {
  const path = join(scratch, `network-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(
    path,
    [
      'import { appendFileSync } from "node:fs";',
      `const log = ${JSON.stringify(log)};`,
      'globalThis.fetch = async (input) => { appendFileSync(log, `fetch ${String(input)}\\n`); throw new TypeError("network disabled"); };',
      'globalThis.WebSocket = class { constructor(url) { appendFileSync(log, `websocket ${String(url)}\\n`); throw new TypeError("network disabled"); } };',
      "",
    ].join("\n"),
  );
  return path;
}

/** A Git repository in `dir` with `config` set, standing for an agent's claim clone. */
function clone(dir: string, config: Record<string, string>): string {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  for (const [key, value] of Object.entries(config)) {
    execFileSync("git", ["-C", dir, "config", key, value]);
  }
  return dir;
}

describe("qualify-slice.mjs", () => {
  test("probe-config writes a probe config on the given namespace and a private secret", async () => {
    const dir = join(scratch, "probe");
    const ran = await run(["probe-config", "--namespace", "railhead-qual", "--dir", dir]);
    assert.equal(ran.code, 0, ran.stderr);
    const config = JSON.parse(readFileSync(join(dir, "wrangler.json"), "utf8"));
    assert.equal(config.name, "railhead-qual-probe");
    assert.deepEqual(config.artifacts, [{ binding: "ARTIFACTS", namespace: "railhead-qual" }]);
    assert.match(config.main, /packages\/railhead-backend\/qualify\/probe\.ts$/);
    assert.match(config.compatibility_date, /^\d{4}-\d{2}-\d{2}$/);
    const secrets = join(dir, "probe-secrets.json");
    assert.equal(statSync(secrets).mode & 0o777, 0o600);
    const { PROBE_SECRET } = JSON.parse(readFileSync(secrets, "utf8"));
    assert.ok(PROBE_SECRET.length >= 32);
    // The secret is written to the file only, never printed.
    assert.ok(!ran.stdout.includes(PROBE_SECRET));
    assert.match(ran.stdout, /wrangler deploy --config .*--secrets-file/);
  });

  test("probe-config refuses Railhead's own namespace and an existing directory", async () => {
    const own = await run([
      "probe-config",
      "--namespace",
      "railhead",
      "--dir",
      join(scratch, "own"),
    ]);
    assert.equal(own.code, 2);
    assert.match(own.stderr, /qualification namespace/);
    const existing = await run(["probe-config", "--namespace", "railhead-qual", "--dir", scratch]);
    assert.equal(existing.code, 2);
    assert.match(existing.stderr, /already exists/);
  });

  test("slice refuses a local origin before reaching anything", async () => {
    const ran = await run([
      "slice",
      "--origin",
      "http://localhost:8787",
      "--repo",
      "acme/upload-app",
      "--clone",
      scratch,
      "--clone",
      scratch,
      "--clone",
      scratch,
      "--out",
      join(scratch, "slice.json"),
    ]);
    assert.equal(ran.code, 2);
    assert.match(ran.stderr, /not a deployed instance/);
  });

  test("slice and binding refuse missing or malformed arguments", async () => {
    const fewClones = await run([
      "slice",
      "--origin",
      "https://railhead.dev",
      "--repo",
      "acme/upload-app",
      "--clone",
      scratch,
      "--out",
      join(scratch, "few.json"),
    ]);
    assert.equal(fewClones.code, 2);
    assert.match(fewClones.stderr, /three agents/);
    const badRepo = await run([
      "slice",
      "--origin",
      "https://railhead.dev",
      "--repo",
      "x",
      "--out",
      "y",
    ]);
    assert.equal(badRepo.code, 2);
    const noProbe = await run(["binding", "--out", join(scratch, "b.json")]);
    assert.equal(noProbe.code, 2);
    assert.match(noProbe.stderr, /--probe is required/);
    const unknown = await run(["deploy"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /qualify-slice\.mjs probe-config/);
  });

  test("slice refuses a clone whose origin names another host before any credential or request", async () => {
    const origin = "https://railhead.dev";
    const upstream = `${origin}/git/acme/upload-app.git`;
    const trace = join(scratch, "git-trace.log");
    const network = join(scratch, "network.log");
    const helperCalls = join(scratch, "helper.log");
    const helper = `!f() { echo "$1" >> '${helperCalls}'; }; f`;
    const claimClone = (name: string, url: string, extra: Record<string, string> = {}) =>
      clone(join(scratch, name), {
        "remote.origin.url": url,
        "remote.upstream.url": upstream,
        "railhead.identity": "agt_atlas1",
        "credential.helper": helper,
        ...extra,
      });
    const atlas = claimClone("atlas", `${origin}/git/acme/upload-app/claims/clm_aaaaaa.git`);
    const cedar = claimClone("cedar", `${origin}/git/acme/upload-app/claims/clm_cccccc.git`);
    const elsewhere = [
      claimClone("attacker", "https://attacker.dev/git/acme/upload-app/claims/clm_bbbbbb.git"),
      claimClone("plain", "http://railhead.dev/git/acme/upload-app/claims/clm_bbbbbb.git"),
      claimClone("other-repo", `${origin}/git/acme/other/claims/clm_bbbbbb.git`),
      // Configured on the instance, but Git would rewrite it to another host.
      claimClone("rewritten", `${origin}/git/acme/upload-app/claims/clm_bbbbbb.git`, {
        "url.https://attacker.dev/.insteadOf": `${origin}/`,
      }),
    ];
    for (const birch of elsewhere) {
      const ran = await run(
        ["slice", "--origin", origin, "--repo", "acme/upload-app"]
          .concat(["--clone", atlas, "--clone", birch, "--clone", cedar])
          .concat(["--out", join(scratch, "refused.json")]),
        {
          env: { GIT_TRACE: trace, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
          execArgv: ["--import", networkRecorder(network)],
        },
      );
      assert.equal(ran.code, 2, `${birch}: ${ran.stderr}`);
      assert.match(ran.stderr, /--clone 2: origin is not a claim remote of acme\/upload-app/);
      assert.equal(existsSync(network), false);
      assert.equal(existsSync(helperCalls), false);
      assert.doesNotMatch(readFileSync(trace, "utf8"), /remote-https|remote-http|credential/);
      assert.equal(existsSync(join(scratch, "refused.json")), false);
    }

    // The recorder sees a request: with every clone on the instance, the log read goes out first.
    const birch = claimClone("birch", `${origin}/git/acme/upload-app/claims/clm_bbbbbb.git`);
    const allowed = await run(
      ["slice", "--origin", origin, "--repo", "acme/upload-app"]
        .concat(["--clone", atlas, "--clone", birch, "--clone", cedar])
        .concat(["--out", join(scratch, "allowed.json")]),
      {
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        execArgv: ["--import", networkRecorder(network)],
      },
    );
    assert.equal(allowed.code, 1);
    assert.equal(readFileSync(network, "utf8"), "websocket wss://railhead.dev/api\n");
    assert.equal(existsSync(helperCalls), false);
  });

  test("slice refuses a first clone whose upstream is not the repository's main remote", async () => {
    const origin = "https://railhead.dev";
    const network = join(scratch, "network-upstream.log");
    const dirs = ["a", "b", "c"].map((name) =>
      clone(join(scratch, `upstream-${name}`), {
        "remote.origin.url": `${origin}/git/acme/upload-app/claims/clm_${name.repeat(6)}.git`,
        "remote.upstream.url": "https://attacker.dev/git/acme/upload-app.git",
      }),
    );
    const ran = await run(
      ["slice", "--origin", origin, "--repo", "acme/upload-app"]
        .concat(dirs.flatMap((dir) => ["--clone", dir]))
        .concat(["--out", join(scratch, "upstream.json")]),
      {
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
        execArgv: ["--import", networkRecorder(network)],
      },
    );
    assert.equal(ran.code, 2, ran.stderr);
    assert.match(
      ran.stderr,
      /--clone 1: upstream is not https:\/\/railhead\.dev\/git\/acme\/upload-app\.git/,
    );
    assert.equal(existsSync(network), false);
  });

  test("gate passes a complete live-collected binding report and slice report", async () => {
    const binding = written("binding.json", liveBindingReport());
    const slice = written("slice.json", liveSliceReport());
    const passed = await run(["gate", binding, slice]);
    assert.equal(passed.code, 0, passed.stdout);
    assert.match(passed.stdout, /PASS binding .*\nPASS slice .*\nthe live gate passed/);
  });

  test("gate fails reports that state passing checks without live observations", async () => {
    const binding = raw("fabricated-binding.json", {
      kind: "binding",
      checks: [{ id: "binding.x", outcome: "pass", detail: "" }],
    });
    const slice = raw("fabricated-slice.json", {
      kind: "slice",
      checks: [{ id: "slice.x", outcome: "pass", detail: "" }],
    });
    const ran = await run(["gate", binding, slice]);
    assert.equal(ran.code, 1);
    assert.match(ran.stdout, /FAIL binding .*\n  FAIL binding\.shape\n  FAIL report\.complete/);
    assert.match(ran.stdout, /FAIL slice .*\n  FAIL slice\.shape/);
    assert.match(ran.stdout, /the live gate did not pass/);
  });

  test("gate fails an incomplete or edited report and a missing or doubled kind", async () => {
    const slice = written("slice-ok.json", liveSliceReport());
    const partial = liveBindingReport();
    const { lostResponse: _lost, ...withoutLost } = partial.observations;
    const incomplete = await run([
      "gate",
      written("binding-partial.json", { ...partial, observations: withoutLost }),
      slice,
    ]);
    assert.equal(incomplete.code, 1);
    assert.match(incomplete.stdout, /  FAIL main\.lost-response/);

    // Outcomes edited to pass where the observations fail.
    const edited = JSON.parse(
      readFileSync(written("binding-edited.json", liveBindingReport()), "utf8"),
    );
    edited.observations.restActive = 31;
    const editedRun = await run(["gate", raw("binding-edited-2.json", edited), slice]);
    assert.equal(editedRun.code, 1);
    assert.match(editedRun.stdout, /  FAIL listing\.rest-active\n  FAIL report\.recorded/);

    const binding = written("binding-ok.json", liveBindingReport());
    const onlyBinding = await run(["gate", binding]);
    assert.equal(onlyBinding.code, 1);
    assert.match(onlyBinding.stdout, /needs exactly one binding report and one slice report/);
    const doubled = await run(["gate", binding, binding, slice]);
    assert.equal(doubled.code, 1);
    assert.match(doubled.stdout, /needs exactly one binding report and one slice report/);

    const unreadable = await run(["gate", binding, join(scratch, "missing.json")]);
    assert.equal(unreadable.code, 2);
    assert.match(unreadable.stderr, /not a readable JSON report/);
  });
});
