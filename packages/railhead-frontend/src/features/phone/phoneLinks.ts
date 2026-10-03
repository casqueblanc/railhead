// Links that open one question or one join confirmation on a phone.
//
// A link names only an identifier the board already shows to anyone who can open it. It carries no
// token, code or proof: whoever opens it still reads the board anonymously and needs the owner's
// passkey for the one action the page offers, prepared and signed for that action alone.
//
// The owner's passkey is bound to the exact host it was enrolled on, so a link is only useful, and
// only safe to scan, when it points at a reviewed Railhead instance. The board builds links from
// this fixed list, never from a configured or request-derived origin; a board served anywhere else
// offers no phone links.

import { isId, type AgentId, type DecisionId } from "@railhead/shared/events";

/** The Railhead instances a phone link may point at, each the exact origin its passkey is bound to. */
export const PHONE_ORIGINS = [
  "https://railhead.dev",
  "https://railhead.mashin.workers.dev",
] as const;

/** One of {@link PHONE_ORIGINS}. */
export type PhoneOrigin = (typeof PHONE_ORIGINS)[number];

/** The search parameter naming the decision a question link opens. */
export const QUESTION_PARAM = "decision";

/** The search parameter naming the agent a confirmation link opens. */
export const CONFIRM_PARAM = "agent";

/** The reviewed origin the board is served from, or `null` when it is served anywhere else. */
export const phoneOrigin = (origin: string): PhoneOrigin | null =>
  PHONE_ORIGINS.find((reviewed) => reviewed === origin) ?? null;

/** The link that opens decision `decisionId`'s question on a phone. */
export const questionLink = (origin: PhoneOrigin, decisionId: DecisionId): string =>
  link(origin, "/question", QUESTION_PARAM, decisionId);

/** The link that opens agent `agentId`'s join confirmation on a phone. */
export const confirmLink = (origin: PhoneOrigin, agentId: AgentId): string =>
  link(origin, "/confirm", CONFIRM_PARAM, agentId);

const link = (origin: PhoneOrigin, path: string, param: string, id: string): string => {
  const url = new URL(path, origin);
  url.searchParams.set(param, id);
  return url.href;
};

/** What a phone page was asked to open: a well-formed identifier, or nothing it can use. */
export type PhoneTarget<Id extends string> = { kind: "id"; id: Id } | { kind: "invalid" };

/** Reads a question link's decision from the route's search value, which is untrusted. */
export const questionTarget = (value: unknown): PhoneTarget<DecisionId> =>
  typeof value === "string" && isId("decision", value)
    ? { kind: "id", id: value }
    : { kind: "invalid" };

/** Reads a confirmation link's agent from the route's search value, which is untrusted. */
export const confirmTarget = (value: unknown): PhoneTarget<AgentId> =>
  typeof value === "string" && isId("agent", value)
    ? { kind: "id", id: value }
    : { kind: "invalid" };
