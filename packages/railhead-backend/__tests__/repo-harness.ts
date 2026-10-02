// The Worker the backend tests run: the real entry, plus a SQLite-backed Durable Object that gives
// the `repo/` storage tests real Durable Object storage. Test-only: nothing in `src/` imports it,
// and the binding below exists only in vitest.config.ts until the `Repo` Durable Object replaces it.

import { DurableObject } from "cloudflare:workers";

export { default } from "../src/server";

/** A Durable Object with no behaviour of its own; tests reach its storage through `runInDurableObject`. */
export class StorageTestObject extends DurableObject {}

declare global {
  namespace Cloudflare {
    interface Env {
      /** The test-only namespace of `StorageTestObject`, declared in vitest.config.ts. */
      STORAGE_TEST: DurableObjectNamespace<StorageTestObject>;
    }
  }
}
