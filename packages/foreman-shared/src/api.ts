import type { RpcTarget } from "capnweb";

/** Path on the backend origin where the Cap'n Web session is served. */
export const API_PATH = "/api";

/** Public API exposed to the internet, before any authentication. */
export interface PublicApi extends RpcTarget {
  /** Confirms that the RPC connection can round-trip without performing application work. */
  ping(): Promise<void>;
}
