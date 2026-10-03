// The agents section's rows, derived from the folded log. Who is enrolled is whatever the log says;
// an action the owner just performed shows here only once its event is folded.

import { MAX_AGENT_NAME_LENGTH, type InviteId } from "@railhead/shared/events";
import type { AgentState, BoardState } from "../board/boardState";

/**
 * The agent name rule `validateEvent` applies, checked before asking for a challenge so the owner
 * is not asked for a passkey over a name the backend refuses. The backend checks it again.
 */
const AGENT_NAME = /^[a-z][a-z0-9-]*$/;
const CONFIRMATION_CODE = /^[0-9]{6}$/;

/** An invite no agent has used yet. */
export interface OpenInvite {
  inviteId: InviteId;
  name: string;
}

/** The section's rows, each list ordered by name and then id so it does not reshuffle. */
export interface Roster {
  invites: readonly OpenInvite[];
  awaiting: readonly AgentState[];
  confirmed: readonly AgentState[];
  revoked: readonly AgentState[];
}

const byName =
  <T extends { name: string }>(key: (item: T) => string) =>
  (a: T, b: T) =>
    a.name.localeCompare(b.name) || key(a).localeCompare(key(b));

/** Splits the board's invites and agents into the section's rows. */
export const roster = (state: BoardState): Roster => {
  const agents = Object.values(state.agents).toSorted(byName((agent) => agent.agentId));
  return {
    invites: Object.values(state.invites)
      .filter((invite) => invite.agentId === null)
      .map(({ inviteId, name }) => ({ inviteId, name }))
      .toSorted(byName((invite) => invite.inviteId)),
    awaiting: agents.filter((agent) => agent.status === "awaiting_confirmation"),
    confirmed: agents.filter((agent) => agent.status === "confirmed"),
    revoked: agents.filter((agent) => agent.status === "revoked"),
  };
};

/** Why an invite name is refused, or `null` when the backend may accept it. */
export const inviteNameProblem = (name: string): string | null => {
  if (name.length === 0) return "Enter a name for the agent.";
  if (name.length > MAX_AGENT_NAME_LENGTH) {
    return `Use at most ${MAX_AGENT_NAME_LENGTH} characters.`;
  }
  if (!AGENT_NAME.test(name)) {
    return "Start with a lowercase letter; use only lowercase letters, digits and hyphens.";
  }
  return null;
};

/** Why a confirmation code is refused, or `null` for six digits. */
export const codeProblem = (code: string): string | null =>
  CONFIRMATION_CODE.test(code) ? null : "Enter the six digits the agent's terminal shows.";
