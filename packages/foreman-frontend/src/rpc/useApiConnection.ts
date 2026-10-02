import { useEffect, useState } from "react";
import { type ApiSession, openApiSession } from "./apiSession";

/** Where the backend session stands. `lost` covers a failed first probe and a later break. */
export type ConnectionStatus = "connecting" | "connected" | "lost";

/**
 * Owns one RPC session for the lifetime of the calling component and reports whether the backend
 * answers. A lost session is replaced only when the caller asks, so a dead backend is never
 * retried in a loop.
 */
export const useApiConnection = (
  connect: () => ApiSession = openApiSession,
): { status: ConnectionStatus; onRetry: () => void } => {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    let current = true;
    const session = connect();
    const markLost = () => {
      if (current) setStatus("lost");
    };
    session.onRpcBroken(markLost);
    session.ping().then(() => {
      if (current) setStatus("connected");
    }, markLost);
    return () => {
      current = false;
      session[Symbol.dispose]();
    };
  }, [attempt, connect]);

  const onRetry = () => {
    setStatus("connecting");
    setAttempt((n) => n + 1);
  };
  return { status, onRetry };
};
