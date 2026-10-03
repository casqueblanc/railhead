import { Button, Input, Text } from "@cloudflare/kumo";
import { useId, useState, type FormEvent } from "react";
import type { EnrollmentPort } from "../board/boardPorts";
import { BlockedNote } from "./BlockedNote";
import { enrollOwner, type AvailableEnrollmentPort, type BootstrapOutcome } from "./ownerBootstrap";
import type { EnrollmentBlock } from "./ownerActions";
import { usePortAttempt } from "./usePortAttempt";
import type { Authenticator } from "./webauthn";

interface OwnerPasskeySetupProps {
  enrollment: EnrollmentPort;
  authenticator: Authenticator | null;
}

/** Why the owner's passkey cannot be enrolled from this page, or `null` when it can. */
const setupBlock = (
  enrollment: EnrollmentPort,
  authenticator: Authenticator | null,
): EnrollmentBlock | null => {
  if (enrollment.kind === "unavailable") {
    return { kind: "unavailable", reason: enrollment.reason };
  }
  return authenticator === null ? { kind: "no_authenticator" } : null;
};

/**
 * Enrolls the instance owner's first passkey with the one-time token the operator configured at
 * deploy. The backend closes enrollment after the first success and refuses a wrong token. An
 * attempt belongs to the enrollment port it started with; see {@link usePortAttempt}.
 */
export const OwnerPasskeySetup = ({ enrollment, authenticator }: OwnerPasskeySetupProps) => {
  const headingId = useId();
  const [token, setToken] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const { state, start } = usePortAttempt<AvailableEnrollmentPort, BootstrapOutcome>(
    enrollment.kind === "available" ? enrollment : null,
  );
  const block = setupBlock(enrollment, authenticator);
  const pending = state.kind === "pending";

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (enrollment.kind !== "available" || authenticator === null) return;
    const bootstrapToken = token.trim();
    if (bootstrapToken.length === 0) {
      setInvalid("Enter the bootstrap token from the deploy.");
      return;
    }
    setInvalid(null);
    const outcome = await start(enrollment, (control) =>
      enrollOwner(enrollment, authenticator, bootstrapToken, control),
    );
    if (outcome?.kind === "enrolled") setToken("");
  };

  return (
    <section aria-labelledby={headingId} className="grid gap-3 border-t border-kumo-line px-4 py-3">
      <div className="grid gap-1">
        <Text as="h3" variant="heading">
          <span id={headingId}>Owner passkey</span>
        </Text>
        <Text variant="secondary">
          On a new Railhead, enroll the owner&apos;s passkey once with the bootstrap token set at
          deploy. Every invite, confirmation and revocation then needs that passkey.
        </Text>
      </div>
      {state.kind === "enrolled" ? (
        <div aria-live="polite">
          <Text>Owner passkey enrolled. Enrollment is now closed.</Text>
        </div>
      ) : (
        <form className="grid gap-3" noValidate onSubmit={(event) => void onSubmit(event)}>
          <Input
            label="Bootstrap token"
            name="bootstrap-token"
            type="password"
            autoComplete="off"
            spellCheck={false}
            passwordManagerIgnore
            value={token}
            onChange={(event) => {
              setToken(event.target.value);
              setInvalid(null);
            }}
            disabled={block !== null || pending}
            {...(invalid === null ? {} : { error: invalid })}
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Button type="submit" variant="secondary" disabled={block !== null} loading={pending}>
              {pending ? "Waiting for passkey…" : "Enroll owner passkey"}
            </Button>
            {block !== null && <BlockedNote block={block} />}
          </div>
          <div aria-live="polite">
            {state.kind === "cancelled" && (
              <Text variant="secondary">Cancelled. No passkey was enrolled.</Text>
            )}
            {state.kind === "failed" && (
              <Text variant="error" DANGEROUS_className="break-words">
                {state.message}
              </Text>
            )}
            {state.kind === "withdrawn" && (
              <Text variant="error" DANGEROUS_className="break-words">
                {state.sent
                  ? "The board lost its connection after the passkey was sent. Try again; if enrollment is closed, the passkey was enrolled."
                  : "Stopped: the board lost its connection before the passkey was sent. Nothing was enrolled."}
              </Text>
            )}
          </div>
        </form>
      )}
    </section>
  );
};
