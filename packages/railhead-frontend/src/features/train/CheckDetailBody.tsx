import { Button, SkeletonLine, Text } from "@cloudflare/kumo";
import { MAX_CHECK_DETAIL_LOG_BYTES } from "@railhead/shared/board-api";
import type { CheckDetailUnavailableReason } from "../board/boardPorts";
import { ShortSha } from "../claims/ShortSha";
import { CHECK_RESULT_BADGE } from "./CheckResultBadge";
import type { CheckDetailLoad, ListedCheckDetail } from "./useCheckDetail";

const UNAVAILABLE_TEXT: Readonly<Record<CheckDetailUnavailableReason, string>> = {
  offline: "The board is offline. Reconnect to read this run.",
  module_unavailable: "This Railhead cannot read check runs.",
  replay: "A replay has no backend, so the command and output are not available.",
};

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });

interface CheckDetailBodyProps {
  load: CheckDetailLoad;
  onRetry: () => void;
}

/**
 * What the backend recorded for one run: the commit checked, the command main's definition gave
 * it and its result with the end of its output, or for a run that timed out, its deadline. The
 * command and output are repository content and run output, shown only as text.
 */
export const CheckDetailBody = ({ load, onRetry }: CheckDetailBodyProps) => {
  switch (load.kind) {
    case "closed":
      return null;
    case "loading":
      return (
        <div className="grid gap-2">
          <span className="sr-only">Loading the check run…</span>
          <SkeletonLine />
          <SkeletonLine />
        </div>
      );
    case "unavailable":
      return <Text variant="secondary">{UNAVAILABLE_TEXT[load.reason]}</Text>;
    case "failed":
      return <Failure code={load.code} onRetry={onRetry} />;
    case "loaded":
      return <Detail detail={load.detail} timedOut={load.timedOut} />;
    default:
      return unreachable(load);
  }
};

const Failure = ({
  code,
  onRetry,
}: {
  code: Extract<CheckDetailLoad, { kind: "failed" }>["code"];
  onRetry: () => void;
}) => {
  switch (code) {
    case "not_found":
      return (
        <Text variant="secondary">
          The backend no longer keeps this run. It keeps a bounded number of runs; the result above
          stays in the log.
        </Text>
      );
    case "unavailable":
      return <Text variant="secondary">This Railhead's checks module is not installed.</Text>;
    case "mismatch":
      return (
        <Text variant="secondary">
          The backend's record does not match this run in the log, so nothing is shown.
        </Text>
      );
    case "invalid_request":
    case "cursor_ahead":
    case "proof_invalid":
    case "proof_expired":
    case "action_stale":
    case "bootstrap_closed":
    case "quota_exceeded":
    case "busy":
    case "internal":
      return (
        <div className="flex flex-wrap items-center gap-2">
          <Text variant="secondary">The run could not be read.</Text>
          <Button size="sm" onClick={onRetry}>
            Try again
          </Button>
        </div>
      );
    default:
      return unreachable(code);
  }
};

const Detail = ({ detail, timedOut }: { detail: ListedCheckDetail; timedOut: boolean }) => {
  const { state } = detail;
  return (
    <div className="grid gap-3 text-sm">
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-kumo-subtle">Candidate</dt>
        {/* The full id, so a person can read and copy the exact commit checked. */}
        <dd className="font-mono break-all select-all" translate="no">
          {detail.candidate}
        </dd>
        <dt className="text-kumo-subtle">Composed on main</dt>
        <dd>
          <ShortSha sha={detail.expectedMain} />
        </dd>
        <dt className="text-kumo-subtle">Definition</dt>
        <dd className="font-mono break-all" translate="no" title={detail.definitionDigest}>
          {`sha256:${detail.definitionDigest.slice(0, 12)}`}
        </dd>
      </dl>
      <div className="grid gap-1">
        <Text variant="secondary">Command, from main's definition</Text>
        {detail.command === null ? (
          <Text variant="secondary">Not recorded: this run predates commands being kept.</Text>
        ) : (
          <TextBlock text={detail.command} label="Command" />
        )}
      </div>
      {state.kind === "started" ? (
        <Text>
          No report arrived by its deadline,{" "}
          <time dateTime={new Date(state.deadline).toISOString()}>
            {timeFormat.format(state.deadline)}
          </time>
          .
        </Text>
      ) : (
        <div className="grid gap-1">
          <Text>
            {CHECK_RESULT_BADGE[state.result].label} at{" "}
            <time dateTime={new Date(state.finishedAt).toISOString()}>
              {timeFormat.format(state.finishedAt)}
            </time>
            {timedOut ? ", after its deadline, so the train did not use this result" : ""}.
          </Text>
          <Text variant="secondary">
            {state.logCut ? `Output, last ${MAX_CHECK_DETAIL_LOG_BYTES / 1024} KiB` : "Output"}
          </Text>
          {state.logTail === "" ? (
            <Text variant="secondary">No output.</Text>
          ) : (
            <TextBlock text={state.logTail} label="Output" />
          )}
        </div>
      )}
    </div>
  );
};

/** Untrusted text kept verbatim, scrollable, never interpreted. */
const TextBlock = ({ text, label }: { text: string; label: string }) => (
  <pre
    // A scrollable region must be reachable by keyboard.
    tabIndex={0}
    aria-label={label}
    className="max-h-64 overflow-auto rounded-md border border-kumo-line bg-kumo-recessed p-2 font-mono text-xs whitespace-pre-wrap break-words"
    translate="no"
  >
    {text}
  </pre>
);

const unreachable = (value: never): never => {
  throw new Error(`unhandled check detail: ${JSON.stringify(value)}`);
};
