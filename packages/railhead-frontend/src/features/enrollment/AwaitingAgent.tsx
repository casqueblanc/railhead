import { Badge, Button, Input, Text } from "@cloudflare/kumo";
import { useState, type FormEvent } from "react";
import type { AgentState } from "../board/boardState";
import { ActionMessage } from "./ActionMessage";
import { RevokeAgent } from "./RevokeAgent";
import { codeProblem } from "./roster";
import { useOwnerAction, type ActionAccess } from "./useOwnerAction";

interface AwaitingAgentProps {
  agent: AgentState;
  access: ActionAccess;
}

/**
 * An agent that joined and waits for the owner. The board does not show the confirmation code: the
 * owner types the code the agent's own terminal shows, and the backend refuses one that differs.
 * The agent stays unconfirmed until the log records `agent.confirmed`. An agent the owner did not
 * invite, or whose code does not match, is rejected instead, without ever being confirmed.
 */
export const AwaitingAgent = ({ agent, access }: AwaitingAgentProps) => {
  const [code, setCode] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const { state, run } = useOwnerAction(access);
  const pending = state.kind === "pending";

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const problem = codeProblem(code);
    setInvalid(problem);
    if (problem !== null) return;
    await run({ kind: "agent.confirm", agentId: agent.agentId, code });
  };

  return (
    <li className="grid gap-3 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <Text bold DANGEROUS_className="min-w-0 break-words">
          {agent.name}
        </Text>
        <Badge variant="warning">Awaiting confirmation</Badge>
      </div>
      <form className="grid gap-3" noValidate onSubmit={(event) => void onSubmit(event)}>
        <Input
          label={`Code shown by ${agent.name}`}
          name="confirmation-code"
          description="Match the six digits in the agent's terminal. Confirm only if they are the same."
          placeholder="123456…"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          spellCheck={false}
          passwordManagerIgnore
          value={code}
          onChange={(event) => {
            setCode(event.target.value.trim());
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
            {pending ? "Waiting for passkey…" : "Confirm agent"}
          </Button>
        </div>
        <div aria-live="polite">
          <ActionMessage
            state={state}
            cancelled={`Cancelled. ${agent.name} stays unconfirmed and cannot work.`}
            performed={`Confirmed. ${agent.name} shows as confirmed once the log records it.`}
          />
        </div>
      </form>
      <RevokeAgent agent={agent} access={access} stage="awaiting" />
    </li>
  );
};
