import { defineConfig } from "vite-plus";

/**
 * Repo-wide toolchain config: the format and lint rules `vp check` enforces. Vite+ pins the oxfmt
 * and oxlint it runs, so there is one toolchain config and one version, and no `.oxlintrc.json`.
 */
export default defineConfig({
  fmt: {
    printWidth: 100,
    ignorePatterns: [
      // Imported skills keep their upstream text byte for byte; see engineering/UPSTREAM.md.
      "engineering/**",
      // Generated, and compared byte for byte by `pnpm configs:check`.
      "**/wrangler.jsonc",
      "**/worker-configuration.d.ts",
      "**/*.gen.ts",
      "pnpm-lock.yaml",
    ],
  },
  lint: {
    categories: {
      correctness: "error",
      suspicious: "error",
    },
    plugins: ["typescript", "unicorn", "oxc", "import"],
    options: {
      // Type-aware rules are not enabled: `no-floating-promises` conflicts with RPC promise
      // pipelining, which deliberately leaves promises unawaited. Type safety is enforced by
      // `tsc` through `pnpm build`.
      typeAware: false,
    },
    env: {
      es2024: true,
    },
    rules: {
      // Side-effect imports are deliberate: CSS (`./styles.css`).
      "import/no-unassigned-import": "off",

      // Do not require `_` prefixes on unused callback or interface parameters or catch bindings,
      // but still flag unused imports and local variables.
      "no-unused-vars": [
        "error",
        {
          args: "none",
          caughtErrors: "none",
          varsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
    ignorePatterns: [
      "**/dist/**",
      "**/*.gen.ts",
      "**/node_modules/**",
      "**/.wrangler/**",
      "**/worker-configuration.d.ts",
    ],
    overrides: [
      {
        files: ["packages/foreman-frontend/**/*.{ts,tsx}"],
        plugins: ["typescript", "unicorn", "oxc", "import", "react", "jsx-a11y"],
        env: {
          browser: true,
          es2024: true,
        },
      },
      {
        // Cloudflare Workers code: worker global scope.
        files: ["packages/foreman-backend/**/*.ts", "packages/foreman-shared/**/*.ts"],
        env: {
          serviceworker: true,
          es2024: true,
        },
      },
      {
        files: ["**/*.test.ts", "**/*.test.tsx", "**/vitest.config.ts"],
        plugins: ["typescript", "unicorn", "oxc", "import", "vitest"],
        env: {
          vitest: true,
          es2024: true,
        },
      },
      {
        // Hook tests capture the hook's return value from a throwaway probe component into a `let`
        // in the enclosing `describe`. Reassigning an outer variable during render is the point
        // there, not the production side effect `react/globals` guards against.
        files: ["packages/foreman-frontend/**/*.test.tsx"],
        plugins: ["typescript", "unicorn", "oxc", "import", "react", "jsx-a11y", "vitest"],
        rules: {
          "react/globals": "off",
          // The automatic JSX runtime (`"jsx": "react-jsx"`) needs no `React` in scope.
          "react/react-in-jsx-scope": "off",
        },
      },
      {
        files: ["scripts/**/*.ts", "engineering/**/*.mjs", "**/cloudflare.config.ts"],
        env: {
          node: true,
          es2024: true,
        },
      },
      {
        // `scripts/` and `engineering/` tests run under `node --test`, not vitest, so they must
        // not pick up the vitest override above. Ordered last so it wins over that entry.
        files: ["scripts/**/*.test.ts", "engineering/**/*.test.mjs"],
        plugins: ["typescript", "unicorn", "oxc", "import"],
        env: {
          node: true,
          es2024: true,
        },
      },
    ],
  },
});
