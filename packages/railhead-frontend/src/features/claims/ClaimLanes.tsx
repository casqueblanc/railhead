import { Button, Empty, LayerCard, SkeletonLine, Text } from "@cloudflare/kumo";
import { useId } from "react";
import { GitBranchIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { feedView, type BoardFeed } from "./boardFeed";
import { ClaimLane } from "./ClaimLane";
import { claimLanes } from "./lanes";
import { FeedStatus } from "./FeedStatus";

interface ClaimLanesProps {
  feed: BoardFeed;
  /** Reopens the session and reads the board again. */
  onRetry: () => void;
}

/** Every claim on the board as a lane, blocked lanes first. */
export const ClaimLanes = ({ feed, onRetry }: ClaimLanesProps) => {
  const headingId = useId();
  const view = feedView(feed);
  const lanes = "board" in view ? claimLanes(view.board) : [];

  return (
    <section aria-labelledby={headingId} aria-busy={view.kind === "loading"}>
      <LayerCard>
        <LayerCard.Secondary className="flex items-center justify-between gap-2">
          <Text as="h2" variant="heading" DANGEROUS_className="text-balance">
            <span id={headingId}>Claims</span>
          </Text>
          {"board" in view && (
            <span className="tabular-nums text-kumo-subtle">
              {lanes.length}
              <span className="sr-only"> claims</span>
            </span>
          )}
        </LayerCard.Secondary>
        <LayerCard.Primary className="grid gap-3 p-0">
          <div aria-live="polite" className="empty:hidden px-4 pt-3">
            <FeedStatus view={view} onRetry={onRetry} />
          </div>
          {view.kind === "loading" && (
            <div className="grid gap-2 px-4 py-3">
              <span className="sr-only">Loading claims…</span>
              <SkeletonLine />
              <SkeletonLine />
              <SkeletonLine />
            </div>
          )}
          {view.kind === "failed" && (
            <Empty
              size="sm"
              icon={<WarningCircleIcon size={32} aria-hidden="true" />}
              title="Claims did not load"
              description="The board could not be read from the backend."
              contents={
                <Button variant="primary" onClick={onRetry}>
                  Try again
                </Button>
              }
            />
          )}
          {"board" in view && lanes.length === 0 && (
            <Empty
              size="sm"
              icon={<GitBranchIcon size={32} aria-hidden="true" />}
              title="No claims yet"
              description="A lane appears here when an agent claims an issue."
            />
          )}
          {lanes.length > 0 && (
            <ul className="grid divide-y divide-kumo-line">
              {lanes.map((lane) => (
                <ClaimLane key={lane.claimId} lane={lane} />
              ))}
            </ul>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};
