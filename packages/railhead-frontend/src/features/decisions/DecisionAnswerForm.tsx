import { Button, Radio, Text } from "@cloudflare/kumo";
import { LockSimpleIcon } from "@phosphor-icons/react";
import { useState, type FormEvent } from "react";
import type { DecisionId, QuestionOption } from "@railhead/shared/events";
import { usePortAttempt } from "../enrollment/usePortAttempt";
import { blockMessage, type DecisionCardAction, type RecordDecision } from "./decisionActions";

type Outcome = { kind: "recorded"; version: number } | { kind: "failed"; message: string };

interface DecisionAnswerFormProps {
  decisionId: DecisionId;
  options: readonly QuestionOption[];
  /** The current answer, or `null` while the decision has none. */
  current: { version: number; option: string } | null;
  action: DecisionCardAction;
}

/**
 * Records the first answer to a decision, or replaces its current one. An answer belongs to the
 * callback it started with: when the action is blocked or replaced mid-request it is withdrawn and
 * its late outcome is dropped.
 */
export const DecisionAnswerForm = ({
  decisionId,
  options,
  current,
  action,
}: DecisionAnswerFormProps) => {
  const [option, setOption] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const { state: submission, start } = usePortAttempt<RecordDecision, Outcome>(
    action.kind === "available" ? action.onRecordDecision : null,
  );

  const verb = current === null ? "Record answer" : "Replace answer";
  const blocked = action.kind === "blocked";
  const pending = submission.kind === "pending";

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (action.kind !== "available") return;
    if (option === null) {
      setInvalid("Choose an option.");
      return;
    }
    if (current !== null && option === current.option) {
      setInvalid("This is already the current answer. Choose another option to replace it.");
      return;
    }
    setInvalid(null);
    const record = action.onRecordDecision;
    const request = { decisionId, option, expectedVersion: current?.version ?? null };
    await start(record, async (control): Promise<Outcome> => {
      try {
        const outcome = await record(request, control);
        return outcome.ok
          ? { kind: "recorded", version: outcome.version }
          : { kind: "failed", message: outcome.message };
      } catch {
        return {
          kind: "failed",
          message: "The answer was not confirmed as recorded. Check the history, then try again.",
        };
      }
    });
  };

  return (
    <form className="grid gap-3" onSubmit={(event) => void onSubmit(event)}>
      <Radio.Group
        legend={current === null ? "Your answer" : "Replace the answer"}
        value={option ?? ""}
        onValueChange={(value: string) => {
          setOption(value);
          setInvalid(null);
        }}
        disabled={blocked || pending}
        {...(invalid === null ? {} : { error: invalid })}
      >
        {options.map((candidate) => (
          <Radio.Item key={candidate.key} label={candidate.label} value={candidate.key} />
        ))}
      </Radio.Group>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button type="submit" variant="primary" disabled={blocked} loading={pending}>
          {pending ? "Recording…" : verb}
        </Button>
        {action.kind === "blocked" && (
          <span className="flex min-w-0 items-start gap-1.5">
            <span className="flex h-lh items-center text-kumo-subtle">
              <LockSimpleIcon size={14} aria-hidden="true" />
            </span>
            <Text as="span" variant="secondary">
              {blockMessage(action.block)}
            </Text>
          </span>
        )}
      </div>
      <div aria-live="polite">
        {submission.kind === "recorded" && (
          <Text variant="secondary">Recorded as version {submission.version}.</Text>
        )}
        {submission.kind === "failed" && (
          <Text variant="error" DANGEROUS_className="break-words">
            {submission.message}
          </Text>
        )}
        {submission.kind === "withdrawn" && (
          <Text variant="error" DANGEROUS_className="break-words">
            {submission.sent
              ? "The board stopped being current after the answer was sent. Check the decision's history before answering again."
              : "Stopped: the board stopped being current before the answer was sent. Nothing was recorded."}
          </Text>
        )}
      </div>
    </form>
  );
};
