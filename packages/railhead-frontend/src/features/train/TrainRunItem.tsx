import { Text } from "@cloudflare/kumo";
import type { CheckResult } from "@railhead/shared/events";
import { ShortSha } from "../claims/ShortSha";
import { OutcomeBadge } from "./OutcomeBadge";
import type { CheckSummary, TrainRun } from "./trainRuns";

/**
 * One merge intent: which claims it carried, the exact candidate its checks covered, the decision
 * versions it was authorised against and what happened to main. Issue titles are untrusted text.
 */
export const TrainRunItem = ({ run }: { run: TrainRun }) => (
  <li className="grid gap-2 px-4 py-3" aria-labelledby={`run-${run.intentId}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <Text as="h3" variant="heading" DANGEROUS_className="min-w-0 break-words text-pretty">
        <span id={`run-${run.intentId}`}>{runTitle(run)}</span>
      </Text>
      <OutcomeBadge outcome={run.outcome.kind} />
    </div>
    <Text>
      <OutcomeText run={run} />
    </Text>
    {run.claims.length > 1 && (
      <ul className="grid list-disc gap-1 pl-5 text-sm" aria-label="Claims in this merge">
        {run.claims.map((claim) => (
          <li key={claim.claimId} className="break-words">
            {claim.issueTitle}
          </li>
        ))}
      </ul>
    )}
    <Text variant="secondary">
      {checksText(run.checks)} <ShortSha sha={run.checks.candidate} />.
    </Text>
    {run.decisions.length > 0 && (
      <Text variant="secondary">
        Authorised against{" "}
        <span translate="no">
          {run.decisions.map((ref) => `${ref.decisionId} version ${ref.version}`).join(", ")}
        </span>
        .
      </Text>
    )}
  </li>
);

const OutcomeText = ({ run }: { run: TrainRun }) => {
  const { outcome } = run;
  switch (outcome.kind) {
    case "pending":
      return (
        <>
          Waiting to move main from <ShortSha sha={run.expectedMain} /> to{" "}
          <ShortSha sha={run.candidate} />.
        </>
      );
    case "landed":
      return (
        <>
          Main moved from <ShortSha sha={run.expectedMain} /> to <ShortSha sha={run.candidate} />.
        </>
      );
    case "landed_after_read_back":
      return (
        <>
          The push result was uncertain. Main was read back at <ShortSha sha={run.candidate} />, the
          candidate, so it landed.
        </>
      );
    case "main_moved":
      return (
        <>
          Main was at <ShortSha sha={outcome.main} />, not <ShortSha sha={run.expectedMain} />, so
          nothing changed.
        </>
      );
    case "not_landed_after_read_back":
      return (
        <>
          The push result was uncertain. Main was read back at <ShortSha sha={outcome.main} />, not
          the candidate <ShortSha sha={run.candidate} />, so it did not land.
        </>
      );
    default:
      return unreachable(outcome);
  }
};

const runTitle = (run: TrainRun): string => {
  const [first, ...rest] = run.claims;
  if (first === undefined) return "Merge with no claims";
  return rest.length === 0 ? first.issueTitle : `${first.issueTitle} and ${rest.length} more`;
};

const RESULT_TEXT: Readonly<Record<CheckResult, string>> = {
  pass: "passed",
  fail: "failed",
  error: "could not run",
};

const checksText = (checks: CheckSummary): string => {
  const parts = (["pass", "fail", "error"] as const)
    .filter((result) => checks.counts[result] > 0)
    .map((result) => `${checks.counts[result]} ${RESULT_TEXT[result]}`);
  return parts.length === 0 ? "No check results on" : `Checks ${parts.join(", ")} on`;
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled train outcome: ${JSON.stringify(value)}`);
};
