import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useLiveBoardPorts } from "../features/board/liveConnection";
import { browserAuthenticator } from "../features/enrollment/webauthn";
import { PhoneConfirmPage } from "../features/phone/PhoneConfirmPage";
import { CONFIRM_PARAM, confirmTarget } from "../features/phone/phoneLinks";
import { DEFAULT_BOARD_REPO } from "../rpc/apiSession";

interface ConfirmSearch {
  [CONFIRM_PARAM]?: string;
}

const ConfirmRoute = () => {
  const search = Route.useSearch();
  const [authenticator] = useState(browserAuthenticator);
  return (
    <PhoneConfirmPage
      ports={useLiveBoardPorts(DEFAULT_BOARD_REPO)}
      target={confirmTarget(search[CONFIRM_PARAM])}
      authenticator={authenticator}
    />
  );
};

/** Opens one agent's join confirmation on a phone. The search parameter only names the agent. */
export const Route = createFileRoute("/confirm")({
  validateSearch: (search: Record<string, unknown>): ConfirmSearch => {
    const value = search[CONFIRM_PARAM];
    return typeof value === "string" ? { [CONFIRM_PARAM]: value } : {};
  },
  component: ConfirmRoute,
});
