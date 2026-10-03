// Replay: capturing a real event log and replaying it offline. Capture reads the public board log
// (`openBoard`, then `readEvents`) through `scripts/capture-replay.mjs`, and the board's /replay
// page folds the file in the browser, so neither needs a Repo method of its own. The port stays
// empty until an adapter needs one; nothing calls it.

import type { ModuleFactory } from "../../repo/composeRepo";

/** The replay module's port. It has no methods: capture and replay need none from the Repo. */
export type ReplayPort = Readonly<Record<never, never>>;

/** Builds the replay module of one repository. */
export const replay: ModuleFactory<ReplayPort> = () => ({});
