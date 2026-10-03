import { Button, ClipboardText, Input, Text } from "@cloudflare/kumo";
import { useState, type FormEvent } from "react";
import { ActionMessage } from "./ActionMessage";
import { inviteNameProblem } from "./roster";
import { useOwnerAction, type ActionAccess } from "./useOwnerAction";

const expiryFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** Creates a single-use invite for a named agent and shows its URL once. */
export const InviteForm = ({ access }: { access: ActionAccess }) => {
  const [name, setName] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const { state, run, reset } = useOwnerAction(access);
  const pending = state.kind === "pending";

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = inviteNameProblem(name);
    setInvalid(problem);
    if (problem !== null) return;
    const outcome = await run({ kind: "invite.create", name });
    if (outcome?.kind === "performed") setName("");
  };

  const invite =
    state.kind === "performed" && state.result.kind === "invite.create" ? state.result : null;

  return (
    <form className="grid gap-3" noValidate onSubmit={(event) => void onSubmit(event)}>
      <Input
        label="Agent name"
        name="agent-name"
        description="Lowercase letters, digits and hyphens. The name is fixed by the invite."
        placeholder="atlas…"
        autoComplete="off"
        spellCheck={false}
        passwordManagerIgnore
        value={name}
        onChange={(event) => {
          setName(event.target.value);
          setInvalid(null);
        }}
        disabled={access.kind === "blocked" || pending}
        {...(invalid === null ? {} : { error: invalid })}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          type="submit"
          variant="primary"
          disabled={access.kind === "blocked"}
          loading={pending}
        >
          {pending ? "Waiting for passkey…" : "Create invite"}
        </Button>
      </div>
      <div aria-live="polite" className="grid gap-2">
        {invite === null ? (
          <ActionMessage state={state} cancelled="Cancelled. No invite was created." />
        ) : (
          <>
            <Text>
              Invite created. Give this URL to the agent; it works once, until{" "}
              {expiryFormat.format(invite.expiresAt)}, and is not shown again.
            </Text>
            <ClipboardText size="base" text={invite.inviteUrl} />
            <div>
              <Button variant="secondary" size="sm" onClick={reset}>
                Hide invite
              </Button>
            </div>
          </>
        )}
      </div>
    </form>
  );
};
