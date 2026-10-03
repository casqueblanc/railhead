import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const script = join(import.meta.dirname, "write-worker-secrets.mjs");
const backendConfig = join(import.meta.dirname, "../packages/railhead-backend/wrangler.jsonc");

const SIGNING = "signing-value-7f3a";
const BOOTSTRAP = "bootstrap-value-91c2";
const TOKEN = "api-token-value-4d0e";

interface Run {
  code: number;
  output: string;
}

/** Runs the script with only PATH and `env` in its environment, so the runner's own cannot leak in. */
const run = (args: string[], env: Record<string, string>): Promise<Run> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...args],
      { env: { PATH: process.env.PATH ?? "", ...env } },
      (error, stdout, stderr) => {
        resolve({
          code: error === null ? 0 : typeof error.code === "number" ? error.code : -1,
          output: stdout + stderr,
        });
      },
    );
  });

describe("write-worker-secrets", () => {
  let dir: string;
  let n = 0;
  /** A fresh path under the test's temporary directory; the suite never writes in the workspace. */
  const fresh = (name: string) => join(dir, `${(n += 1)}-${name}`);

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "worker-secrets-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes exactly the backend's required secrets, mode 600, without printing values", async () => {
    const out = fresh("secrets.json");
    const result = await run(
      ["--config", backendConfig, "--out", out, "--require", "CLOUDFLARE_API_TOKEN"],
      {
        SESSION_SIGNING_SECRET: SIGNING,
        OWNER_BOOTSTRAP_TOKEN: BOOTSTRAP,
        CLOUDFLARE_API_TOKEN: TOKEN,
      },
    );
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), {
      OWNER_BOOTSTRAP_TOKEN: BOOTSTRAP,
      SESSION_SIGNING_SECRET: SIGNING,
    });
    assert.equal(statSync(out).mode & 0o777, 0o600);
    for (const value of [SIGNING, BOOTSTRAP, TOKEN]) {
      assert.ok(!result.output.includes(value), "a secret value was printed");
    }
  });

  test("names every unset or empty secret and writes nothing", async () => {
    const out = fresh("secrets.json");
    const result = await run(
      ["--config", backendConfig, "--out", out, "--require", "CLOUDFLARE_API_TOKEN"],
      { SESSION_SIGNING_SECRET: SIGNING, OWNER_BOOTSTRAP_TOKEN: "" },
    );
    assert.equal(result.code, 1);
    assert.match(
      result.output,
      /missing required secret\(s\): CLOUDFLARE_API_TOKEN, OWNER_BOOTSTRAP_TOKEN\n/,
    );
    assert.ok(!result.output.includes("SESSION_SIGNING_SECRET"), "a present secret was named");
    assert.ok(!result.output.includes(SIGNING), "a secret value was printed");
    assert.equal(existsSync(out), false);
  });

  test("keeps values with JSON and .env metacharacters intact", async () => {
    const out = fresh("secrets.json");
    const awkward = 'a"b\\c=d\ne #f $g';
    const result = await run(["--config", backendConfig, "--out", out], {
      SESSION_SIGNING_SECRET: awkward,
      OWNER_BOOTSTRAP_TOKEN: BOOTSTRAP,
    });
    assert.equal(result.code, 0, result.output);
    const written: unknown = JSON.parse(readFileSync(out, "utf8"));
    assert.deepEqual(written, {
      OWNER_BOOTSTRAP_TOKEN: BOOTSTRAP,
      SESSION_SIGNING_SECRET: awkward,
    });
  });

  test("writes an empty object for a config with no required secrets", async () => {
    const config = fresh("wrangler.jsonc");
    writeFileSync(config, '// comment\n{ "name": "plain", "main": "src/index.ts" }\n');
    const out = fresh("secrets.json");
    const result = await run(["--config", config, "--out", out], {});
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), {});
  });

  test("refuses to overwrite an existing file", async () => {
    const out = fresh("secrets.json");
    writeFileSync(out, "keep");
    const result = await run(["--config", backendConfig, "--out", out], {
      SESSION_SIGNING_SECRET: SIGNING,
      OWNER_BOOTSTRAP_TOKEN: BOOTSTRAP,
    });
    assert.equal(result.code, 2);
    assert.equal(readFileSync(out, "utf8"), "keep");
  });

  test("rejects unusable arguments and configs without writing", async () => {
    const out = fresh("secrets.json");
    const env = { SESSION_SIGNING_SECRET: SIGNING, OWNER_BOOTSTRAP_TOKEN: BOOTSTRAP };
    const notJson = fresh("not-json.jsonc");
    writeFileSync(notJson, "{ name: 'x', }\n");
    const notNames = fresh("not-names.jsonc");
    writeFileSync(notNames, '{ "secrets": { "required": "SESSION_SIGNING_SECRET" } }\n');
    const cases: Array<[string, string[]]> = [
      ["missing --out", ["--config", backendConfig]],
      ["unknown flag", ["--config", backendConfig, "--out", out, "--print"]],
      ["missing config file", ["--config", fresh("absent.jsonc"), "--out", out]],
      ["config that is not generated JSON", ["--config", notJson, "--out", out]],
      ["secrets.required not a list", ["--config", notNames, "--out", out]],
      ["invalid --require name", ["--config", backendConfig, "--out", out, "--require", "a-b"]],
    ];
    for (const [label, args] of cases) {
      const result = await run(args, env);
      assert.equal(result.code, 2, `${label}: ${result.output}`);
    }
    assert.equal(existsSync(out), false);
  });
});
