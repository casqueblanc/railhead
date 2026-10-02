import { cloudflareTest } from "@cloudflare/vitest-plugin";
import capnwebValidate from "capnweb-validate/vite";
import { defineConfig } from "vitest/config";

// Tests run inside workerd against the generated wrangler.jsonc, so they exercise the deployed
// configuration: the same compatibility date, bindings and asset routing.
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      // The test harness re-exports the source entry, not the config's `.wrangler/validate` tree:
      // the plugin above applies the same `@validateRpc()` transform in memory. It adds a
      // test-only SQLite Durable Object for the storage tests, bound below until the `Repo`
      // Durable Object's binding replaces it.
      main: "./__tests__/repo-harness.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        durableObjects: {
          STORAGE_TEST: { className: "StorageTestObject", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@railhead/scripts/assert-workerd"],
  },
});
