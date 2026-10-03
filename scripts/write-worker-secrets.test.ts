import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

const script = join(import.meta.dirname, "write-worker-secrets.mjs");
const backendConfig = join(import.meta.dirname, "../packages/railhead-backend/wrangler.jsonc");

/** A config in the shape scripts/generate-worker-configs.ts writes, with two required secrets. */
const FIXTURE_CONFIG =
  "// Generated from cloudflare.config.ts by scripts/generate-worker-configs.ts -- do not edit.\n" +
  "// Change cloudflare.config.ts and run `pnpm configs:generate`.\n" +
  JSON.stringify(
    { name: "fixture", secrets: { required: ["OWNER_BOOTSTRAP_TOKEN", "SESSION_SIGNING_SECRET"] } },
    null,
    2,
  ) +
  "\n";

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
  let config: string;
  let n = 0;
  /** A fresh path under the test's temporary directory; the suite never writes in the workspace. */
  const fresh = (name: string) => join(dir, `${(n += 1)}-${name}`);

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "worker-secrets-"));
    config = join(dir, "wrangler.jsonc");
    writeFileSync(config, FIXTURE_CONFIG);
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("writes exactly the required secrets, mode 600, without printing values", async () => {
    const out = fresh("secrets.json");
    const result = await run(
      ["--config", config, "--out", out, "--require", "CLOUDFLARE_API_TOKEN"],
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

  test("writes every secret the backend's generated config requires", async () => {
    const generated: unknown = JSON.parse(
      readFileSync(backendConfig, "utf8").replace(/^(?:\/\/.*\n)*/, ""),
    );
    assert.ok(typeof generated === "object" && generated !== null && "secrets" in generated);
    const { secrets } = generated;
    assert.ok(typeof secrets === "object" && secrets !== null && "required" in secrets);
    const { required } = secrets;
    assert.ok(Array.isArray(required) && required.length > 0);
    const env = Object.fromEntries(
      required.map((name: unknown) => [String(name), `value-${String(name)}`]),
    );
    const out = fresh("secrets.json");
    const result = await run(["--config", backendConfig, "--out", out], env);
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), env);
  });

  test("names every unset or empty secret and writes nothing", async () => {
    const out = fresh("secrets.json");
    const result = await run(
      ["--config", config, "--out", out, "--require", "CLOUDFLARE_API_TOKEN"],
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
    const result = await run(["--config", config, "--out", out], {
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
    const plain = fresh("wrangler.jsonc");
    writeFileSync(plain, '// comment\n{ "name": "plain", "main": "src/index.ts" }\n');
    const out = fresh("secrets.json");
    const result = await run(["--config", plain, "--out", out], {});
    assert.equal(result.code, 0, result.output);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), {});
  });

  test("refuses to overwrite an existing file", async () => {
    const out = fresh("secrets.json");
    writeFileSync(out, "keep");
    const result = await run(["--config", config, "--out", out], {
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
      ["missing --out", ["--config", config]],
      ["unknown flag", ["--config", config, "--out", out, "--print"]],
      ["missing config file", ["--config", fresh("absent.jsonc"), "--out", out]],
      ["config that is not generated JSON", ["--config", notJson, "--out", out]],
      ["secrets.required not a list", ["--config", notNames, "--out", out]],
      ["invalid --require name", ["--config", config, "--out", out, "--require", "a-b"]],
    ];
    for (const [label, args] of cases) {
      const result = await run(args, env);
      assert.equal(result.code, 2, `${label}: ${result.output}`);
    }
    assert.equal(existsSync(out), false);
  });
});
