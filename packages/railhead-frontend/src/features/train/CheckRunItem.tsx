import { Collapsible, Text } from "@cloudflare/kumo";
import { useState } from "react";
import type { CheckDetailPort } from "../board/boardPorts";
import { ShortSha } from "../claims/ShortSha";
import { CheckDetailBody } from "./CheckDetailBody";
import { CHECK_RESULT_BADGE, CheckResultBadge } from "./CheckResultBadge";
import type { CheckRunView } from "./checkRuns";
import { useCheckDetail } from "./useCheckDetail";

interface CheckRunItemProps {
  run: CheckRunView;
  checks: CheckDetailPort;
}

/**
 * One check run: the exact candidate, each result as the log recorded it, and one click away the
 * command and output the backend kept. Check names are repository content.
 */
export const CheckRunItem = ({ run, checks }: CheckRunItemProps) => {
  const [open, setOpen] = useState(false);
  const { load, onRetry } = useCheckDetail(
    checks,
    { checkRunId: run.checkRunId, candidate: run.candidate, results: run.results.length },
    open,
  );
  const headingId = `check-${run.checkRunId}`;
  return (
    <li className="grid gap-2 px-4 py-3" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Text as="h4" variant="heading" DANGEROUS_className="min-w-0 break-words">
          <span id={headingId}>
            Check of <ShortSha sha={run.candidate} />
          </span>
        </Text>
        <CheckResultBadge result={run.overall} />
      </div>
      <ul className="grid gap-1 text-sm">
        {run.results.map((entry, index) => (
          // A run may record the same check more than once; the log order is the identity.
          <li key={index} className="break-words">
            <span translate="no">{entry.check}</span>: {CHECK_RESULT_BADGE[entry.result].label}
            {entry.acceptance !== null && (
              <span className="text-kumo-subtle">
                {" "}
                (proves option <span translate="no">{entry.acceptance.option}</span> of{" "}
                <span translate="no">{entry.acceptance.decision.decisionId}</span> version{" "}
                {entry.acceptance.decision.version})
              </span>
            )}
          </li>
        ))}
      </ul>
      {run.intents.length > 0 && (
        <Text variant="secondary">
          Cited by <span translate="no">{run.intents.join(", ")}</span>.
        </Text>
      )}
      <Collapsible.Root open={open} onOpenChange={setOpen}>
        <Collapsible.DefaultTrigger>Command and output</Collapsible.DefaultTrigger>
        <Collapsible.DefaultPanel>
          <CheckDetailBody load={load} onRetry={onRetry} />
        </Collapsible.DefaultPanel>
      </Collapsible.Root>
    </li>
  );
};
