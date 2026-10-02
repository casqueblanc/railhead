import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import checks from "./acceptance/checks.json";
import { SUITE_ENV, parseCheckDefinitions, selectSuite } from "./acceptance/select";

// The acceptance suite for the decision option in force, or the one UPLOAD_ACCEPTANCE names. A
// selection that matches no suite, or a suite file that is missing, fails the run instead of
// leaving only the fixture's own tests to pass.
const suite = selectSuite(parseCheckDefinitions(checks), process.env[SUITE_ENV]);
if (!existsSync(join(dirname(fileURLToPath(import.meta.url)), suite.file))) {
  throw new Error(`The selected acceptance suite ${suite.file} does not exist.`);
}

// Tests run inside workerd against wrangler.jsonc: the same compatibility date and bindings as the
// deployed app.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    include: ["__tests__/*.test.ts", suite.file],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ["@railhead/scripts/assert-workerd"],
    // Each acceptance check sends a body of 9 or 11 MB.
    testTimeout: 30_000,
  },
});
