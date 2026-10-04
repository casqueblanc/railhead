import { Empty, LayerCard, SkeletonLine, Text } from "@cloudflare/kumo";
import { ChartBarIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useId } from "react";
import { feedView, type BoardFeed, type FeedView } from "../claims/boardFeed";
import { boardMetrics, type BoardMetrics } from "./metrics";

/**
 * Raw totals counted from the log: questions, human actions, reported checks including failures,
 * checks that timed out or were held, changes landed, active claims and the recent window. Every number is a count of recorded events.
 */
export const TotalsPanel = ({ feed }: { feed: BoardFeed }) => {
  const headingId = useId();
  const view = feedView(feed);
  return (
    <section aria-labelledby={headingId} aria-busy={view.kind === "loading"}>
      <LayerCard>
        <LayerCard.Secondary>
          <Text as="h2" variant="heading">
            <span id={headingId}>Totals</span>
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="grid gap-3 px-4 py-3">
          <TotalsBody view={view} />
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};

const TotalsBody = ({ view }: { view: FeedView }) => {
  switch (view.kind) {
    case "loading":
      return (
        <div className="grid gap-2">
          <span className="sr-only">Loading totals…</span>
          <SkeletonLine />
          <SkeletonLine />
        </div>
      );
    case "failed":
      return (
        <Empty
          size="sm"
          icon={<WarningCircleIcon size={32} aria-hidden="true" />}
          title="Totals did not load"
          description="The board could not be read from the backend."
        />
      );
    case "halted":
    case "stale":
    case "recovered":
    case "live": {
      const { board } = view;
      if (board.cursor === 0) {
        return (
          <Empty
            size="sm"
            icon={<ChartBarIcon size={32} aria-hidden="true" />}
            title="Nothing counted yet"
            description={emptyReason(view.kind)}
          />
        );
      }
      return (
        <>
          <Counts metrics={boardMetrics(board)} />
          <Text variant="secondary">
            Counted from events 1–{board.cursor}
            {view.kind === "halted" || view.kind === "stale" ? ", while the board is not live" : ""}
            .
          </Text>
        </>
      );
    }
    default:
      return unreachable(view);
  }
};

/** Why no event is counted: a board stopped before its first event says so, not that none exist. */
const emptyReason = (kind: "halted" | "stale" | "recovered" | "live") => {
  switch (kind) {
    case "halted":
      return "The board stopped at the log's first event, so nothing could be counted.";
    case "stale":
      return "The board is not live and has applied no event yet.";
    case "recovered":
    case "live":
      return "Totals appear once the repository records its first event.";
    default:
      return unreachable(kind);
  }
};

const Counts = ({ metrics }: { metrics: BoardMetrics }) => {
  const { checks, recent } = metrics;
  const checksReported = checks.pass + checks.fail + checks.error;
  return (
    <>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Count label="Questions asked" value={metrics.questionsAsked} />
        <Count label="Human actions" value={metrics.humanActions} />
        <Count label="Checks reported" value={checksReported} />
        <Count label="Checks failed" value={checks.fail} />
        <Count label="Checks that could not run" value={checks.error} />
        <Count label="Checks timed out" value={metrics.checksTimedOut} />
        <Count label="Checks held for a person" value={metrics.checksHeld} />
        <Count label="Changes landed" value={metrics.changesLanded} />
        <Count label="Active claims" value={metrics.activeClaims} />
      </dl>
      {recent !== null && (
        <div className="grid gap-2">
          <Text as="h3" variant="secondary">
            In the last {recent.minutes === 1 ? "minute" : `${recent.minutes} minutes`} of the log
          </Text>
          <dl className="grid grid-cols-3 gap-x-4 gap-y-2">
            <Count label="Claims opened" value={recent.claimsOpened} />
            <Count label="Checks reported" value={recent.checksReported} />
            <Count label="Changes landed" value={recent.changesLanded} />
          </dl>
        </div>
      )}
    </>
  );
};

const Count = ({ label, value }: { label: string; value: number }) => (
  <div className="flex min-w-0 flex-col-reverse">
    <dt className="text-sm text-kumo-subtle">{label}</dt>
    <dd className="text-lg font-semibold tabular-nums">{value}</dd>
  </div>
);

const unreachable = (value: never): never => {
  throw new Error(`unhandled totals view: ${JSON.stringify(value)}`);
};
