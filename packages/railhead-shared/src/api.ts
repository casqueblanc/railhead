import type { RpcTarget } from "capnweb";
import type { RepoSegment } from "./agent-api.ts";
import type { BoardApi, BoardResult, DemoSeedApi, OwnerEnrollmentApi } from "./board-api.ts";

/** Path on the backend origin where the Cap'n Web session is served. */
export const API_PATH = "/api";

/** Public API exposed to the internet, before any authentication. */
export interface PublicApi extends RpcTarget {
  /** Confirms that the RPC connection can round-trip without performing application work. */
  ping(): Promise<void>;
}

/**
 * The complete public surface of the RPC session: `PublicApi` plus the entry points to the board.
 */
export interface RailheadApi extends PublicApi {
  /**
   * Opens the board for the repository `org/repo`: read access to its log and the entry point for
   * its owner's passkey actions. Fails with `not_found` when there is no such repository.
   */
  openBoard(org: RepoSegment, repo: RepoSegment): Promise<BoardResult<BoardApi>>;
  /** The instance owner's passkey enrollment, open only until it first succeeds. */
  ownerEnrollment(): Promise<OwnerEnrollmentApi>;
  /** Seeding and resetting the demo repository, each action approved with the owner passkey. */
  demoSeed(): Promise<DemoSeedApi>;
}
