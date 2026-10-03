// One repository's Durable Object: its storage, its event log and its composed modules.
//
// It is reached only through this Worker's `REPO` binding, by the fixed adapters in `gateway/`;
// nothing outside the Worker can call its methods. The adapters validate input and authenticate
// nothing themselves: who is calling is decided inside, by the sessions and owner modules, against
// current state. No method takes an actor or appends an arbitrary event.
//
// A repository exists once `initialize` has recorded it. Until then the object reads, but never
// writes, its storage, so a request for a name nobody created leaves nothing behind. The two demo
// seed objects are the exception: the demo repository's object records its seed's Artifacts
// effects and its reset marker, and migrates the Artifacts adapter's tables to list forks, before
// `initialize`; the seed control object keeps its seal key and spent proofs without ever being
// initialized. All state is rebuilt from storage when the object starts, so eviction or
// hibernation loses nothing but live subscriptions.

import { DurableObject } from "cloudflare:workers";
import { isRepoSegment, type RepoSegment } from "@railhead/shared/agent-api";
import type {
  ActionChallenge,
  DemoSeedAction,
  DemoSeedResult,
  DemoSeedState,
  EventPage,
  OwnerAction,
  OwnerActionResult,
  PasskeyAssertion,
  PendingJoin,
} from "@railhead/shared/board-api";
import { DEMO_ORG, DEMO_REPO, MAX_EVENT_PAGE } from "@railhead/shared/board-api";
import type { CommitSha, RepoId } from "@railhead/shared/events";
import { fail, ok, type PortResult } from "../contracts/result";
import type { CheckAttempt, CheckRunReport } from "../contracts/train";
import { dispatchAgent, type AgentCall, type AgentReply } from "../gateway/agentDispatch";
import type { SeedControl } from "../modules/demoSeed/control";
import {
  DEMO_OBJECT_NAME,
  DEMO_SEED_CONTROL,
  demoSeedControl,
  demoSeedTarget,
} from "../modules/demoSeed/entry";
import type { SeedTarget } from "../modules/demoSeed/target";
import type { GitTarget } from "../modules/git/entry";
import type { StreamListener, StreamSubscription } from "../modules/stream/entry";
import { composeRepo, resumables, resumeAll, type RepoPorts } from "./composeRepo";
import { EventLog, EventLogError } from "./eventLog";
import { EarliestAlarm, migrate } from "./storage";

/** A repository as it was recorded. */
export interface RepoSummary {
  /** The repository's identifier. */
  repoId: RepoId;
  /** Its organisation segment. */
  org: RepoSegment;
  /** Its repository segment. */
  name: RepoSegment;
}

/** The migration owner name of the Repo's own table. */
const REPO_OWNER = "repo";

/** Released schema steps of the Repo's own table. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE repo (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    repo_id TEXT NOT NULL,
    org TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  // The history a reset replaces. A repository recorded before this step gets one here.
  "ALTER TABLE repo ADD COLUMN history TEXT NOT NULL DEFAULT ''",
  "UPDATE repo SET history = lower(hex(randomblob(16))) WHERE history = ''",
];

/** The Durable Object name of the repository `org/name`. */
export function repoObjectName(org: RepoSegment, name: RepoSegment): string {
  return `${org}/${name}`;
}

interface Installed {
  summary: RepoSummary;
  /** The history its log belongs to, new each time the repository is recorded. */
  history: string;
  log: EventLog;
  ports: RepoPorts;
}

/** One repository. */
export class Repo extends DurableObject<Env> {
  #installed: Installed | null = null;
  readonly #alarm: EarliestAlarm;
  #seedControl: SeedControl | null = null;
  #seedTarget: SeedTarget | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#alarm = new EarliestAlarm(ctx.storage, (error) => {
      const name = error instanceof Error ? error.name : "unknown";
      const repo = this.#installed?.summary.repoId ?? null;
      console.error(JSON.stringify({ event: "repo.wake_failed", repo, error: name }));
    });
    // Modules ask for wakes while they are built, so the alarm is read first.
    void ctx.blockConcurrencyWhile(async () => {
      await this.#alarm.load();
      const summary = this.#readSummary();
      this.#installed = summary === null ? null : this.#install(summary);
    });
  }

  /** The repository, or `null` when it was never initialized. */
  describe(): RepoSummary | null {
    return this.#installed?.summary ?? null;
  }

  /**
   * Records this object as the repository `org/name` and installs its modules. A repeat with the
   * same name returns the same repository; any other name is refused with `invalid_request` and
   * writes nothing.
   */
  initialize(org: RepoSegment, name: RepoSegment): PortResult<RepoSummary> {
    if (!isRepoSegment(org) || !isRepoSegment(name)) {
      return fail("invalid_request", "The organisation and name must be repository segments.");
    }
    const expected = repoObjectName(org, name);
    if (this.ctx.id.name !== undefined && this.ctx.id.name !== expected) {
      return fail("invalid_request", "This object is not named for that repository.");
    }
    if (this.#installed !== null) {
      const { summary } = this.#installed;
      if (summary.org !== org || summary.name !== name) {
        return fail("invalid_request", "This object already holds another repository.");
      }
      return ok(summary);
    }
    migrate(this.ctx.storage, REPO_OWNER, MIGRATIONS);
    const summary: RepoSummary = { repoId: `rep_${this.ctx.id.toString()}`, org, name };
    // A repository recorded again after a reset reuses its id and restarts its `seq` numbers, so
    // only a new history tells a cursor from the deleted log apart from one in the new log.
    const history = randomHistory();
    this.ctx.storage.sql.exec(
      "INSERT INTO repo (id, repo_id, org, name, created_at, history) VALUES (1, ?, ?, ?, ?, ?)",
      summary.repoId,
      org,
      name,
      Date.now(),
      history,
    );
    this.#installed = this.#install(summary);
    return ok(summary);
  }

  /**
   * Reads up to `limit` events after `cursor`. A `history` other than `null` must be the log's
   * current history, or the cursor is refused as belonging to another log.
   */
  readEvents(cursor: number, limit: number, history: string | null): PortResult<EventPage> {
    const installed = this.#installed;
    if (installed === null) return missing();
    if (history !== null && history !== installed.history) return replaced();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_EVENT_PAGE) {
      return fail(
        "invalid_request",
        `The limit must be a whole number from 1 to ${MAX_EVENT_PAGE}.`,
      );
    }
    try {
      const page = installed.log.replay(cursor, limit);
      return ok({
        repo: installed.summary.repoId,
        events: page.events,
        cursor: page.events.at(-1)?.seq ?? cursor,
        head: page.head,
        history: installed.history,
      });
    } catch (error) {
      if (!(error instanceof EventLogError)) throw error;
      switch (error.code) {
        case "invalid_request":
        case "replay_too_large":
          return fail("invalid_request", "The cursor must be a whole number from 0.");
        case "cursor_ahead":
          return fail("cursor_ahead", "The cursor is ahead of this repository's log.");
        case "invalid_repo":
        case "invalid_event":
        case "invalid_transaction":
        case "corrupt_log":
          // An unreadable log is a backend fault, not the caller's: let the Worker report it.
          throw error;
        default:
          return unreachable(error.code);
      }
    }
  }

  /**
   * Subscribes `listener` to events after `cursor`, through the stream module. `history` is checked
   * as `readEvents` checks it.
   */
  async subscribe(
    cursor: number,
    listener: StreamListener,
    history: string | null,
  ): Promise<PortResult<StreamSubscription>> {
    const installed = this.#installed;
    if (installed === null) return missing();
    if (history !== null && history !== installed.history) return replaced();
    return installed.ports.stream.subscribe(cursor, listener);
  }

  /** The joins waiting for the owner, through the identity module. */
  async pendingJoins(): Promise<PortResult<PendingJoin[]>> {
    const ports = this.#ports();
    if (ports === null) return missing();
    return ports.identity.pendingJoins();
  }

  /** Prepares an owner action, through the owner module. */
  async prepareOwnerAction(action: OwnerAction): Promise<PortResult<ActionChallenge>> {
    const ports = this.#ports();
    if (ports === null) return missing();
    return ports.owner.prepare(action);
  }

  /** Performs a prepared owner action, through the owner module. */
  async performOwnerAction(
    challengeId: string,
    assertion: PasskeyAssertion,
  ): Promise<PortResult<OwnerActionResult>> {
    const ports = this.#ports();
    if (ports === null) return missing();
    return ports.owner.perform(challengeId, assertion);
  }

  /** Answers one validated agent request. */
  async agent(call: AgentCall): Promise<AgentReply> {
    const installed = this.#installed;
    if (installed === null) return dispatchAgent(null, call);
    return dispatchAgent({ ...installed.summary, ports: installed.ports }, call);
  }

  /**
   * Records a check run's report, through the checks module. Only the check Workflow calls it, from
   * outside the sandbox, with the attempt the checks module started.
   */
  async reportCheck(report: CheckRunReport): Promise<PortResult<CheckAttempt>> {
    const ports = this.#ports();
    if (ports === null) return missing();
    return ports.checks.report(report);
  }

  /** Answers one Git smart-HTTP request, through the Git module. */
  async git(request: Request, target: GitTarget, path: string): Promise<Response> {
    const ports = this.#ports();
    if (ports === null) return new Response("Repository not found.\n", { status: 404 });
    return ports.git.serve(request, target, path);
  }

  /**
   * Resumes every module that owes work. Each module asks for its own next wake. If one of those
   * wakes failed to reach storage, the handler throws so the runtime retries the alarm.
   */
  async alarm(): Promise<void> {
    this.#alarm.fired();
    const installed = this.#installed;
    if (installed === null) return;
    await resumeAll(installed.summary.repoId, resumables(installed.ports));
    await this.#alarm.settle();
  }

  /** The demo repository and its main, on the demo repository's object only. */
  async demoSeedState(): Promise<PortResult<DemoSeedState | null>> {
    const target = this.#demoSeedTarget();
    if (target === null) return missing();
    return target.read();
  }

  /** Seeds the demo repository's main, after the control spent a proof for it. */
  async seedDemo(head: CommitSha, pack: Uint8Array): Promise<PortResult<DemoSeedResult>> {
    const target = this.#demoSeedTarget();
    if (target === null) return missing();
    return target.seed(head, pack);
  }

  /** Resets the demo repository, after the control spent a proof for it. */
  async resetDemo(): Promise<PortResult<DemoSeedResult>> {
    const target = this.#demoSeedTarget();
    if (target === null) return missing();
    return target.reset();
  }

  /** Prepares a demo seed action, on the demo seed's control object only. */
  async prepareDemoSeed(action: DemoSeedAction): Promise<PortResult<ActionChallenge>> {
    const control = this.#demoSeedControl();
    if (control === null) return missing();
    return control.prepare(action);
  }

  /** Performs a prepared demo seed action, on the demo seed's control object only. */
  async performDemoSeed(
    challengeId: string,
    assertion: PasskeyAssertion,
    bundle: Uint8Array | null,
  ): Promise<PortResult<DemoSeedResult>> {
    const control = this.#demoSeedControl();
    if (control === null) return missing();
    return control.perform(challengeId, assertion, bundle);
  }

  #demoSeedTarget(): SeedTarget | null {
    if (this.ctx.id.name !== DEMO_OBJECT_NAME) return null;
    this.#seedTarget ??= demoSeedTarget(
      {
        repoId: `rep_${this.ctx.id.toString()}`,
        storage: this.ctx.storage,
        initialized: () => this.#installed !== null,
        initialize: () => this.initialize(DEMO_ORG, DEMO_REPO),
        wipe: async () => {
          // Subscribers follow the history being deleted: they end, and a board that subscribes
          // again starts from the new history.
          this.#installed?.ports.stream.endAll("revoked");
          await this.ctx.storage.deleteAll();
          // Only once storage is empty: a wipe that fails leaves the Repo installed, as storage
          // still holds it, so a seed finds an initialized Repo without main and is refused.
          this.#installed = null;
          // Whether the wipe removed the alarm or not, the next wake request must see storage.
          await this.#alarm.load();
        },
      },
      this.env,
    );
    return this.#seedTarget;
  }

  #demoSeedControl(): SeedControl | null {
    if (this.ctx.id.name !== DEMO_SEED_CONTROL) return null;
    this.#seedControl ??= demoSeedControl(this.ctx.storage, this.env);
    return this.#seedControl;
  }

  #ports(): RepoPorts | null {
    return this.#installed?.ports ?? null;
  }

  // Reads only, so that a name nobody initialized leaves no storage behind.
  #readSummary(): RepoSummary | null {
    const sql = this.ctx.storage.sql;
    const table = sql
      .exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'repo'")
      .toArray();
    if (table.length === 0) return null;
    const row = sql
      .exec<{ repo_id: string; org: string; name: string }>(
        "SELECT repo_id, org, name FROM repo WHERE id = 1",
      )
      .toArray()[0];
    if (row === undefined) return null;
    return { repoId: row.repo_id, org: row.org, name: row.name };
  }

  #install(summary: RepoSummary): Installed {
    migrate(this.ctx.storage, REPO_OWNER, MIGRATIONS);
    const history = this.ctx.storage.sql
      .exec<{ history: string }>("SELECT history FROM repo WHERE id = 1")
      .one().history;
    const log = EventLog.open(this.ctx.storage, summary.repoId);
    const ports = composeRepo({
      repoId: summary.repoId,
      storage: this.ctx.storage,
      log,
      clock: Date.now,
      env: this.env,
      wake: (at) => this.#alarm.request(at),
    });
    return { summary, history, log, ports };
  }
}

/** A new history: 128 random bits in lowercase hex. */
function randomHistory(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function replaced(): PortResult<never> {
  return fail("cursor_ahead", "The cursor belongs to a history this repository no longer holds.");
}

function missing(): PortResult<never> {
  return fail("not_found", "No such repository.");
}

function unreachable(value: never): never {
  throw new Error(`unhandled event log error: ${String(value)}`);
}
