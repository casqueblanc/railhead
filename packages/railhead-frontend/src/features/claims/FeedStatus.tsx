import { Banner, Button } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  CheckCircleIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { BoardFault } from "../board/boardState";
import type { FeedView } from "./boardFeed";

interface FeedStatusProps {
  view: FeedView;
  /** Reopens the session and reads the board again. */
  onRetry: () => void;
}

/**
 * Says when a section's content is not the live board: stopped, behind the log or just caught up.
 * Renders nothing for a live board or for states without content. The caller places it in a
 * persistent polite live region; a stopped board also announces itself as an alert.
 */
export const FeedStatus = ({ view, onRetry }: FeedStatusProps) => {
  switch (view.kind) {
    case "loading":
    case "failed":
    case "live":
      return null;
    case "halted":
      return (
        <div role="alert">
          <Banner
            size="sm"
            variant="error"
            icon={<XCircleIcon weight="fill" aria-hidden="true" />}
            title={`Board stopped at event ${view.fault.seq}`}
            description={`${faultText(view.fault)} Showing the board through event ${view.board.cursor}.`}
            action={
              <Button size="sm" onClick={onRetry}>
                Reload board
              </Button>
            }
          />
        </div>
      );
    case "stale":
      return (
        <>
          {view.reason.kind === "disconnected" ? (
            <Banner
              size="sm"
              variant="alert"
              icon={<WarningIcon weight="fill" aria-hidden="true" />}
              title="Disconnected"
              description={`Showing the board through event ${view.board.cursor}. Later events appear after you reconnect.`}
              action={
                <Button
                  size="sm"
                  icon={<ArrowsClockwiseIcon aria-hidden="true" />}
                  onClick={onRetry}
                >
                  Reconnect
                </Button>
              }
            />
          ) : (
            <Banner
              size="sm"
              variant="alert"
              icon={<WarningIcon weight="fill" aria-hidden="true" />}
              title={`Waiting for events ${view.reason.expected}–${view.reason.through}`}
              description={`Showing the board through event ${view.board.cursor} until the missing events arrive.`}
            />
          )}
        </>
      );
    case "recovered":
      return (
        <Banner
          size="sm"
          variant="secondary"
          icon={<CheckCircleIcon weight="fill" aria-hidden="true" />}
          title="Back in sync"
          description={`Caught up through event ${view.board.cursor}.`}
        />
      );
    default:
      return unreachable(view);
  }
};

const faultText = (fault: BoardFault): string => {
  switch (fault.kind) {
    case "unsupported_version":
      return `It uses event schema version ${fault.version}, which this board cannot read.`;
    case "invalid_event":
      return "It failed validation.";
    case "foreign_repo":
      return "It belongs to another repository.";
    case "inconsistent":
      return `It contradicts the log: ${fault.message}.`;
    default:
      return unreachable(fault);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled board status: ${JSON.stringify(value)}`);
};
