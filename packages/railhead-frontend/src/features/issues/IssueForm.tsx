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
  titleProblem,
  type FileOutcome,
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
 */
export const IssueForm = ({ access, board }: IssueFormProps) => {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [problems, setProblems] = useState<Problems>(NO_PROBLEMS);
  const { state, start } = usePortAttempt<AvailableOwnerPort, FileOutcome>(
    access.kind === "ready" ? access.owner : null,
  );
  const pending = state.kind === "pending";
  const blocked = access.kind === "blocked";

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (access.kind !== "ready") return;
    const draft = issueDraft(title, body);
    const duplicate = filedDuplicate(board, draft);
    const found: Problems = {
      title:
        titleProblem(title) ??
        (duplicate === null
          ? null
          : "An issue with this exact title and description is already on the board."),
      body: bodyProblem(body),
    };
    setProblems(found);
    if (found.title !== null || found.body !== null) return;
    const { owner, authenticator } = access;
    const outcome = await start(owner, (control) =>
      fileIssue(owner, authenticator, draft, control),
    );
    if (outcome?.kind === "filed") {
      setTitle("");
      setBody("");
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
        <FileMessage state={state} board={board} />
      </div>
    </form>
  );
};

/** The outcome of the last filing. */
const FileMessage = ({ state, board }: { state: AttemptState<FileOutcome>; board: BoardState }) => {
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
    case "withdrawn":
      return (
        <Text variant="error" DANGEROUS_className="break-words">
          {state.sent
            ? "The board lost its current view after the issue was sent. Check the issues list before filing again."
            : "Stopped: the board lost its current view before the issue was sent. Nothing was filed."}
        </Text>
      );
    default:
      return unreachable(state);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled filing state: ${JSON.stringify(value)}`);
};
