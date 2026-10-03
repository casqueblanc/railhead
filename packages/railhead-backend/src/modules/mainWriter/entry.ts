// Main writer: publishes authorized intents to main and reconciles uncertain writes. It is the only
// module that receives main's ref. The implementation is `createMainWriter` in `mainWriter.ts`.

import type { MainWriterFactory } from "../../repo/composeRepo";
import { createMainWriter } from "./mainWriter";

/** Builds the main writer of one repository. */
export const mainWriter: MainWriterFactory = (context, ports, mainRef) =>
  createMainWriter(
    context,
    () => {
      const { authorization, claims, decisions, train } = ports();
      return {
        authorization,
        attemptOutcome: (attemptId) => train.attemptOutcome(attemptId),
        currentGeneration: (claimId) => claims.currentGeneration(claimId),
        currentVersions: (claimId) => decisions.currentVersions(claimId),
      };
    },
    mainRef,
  );
