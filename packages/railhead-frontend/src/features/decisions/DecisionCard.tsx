import { Badge, LayerCard, Text } from "@cloudflare/kumo";
import type { AgentState } from "../board/boardState";
import { DecisionAnswerForm } from "./DecisionAnswerForm";
import { DecisionRippleTable } from "./DecisionRippleTable";
import type { DecisionCardAction } from "./decisionActions";
import type { DecisionView } from "./decisionQueue";

interface DecisionCardProps {
  view: DecisionView;
  agents: Readonly<Record<string, AgentState>>;
  action: DecisionCardAction;
}

/** One decision: the questions behind it, its answer history, its ripple and the answer form. */
export const DecisionCard = ({ view, agents, action }: DecisionCardProps) => {
  const [current, ...replaced] = view.versions;
  const [first, ...others] = view.questions;
  const affected = view.affectedClaims.length;

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-2">
        <span translate="no">{view.decisionId}</span>
        <span className="tabular-nums">
          Affects {affected} {affected === 1 ? "claim" : "claims"}
        </span>
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-5 px-5 py-4">
        <div className="grid gap-1.5">
          <Text as="h3" variant="heading" DANGEROUS_className="break-words text-pretty">
            {first?.text}
          </Text>
          {others.length > 0 && (
            <ul className="grid gap-1">
              {others.map((question) => (
                <li key={question.questionId}>
                  <Text variant="secondary" DANGEROUS_className="break-words">
                    Also asked: {question.text}
                  </Text>
                </li>
              ))}
            </ul>
          )}
        </div>

        {current !== undefined && (
          <section className="grid gap-2" aria-label="Answer history">
            <ol className="grid gap-1.5">
              <li className="flex flex-wrap items-center gap-2">
                <Badge variant="primary">Version {current.version}</Badge>
                <Text as="span" DANGEROUS_className="break-words">
                  {current.label ?? current.option}
                </Text>
              </li>
              {replaced.map((version) => (
                <li key={version.version} className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">Version {version.version}</Badge>
                  <Text
                    as="span"
                    variant="secondary"
                    DANGEROUS_className="break-words line-through"
                  >
                    {version.label ?? version.option}
                  </Text>
                  <Text as="span" variant="secondary">
                    replaced
                  </Text>
                </li>
              ))}
            </ol>
            {current.scope.length > 0 && (
              <Text variant="secondary" DANGEROUS_className="break-words">
                Scope:{" "}
                <span className="font-mono text-[0.9em]" translate="no">
                  {current.scope.join(", ")}
                </span>
              </Text>
            )}
          </section>
        )}

        {current !== undefined && (
          <section className="grid gap-2">
            <Text as="h4" variant="heading">
              Who has version {current.version}
            </Text>
            <DecisionRippleTable version={current.version} rows={view.ripple} agents={agents} />
          </section>
        )}

        <DecisionAnswerForm
          key={current?.version ?? 0}
          decisionId={view.decisionId}
          options={view.options}
          current={
            current === undefined ? null : { version: current.version, option: current.option }
          }
          action={action}
        />
      </LayerCard.Primary>
    </LayerCard>
  );
};
