import { type ApiSession, openApiSession } from "../../rpc/apiSession";
import { useApiConnection } from "../../rpc/useApiConnection";
import type { BoardPorts } from "./boardPorts";

/**
 * Binds the board page's ports to the one backend session. The backend does not serve a board yet,
 * so the board, the decision action and the owner's actions are all reported unavailable; only the
 * connection itself is live.
 */
export const useLiveBoardPorts = (connect: () => ApiSession = openApiSession): BoardPorts => {
  const { status, onRetry } = useApiConnection(connect);
  const reason = status === "lost" ? "offline" : "module_unavailable";
  return {
    connection: status,
    onReconnect: onRetry,
    board: { kind: "unavailable" },
    decisions: { kind: "unavailable", reason },
    owner: { kind: "unavailable", reason },
  };
};
