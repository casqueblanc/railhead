// The questions a person answers, as derived from the folded board state.
//
// A decision is opened by one or more questions and answered by versions. This module groups the
// questions by decision, counts the work each one affects and orders the queue so the decision
// holding up the most work comes first. Everything here is computed from `BoardState`; nothing is
// stored beside it.

import type { ClaimId, DecisionId, QuestionOption } from "@railhead/shared/events";
import {
  decisionRipple,
  type BoardState,
  type DecisionVersionState,
  type QuestionState,
  type RippleRow,
} from "../board/boardState";

/** One recorded version, with the label of the option it chose. */
export interface DecisionVersionView {
  version: number;
  /** The chosen option's key. */
  option: string;
  /** The chosen option's label, untrusted text; `null` when its question offers no such key. */
  label: string | null;
  scope: readonly string[];
}

/** A decision as the questions queue shows it. */
export interface DecisionView {
  decisionId: DecisionId;
  /** The questions that ask for this decision, in log order; never empty. */
  questions: readonly QuestionState[];
  /** The options of the first question, which every version must choose from. */
  options: readonly QuestionOption[];
  /** Newest first. Empty while the decision waits for its first answer. */
  versions: readonly DecisionVersionView[];
  /** Live claims the decision's questions name or that were sent one of its versions. */
  affectedClaims: readonly ClaimId[];
  /** One row per agent for the current version; empty while unanswered. */
  ripple: readonly RippleRow[];
}

/** The questions queue: unanswered decisions, then answered ones. */
export interface DecisionQueue {
  /** Decisions with no version yet, most affected work first. */
  open: readonly DecisionView[];
  /** Decisions with at least one version, most affected work first. */
  decided: readonly DecisionView[];
}

/**
 * Builds the questions queue. Each list is sorted by the number of affected claims, descending;
 * equal counts keep the order in which the decision's first question was asked. An expired claim
 * no longer counts as affected work.
 */
export const decisionQueue = (state: BoardState): DecisionQueue => {
  const asked = new Map<DecisionId, QuestionState[]>();
  for (const question of Object.values(state.questions)) {
    const list = asked.get(question.decisionId);
    if (list === undefined) asked.set(question.decisionId, [question]);
    else list.push(question);
  }

  const views = [...asked].map(([decisionId, questions]) =>
    decisionView(state, decisionId, questions),
  );
  return {
    open: views.filter((view) => view.versions.length === 0).toSorted(byAffected),
    decided: views.filter((view) => view.versions.length > 0).toSorted(byAffected),
  };
};

const byAffected = (a: DecisionView, b: DecisionView): number =>
  b.affectedClaims.length - a.affectedClaims.length;

const decisionView = (
  state: BoardState,
  decisionId: DecisionId,
  questions: readonly QuestionState[],
): DecisionView => {
  const options = questions[0]?.options ?? [];
  const recorded = Object.hasOwn(state.decisions, decisionId)
    ? (state.decisions[decisionId]?.versions ?? [])
    : [];
  const versions = recorded.toReversed().map((version) => versionView(state, version));

  const claims = new Set<ClaimId>(questions.flatMap((question) => question.claimIds));
  for (const item of Object.values(state.inbox)) {
    if (item.entry.kind !== "conflict" && item.entry.decision.decisionId === decisionId) {
      claims.add(item.claimId);
    }
  }
  const affectedClaims = [...claims].filter((claimId) => {
    const claim = Object.hasOwn(state.claims, claimId) ? state.claims[claimId] : undefined;
    return claim !== undefined && claim.phase !== "expired";
  });

  return {
    decisionId,
    questions,
    options,
    versions,
    affectedClaims,
    ripple: decisionRipple(state, decisionId),
  };
};

const versionView = (state: BoardState, version: DecisionVersionState): DecisionVersionView => {
  const question = Object.hasOwn(state.questions, version.questionId)
    ? state.questions[version.questionId]
    : undefined;
  const label = question?.options.find((option) => option.key === version.option)?.label ?? null;
  return { version: version.version, option: version.option, label, scope: version.scope };
};
