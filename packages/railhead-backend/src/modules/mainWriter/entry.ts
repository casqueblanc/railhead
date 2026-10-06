// Main writer: publishes authorized intents to main and reconciles uncertain writes. It is the only
// module that receives main's ref. The implementation is `createMainWriter` in `mainWriter.ts`.

import type { MainWriterFactory } from "../../repo/composeRepo";
import { authorizationReaders } from "../authorization/entry";
import { createMainWriter } from "./mainWriter";

/** Builds the main writer of one repository. */
export const mainWriter: MainWriterFactory = (context, ports, mainRef) => {
  const readers = authorizationReaders(ports);
  return createMainWriter(
    context,
    () => ({ authorization: ports().authorization, ...readers }),
    mainRef,
  );
};
