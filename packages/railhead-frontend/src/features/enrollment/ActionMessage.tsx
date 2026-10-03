import { Text } from "@cloudflare/kumo";
import { unreachable } from "./ownerActions";
import type { ActionState } from "./useOwnerAction";

interface ActionMessageProps {
  state: ActionState;
  /** What a dismissed passkey prompt left unchanged, as a full sentence. */
  cancelled: string;
  /**
   * What to say once the action is performed, if the form shows nothing else for it. The row
   * itself changes only when the log records the action.
   */
  performed?: string;
}

/** The outcome of a form's last action. Place it in a persistent polite live region. */
export const ActionMessage = ({ state, cancelled, performed }: ActionMessageProps) => {
  switch (state.kind) {
    case "idle":
    case "pending":
      return null;
    case "cancelled":
      return <Text variant="secondary">{cancelled}</Text>;
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
            ? "The board lost its current view after the action was sent. Check the agents list before retrying."
            : "Stopped: the board lost its current view before the action was sent. Nothing changed."}
        </Text>
      );
    case "performed":
      return performed === undefined ? null : <Text variant="secondary">{performed}</Text>;
    default:
      return unreachable(state);
  }
};
