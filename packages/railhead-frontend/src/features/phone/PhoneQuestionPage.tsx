import { Badge, Empty, LayerCard, Text } from "@cloudflare/kumo";
import { LinkBreakIcon } from "@phosphor-icons/react";
import type { DecisionId } from "@railhead/shared/events";
import { gateOnConnection, type BoardPorts } from "../board/boardPorts";
import type { BoardState } from "../board/boardState";
import { DecisionAnswerForm } from "../decisions/DecisionAnswerForm";
import { cardAction, type DecisionActions } from "../decisions/decisionActions";
import { decisionQueue } from "../decisions/decisionQueue";
import { InvalidLink } from "./InvalidLink";
import { PhoneFrame } from "./PhoneFrame";
import type { PhoneTarget } from "./phoneLinks";

interface PhoneQuestionPageProps {
  ports: BoardPorts;
  /** The decision the link names. The link grants nothing; the answer needs a passkey. */
  target: PhoneTarget<DecisionId>;
}

/** One question, opened from a link on a phone, with the form that answers it. */
export const PhoneQuestionPage = ({ ports, target }: PhoneQuestionPageProps) => {
  const gated = gateOnConnection(ports);
  if (target.kind === "invalid") return <InvalidLink />;
  return (
    <PhoneFrame ports={gated} title="Answer a question">
      {(board) => <Question board={board} decisionId={target.id} actions={gated.decisions} />}
    </PhoneFrame>
  );
};

interface QuestionProps {
  board: BoardState;
  decisionId: DecisionId;
  actions: DecisionActions;
}

const Question = ({ board, decisionId, actions }: QuestionProps) => {
  const queue = decisionQueue(board);
  const view = [...queue.open, ...queue.decided].find((item) => item.decisionId === decisionId);
  if (view === undefined) {
    return (
      <Empty
        icon={<LinkBreakIcon size={48} aria-hidden="true" />}
        title="This question is not on the board"
        description="The link may be for another Railhead, or the board has not reached it yet. Open the board to see the questions waiting for you."
      />
    );
  }
  const [current] = view.versions;
  const [first, ...others] = view.questions;

  return (
    <LayerCard>
      <LayerCard.Secondary className="flex flex-wrap items-center justify-between gap-2">
        <span translate="no" className="min-w-0 break-all">
          {view.decisionId}
        </span>
        {current === undefined ? (
          <Badge variant="warning">Waiting for an answer</Badge>
        ) : (
          <Badge variant="primary">Version {current.version}</Badge>
        )}
      </LayerCard.Secondary>
      <LayerCard.Primary className="grid gap-5 px-4 py-4">
        <div className="grid gap-1.5">
          <Text as="h3" variant="heading" DANGEROUS_className="break-words text-pretty">
            {first?.text}
          </Text>
          {others.map((question) => (
            <Text key={question.questionId} variant="secondary" DANGEROUS_className="break-words">
              Also asked: {question.text}
            </Text>
          ))}
          {current !== undefined && (
            <Text variant="secondary" DANGEROUS_className="break-words">
              Current answer: {current.label ?? current.option}
            </Text>
          )}
        </div>
        <DecisionAnswerForm
          key={`${view.decisionId}:${current?.version ?? 0}`}
          decisionId={view.decisionId}
          options={view.options}
          current={
            current === undefined ? null : { version: current.version, option: current.option }
          }
          action={cardAction(actions, board.stream)}
        />
      </LayerCard.Primary>
    </LayerCard>
  );
};
