import { useEffect, useState } from "react";
import type { CommitSha } from "@railhead/shared/events";
import { readAppRevision, type RevisionRead } from "./appRevision";

/** How often the board asks the app again, so a redeploy shows without a reload. */
export const REVISION_POLL_MS = 30_000;

/**
 * Reads the deployed app's revision now, whenever `main` moves, every {@link REVISION_POLL_MS}
 * and when the person asks. A read that a newer one replaced, or that finishes after unmount, is
 * dropped rather than applied.
 */
export const useAppRevision = (
  origin: string,
  main: CommitSha | null,
  fetchRevision: typeof fetch,
): { read: RevisionRead; onRecheck: () => void } => {
  const [read, setRead] = useState<RevisionRead>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      const result = await readAppRevision(origin, fetchRevision, controller.signal);
      if (controller.signal.aborted) return;
      setRead(result);
      timer = setTimeout(() => void check(), REVISION_POLL_MS);
    };
    void check();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [origin, main, fetchRevision, attempt]);

  return {
    read,
    onRecheck: () => {
      setRead({ kind: "checking" });
      setAttempt((n) => n + 1);
    },
  };
};
