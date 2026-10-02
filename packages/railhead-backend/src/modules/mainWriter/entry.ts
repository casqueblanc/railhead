// Main writer: publishes authorized intents to main and reconciles uncertain writes. It is the only
// module that receives main's ref. Until its task installs the module, every call refuses with
// `unavailable` and has no effect.

import { unavailableMainWriter } from "../../contracts/unavailable";
import type { MainWriterFactory } from "../../repo/composeRepo";

/** Builds the main writer of one repository. */
export const mainWriter: MainWriterFactory = () => unavailableMainWriter;
