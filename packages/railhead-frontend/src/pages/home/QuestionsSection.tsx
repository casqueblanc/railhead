import { Button, Empty, SkeletonLine } from "@cloudflare/kumo";
import { WarningCircleIcon } from "@phosphor-icons/react";
import type { BoardFeed } from "../../features/claims/boardFeed";
import type { DecisionActions } from "../../features/decisions/decisionActions";
import { DecisionsPanel } from "../../features/decisions/DecisionsPanel";

interface QuestionsSectionProps {
  feed: BoardFeed;
  actions: DecisionActions;
  /** Reopens the session and reads the board again. */
  onRetry: () => void;
}

/** The questions queue, with the loading and failed states of the board it reads. */
export const QuestionsSection = ({ feed, actions, onRetry }: QuestionsSectionProps) => (
  <section aria-label="Questions" aria-busy={feed.kind === "loading"}>
    {feed.kind === "loading" && (
      <div className="grid gap-2">
        <span className="sr-only">Loading questions…</span>
        <SkeletonLine />
        <SkeletonLine />
      </div>
    )}
    {feed.kind === "failed" && (
      <Empty
        size="sm"
        icon={<WarningCircleIcon size={32} aria-hidden="true" />}
        title="Questions did not load"
        description="The board could not be read from the backend."
        contents={
          <Button variant="primary" onClick={onRetry}>
            Try again
          </Button>
        }
      />
    )}
    {feed.kind === "board" && <DecisionsPanel state={feed.board} actions={actions} />}
  </section>
);
