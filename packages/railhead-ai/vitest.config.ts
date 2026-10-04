import { defineConfig } from "vitest/config";

// The adapter reaches Workers AI only through the binding its caller passes in, so its tests run
// under Node against recorded responses. The backend tests the adapter inside workerd through the
// conflicts module.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
