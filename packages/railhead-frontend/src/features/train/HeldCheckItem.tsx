import { Badge, Button, Text, type BadgeVariant } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  ClockIcon,
  ProhibitIcon,
  ShieldWarningIcon,
  WarningIcon,
  XCircleIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { HeldCheckState } from "../board/boardState";
import { ShortSha } from "../claims/ShortSha";
import { BlockedNote } from "../enrollment/BlockedNote";
import type { AvailableOwnerPort } from "../enrollment/ownerActions";
import type { ActionAccess } from "../enrollment/useOwnerAction";
import { usePortAttempt, type AttemptState } from "../enrollment/usePortAttempt";
import { approveCheck, type ApproveOutcome } from "./approveCheck";
import type { HeldCheckRow, HeldCheckStatus } from "./heldCheckRows";

/**
 * The approvals sent that the log has not yet recorded or the backend refused, by `approvalKey`.
 * Each may have been recorded, so none is offered again until the log or a refusal settles it.
 */
export interface SentApprovals {
  keys: ReadonlySet<string>;
  onChange: (key: string, sent: boolean) => void;
}

const approvalKey = (held: HeldCheckState & { digest: string }): string =>
  `${held.checkRunId}:${held.digest}`;

interface HeldCheckItemProps {
  row: HeldCheckRow;
  access: ActionAccess;
  sent: SentApprovals;
  /** The event the board stopped at when it is not current, or `null` when it is. */
  asOf: number | null;
}

/**
 * One held check: which claims and candidate it covers, the protected paths the candidate changes
 * and, while it waits, the owner's approval of exactly the candidate's definition. Issue titles and
 * paths are untrusted text.
 */
export const HeldCheckItem = ({ row, access, sent, asOf }: HeldCheckItemProps) => {
  const { held, claims, status } = row;
  const titleId = `held-${held.checkRunId}`;
  const [first, ...rest] = claims;
  const title =
    first === undefined
      ? "Held check"
      : rest.length === 0
        ? first.issueTitle
        : `${first.issueTitle} and ${rest.length} more`;

  return (
    <li className="grid gap-2 px-4 py-3" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Text as="h3" variant="heading" DANGEROUS_className="min-w-0 break-words text-pretty">
          <span id={titleId}>{title}</span>
        </Text>
        <HeldBadge status={status} asOf={asOf} />
      </div>
      <Text>
        Candidate <ShortSha sha={held.candidate} />, composed on main{" "}
        <ShortSha sha={held.expectedMain} />,{" "}
        {held.approval !== null
          ? "changed what its check runs, so the check was held until it was approved."
          : status.kind === "ended"
            ? "changed what its check runs, so the check was held instead of run."
            : "changes what its check runs, so the check is held instead of run."}
      </Text>
      <div className="grid gap-1">
        <Text variant="secondary">Protected paths it changes</Text>
        <ul className="grid gap-0.5 pl-1" aria-label="Protected paths it changes">
          {held.paths.map((path) => (
            <li key={path} className="min-w-0 break-all font-mono text-sm" translate="no">
              {path}
            </li>
          ))}
        </ul>
      </div>
      {claims.length > 1 && (
        <div className="grid gap-1">
          <Text variant="secondary">Claims in this candidate</Text>
          <ul className="grid gap-0.5 pl-1" aria-label="Claims in this candidate">
            {claims.map((claim) => (
              <li key={claim.claimId} className="min-w-0 break-words">
                {claim.issueTitle}{" "}
                <span className="font-mono text-sm text-kumo-subtle" translate="no">
                  {claim.claimId}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <StatusDetail held={held} status={status} access={access} sent={sent} />
    </li>
  );
};

const StatusDetail = ({
  held,
  status,
  access,
  sent,
}: {
  held: HeldCheckState;
  status: HeldCheckStatus;
  access: ActionAccess;
  sent: SentApprovals;
}) => {
  switch (status.kind) {
    case "waiting":
      return held.digest === null ? null : (
        <ApproveAction held={{ ...held, digest: held.digest }} access={access} sent={sent} />
      );
    case "unapprovable":
      return (
        <Text variant="secondary">
          The candidate has no valid check definition, so there is nothing to approve. A new push to
          the claim is checked again.
        </Text>
      );
    case "approved":
      return (
        <Text variant="secondary">
          <Approver held={held} /> Waiting for the run's result.
        </Text>
      );
    case "ran":
      return (
        <Text variant="secondary">
          <Approver held={held} /> The run {RESULT_TEXT[status.result]}.
        </Text>
      );
    case "ended":
      return <Text variant="secondary">{ENDED_TEXT[status.reason]}</Text>;
    default:
      return unreachable(status);
  }
};

const ENDED_TEXT = {
  superseded:
    "A newer attempt or a new holder of its claim replaced this one, so the train will not run it and there is nothing to approve.",
  dropped:
    "Its claim was reopened or expired, so the train will not run this attempt and there is nothing to approve.",
} as const;

const Approver = ({ held }: { held: HeldCheckState }) => (
  <>
    Approved by <span translate="no">{held.approval?.userId ?? "the owner"}</span> to run the
    candidate's definition <Digest digest={held.digest} />.
  </>
);

const Digest = ({ digest }: { digest: string | null }) =>
  digest === null ? null : (
    <span className="font-mono text-[0.9em]" translate="no" title={digest}>
      {digest.slice(0, 12)}
    </span>
  );

const ApproveAction = ({
  held,
  access,
  sent,
}: {
  held: HeldCheckState & { digest: string };
  access: ActionAccess;
  sent: SentApprovals;
}) => {
  const { state, start } = usePortAttempt<AvailableOwnerPort, ApproveOutcome>(
    access.kind === "ready" ? access.owner : null,
  );
  const pending = state.kind === "pending";
  const key = approvalKey(held);
  // Once sent, an approval may have been recorded, including one the board withdrew mid-send: it is
  // not offered again, even on a new session, until the log records it or the backend refuses it.
  const unsettled = sent.keys.has(key);

  const onApprove = async () => {
    if (access.kind !== "ready") return;
    const { owner, authenticator } = access;
    const outcome = await start(owner, (control) =>
      approveCheck(owner, authenticator, held, {
        signal: control.signal,
        onSent: () => {
          control.onSent();
          sent.onChange(key, true);
        },
      }),
    );
    // A stated refusal proves nothing was approved; every other outcome after sending is kept.
    if (outcome?.kind === "failed") sent.onChange(key, false);
  };

  return (
    <div className="grid gap-2">
      <Text variant="secondary">
        Approving runs the check command from this candidate's own definition{" "}
        <Digest digest={held.digest} /> instead of main's, for this candidate only.
      </Text>
      {access.kind === "blocked" && <BlockedNote block={access.block} />}
      <div>
        <Button
          variant="primary"
          disabled={access.kind === "blocked" || unsettled}
          loading={pending}
          onClick={() => void onApprove()}
        >
          {pending ? "Waiting for passkey…" : "Approve and run this definition"}
        </Button>
      </div>
      <div aria-live="polite">
        <ApproveMessage state={state} unsettled={unsettled} />
      </div>
    </div>
  );
};

const ApproveMessage = ({
  state,
  unsettled,
}: {
  state: AttemptState<ApproveOutcome>;
  unsettled: boolean;
}) => {
  switch (state.kind) {
    case "idle":
      // A row remounted after its approval was sent no longer has the attempt, only that it was sent.
      return unsettled ? (
        <Text variant="secondary">
          The approval was sent but not confirmed. It shows here once the log records it.
        </Text>
      ) : null;
    case "pending":
      return null;
    case "approved":
      return <Text>Approved. The train runs the check next.</Text>;
    case "cancelled":
      return (
        <Text variant="secondary">The passkey prompt was dismissed. Nothing was approved.</Text>
      );
    case "failed":
      return <Text variant="error">{state.message}</Text>;
    case "unconfirmed":
      return (
        <Text variant="secondary">
          The approval was sent but not confirmed. It shows here once the log records it.
        </Text>
      );
    case "withdrawn":
      return (
        <Text variant="secondary">
          {state.sent
            ? "The board lost its session after sending the approval. It shows here once the log records it."
            : "The board lost its session. Nothing was approved."}
        </Text>
      );
    default:
      return unreachable(state);
  }
};

const HeldBadge = ({ status, asOf }: { status: HeldCheckStatus; asOf: number | null }) => {
  const { label, variant, icon: StatusIcon } = badgeFor(status, asOf);
  return (
    <Badge variant={variant} icon={<StatusIcon weight="bold" aria-hidden="true" />}>
      {label}
    </Badge>
  );
};

const badgeFor = (
  status: HeldCheckStatus,
  asOf: number | null,
): { label: string; variant: BadgeVariant; icon: Icon } => {
  switch (status.kind) {
    case "waiting":
      return {
        label: asOf === null ? "Waiting for approval" : `Waiting as of event ${asOf}`,
        variant: "warning",
        icon: ShieldWarningIcon,
      };
    case "unapprovable":
      return { label: "Nothing to approve", variant: "neutral", icon: ProhibitIcon };
    case "approved":
      return { label: "Approved", variant: "info", icon: ClockIcon };
    case "ran":
      switch (status.result) {
        case "pass":
          return { label: "Passed", variant: "success", icon: CheckCircleIcon };
        case "fail":
          return { label: "Failed", variant: "error", icon: XCircleIcon };
        case "error":
          return { label: "Could not run", variant: "warning", icon: WarningIcon };
        default:
          return unreachable(status.result);
      }
    case "ended":
      return {
        label: status.reason === "superseded" ? "Superseded" : "Dropped",
        variant: "neutral",
        icon: ProhibitIcon,
      };
    default:
      return unreachable(status);
  }
};

const RESULT_TEXT = { pass: "passed", fail: "failed", error: "could not run" } as const;

const unreachable = (value: never): never => {
  throw new Error(`unhandled held check variant: ${JSON.stringify(value)}`);
};
