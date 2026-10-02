import { Badge, Collapsible, Text, type BadgeVariant } from "@cloudflare/kumo";
import type { DecisionRef, RefusalReason } from "@railhead/shared/events";
import type { ClaimLane as Lane, LaneInboxItem, LaneStatus } from "./lanes";
import { ShortSha } from "./ShortSha";

/**
 * One claim's lane: the issue, who holds it at which generation, what it is waiting for and its
 * recent pushes. Issue titles, agent names and paths are untrusted and rendered only as text.
 */
export const ClaimLane = ({ lane }: { lane: Lane }) => {
  const reason = waitingReason(lane.status);
  return (
    <li className="grid gap-3 px-4 py-3" aria-labelledby={`lane-${lane.claimId}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Text as="h3" variant="heading" DANGEROUS_className="min-w-0 break-words text-pretty">
          <span id={`lane-${lane.claimId}`}>{lane.issueTitle}</span>
        </Text>
        <Badge variant={STATUS_BADGE[lane.status.kind].variant}>
          {STATUS_BADGE[lane.status.kind].label}
        </Badge>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
        <dt className="text-kumo-subtle">Agent</dt>
        <dd className="min-w-0 break-words">
          {lane.agentName}
          {lane.agentStatus === "revoked" && <span className="text-kumo-subtle"> (revoked)</span>}
        </dd>
        <dt className="text-kumo-subtle">Generation</dt>
        <dd className="tabular-nums">{lane.generation}</dd>
        <dt className="text-kumo-subtle">Base</dt>
        <dd>
          <ShortSha sha={lane.base} />
        </dd>
        <dt className="text-kumo-subtle">Head</dt>
        <dd>{lane.head === null ? "No push yet" : <ShortSha sha={lane.head} />}</dd>
      </dl>

      {reason !== null && <Text>{reason}</Text>}
      {lane.status.kind === "ready" && (
        <Text>
          Pinned <ShortSha sha={lane.status.commit} /> for the train
          {lane.status.decisions.length > 0 && <> against {decisionList(lane.status.decisions)}</>}.
        </Text>
      )}
      {lane.staleRefusal !== null && (
        <Text variant="secondary">
          {`A call at generation ${lane.staleRefusal.generation} was refused: ${REFUSAL_TEXT[lane.staleRefusal.reason]}`}
        </Text>
      )}

      {lane.inbox.length > 0 && (
        <div className="grid gap-1">
          <Text variant="secondary">Waiting for the agent to acknowledge</Text>
          <ul className="grid list-disc gap-1 pl-5 text-sm">
            {lane.inbox.map((item) => (
              <li key={item.key} className="break-words">
                {inboxText(item)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {lane.pushes.length > 0 && (
        <Collapsible.Root>
          <Collapsible.DefaultTrigger>{pushesLabel(lane.pushes.length)}</Collapsible.DefaultTrigger>
          <Collapsible.DefaultPanel>
            <ol className="grid gap-1 text-sm">
              {lane.pushes.map((push) => (
                <li key={push.seq} className="flex flex-wrap gap-x-2">
                  <span className="tabular-nums text-kumo-subtle">{`Event ${push.seq}`}</span>
                  <span className="min-w-0 break-all font-mono text-[0.9em]" translate="no">
                    {push.ref}
                  </span>
                  <span>
                    {push.from === null ? "new" : <ShortSha sha={push.from} />} to{" "}
                    <ShortSha sha={push.to} />
                  </span>
                </li>
              ))}
            </ol>
          </Collapsible.DefaultPanel>
        </Collapsible.Root>
      )}
    </li>
  );
};

const STATUS_BADGE: Readonly<Record<LaneStatus["kind"], { label: string; variant: BadgeVariant }>> =
  {
    refused: { label: "Refused", variant: "error" },
    waiting_on_decision: { label: "Waiting on decision", variant: "warning" },
    working: { label: "Working", variant: "neutral" },
    ready: { label: "Ready", variant: "info" },
    landed: { label: "Landed", variant: "success" },
    expired: { label: "Expired", variant: "outline" },
  };

const REFUSAL_TEXT: Readonly<Record<RefusalReason, string>> = {
  stale_generation: "that generation no longer holds the claim.",
  after_ready: "the claim was already ready, so its commit is pinned.",
  unacked_decision: "a decision affecting the claim is not acknowledged yet.",
};

const waitingReason = (status: LaneStatus): string | null => {
  switch (status.kind) {
    case "refused":
      return `Refused: ${REFUSAL_TEXT[status.reason]}`;
    case "waiting_on_decision":
      return status.questions.length === 1
        ? "Waiting for a person to answer its question."
        : `Waiting for a person to answer its ${status.questions.length} questions.`;
    case "expired":
      return "The claim expired. Its fork takes no more pushes.";
    case "working":
    case "ready":
    case "landed":
      return null;
    default:
      return unreachable(status);
  }
};

const decisionText = (ref: DecisionRef): string => `${ref.decisionId} version ${ref.version}`;

const decisionList = (refs: readonly DecisionRef[]) => (
  <span translate="no">{refs.map(decisionText).join(", ")}</span>
);

const inboxText = (item: LaneInboxItem): string => {
  switch (item.kind) {
    case "decision":
      return `Decision ${decisionText(item.decision)}`;
    case "rework":
      return `Rework for decision ${decisionText(item.decision)}`;
    case "conflict":
      return `Redo on the new base: conflict on ${item.path} with ${item.otherIssueTitle ?? item.otherClaimId}`;
    default:
      return unreachable(item);
  }
};

const pushesLabel = (count: number): string =>
  count === 1 ? "1 recent push" : `${count} recent pushes`;

const unreachable = (value: never): never => {
  throw new Error(`unhandled claim lane variant: ${JSON.stringify(value)}`);
};
