import { SELF, evictAllDurableObjects } from "cloudflare:test";
import type { UploadTarget } from "./checks";

/** The Worker under test, with restarts that evict every Durable Object so reads hit storage. */
export const workerTarget: UploadTarget = {
  fetch: (path, init) => SELF.fetch(new URL(path, "https://upload.invalid"), init),
  restart: () => evictAllDurableObjects(),
};
