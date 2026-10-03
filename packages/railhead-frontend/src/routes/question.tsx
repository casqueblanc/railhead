import { createFileRoute } from "@tanstack/react-router";
import { useLiveBoardPorts } from "../features/board/liveConnection";
import { PhoneQuestionPage } from "../features/phone/PhoneQuestionPage";
import { QUESTION_PARAM, questionTarget } from "../features/phone/phoneLinks";
import { DEFAULT_BOARD_REPO } from "../rpc/apiSession";

interface QuestionSearch {
  [QUESTION_PARAM]?: string;
}

const QuestionRoute = () => {
  const search = Route.useSearch();
  return (
    <PhoneQuestionPage
      ports={useLiveBoardPorts(DEFAULT_BOARD_REPO)}
      target={questionTarget(search[QUESTION_PARAM])}
    />
  );
};

/** Opens one question on a phone. The search parameter only names it and grants nothing. */
export const Route = createFileRoute("/question")({
  validateSearch: (search: Record<string, unknown>): QuestionSearch => {
    const value = search[QUESTION_PARAM];
    return typeof value === "string" ? { [QUESTION_PARAM]: value } : {};
  },
  component: QuestionRoute,
});
