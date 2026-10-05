import { LayerCard, Text } from "@cloudflare/kumo";
import { useId } from "react";
import type { EnrollmentPort } from "../board/boardPorts";
import { BlockedNote } from "./BlockedNote";
import { OwnerPasskeySetup } from "./OwnerPasskeySetup";
import type { Authenticator } from "./webauthn";

/** What the page hands the owner setup slot on an instance with no board. */
export interface OwnerSetupSlotProps {
  enrollment: EnrollmentPort;
}

interface OwnerSetupCardProps extends OwnerSetupSlotProps {
  /** The browser's authenticator, or `null` when this page cannot use passkeys. */
  authenticator: Authenticator | null;
}

/**
 * The owner passkey form on an instance that serves no board yet, where the Agents panel that
 * otherwise holds it does not render. Seeding the demo repository needs this passkey.
 *
 * The board cannot read whether enrollment is still open: the backend answers `bootstrap_closed`
 * for a wrong token and for an existing owner alike. The form therefore stays until this page
 * enrolls the owner, and a refusal leaves it in place so a mistyped token can be entered again.
 */
export const OwnerSetupCard = ({ enrollment, authenticator }: OwnerSetupCardProps) => {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <LayerCard>
        <LayerCard.Secondary>
          <Text as="h2" variant="heading" DANGEROUS_className="text-balance">
            <span id={headingId}>Set up this Railhead</span>
          </Text>
        </LayerCard.Secondary>
        <LayerCard.Primary className="p-0">
          {enrollment.kind === "available" ? (
            <OwnerPasskeySetup enrollment={enrollment} authenticator={authenticator} />
          ) : (
            <div className="px-4 py-3">
              <BlockedNote block={{ kind: "unavailable", reason: enrollment.reason }} />
            </div>
          )}
        </LayerCard.Primary>
      </LayerCard>
    </section>
  );
};
