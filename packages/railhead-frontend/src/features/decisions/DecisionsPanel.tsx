import { Empty, Text } from "@cloudflare/kumo";
import { ChatCircleDotsIcon } from "@phosphor-icons/react";
import type { BoardState } from "../board/boardState";
import { DecisionCard } from "./DecisionCard";
import { cardAction, type DecisionActions } from "./decisionActions";
import { decisionQueue, type DecisionView } from "./decisionQueue";

interface DecisionsPanelProps {
  state: BoardState;
  actions: DecisionActions;
}

/**
 * The questions queue: decisions waiting for an answer, then answered ones, each list ordered by
 * how much work the decision affects.
 */
export const DecisionsPanel = ({ state, actions }: DecisionsPanelProps) => {
  const queue = decisionQueue(state);
  const action = cardAction(actions, state.stream);

  if (queue.open.length === 0 && queue.decided.length === 0) {
    return (
      <Empty
        icon={<ChatCircleDotsIcon size={48} aria-hidden="true" />}
        title="No questions yet"
        description="Questions agents ask appear here for you to answer."
      />
    );
  }

  const section = (title: string, views: readonly DecisionView[]) => (
    <section className="grid gap-3" aria-label={title}>
      <Text as="h2" variant="heading">
        {title} <span className="tabular-nums text-kumo-subtle">{views.length}</span>
      </Text>
      {views.map((view) => (
        <DecisionCard key={view.decisionId} view={view} agents={state.agents} action={action} />
      ))}
    </section>
  );

  return (
    <div className="grid gap-8">
      {queue.open.length > 0 && section("Waiting for an answer", queue.open)}
      {queue.decided.length > 0 && section("Decided", queue.decided)}
    </div>
  );
};
