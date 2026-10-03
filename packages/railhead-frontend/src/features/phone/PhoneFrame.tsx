import { Button, Empty, Link, Loader, SkeletonLine, Text } from "@cloudflare/kumo";
import { PlugsIcon, SquaresFourIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import type { BoardPorts } from "../board/boardPorts";
import type { BoardState } from "../board/boardState";

interface PhoneFrameProps {
  /** The page's ports, already gated on the connection. */
  ports: BoardPorts;
  /** What the page is for, as its heading. */
  title: string;
  /** The page's content once a board is folded. */
  children: (board: BoardState) => ReactNode;
}

/**
 * One phone page: a single column with its heading, the board's loading, failed and lost states,
 * and a way back to the full board.
 */
export const PhoneFrame = ({ ports, title, children }: PhoneFrameProps) => (
  <div className="mx-auto grid w-full max-w-xl content-start gap-4 px-4 py-4">
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
      <Text as="h2" variant="heading" size="lg" DANGEROUS_className="text-balance">
        {title}
      </Text>
      <Link href="/" variant="inline">
        Open the board
      </Link>
    </div>
    <div className="grid gap-4">
      <Body ports={ports}>{children}</Body>
    </div>
  </div>
);

const Body = ({ ports, children }: Omit<PhoneFrameProps, "title">) => {
  const { board, connection, onReconnect } = ports;
  if (board.kind === "unavailable") {
    return (
      <Empty
        icon={<SquaresFourIcon size={48} aria-hidden="true" />}
        title="No board on this Railhead"
        description="The backend does not serve a board for this repository, so there is nothing to open here."
      />
    );
  }
  const { feed } = board;
  switch (feed.kind) {
    case "loading":
      return connection === "connecting" ? (
        <Empty icon={<Loader size="lg" />} title="Connecting to the backend…" />
      ) : (
        <div className="grid gap-2" aria-busy="true">
          <span className="sr-only">Loading the board…</span>
          <SkeletonLine />
          <SkeletonLine />
        </div>
      );
    case "failed":
      return (
        <Empty
          icon={<WarningCircleIcon size={48} aria-hidden="true" />}
          title="The board did not load"
          description="The board could not be read from the backend."
          contents={
            <Button variant="primary" onClick={onReconnect}>
              Try again
            </Button>
          }
        />
      );
    case "board":
      return (
        <>
          {feed.connection === "lost" && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="flex min-w-0 items-start gap-1.5">
                <span className="flex h-lh items-center text-kumo-subtle">
                  <PlugsIcon size={14} aria-hidden="true" />
                </span>
                <Text as="span" variant="secondary">
                  Connection lost. This page may be out of date and cannot act until it reconnects.
                </Text>
              </span>
              <Button size="sm" onClick={onReconnect}>
                Reconnect
              </Button>
            </div>
          )}
          {children(feed.board)}
        </>
      );
    default:
      return unreachable(feed);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled phone page variant: ${JSON.stringify(value)}`);
};
