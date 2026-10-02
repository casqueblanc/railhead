import { Button, Empty, Loader } from "@cloudflare/kumo";
import { PlugsConnectedIcon, PlugsIcon } from "@phosphor-icons/react";
import { useApiConnection } from "../../rpc/useApiConnection";

/** The board's landing page. Until the board has content, it reports the backend connection. */
export const HomePage = () => {
  const { status, onRetry } = useApiConnection();

  return (
    <div className="flex flex-1 items-center justify-center p-4" aria-live="polite">
      {status === "connecting" && (
        <Empty icon={<Loader size="lg" />} title="Connecting to the backend…" />
      )}
      {status === "connected" && (
        <Empty
          icon={<PlugsConnectedIcon size={48} aria-hidden="true" />}
          title="Connected to the backend"
          description="The board has nothing to show yet."
        />
      )}
      {status === "lost" && (
        <Empty
          icon={<PlugsIcon size={48} aria-hidden="true" />}
          title="Connection to the backend lost"
          description="Check that the backend is running, then try again."
          contents={
            <Button variant="primary" onClick={onRetry}>
              Reconnect
            </Button>
          }
        />
      )}
    </div>
  );
};
