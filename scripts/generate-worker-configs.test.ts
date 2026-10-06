import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  generateWorkerConfigs,
  renderWorkerConfig,
  workerConfigDirs,
} from "./generate-worker-configs.ts";
import { COMPATIBILITY_DATE } from "./worker-config.ts";

const fixture = (name: string) => join(import.meta.dirname, "testdata", name);
const BACKEND = join(import.meta.dirname, "..", "packages", "railhead-backend");

/** The JSON body of a rendered wrangler.jsonc, below its two header lines. */
const body = (text: string): unknown => JSON.parse(text.split("\n").slice(2).join("\n"));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every string in `value`, keyed by its dotted path. */
function stringLeaves(value: unknown, path = ""): Map<string, string> {
  if (typeof value === "string") return new Map([[path, value]]);
  const entries = Array.isArray(value)
    ? value.map((item, i) => [String(i), item] as const)
    : isRecord(value)
      ? Object.entries(value)
      : [];
  return new Map(
    entries.flatMap(([key, item]) => [...stringLeaves(item, path ? `${path}.${key}` : key)]),
  );
}

test("renders the Worker definition and the Wrangler-only settings under the generated header", async () => {
  const text = await renderWorkerConfig(fixture("valid"));

  const [first, second, ...json] = text.split("\n");
  assert.match(first ?? "", /^\/\/ Generated from cloudflare\.config\.ts .* do not edit\.$/);
  assert.match(
    second ?? "",
    /^\/\/ Change cloudflare\.config\.ts and run `pnpm configs:generate`\.$/,
  );
  assert.deepEqual(JSON.parse(json.join("\n")), {
    name: "fixture",
    main: "src/index.ts",
    compatibility_date: COMPATIBILITY_DATE,
    assets: { binding: "ASSETS", directory: "../site/dist" },
    build: { command: "build-it", watch_dir: "src" },
  });
});

test("rejects an export the generator would silently ignore", async () => {
  await assert.rejects(renderWorkerConfig(fixture("unknown-export")), /exports wranglr/);
});

test("rejects a wrangler.jsonc with no cloudflare.config.ts beside it", async () => {
  await assert.rejects(renderWorkerConfig(fixture("handwritten")), /has no cloudflare\.config\.ts/);
});

test("rejects an assets directory when the Worker binds no assets", async () => {
  await assert.rejects(
    renderWorkerConfig(fixture("assets-without-binding")),
    /assetsDirectory needs an assets binding/,
  );
});

test("binds the Worker's own Durable Object class without naming the Worker as another script", async () => {
  const text = await renderWorkerConfig(fixture("durable-objects"));

  const json: unknown = JSON.parse(text.split("\n").slice(2).join("\n"));
  assert.deepEqual(json, {
    name: "fixture",
    main: "src/index.ts",
    compatibility_date: COMPATIBILITY_DATE,
    durable_objects: {
      bindings: [
        { name: "OWN", class_name: "Own" },
        { name: "OTHER", class_name: "Theirs", script_name: "other-worker" },
      ],
    },
    exports: { Own: { type: "durable-object", storage: "sqlite" } },
  });
});

test("every Worker package commits the config its source generates", async () => {
  const dirs = workerConfigDirs();
  assert.ok(dirs.length > 0, "no Worker config found under packages/");
  for (const dir of dirs) {
    assert.ok(existsSync(join(dir, "cloudflare.config.ts")), `${dir} has no cloudflare.config.ts`);
    assert.equal(readFileSync(join(dir, "wrangler.jsonc"), "utf8"), await renderWorkerConfig(dir));
  }
  assert.deepEqual(await generateWorkerConfigs({ check: true }), []);
});

/** The rendered form of one Worker in the `environment` fixture. */
const environmentWorker = (name: string) => ({
  name,
  main: "src/index.ts",
  compatibility_date: COMPATIBILITY_DATE,
  durable_objects: { bindings: [{ name: "OWN", class_name: "Own" }] },
  exports: { Own: { type: "durable-object", storage: "sqlite" } },
  build: { command: "build-it" },
});

/** Whether a string at `path` names no resource: binding and class names, paths and settings. */
const namesNoResource = (path: string) =>
  /(^|\.)(binding|class_name|type|storage|main|compatibility_date|image|instance_type|command|watch_dir|directory|not_found_handling)$/.test(
    path,
  ) ||
  /^durable_objects\.bindings\.\d+\.name$/.test(path) ||
  /^(secrets\.required|assets\.run_worker_first)\.\d+$/.test(path);

test("nests an environment export under env with its own Worker name", async () => {
  const json = body(await renderWorkerConfig(fixture("environment")));

  assert.deepEqual(json, {
    ...environmentWorker("fixture"),
    env: { qualification: environmentWorker("fixture-qual") },
  });
});

test("the backend's qualification environment names its own resource in every binding", async () => {
  const json = body(await renderWorkerConfig(BACKEND));
  assert.ok(isRecord(json) && isRecord(json.env), "the backend config has no env");
  const { env, ...production } = json;
  const qualification = stringLeaves(env.qualification);
  const development = stringLeaves(production);

  assert.deepEqual([...qualification.keys()].toSorted(), [...development.keys()].toSorted());
  const resources = [...development.keys()].filter((path) => !namesNoResource(path));
  for (const path of resources) {
    assert.notEqual(qualification.get(path), development.get(path), `${path} is shared`);
  }
  assert.deepEqual(resources.toSorted(), [
    "artifacts.0.namespace",
    "containers.0.name",
    "exports.CheckWorkflow.name",
    "exports.RailheadSandbox.container",
    "name",
    "r2_buckets.0.bucket_name",
    "vars.ARTIFACTS_NAMESPACE",
    "vars.BACKUP_BUCKET_NAME",
    "vars.RELYING_PARTY_HOST",
    "workflows.0.name",
    "workflows.0.script_name",
  ]);
  assert.equal(qualification.get("name"), "railhead-qual");
  assert.equal(qualification.get("vars.RELYING_PARTY_HOST"), "railhead-qual.mashin.workers.dev");
});

test("rejects an invalid environment export by name", async () => {
  await assert.rejects(
    renderWorkerConfig(fixture("invalid-environment")),
    /qualification export is invalid/,
  );
});
