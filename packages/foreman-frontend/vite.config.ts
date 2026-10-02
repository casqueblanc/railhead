import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { typeCheckTask } from "@foreman/scripts/typecheck-task";
import { vitestTask } from "@foreman/scripts/vitest-task";

// `dist/` is this package's own build output, excluded from the inputs of the bundle and test
// tasks: vp declines to cache a task that reads a path it also wrote.
const ownDist = { pattern: "!dist/**", base: "package" } as const;

const runConfig = {
  run: {
    tasks: {
      // `tsconfig.vite.json` is the config-file pass, which the app's own `tsconfig.json` excludes.
      typecheck: typeCheckTask(["tsc", "tsc -p tsconfig.vite.json"]),
      /**
       * `build` is a task rather than a package.json script so `cache.env` can declare the `VITE_*`
       * flags a bundle may read: a cached `vp` run executes in a clean environment, and the values
       * would be missing from the fingerprint besides.
       */
      build: {
        command: "vite build",
        dependsOn: ["typecheck"],
        cache: {
          env: ["VITE_*"],
          input: [
            { auto: true },
            ownDist,
            // Wrangler's scratch bundles are randomly named, and tracking reaches past the package
            // that owns the task, so a sibling that ran `wrangler dev` would guarantee a miss.
            { pattern: "!**/.wrangler/**", base: "workspace" } as const,
          ],
          output: ["dist/**"],
        },
      },
      test: vitestTask("vitest run", [ownDist]),
    },
  },
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd());
  const backendHost = env.VITE_BACKEND_HOST?.trim() || "localhost:8787";
  return {
    // Spread, not a literal `run: {...}`: `run` is Vite+'s field and vite's own `defineConfig` has
    // no such property, but the excess-property check doesn't reach spreads.
    ...runConfig,
    plugins: [tanstackRouter({ target: "react", autoCodeSplitting: true }), react(), tailwindcss()],
    server: {
      port: 3000,
      // The client always opens its session on its own origin; in dev that is this server, which
      // forwards the WebSocket to `pnpm dev-server`.
      proxy: {
        "/api": { target: `http://${backendHost}`, ws: true },
      },
    },
    test: {
      environment: "jsdom",
      include: ["src/**/*.test.{ts,tsx}"],
    },
  };
});
