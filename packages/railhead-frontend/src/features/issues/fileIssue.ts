// Filing an issue for agents, end to end: ask the backend for a challenge bound to the exact title
// and body, have the owner's authenticator sign it, and perform it with that assertion.
//
// The issue the backend records is the task agents receive, so the board files exactly what the
// owner typed (the title without surrounding spaces) and shows an issue as filed only once the log
// records it.
//
// Once the signed filing is sent, only a refusal the backend states is proof that nothing was
// filed. A lost answer, an internal failure or a result for another action leaves the filing
// unconfirmed: it may be on its way through the log, so the board does not send the same draft
// again until the log records it. The owner port has no lookup for a performed challenge, so the
// board never concludes from an issue's absence that it was not filed.

import type { BoardErrorCode, BoardFailure } from "@railhead/shared/board-api";
import { MAX_ISSUE_BODY_LENGTH, MAX_TITLE_LENGTH, type IssueId } from "@railhead/shared/events";
import type { BoardState, IssueState } from "../board/boardState";
import type { AttemptControl, AvailableOwnerPort } from "../enrollment/ownerActions";
import { signAction, type Authenticator } from "../enrollment/webauthn";

/** The issue as it is sent: the title already trimmed. */
export interface IssueDraft {
  title: string;
  body: string;
}

/** What became of one filing. Messages are shown as plain text. */
export type FileOutcome =
  | { kind: "filed"; issueId: IssueId }
  /** The owner dismissed the passkey prompt. Nothing was filed. */
  | { kind: "cancelled" }
  /** The filing was refused or never sent. Nothing was filed, so it can be tried again. */
  | { kind: "failed"; message: string }
  /** The filing was sent and its result is unknown. The backend may have filed it. */
  | { kind: "unconfirmed" }
  /**
   * The board withdrew the filing before it finished. `sent` says whether `perform` had already
   * been called, in which case the backend may still have filed it.
   */
  | { kind: "withdrawn"; sent: boolean };

/** Why the title cannot be filed, or `null` when it can. */
export const titleProblem = (title: string): string | null => {
  const trimmed = title.trim();
  if (trimmed === "") return "Enter a title.";
  if (trimmed.length > MAX_TITLE_LENGTH) {
    return `The title is ${trimmed.length} characters. Shorten it to ${MAX_TITLE_LENGTH} or fewer.`;
  }
  return null;
};

/** Why the body cannot be filed, or `null` when it can. An empty body is allowed. */
export const bodyProblem = (body: string): string | null =>
  body.length > MAX_ISSUE_BODY_LENGTH
    ? `The description is ${body.length} characters. Shorten it to ${MAX_ISSUE_BODY_LENGTH} or fewer.`
    : null;

/** Whether two drafts would file the same issue. */
export const sameDraft = (a: IssueDraft, b: IssueDraft): boolean =>
  a.title === b.title && a.body === b.body;

/** The draft as it would be sent. */
export const issueDraft = (title: string, body: string): IssueDraft => ({
  title: title.trim(),
  body,
});

/**
 * The issue on the board with exactly this title and body, or `null`. Filing it again would hand
 * agents the same task twice.
 */
export const filedDuplicate = (board: BoardState, draft: IssueDraft): IssueState | null =>
  Object.values(board.issues).find((issue) => sameDraft(issue, draft)) ?? null;

/**
 * Files `draft` with a fresh passkey assertion, unless `control.signal` aborts before it is sent.
 * Never throws.
 */
export const fileIssue = async (
  owner: AvailableOwnerPort,
  authenticator: Authenticator,
  draft: IssueDraft,
  control: AttemptControl,
): Promise<FileOutcome> => {
  const { signal } = control;
  let sent = false;
  try {
    const prepared = await owner.onPrepareAction({ kind: "issue.file", ...draft });
    if (signal.aborted) return { kind: "withdrawn", sent: false };
    if (!prepared.ok) return failed(prepared);
    const signed = await signAction(authenticator, prepared.value, signal);
    if (signal.aborted) return { kind: "withdrawn", sent: false };
    switch (signed.kind) {
      case "cancelled":
        return signed;
      case "failed":
        return signed;
      case "done":
        break;
      default:
        return unreachable(signed);
    }
    control.onSent();
    sent = true;
    const performed = await owner.onPerformAction(prepared.value.challengeId, signed.value);
    if (signal.aborted) return { kind: "withdrawn", sent: true };
    if (!performed.ok) return refusedAfterSending(performed) ? failed(performed) : UNCONFIRMED;
    if (performed.value.kind !== "issue.file") return UNCONFIRMED;
    return { kind: "filed", issueId: performed.value.issueId };
  } catch {
    return sent ? UNCONFIRMED : { kind: "failed", message: NOT_SENT };
  }
};

const UNCONFIRMED: FileOutcome = { kind: "unconfirmed" };

const NOT_SENT = "The issue could not be sent. Nothing was filed. Try again.";

const failed = (failure: BoardFailure): FileOutcome => ({
  kind: "failed",
  message: failureMessage(failure.code),
});

/**
 * Whether a failed `perform` proves the issue was not filed. The board performs each challenge
 * once, so `proof_expired` means it expired before use. `internal` and `cursor_ahead` say nothing
 * about whether the filing was committed.
 */
const refusedAfterSending = (failure: BoardFailure): boolean => {
  switch (failure.code) {
    case "proof_invalid":
    case "proof_expired":
    case "action_stale":
    case "quota_exceeded":
    case "unavailable":
    case "invalid_request":
    case "not_found":
    case "bootstrap_closed":
    case "busy":
      return true;
    case "cursor_ahead":
    case "internal":
      return false;
    default:
      return unreachable(failure.code);
  }
};

/**
 * The sentence for a filing refused before or after it was sent. The backend's own message is untrusted text and may change
 * with its version, so the board names the outcome from the closed code.
 */
export const failureMessage = (code: BoardErrorCode): string => {
  switch (code) {
    case "proof_invalid":
      return "The passkey did not verify for this issue. Nothing was filed.";
    case "proof_expired":
      return "The passkey request expired or was already used. File the issue again.";
    case "action_stale":
      return "The backend no longer accepts this issue as signed. Nothing was filed.";
    case "quota_exceeded":
      return "The issue limit was reached. Nothing was filed.";
    case "unavailable":
      return "This Railhead cannot file issues: its module is not installed.";
    case "busy":
      return "The backend is busy. Nothing was filed; try again shortly.";
    case "invalid_request":
      return "The backend refused the issue as invalid. Check the title and description.";
    case "not_found":
      return "The repository is not available to this board.";
    case "bootstrap_closed":
      return "The backend refused the owner passkey. Nothing was filed.";
    case "cursor_ahead":
    case "internal":
      return NOT_SENT;
    default:
      return unreachable(code);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled issue variant: ${JSON.stringify(value)}`);
};
