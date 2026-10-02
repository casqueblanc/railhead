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
