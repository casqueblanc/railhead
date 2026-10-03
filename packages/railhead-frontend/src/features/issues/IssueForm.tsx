import { Button, Input, InputArea, Text } from "@cloudflare/kumo";
import { MAX_ISSUE_BODY_LENGTH, MAX_TITLE_LENGTH } from "@railhead/shared/events";
import { useState, type FormEvent } from "react";
import type { BoardState } from "../board/boardState";
import type { AvailableOwnerPort } from "../enrollment/ownerActions";
import type { ActionAccess } from "../enrollment/useOwnerAction";
import { usePortAttempt, type AttemptState } from "../enrollment/usePortAttempt";
import {
  bodyProblem,
  fileIssue,
  filedDuplicate,
  issueDraft,
  sameDraft,
  titleProblem,
  type FileOutcome,
  type IssueDraft,
} from "./fileIssue";

interface Problems {
  title: string | null;
  body: string | null;
}

const NO_PROBLEMS: Problems = { title: null, body: null };

interface IssueFormProps {
  access: ActionAccess;
  /** The board the section shows, used to spot an issue already filed. */
  board: BoardState;
}

/**
 * Files an issue for agents with one passkey assertion. What was typed stays in the form until the
 * backend reports the issue filed, so a refusal or a lost session never discards it.
 *
 * A draft sent without a confirmed result may still be filed. The form keeps it as unconfirmed and
 * will not send it again until the log records it; only a refusal the backend states makes it
 * fileable again. Changing the title or description makes a different issue, which can be filed.
 */
export const IssueForm = ({ access, board }: IssueFormProps) => {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [problems, setProblems] = useState<Problems>(NO_PROBLEMS);
  // Each entry took one passkey ceremony, and entries the log records are dropped on submit.
  const [unconfirmed, setUnconfirmed] = useState<readonly IssueDraft[]>([]);
  const { state, start } = usePortAttempt<AvailableOwnerPort, FileOutcome>(
    access.kind === "ready" ? access.owner : null,
  );
  const pending = state.kind === "pending";
  const blocked = access.kind === "blocked";
  const outstanding = unconfirmed.filter((sent) => filedDuplicate(board, sent) === null);
  const lastSent = unconfirmed.at(-1);
  const lastLanded = lastSent !== undefined && filedDuplicate(board, lastSent) !== null;

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (access.kind !== "ready") return;
    const draft = issueDraft(title, body);
    const found: Problems = {
      title: titleProblem(title) ?? sentProblem(board, outstanding, draft),
      body: bodyProblem(body),
    };
    setProblems(found);
    if (found.title !== null || found.body !== null) return;
    setUnconfirmed(outstanding);
    const { owner, authenticator } = access;
    const outcome = await start(owner, (control) =>
      fileIssue(owner, authenticator, draft, {
        signal: control.signal,
        onSent: () => {
          control.onSent();
          setUnconfirmed((current) => [...current, draft]);
        },
      }),
    );
    // A withdrawn attempt resolves to `null`; if it was sent, its draft stays unconfirmed.
    if (outcome === null) return;
    switch (outcome.kind) {
      case "filed":
        setTitle("");
        setBody("");
        setUnconfirmed((current) => current.filter((sent) => !sameDraft(sent, draft)));
        return;
      case "failed":
        setUnconfirmed((current) => current.filter((sent) => !sameDraft(sent, draft)));
        return;
      case "cancelled":
      case "unconfirmed":
      case "withdrawn":
        return;
      default:
        unreachable(outcome);
    }
  };

  return (
    <form className="grid gap-3" noValidate onSubmit={(event) => void onSubmit(event)}>
      <Input
        label="Title"
        name="issue-title"
        description={`What an agent should do, in up to ${MAX_TITLE_LENGTH} characters.`}
        placeholder="Show upload limits…"
        autoComplete="off"
        passwordManagerIgnore
        value={title}
        onChange={(event) => {
          setTitle(event.target.value);
          setProblems((current) => ({ ...current, title: null }));
        }}
        disabled={blocked || pending}
        {...(problems.title === null ? {} : { error: problems.title })}
      />
      <InputArea
        label="Description"
        name="issue-body"
        description={`Optional. Agents read it as their task, up to ${MAX_ISSUE_BODY_LENGTH.toLocaleString()} characters.`}
        autoComplete="off"
        rows={4}
        value={body}
        onChange={(event) => {
          setBody(event.target.value);
          setProblems((current) => ({ ...current, body: null }));
        }}
        disabled={blocked || pending}
        {...(problems.body === null ? {} : { error: problems.body })}
      />
      <div>
        <Button type="submit" variant="primary" disabled={blocked} loading={pending}>
          {pending ? "Waiting for passkey…" : "File issue"}
        </Button>
      </div>
      <div aria-live="polite">
        <FileMessage state={state} board={board} landed={lastLanded} />
      </div>
    </form>
  );
};

/** Why `draft` cannot be sent now, or `null` when nothing on the board or in flight matches it. */
const sentProblem = (
  board: BoardState,
  outstanding: readonly IssueDraft[],
  draft: IssueDraft,
): string | null => {
  if (filedDuplicate(board, draft) !== null) {
    return "An issue with this exact title and description is already on the board.";
  }
  if (outstanding.some((sent) => sameDraft(sent, draft))) {
    return "This issue was already sent and may have been filed. It is not sent again until it shows in the list below.";
  }
  return null;
};

interface FileMessageProps {
  state: AttemptState<FileOutcome>;
  board: BoardState;
  /** Whether the log records the last draft sent, so an unconfirmed filing turned out filed. */
  landed: boolean;
}

/** The outcome of the last filing. */
const FileMessage = ({ state, board, landed }: FileMessageProps) => {
  switch (state.kind) {
    case "idle":
    case "pending":
      return null;
    case "filed":
      return (
        <Text variant="secondary">
          {state.issueId in board.issues
            ? "Filed. The issue is in the list below, ready for an agent."
            : "Filed. The issue shows in the list once the log records it."}
        </Text>
      );
    case "cancelled":
      return <Text variant="secondary">Cancelled. No issue was filed.</Text>;
    case "failed":
      return (
        <Text variant="error" DANGEROUS_className="break-words">
          {state.message}
        </Text>
      );
    case "unconfirmed":
      return landed ? (
        <FiledAfterAll />
      ) : (
        <Text variant="error" DANGEROUS_className="break-words">
          The backend did not confirm the issue. If it was filed, it shows in the list below; until
          then this board will not send the same issue again.
        </Text>
      );
    case "withdrawn":
      if (!state.sent) {
        return (
          <Text variant="error" DANGEROUS_className="break-words">
            Stopped: the board lost its current view before the issue was sent. Nothing was filed.
          </Text>
        );
      }
      return landed ? (
        <FiledAfterAll />
      ) : (
        <Text variant="error" DANGEROUS_className="break-words">
          The board lost its current view after the issue was sent. If it was filed, it shows in the
          list below; until then this board will not send the same issue again.
        </Text>
      );
    default:
      return unreachable(state);
  }
};

const FiledAfterAll = () => (
  <Text variant="secondary">
    Filed after all. The issue is in the list below, ready for an agent.
  </Text>
);

const unreachable = (value: never): never => {
  throw new Error(`unhandled filing state: ${JSON.stringify(value)}`);
};
