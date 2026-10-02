import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

// Tests run inside workerd against the generated wrangler.jsonc, so they exercise the deployed
// configuration: the same compatibility date, bindings and asset routing.
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      // The source entry, not the config's `.wrangler/validate` tree: the plugin above applies the
      // same `@validateRpc()` transform in memory.
      main: "./src/server.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@foreman/scripts/assert-workerd"],
  },
});
