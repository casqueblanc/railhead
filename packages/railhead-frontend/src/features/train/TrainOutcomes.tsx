import { Button, Empty, LayerCard, SkeletonLine, Text } from "@cloudflare/kumo";
import { useId } from "react";
import { GitMergeIcon, WarningCircleIcon } from "@phosphor-icons/react";
import type { CheckDetailPort } from "../board/boardPorts";
import { feedView, type BoardFeed } from "../claims/boardFeed";
import { FeedStatus } from "../claims/FeedStatus";
import { CheckRunItem } from "./CheckRunItem";
import { checkRuns } from "./checkRuns";
import { TrainRunItem } from "./TrainRunItem";
import { trainRuns } from "./trainRuns";

interface TrainOutcomesProps {
  feed: BoardFeed;
  /** Reads what the backend recorded for a check run. */
  checks: CheckDetailPort;
  /** Reopens the session and reads the board again. */
  onRetry: () => void;
}

/**
 * The train's merge intents and what became of each, newest first, then its check runs that reported
 * a result or timed out, failed ones included, newest first.
 */
export const TrainOutcomes = ({ feed, checks, onRetry }: TrainOutcomesProps) => {
  const headingId = useId();
  const checksHeadingId = useId();
  const view = feedView(feed);
  const runs = "board" in view ? trainRuns(view.board) : [];
  const checked = "board" in view ? checkRuns(view.board) : { runs: [], omitted: 0 };

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
          {checked.runs.length > 0 && (
            <section aria-labelledby={checksHeadingId} className="border-t border-kumo-line">
              <Text as="h3" variant="heading" DANGEROUS_className="px-4 pt-3">
                <span id={checksHeadingId}>Check runs</span>
              </Text>
              <ul className="grid divide-y divide-kumo-line">
                {checked.runs.map((run) => (
                  <CheckRunItem key={run.checkRunId} run={run} checks={checks} />
                ))}
              </ul>
              {checked.omitted > 0 && (
                <Text variant="secondary" DANGEROUS_className="px-4 pb-3">
                  {checked.omitted} older check runs are not listed; the totals count them.
                </Text>
              )}
            </section>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};
