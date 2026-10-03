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
      // same `@validateRpc()` transform in memory. The `Repo` binding is the generated config's.
      main: "./src/server.ts",
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests never reach a live resource: the Artifacts binding is always remote, so without this
      // the pool opens a remote session for it. Tests that need Artifacts stub it.
      remoteBindings: false,
      // A fixed test value, never a real secret, so agent logins over HTTP work in the pool.
      miniflare: {
        bindings: { SESSION_SIGNING_SECRET: "test-only-session-signing-secret-0123456789" },
      },
    }),
  ],
  test: {
    include: ["__tests__/*.test.ts"],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@railhead/scripts/assert-workerd"],
  },
});
