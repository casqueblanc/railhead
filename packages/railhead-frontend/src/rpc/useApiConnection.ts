import { useEffect, useState } from "react";
import { type ApiSession, openApiSession } from "./apiSession";

/** Where the backend session stands. `lost` covers a failed first probe and a later break. */
export type ConnectionStatus = "connecting" | "connected" | "lost";

/**
 * The session of one connection attempt. A new object per attempt, so it identifies the attempt;
 * the stub is wrapped because React would call a stub passed to a state setter.
 */
export interface CurrentSession {
  readonly api: ApiSession;
}

/**
 * Owns one RPC session for the lifetime of the calling component and reports whether the backend
 * answers. A lost session is replaced only when the caller asks, so a dead backend is never
 * retried in a loop. `session` is the current attempt's session until its Effect is cleaned up; it
 * is disposed then, so a caller must not use it afterwards.
 */
export const useApiConnection = (
  connect: () => ApiSession = openApiSession,
): { status: ConnectionStatus; session: CurrentSession | null; onRetry: () => void } => {
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [session, setSession] = useState<CurrentSession | null>(null);

  useEffect(() => {
    let current = true;
    const api = connect();
    const markLost = () => {
      if (current) setStatus("lost");
    };
    api.onRpcBroken(markLost);
    api.ping().then(() => {
      if (current) setStatus("connected");
    }, markLost);
    setSession({ api });
    return () => {
      current = false;
      setSession(null);
      api[Symbol.dispose]();
    };
  }, [attempt, connect]);

  const onRetry = () => {
    setStatus("connecting");
    setAttempt((n) => n + 1);
  };
  return { status, session, onRetry };
};
