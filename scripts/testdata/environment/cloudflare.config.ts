import { defineRailheadWorker, type WranglerExtras } from "../../worker-config.ts";

const fixture = (name: string) =>
  defineRailheadWorker({
    name,
    entrypoint: "src/index.ts",
    env: { OWN: { type: "durable-object", worker: name, exportName: "Own" } },
    exports: { Own: { type: "durable-object", storage: "sqlite" } },
  });

export default fixture("fixture");

export const qualification = fixture("fixture-qual");

export const wrangler = { build: { command: "build-it" } } satisfies WranglerExtras;
