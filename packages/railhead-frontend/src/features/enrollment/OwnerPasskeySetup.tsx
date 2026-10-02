import { Button, Input, Text } from "@cloudflare/kumo";
import { useId, useRef, useState, type FormEvent } from "react";
import type { EnrollmentPort } from "../board/boardPorts";
import { BlockedNote } from "./BlockedNote";
import { enrollOwner, type BootstrapOutcome } from "./ownerBootstrap";
import type { EnrollmentBlock } from "./ownerActions";
import type { Authenticator } from "./webauthn";

type SetupState = { kind: "idle" } | { kind: "pending" } | BootstrapOutcome;

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
 * deploy. The backend closes enrollment after the first success and refuses a wrong token.
 */
export const OwnerPasskeySetup = ({ enrollment, authenticator }: OwnerPasskeySetupProps) => {
  const headingId = useId();
  const [token, setToken] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const [state, setState] = useState<SetupState>({ kind: "idle" });
  // `pending` is captured at render, so two submits in one tick would both pass it.
  const inFlight = useRef(false);
  const block = setupBlock(enrollment, authenticator);
  const pending = state.kind === "pending";

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (enrollment.kind !== "available" || authenticator === null || inFlight.current) return;
    if (token.trim().length === 0) {
      setInvalid("Enter the bootstrap token from the deploy.");
      return;
    }
    setInvalid(null);
    inFlight.current = true;
    setState({ kind: "pending" });
    const outcome = await enrollOwner(enrollment, authenticator, token.trim());
    inFlight.current = false;
    if (outcome.kind === "enrolled") setToken("");
    setState(outcome);
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
          </div>
        </form>
      )}
    </section>
  );
};
