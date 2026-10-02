import { Button, Empty, LayerCard, SkeletonLine, Text } from "@cloudflare/kumo";
import { useId } from "react";
import { GitMergeIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { feedView, type BoardFeed } from "../claims/boardFeed";
import { FeedStatus } from "../claims/FeedStatus";
import { TrainRunItem } from "./TrainRunItem";
import { trainRuns } from "./trainRuns";

interface TrainOutcomesProps {
  feed: BoardFeed;
  /** Reopens the session and reads the board again. */
  onRetry: () => void;
}

/** The train's merge intents and what became of each, newest first. */
export const TrainOutcomes = ({ feed, onRetry }: TrainOutcomesProps) => {
  const headingId = useId();
  const view = feedView(feed);
  const runs = "board" in view ? trainRuns(view.board) : [];

  return (
    <section aria-labelledby={headingId} aria-busy={view.kind === "loading"}>
      <LayerCard>
        <LayerCard.Secondary className="flex items-center justify-between gap-2">
          <Text as="h2" variant="heading" DANGEROUS_className="text-balance">
            <span id={headingId}>Train</span>
          </Text>
          {"board" in view && (
            <span className="tabular-nums text-kumo-subtle">
              {runs.length}
              <span className="sr-only"> merges</span>
            </span>
          )}
        </LayerCard.Secondary>
        <LayerCard.Primary className="grid gap-3 p-0">
          <div aria-live="polite" className="empty:hidden px-4 pt-3">
            <FeedStatus view={view} onRetry={onRetry} />
          </div>
          {view.kind === "loading" && (
            <div className="grid gap-2 px-4 py-3">
              <span className="sr-only">Loading train outcomes…</span>
              <SkeletonLine />
              <SkeletonLine />
            </div>
          )}
          {view.kind === "failed" && (
            <Empty
              size="sm"
              icon={<WarningCircleIcon size={32} aria-hidden="true" />}
              title="Train outcomes did not load"
              description="The board could not be read from the backend."
              contents={
                <Button variant="primary" onClick={onRetry}>
                  Try again
                </Button>
              }
            />
          )}
          {"board" in view && runs.length === 0 && (
            <Empty
              size="sm"
              icon={<GitMergeIcon size={32} aria-hidden="true" />}
              title="Nothing merged yet"
              description="A merge appears here when the train tries to land a ready claim."
            />
          )}
          {runs.length > 0 && (
            <ul className="grid divide-y divide-kumo-line">
              {runs.map((run) => (
                <TrainRunItem key={run.intentId} run={run} />
              ))}
            </ul>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};
