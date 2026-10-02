// The fixed composition of a `Repo`: which feature modules exist, what each one receives, and the
// order they are built in. The list is closed. There is no runtime discovery, no import named by
// repository text and no registry a module can write to; a feature takes over its slot by replacing
// the factory its own `modules/<name>/entry.ts` exports, never by editing this file.
//
// Each factory receives the `RepoContext` and a `ports` function. `ports()` returns the other
// modules' ports once every factory has run, so a factory keeps the function and calls it when it
// handles a request, never while it is being built. Main's ref is not among them: only the main
// writer's factory receives `MainRefPort`.

import type { RepoId } from "@railhead/shared/events";
import type { ArtifactsPort } from "../contracts/artifacts";
import type { ClaimsPort } from "../contracts/claims";
import type { DecisionsPort } from "../contracts/decisions";
import type { IdentityPort, SessionsPort } from "../contracts/identity";
import type { InboxPort } from "../contracts/inbox";
import type {
  AuthorizationPort,
  CheckPort,
  MainRefPort,
  MainWriterPort,
  MergePort,
  TrainPort,
} from "../contracts/train";
import { unavailableMainRef } from "../contracts/unavailable";
import { adaptation, type AdaptationPort } from "../modules/adaptation/entry";
import { artifacts } from "../modules/artifacts/entry";
import { authorization } from "../modules/authorization/entry";
import { checks } from "../modules/checks/entry";
import { claims } from "../modules/claims/entry";
import { codeRead, type CodeReadPort } from "../modules/codeRead/entry";
import { conflicts, type ConflictsPort } from "../modules/conflicts/entry";
import { decisions } from "../modules/decisions/entry";
import { git, type GitPort } from "../modules/git/entry";
import { identity } from "../modules/identity/entry";
import { inbox } from "../modules/inbox/entry";
import { mainWriter } from "../modules/mainWriter/entry";
import { merge } from "../modules/merge/entry";
import { owner, type OwnerPort } from "../modules/owner/entry";
import { replay, type ReplayPort } from "../modules/replay/entry";
import { sessions } from "../modules/sessions/entry";
import { stream, type StreamPort } from "../modules/stream/entry";
import { train } from "../modules/train/entry";
import { sandbox, type SandboxPort } from "../sandbox/entry";
import type { EventLog } from "./eventLog";
import type { RepoStorage } from "./storage";

/** What every module of one repository receives. */
export interface RepoContext {
  /** The repository. */
  readonly repoId: RepoId;
  /**
   * The repository's SQLite storage. A module creates and migrates only its own tables, with
   * `migrate` under its own name, and groups writes with `atomically`.
   */
  readonly storage: RepoStorage;
  /** The event log. A module appends only inside `log.transaction`, together with its state change. */
  readonly log: EventLog;
  /** The current time, in milliseconds since the Unix epoch. */
  readonly clock: () => number;
  /** The Worker's bindings. Secrets read from it never reach a client, an event or a log line. */
  readonly env: Env;
}

/** Every module's port, as other modules and the adapters see them. Main's ref is not here. */
export interface RepoPorts {
  /** Invites and enrollment. */
  readonly identity: IdentityPort;
  /** Login challenges and session tokens. */
  readonly sessions: SessionsPort;
  /** Owner passkey actions on this repository. */
  readonly owner: OwnerPort;
  /** Issues and claims. */
  readonly claims: ClaimsPort;
  /** Agent inboxes. */
  readonly inbox: InboxPort;
  /** Questions and decisions. */
  readonly decisions: DecisionsPort;
  /** The Git smart-HTTP gateway. */
  readonly git: GitPort;
  /** Live board subscriptions. */
  readonly stream: StreamPort;
  /** Artifacts forks and tokens. */
  readonly artifacts: ArtifactsPort;
  /** The sandbox merges and checks run in. */
  readonly sandbox: SandboxPort;
  /** Composing pins into candidates. */
  readonly merge: MergePort;
  /** Starting trusted check runs. */
  readonly checks: CheckPort;
  /** The train's queue and check bookkeeping. */
  readonly train: TrainPort;
  /** Merge authorization. */
  readonly authorization: AuthorizationPort;
  /** Publishing authorized intents to main. */
  readonly mainWriter: MainWriterPort;
  /** Conflict classification. */
  readonly conflicts: ConflictsPort;
  /** Adaptation of landed work to a newer decision. */
  readonly adaptation: AdaptationPort;
  /** Captured runs. */
  readonly replay: ReplayPort;
  /** Reading repository files for the board. */
  readonly codeRead: CodeReadPort;
}

/** Builds one module's port. It must not call `ports` before it returns. */
export type ModuleFactory<P> = (context: RepoContext, ports: () => RepoPorts) => P;

/** Builds the main writer, the one module that receives main's ref. */
export type MainWriterFactory = (
  context: RepoContext,
  ports: () => RepoPorts,
  mainRef: MainRefPort,
) => MainWriterPort;

/** Thrown when a factory calls `ports()` while the composition is still being built. */
export class CompositionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompositionError";
  }
}

/** Builds every module of one repository in a fixed order and returns their ports. */
export function composeRepo(context: RepoContext): RepoPorts {
  let composed: RepoPorts | null = null;
  const ports = (): RepoPorts => {
    if (composed === null) {
      throw new CompositionError("a module asked for ports while the Repo was being composed");
    }
    return composed;
  };
  composed = {
    identity: identity(context, ports),
    sessions: sessions(context, ports),
    owner: owner(context, ports),
    claims: claims(context, ports),
    inbox: inbox(context, ports),
    decisions: decisions(context, ports),
    git: git(context, ports),
    stream: stream(context, ports),
    artifacts: artifacts(context, ports),
    sandbox: sandbox(context, ports),
    merge: merge(context, ports),
    checks: checks(context, ports),
    train: train(context, ports),
    authorization: authorization(context, ports),
    // Main's ref is unavailable until the main writer's task supplies it; no other module gets it.
    mainWriter: mainWriter(context, ports, unavailableMainRef),
    conflicts: conflicts(context, ports),
    adaptation: adaptation(context, ports),
    replay: replay(context, ports),
    codeRead: codeRead(context, ports),
  };
  return Object.freeze(composed);
}
