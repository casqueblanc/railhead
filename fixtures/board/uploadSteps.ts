// SYNTHETIC. Building blocks for the upload-size decision the demo turns on: should uploads above
// 10 MB be rejected or chunked? See syntheticLog.ts.

import type {
  AgentId,
  ClaimId,
  CheckResult,
  CheckRunId,
  CommitSha,
  DecisionRef,
  InboxEntry,
  IntentId,
  MainOutcome,
} from "../../packages/railhead-shared/src/events";
import {
  SYNTH_ADAPTATION,
  SYNTH_CLAIMS,
  SYNTH_GATEWAY,
  SYNTH_OWNER,
  SYNTH_TRAIN,
  synthAgent,
  synthCommit,
  type SyntheticStep,
} from "./syntheticLog";

/** Identifiers shared by the upload scenarios. */
export const UPLOAD = {
  atlas: "agt_synthatlas",
  birch: "agt_synthbirch",
  atlasClaim: "clm_synthatlas",
  birchClaim: "clm_synthbirch",
  uploadIssue: "iss_synthupload",
  limitsIssue: "iss_synthlimits",
  question: "qst_synthsize",
  decision: "dec_synthsize",
} as const;

/** The commit main starts at in every upload scenario. */
export const UPLOAD_BASE = synthCommit(0);

/** Version `version` of the upload decision. */
export const sizeDecision = (version: number): DecisionRef => ({
  decisionId: UPLOAD.decision,
  version,
});

/** Invites, joins and confirms an agent. */
export const enrol = (agentId: AgentId, name: string, inviteId: string): SyntheticStep[] => [
  { type: "agent.invited", actor: SYNTH_OWNER, data: { inviteId, name } },
  {
    type: "agent.joined",
    actor: SYNTH_GATEWAY,
    data: { agentId, inviteId, name, keyFingerprint: `SHA256:${"S".repeat(43)}` },
  },
  { type: "agent.confirmed", actor: SYNTH_OWNER, data: { agentId } },
];

/**
 * Atlas and birch enrolled, two issues filed and one claim each, opened on `UPLOAD_BASE`, with
 * atlas's first push and its question about large uploads.
 */
export const uploadPrelude = (): SyntheticStep[] => [
  ...enrol(UPLOAD.atlas, "atlas", "inv_synthatlas"),
  ...enrol(UPLOAD.birch, "birch", "inv_synthbirch"),
  {
    type: "issue.filed",
    actor: SYNTH_OWNER,
    data: { issueId: UPLOAD.uploadIssue, title: "Accept large uploads", body: "Synthetic issue." },
  },
  {
    type: "issue.filed",
    actor: SYNTH_OWNER,
    data: { issueId: UPLOAD.limitsIssue, title: "Show upload limits", body: "" },
  },
  open(UPLOAD.atlas, UPLOAD.atlasClaim, UPLOAD.uploadIssue),
  open(UPLOAD.birch, UPLOAD.birchClaim, UPLOAD.limitsIssue),
  push(UPLOAD.atlas, UPLOAD.atlasClaim, null, synthCommit(1)),
  {
    type: "question.asked",
    actor: synthAgent(UPLOAD.atlas),
    data: {
      questionId: UPLOAD.question,
      claimId: UPLOAD.atlasClaim,
      decisionId: UPLOAD.decision,
      text: "Should uploads above 10 MB be rejected or chunked?",
      options: [
        { key: "reject", label: "Reject them" },
        { key: "chunk", label: "Upload them in chunks" },
      ],
    },
  },
];

const open = (agentId: AgentId, claimId: ClaimId, issueId: string): SyntheticStep => ({
  type: "claim.opened",
  actor: synthAgent(agentId),
  data: { claimId, issueId, agentId, generation: 1, base: UPLOAD_BASE },
});

/** A push to the claim's fork at generation 1. */
export const push = (
  agentId: AgentId,
  claimId: ClaimId,
  from: CommitSha | null,
  to: CommitSha,
): SyntheticStep => ({
  type: "claim.pushed",
  actor: synthAgent(agentId),
  data: { claimId, generation: 1, ref: "refs/heads/work", from, to },
});

/** The owner records version `version` of the upload decision. */
export const decide = (version: number, option: "reject" | "chunk"): SyntheticStep => ({
  type: "decision.recorded",
  actor: SYNTH_OWNER,
  data: {
    decisionId: UPLOAD.decision,
    version,
    questionId: UPLOAD.question,
    option,
    supersedes: version === 1 ? null : version - 1,
    scope: ["src/uploads"],
  },
});

/** The three inbox events for one item, in the order given by `upTo`. */
export const inbox = (
  agentId: AgentId,
  claimId: ClaimId,
  item: number,
  entry: InboxEntry,
  upTo: "queued" | "delivered" | "acknowledged",
): SyntheticStep[] => {
  const steps: SyntheticStep[] = [
    { type: "inbox.queued", actor: SYNTH_TRAIN, data: { agentId, claimId, item, entry } },
  ];
  if (upTo === "queued") return steps;
  steps.push({ type: "inbox.delivered", actor: SYNTH_TRAIN, data: { agentId, claimId, item } });
  if (upTo === "delivered") return steps;
  steps.push({
    type: "inbox.acked",
    actor: synthAgent(agentId),
    data: { agentId, claimId, item, plan: "Synthetic plan: follow the decision." },
  });
  return steps;
};

/** Marks a claim ready at generation 1. */
export const ready = (
  agentId: AgentId,
  claimId: ClaimId,
  commit: CommitSha,
  decisions: DecisionRef[],
): SyntheticStep => ({
  type: "claim.ready",
  actor: synthAgent(agentId),
  data: { claimId, generation: 1, commit, decisions },
});

/** One check result; `acceptance` names the decision version and option it proves. */
export const checkResult = (
  checkRunId: CheckRunId,
  candidate: CommitSha,
  check: string,
  result: CheckResult,
  acceptance: { decision: DecisionRef; option: "reject" | "chunk" } | null = null,
): SyntheticStep => ({
  type: "train.check",
  actor: SYNTH_TRAIN,
  data: { checkRunId, candidate, check, result, acceptance },
});

/** A merge intent for the given claims, authorised against `decisions`. */
export const intend = (
  intentId: IntentId,
  expectedMain: CommitSha,
  candidate: CommitSha,
  claims: ClaimId[],
  decisions: DecisionRef[],
  checkRunId: CheckRunId,
): SyntheticStep => ({
  type: "train.intent",
  actor: SYNTH_TRAIN,
  data: { intentId, expectedMain, candidate, claims, decisions, checkRunId },
});

/** The backend recording a claim's work landed by an intent as adapted to a decision version. */
export const adapt = (
  claimId: ClaimId,
  intentId: IntentId,
  decision: DecisionRef,
): SyntheticStep => ({
  type: "claim.adapted",
  actor: SYNTH_ADAPTATION,
  data: { claimId, intentId, decision },
});

/** The result of the train's attempt to move main for an intent. */
export const moveMain = (
  intentId: IntentId,
  outcome: MainOutcome,
  main: CommitSha,
): SyntheticStep => ({
  type: "train.main",
  actor: SYNTH_TRAIN,
  data: { intentId, outcome, main },
});

/** The backend closing a claim whose pin landed as `commit` on main, at generation 1. */
export const merge = (claimId: ClaimId, commit: CommitSha): SyntheticStep => ({
  type: "claim.merged",
  actor: SYNTH_CLAIMS,
  data: { claimId, generation: 1, commit },
});
