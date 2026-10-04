import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const script = join(import.meta.dirname, "qualify-slice.mjs");

/** Runs the harness with `args` and returns its exit code and output. */
function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
  });
}

let scratch = "";

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "qualify-slice-test-"));
});

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function report(name: string, kind: string, outcome: "pass" | "fail"): string {
  const path = join(scratch, name);
  writeFileSync(path, JSON.stringify({ kind, checks: [{ id: `${kind}.x`, outcome, detail: "" }] }));
  return path;
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

  test("gate passes only with a passing binding report and a passing slice report", async () => {
    const binding = report("binding.json", "binding", "pass");
    const slice = report("slice.json", "slice", "pass");
    const passed = await run(["gate", binding, slice]);
    assert.equal(passed.code, 0);
    assert.match(passed.stdout, /the live gate passed/);

    const onlyBinding = await run(["gate", binding]);
    assert.equal(onlyBinding.code, 1);
    assert.match(onlyBinding.stdout, /needs one binding report and one slice report/);

    const failed = await run(["gate", binding, report("slice-fail.json", "slice", "fail")]);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /FAIL slice/);
  });
});
