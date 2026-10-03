import { Button, Empty, Loader } from "@cloudflare/kumo";
import { PlugsIcon, SquaresFourIcon } from "@phosphor-icons/react";
import type { ConnectionStatus } from "../../rpc/useApiConnection";

interface BoardUnavailableProps {
  connection: ConnectionStatus;
  onReconnect: () => void;
}

/** The whole page when the backend serves no board, by what the connection says. */
export const BoardUnavailable = ({ connection, onReconnect }: BoardUnavailableProps) => {
  switch (connection) {
    case "connecting":
      return <Empty icon={<Loader size="lg" />} title="Connecting to the backend…" />;
    case "lost":
      return (
        <Empty
          icon={<PlugsIcon size={48} aria-hidden="true" />}
          title="Connection to the backend lost"
          description="Check that the backend is running, then reconnect."
          contents={
            <Button variant="primary" onClick={onReconnect}>
              Reconnect
            </Button>
          }
        />
      );
    case "connected":
      return (
        <Empty
          icon={<SquaresFourIcon size={48} aria-hidden="true" />}
          title="No board on this Railhead yet"
          description="The backend is connected but does not serve a board for this repository. Claims, questions and merges appear here once it does."
        />
      );
    default:
      return unreachable(connection);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled connection status: ${JSON.stringify(value)}`);
};
