// Binds the board page's ports to the one backend session.
//
// Each connection attempt opens the repository's board, its owner's actions and the owner's
// enrollment once, and builds one port object of each kind for that session, so a form can tell a
// replaced session's port from the current one. Everything an attempt obtained is disposed when the
// attempt ends, and nothing it started can update state afterwards: a replaced session never
// overwrites the current one. The folded board outlives sessions, so a reconnect resumes from its
// cursor instead of reloading the log.

import { useEffect, useRef, useState } from "react";
import type { BoardErrorCode, BoardFailure, BoardResult } from "@railhead/shared/board-api";
import {
  type ApiSession,
  type BoardRepo,
  type EnrollmentSession,
  type OwnerSession,
  openApiSession,
} from "../../rpc/apiSession";
import { BoardStream, type StreamPhase, type StreamSink } from "../../rpc/boardStream";
import { type CurrentSession, useApiConnection } from "../../rpc/useApiConnection";
import type {
  DecisionActions,
  RecordDecisionOutcome,
  RecordDecisionRequest,
} from "../decisions/decisionActions";
import type { AttemptControl } from "../enrollment/ownerActions";
import { browserAuthenticator, signAction, type Authenticator } from "../enrollment/webauthn";
import type { BoardPorts, BoardRead, EnrollmentPort, OwnerPort } from "./boardPorts";
import { type BoardState, emptyBoardState, foldEvents } from "./boardState";

/** The folded board, kept across sessions for one repository. */
interface Folded {
  /** The repository it was read from, as `org/repo`. */
  key: string;
  board: BoardState;
  /** A session has caught this board up to its subscription at least once. */
  everLive: boolean;
  recovered: boolean;
}

/** What one session has opened. */
interface SessionView {
  session: CurrentSession;
  board: "opening" | "open" | "unavailable" | "failed";
  stream: StreamPhase | null;
  owner: OwnerPort;
  enrollment: EnrollmentPort;
  decisions: DecisionActions;
}

const OFFLINE = { kind: "unavailable", reason: "offline" } as const;

/**
 * The board page's ports for `target`, bound to one backend session at a time. `connect` and
 * `authenticate` are replaced in tests.
 */
export const useLiveBoardPorts = (
  target: BoardRepo,
  connect: () => ApiSession = openApiSession,
  authenticate: () => Authenticator | null = browserAuthenticator,
): BoardPorts => {
  const { status, session, onRetry } = useApiConnection(connect);
  const [authenticator] = useState(authenticate);
  const [view, setView] = useState<SessionView | null>(null);
  const [folded, setFolded] = useState<Folded | null>(null);
  const kept = useRef<Folded | null>(null);
  const { org, repo } = target;

  useEffect(() => {
    if (session === null) return;
    let current = true;
    const { api } = session;
    const key = `${org}/${repo}`;
    if (kept.current?.key !== key) kept.current = null;
    const held: Disposable[] = [];
    const controller = new AbortController();
    let stream: BoardStream | null = null;
    let live = false;
    // Aborted whenever the board leaves live, so an answer started on a board that stopped being
    // current is never sent. A new period of being live gets a fresh one.
    let liveAccess = new AbortController();

    const update = (patch: Partial<SessionView>) => {
      if (current)
        setView((prior) => (prior?.session === session ? { ...prior, ...patch } : prior));
    };
    const keep = (next: Folded) => {
      kept.current = next;
      setFolded(next);
    };

    const sink: StreamSink = {
      onRepo: (repoId) => {
        if (current && kept.current === null) {
          keep({ key, board: emptyBoardState(repoId), everLive: false, recovered: false });
        }
      },
      onEvents: (events) => {
        const before = kept.current;
        if (!current || before === null) return { cursor: 0, halted: true };
        const board = foldEvents(before.board, events);
        keep({ ...before, board, recovered: live ? false : before.recovered });
        return { cursor: board.cursor, halted: board.stream.kind === "halted" };
      },
      onPhase: (phase) => {
        if (!current) return;
        live = phase.kind === "live";
        if (!live) liveAccess.abort();
        else if (liveAccess.signal.aborted) liveAccess = new AbortController();
        const before = kept.current;
        if (live && before !== null) {
          keep({ ...before, everLive: true, recovered: before.everLive });
        }
        update({ stream: phase });
      },
    };

    // Resolved once: every enrollment call of this session reaches the same capability.
    const enrollment = Promise.resolve(api.ownerEnrollment());
    void enrollment.then(
      (stub) => (current ? held.push(stub) : stub[Symbol.dispose]()),
      () => {},
    );
    setView({
      session,
      board: "opening",
      stream: null,
      owner: OFFLINE,
      enrollment: enrollmentPort(enrollment),
      decisions: OFFLINE,
    });

    const open = async () => {
      const opened = await api.openBoard(org, repo);
      if (!current) {
        if (opened.ok) opened.value[Symbol.dispose]();
        return;
      }
      if (!opened.ok) {
        update({ board: openFailure(opened.code) });
        return;
      }
      const board = opened.value;
      held.push(board);
      stream = new BoardStream(board, sink, kept.current?.board.cursor ?? 0);
      const owner = await board.owner();
      if (!current) {
        owner[Symbol.dispose]();
        return;
      }
      held.push(owner);
      update({
        board: "open",
        owner: ownerPort(owner),
        decisions:
          authenticator === null
            ? { kind: "unavailable", reason: "no_passkey" }
            : {
                kind: "available",
                onRecordDecision: (request, control) =>
                  recordDecision(
                    owner,
                    authenticator,
                    {
                      signal: AbortSignal.any([
                        controller.signal,
                        liveAccess.signal,
                        control.signal,
                      ]),
                      onSent: control.onSent,
                    },
                    request,
                  ),
              },
      });
    };
    open().catch(() => update({ board: "failed" }));

    return () => {
      current = false;
      controller.abort();
      stream?.[Symbol.dispose]();
      for (const stub of held.toReversed()) stub[Symbol.dispose]();
    };
  }, [session, org, repo, authenticator]);

  const bound = view !== null && view.session === session ? view : null;
  return {
    connection: status,
    onReconnect: onRetry,
    board: boardRead(bound, folded?.key === `${org}/${repo}` ? folded : null, status),
    decisions: bound?.decisions ?? OFFLINE,
    owner: bound?.owner ?? OFFLINE,
    enrollment: bound?.enrollment ?? OFFLINE,
  };
};

/** What the page reads: the folded board once one session has caught it up, or why there is none. */
const boardRead = (
  view: SessionView | null,
  folded: Folded | null,
  status: "connecting" | "connected" | "lost",
): BoardRead => {
  const stream = view?.stream ?? null;
  const stopped = stream?.kind === "stopped" ? stream.reason : null;
  if (folded === null || !folded.everLive) {
    if (view?.board === "unavailable" || stopped === "unavailable") return { kind: "unavailable" };
    if (view?.board === "failed" || (stopped !== null && folded === null)) {
      return { kind: "available", feed: { kind: "failed" } };
    }
    if (folded === null || stopped === null) {
      return { kind: "available", feed: { kind: "loading" } };
    }
  }
  const current =
    status !== "lost" && (stream?.kind === "live" || stopped === "halted") ? "live" : "lost";
  return {
    kind: "available",
    feed: {
      kind: "board",
      board: folded.board,
      connection: current,
      recovered: current === "live" && folded.recovered,
    },
  };
};

const openFailure = (code: BoardErrorCode): SessionView["board"] => {
  switch (code) {
    case "not_found":
    case "unavailable":
      return "unavailable";
    case "invalid_request":
    case "cursor_ahead":
    case "proof_invalid":
    case "proof_expired":
    case "action_stale":
    case "bootstrap_closed":
    case "quota_exceeded":
    case "internal":
      return "failed";
    default:
      return unreachable(code);
  }
};

const LOST_CALL: BoardFailure = {
  ok: false,
  code: "internal",
  message: "The call did not complete: the session failed.",
};

/** Turns a call that threw, on a broken or replaced session, into a failed result. */
const settle = async <T>(call: () => PromiseLike<BoardResult<T>>): Promise<BoardResult<T>> => {
  try {
    return await call();
  } catch {
    return LOST_CALL;
  }
};

const ownerPort = (owner: OwnerSession): OwnerPort => ({
  kind: "available",
  onPrepareAction: (action) => settle(() => owner.prepare(action)),
  onPerformAction: (challengeId, assertion) => settle(() => owner.perform(challengeId, assertion)),
});

const enrollmentPort = (enrollment: PromiseLike<EnrollmentSession>): EnrollmentPort => ({
  kind: "available",
  onPrepareEnrollment: (token) => settle(async () => (await enrollment).prepare(token)),
  onCompleteEnrollment: (challengeId, registration) =>
    settle(async () => (await enrollment).complete(challengeId, registration)),
});

/**
 * Records a decision with a fresh passkey assertion bound to exactly that answer. Nothing is
 * performed once `control.signal` aborts, `control.onSent` is called just before the answer is
 * sent, and a result for anything but the requested decision is a failure. Never throws.
 */
export const recordDecision = async (
  owner: OwnerSession,
  authenticator: Authenticator,
  control: AttemptControl,
  request: RecordDecisionRequest,
): Promise<RecordDecisionOutcome> => {
  const { decisionId } = request;
  const { signal } = control;
  try {
    const prepared = await owner.prepare({ kind: "decision.record", ...request });
    if (!prepared.ok) return { ok: false, message: refusal(prepared.code) };
    if (signal.aborted) return WITHDRAWN;
    const signed = await signAction(authenticator, prepared.value, signal);
    switch (signed.kind) {
      case "cancelled":
        return { ok: false, message: "The passkey prompt was dismissed. Nothing was recorded." };
      case "failed":
        return { ok: false, message: signed.message };
      case "done":
        break;
      default:
        return unreachable(signed);
    }
    if (signal.aborted) return WITHDRAWN;
    control.onSent();
    const performed = await owner.perform(prepared.value.challengeId, signed.value);
    if (!performed.ok) return { ok: false, message: refusal(performed.code) };
    const result = performed.value;
    if (result.kind !== "decision.record" || result.decisionId !== decisionId) {
      return {
        ok: false,
        message: "The backend answered for a different action. Check the question before retrying.",
      };
    }
    return { ok: true, version: result.version };
  } catch {
    return {
      ok: false,
      message: "The answer was not confirmed. Check the question before retrying.",
    };
  }
};

const WITHDRAWN: RecordDecisionOutcome = {
  ok: false,
  message: "The board lost its session before the answer was sent. Nothing was recorded.",
};

/**
 * The sentence for a refused answer. The backend's own message is untrusted text, so the board
 * names the outcome from the closed code.
 */
const refusal = (code: BoardErrorCode): string => {
  switch (code) {
    case "proof_invalid":
      return "The passkey did not verify for this answer. Nothing was recorded.";
    case "proof_expired":
      return "The passkey request expired or was already used. Try again.";
    case "action_stale":
      return "The answer changed since this board read it. Nothing was recorded.";
    case "unavailable":
      return "This Railhead cannot record answers: its decisions module is not installed.";
    case "invalid_request":
    case "not_found":
    case "bootstrap_closed":
    case "quota_exceeded":
      return "The backend refused the answer. Nothing was recorded.";
    case "cursor_ahead":
    case "internal":
      return "The backend failed. Check the question, then try again.";
    default:
      return unreachable(code);
  }
};

const unreachable = (value: never): never => {
  throw new Error(`unhandled live board variant: ${JSON.stringify(value)}`);
};
