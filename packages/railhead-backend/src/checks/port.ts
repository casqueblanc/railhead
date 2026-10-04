// The checks module: reads the trusted check definition from main, starts each attempt's run in a
// sandbox slot the repository admitted, and records the run's report.
//
// `start` takes the attempt the train persisted and re-reads its definition from the main commit
// the candidate was composed on; it runs only if that definition still has the attempt's digest. It
// refuses before anything runs when the candidate commit is missing (`commit_not_found`), and holds
// a candidate that edits the definition or a path it protects (`check_held`): the attempt is
// recorded as held with the edited paths and the digest of the candidate's own definition, with a
// `train.held` event, and is not run. Otherwise it admits the attempt's sandbox
// (`ports().sandbox`, so every check sandbox counts against the repository's bound), records the
// attempt as started, and then asks for the Workflow instance named by the attempt. Each step is
// recorded before the next external call, so a repeat after a lost answer joins the same slot and
// instance instead of starting another.
//
// `report` accepts a run's result only for an attempt this module started, on its candidate and
// definition; a repeat of the recorded result is accepted again, anything else is `check_mismatch`.
// It stores the output cut to its end with its digest, passes the result to the train, which checks
// it against its own attempt and deadline, and then releases the sandbox slot.
//
// `approve` takes a person's grant naming one held attempt, its candidate and the digest of the
// candidate's definition. It re-reads that definition, and then, in one transaction, checks that the
// attempt is still held on that candidate with that digest and that the train still holds it,
// records the approval with a `check.approved` event and returns the attempt to the train. The next
// `start` of an approved attempt runs the candidate's definition, after checking its digest again;
// the run's report still names the attempt's own identity, so nothing else about it changes. A
// repeat of the recorded grant answers the same success whatever state the attempt reached since;
// any other grant for an approved attempt is stale.
//
// `detail` reads one stored attempt back for the board: candidate, command and state, with the
// output cut again to `MAX_CHECK_DETAIL_LOG_BYTES`. It never reads Artifacts or the definition.

import { MAX_CHECK_DETAIL_LOG_BYTES, type CheckDetailState } from "@railhead/shared/board-api";
import {
  isCommitSha,
  isId,
  type Actor,
  type CheckRunId,
  type CommitSha,
  type RepoId,
} from "@railhead/shared/events";
import type { GrantFor } from "../contracts/principals";
import { fail, ok, type PortResult } from "../contracts/result";
import type { CheckAttempt, CheckDefinition, CheckPort, CheckRunReport } from "../contracts/train";
import type { RepoPorts } from "../repo/composeRepo";
import type { EventLog } from "../repo/eventLog";
import { MAX_SANDBOX_LIFETIME_MS } from "../sandbox/admission";
import { parseSandboxPolicy } from "../sandbox/policy";
import { AttemptTable, boundedLog, type AttemptIdentity, type AttemptRecord } from "./attempts";
import {
  CHECK_DEFINITION_PATH,
  MAX_DEFINITION_BYTES,
  editedPaths,
  parseTrustedCheck,
  sha256Hex,
  type TreeReader,
  type TrustedCheck,
} from "./definition";
import { RUN_OVERHEAD_MS, type CheckRunParams } from "./workflow";

/** Reads the repository's main Artifacts repository. */
export interface MainReader extends TreeReader {
  /** The bytes of `path` at `commit`, or `null` when there is no such file. */
  readFile(commit: CommitSha, path: string, maxBytes: number): Promise<Uint8Array | null>;
}

/** The repository's main Artifacts repository. */
export interface MainSource {
  /** Its Artifacts name. */
  name: string;
  /** The Artifacts namespace. */
  namespace: string;
  /** The Artifacts Git host a sandbox fetches from. */
  host: string;
  /** Reads its objects. */
  reader: MainReader;
}

/** Where a run's Workflow instance is created. */
export interface RunStarter {
  /**
   * Creates the instance named `id` with `params`. Creating one that already exists is not an
   * error: the earlier request was answered too late.
   */
  create(id: string, params: CheckRunParams): Promise<void>;
}

/** What the checks module needs besides the Repo context. */
export interface ChecksDeps {
  repoId: RepoId;
  /** The table of attempts. */
  attempts: AttemptTable;
  /** The repository's event log, which records held and approved attempts. */
  log: EventLog;
  /**
   * The repository's main Artifacts repository: its name, namespace and Git host, and a reader for
   * it, or `null` when the Worker is not configured for checks.
   */
  main: () => Promise<MainSource | null>;
  /** Starts runs. */
  runs: RunStarter;
  /** The current time. */
  clock: () => number;
  /** The other modules' ports. */
  ports: () => RepoPorts;
}

/** The longest Workflow instance name, which the attempt must fit. */
const MAX_INSTANCE_ID = 64;

const CHECKS_ACTOR: Actor = { kind: "system", id: "sys_checks" };

const DIGEST = /^[0-9a-f]{64}$/;

/** Builds the checks port over `deps`. */
export function createChecks(deps: ChecksDeps): CheckPort {
  const { attempts, clock, ports, log: events } = deps;

  return {
    async definitions(main) {
      if (!isCommitSha(main)) return fail("invalid_request", "Main must be a full commit SHA.");
      const check = await trusted(await deps.main(), main);
      if (!check.ok) return check;
      return ok(check.value === null ? [] : [check.value.definition]);
    },

    async start(attempt) {
      const identity = identityOf(attempt);
      if (identity === null || attempt.attemptId.length > MAX_INSTANCE_ID) {
        return fail("invalid_request", "The attempt is not a valid check attempt.");
      }
      const stored = attempts.get(attempt.attemptId);
      const approved =
        stored !== null && sameIdentity(stored, identity) && stored.approval !== null;
      if (
        stored !== null &&
        !(approved && stored.state.kind === "held") &&
        (!sameIdentity(stored, identity) || stored.state.kind !== "started")
      ) {
        return repeatStart(stored, identity);
      }
      const source = await deps.main();
      if (source === null) return fail("unavailable", "Checks have no Artifacts repository.");

      const check = await trusted(source, attempt.expectedMain);
      if (!check.ok) return check;
      if (check.value === null || !sameDefinition(check.value.definition, attempt.definition)) {
        return fail("check_mismatch", "Main no longer holds the attempt's check definition.");
      }
      let run = check.value;
      const approval = stored?.approval ?? null;
      if (approval !== null) {
        // An approved attempt runs the candidate's own definition, and only the one approved.
        const own = await candidateCheck(source, attempt.candidate);
        if (!own.ok) return own;
        if (own.value === null || own.value.definition.digest !== approval.digest) {
          return fail("check_mismatch", "The candidate's definition is not the one approved.");
        }
        run = own.value;
      }
      // Recorded as started, but the instance may never have been created: ask for it again.
      if (stored?.state.kind === "started") return startRun(identity, run, stored.state, source);

      if (stored?.state.kind === "held") return admitAndStart(identity, run, source, true);

      let edited: string[];
      try {
        const [mainTree, candidateTree] = await Promise.all([
          source.reader.rootTree(attempt.expectedMain),
          source.reader.rootTree(attempt.candidate),
        ]);
        if (mainTree === null) return fail("commit_not_found", "Main's commit is missing.");
        if (candidateTree === null) {
          return fail("commit_not_found", "The candidate commit is missing; nothing ran.");
        }
        edited = await editedPaths(
          source.reader,
          mainTree,
          candidateTree,
          check.value.protectedPaths,
        );
      } catch {
        return fail("unavailable", "The candidate could not be compared with main.");
      }
      if (edited.length > 0) {
        const own = await candidateCheck(source, attempt.candidate);
        if (!own.ok) return own;
        const digest = own.value?.definition.digest ?? null;
        const { command } = check.value;
        const held = events.transaction((tx) => {
          const first = attempts.get(identity.attemptId) === null;
          const record = attempts.hold(identity, command, edited, digest, clock());
          if (first) {
            tx.append(CHECKS_ACTOR, {
              type: "train.held",
              data: {
                checkRunId: identity.attemptId,
                expectedMain: identity.expectedMain,
                candidate: identity.candidate,
                claims: [...new Set(attempt.pins.map((pin) => pin.claimId))],
                paths: edited,
                digest,
              },
            });
          }
          return record;
        });
        return repeatStart(held.value, identity);
      }
      return admitAndStart(identity, check.value, source, false);
    },

    async approve(grant) {
      const { action } = grant;
      if (action.kind !== "check.approve" || !validApproval(grant, deps.repoId)) {
        return fail("invalid_request", "The proof is not a person's approval of a check here.");
      }
      const stale = fail("action_stale", "That check is no longer held for that definition.");
      const stored = attempts.get(action.checkRunId);
      // A repeat of the recorded approval answers as the first did, and drives the train as it did,
      // even once the attempt has started or reported.
      if (recordedApproval(stored, grant)) {
        await ports().train.resume();
        return ok({ checkRunId: action.checkRunId });
      }
      if (!approvable(stored, grant)) return stale;
      // Read again at the time of use: the approval covers exactly the definition it names.
      const own = await candidateCheck(await deps.main(), action.candidate);
      if (!own.ok) return own;
      if (own.value?.definition.digest !== action.digest) return stale;

      const approved = events.transaction((tx): PortResult<{ checkRunId: CheckRunId }> => {
        const current = attempts.get(action.checkRunId);
        // A repeat of the recorded approval: the train already has the attempt back.
        if (recordedApproval(current, grant)) return ok({ checkRunId: action.checkRunId });
        if (current === null || !approvable(current, grant)) return stale;
        if (!ports().train.release(action.checkRunId)) {
          return fail("action_stale", "The train no longer holds that check; nothing changed.");
        }
        const now = clock();
        attempts.approve(
          action.checkRunId,
          { userId: grant.userId, grantId: grant.grantId, digest: action.digest, approvedAt: now },
          now,
        );
        tx.append(
          { kind: "human", id: grant.userId },
          {
            type: "check.approved",
            data: {
              checkRunId: action.checkRunId,
              candidate: action.candidate,
              digest: action.digest,
            },
          },
        );
        return ok({ checkRunId: action.checkRunId });
      }).value;
      if (approved.ok) await ports().train.resume();
      return approved;
    },

    async report(report) {
      if (!validReport(report)) {
        return fail("invalid_request", "The report needs an attempt, a candidate and a result.");
      }
      const stored = attempts.get(report.attemptId);
      if (
        stored === null ||
        stored.candidate !== report.candidate ||
        stored.digest !== report.digest ||
        stored.state.kind === "held"
      ) {
        return fail("check_mismatch", "No run of that attempt was started on that candidate.");
      }
      const log = boundedLog(report.log);
      const logDigest = await sha256Hex(new TextEncoder().encode(log));
      const recorded =
        stored.state.kind === "started"
          ? attempts.report(
              report.attemptId,
              report.result,
              log,
              logDigest,
              report.finishedAt,
              clock(),
            )
          : stored;
      if (recorded?.state.kind !== "reported") {
        throw new Error("a started check attempt was not recorded as reported");
      }
      if (recorded.state.result !== report.result || recorded.state.logDigest !== logDigest) {
        return fail("check_mismatch", "This attempt already has another result.");
      }
      const accepted = await ports().train.recordCheck({
        attemptId: report.attemptId,
        candidate: report.candidate,
        result: recorded.state.result,
        logDigest: recorded.state.logDigest,
        finishedAt: recorded.state.finishedAt,
      });
      await release(report.attemptId);
      return accepted;
    },

    async detail(attemptId) {
      if (!isId("checkRun", attemptId)) return fail("invalid_request", "Not a check run id.");
      const stored = attempts.get(attemptId);
      if (stored === null) return fail("not_found", "No record of that check run is kept.");
      return ok({
        checkRunId: stored.attemptId,
        candidate: stored.candidate,
        expectedMain: stored.expectedMain,
        definitionDigest: stored.digest,
        command: stored.command,
        state: detailState(stored.state),
      });
    },
  };

  // Admits the attempt's sandbox, records the attempt as started and asks for its run. An approved
  // held attempt moves from held; any other is recorded new.
  async function admitAndStart(
    identity: AttemptIdentity,
    check: TrustedCheck,
    source: MainSource,
    approved: boolean,
  ): Promise<PortResult<{ attemptId: CheckRunId }>> {
    const policy = parseSandboxPolicy({
      host: source.host,
      namespace: source.namespace,
      read: [source.name],
      write: null,
    });
    if (policy === null) return fail("internal", "The check sandbox policy is not valid.");
    const lifetimeMs = Math.min(MAX_SANDBOX_LIFETIME_MS, check.timeoutMs + RUN_OVERHEAD_MS);
    const admission = await ports().sandbox.admit(identity.attemptId, policy, lifetimeMs);
    if (!admission.ok) return admission;
    if (admission.value.kind === "queued") {
      return fail("busy", "Every check sandbox is taken; the attempt waits for a slot.");
    }
    const { slot } = admission.value;
    if (slot.deadline === null) throw new Error("an admitted sandbox slot has no deadline");
    const now = clock();
    const started = approved
      ? attempts.startApproved(identity.attemptId, check.command, slot.sandbox, slot.deadline, now)
      : attempts.start(identity, check.command, slot.sandbox, slot.deadline, now);
    if (started === null) throw new Error("an approved check attempt is missing");
    if (!sameIdentity(started, identity) || started.state.kind !== "started") {
      return repeatStart(started, identity);
    }
    return startRun(identity, check, started.state, source);
  }

  // Asks for the attempt's Workflow instance. A repeat for an instance already created is harmless.
  async function startRun(
    identity: AttemptIdentity,
    check: TrustedCheck,
    slot: { sandbox: string; deadline: number },
    source: MainSource,
  ): Promise<PortResult<{ attemptId: CheckRunId }>> {
    try {
      await deps.runs.create(identity.attemptId, {
        repoId: deps.repoId,
        attemptId: identity.attemptId,
        candidate: identity.candidate,
        digest: identity.digest,
        command: check.command,
        timeoutMs: check.timeoutMs,
        namespace: source.namespace,
        artifactsRepo: source.name,
        slot: { sandbox: slot.sandbox, deadline: slot.deadline },
      });
    } catch {
      return fail("unavailable", "The check run could not be started; ask again.");
    }
    return ok({ attemptId: identity.attemptId });
  }

  // Frees the attempt's sandbox slot once its run reported. A slot that does not confirm stays
  // held and is torn down at its deadline.
  async function release(attemptId: CheckRunId): Promise<void> {
    const released = await ports().sandbox.release(attemptId);
    if (!released.ok) {
      console.error(
        JSON.stringify({ event: "checks.release_failed", attempt: attemptId, code: released.code }),
      );
    }
  }
}

/**
 * The candidate's own check definition, `null` when it has none or none that parses. Only an
 * approved attempt runs it.
 */
async function candidateCheck(
  source: MainSource | null,
  candidate: CommitSha,
): Promise<PortResult<TrustedCheck | null>> {
  if (source === null) return fail("unavailable", "Checks have no Artifacts repository.");
  let bytes: Uint8Array | null;
  try {
    bytes = await source.reader.readFile(candidate, CHECK_DEFINITION_PATH, MAX_DEFINITION_BYTES);
  } catch {
    return fail("unavailable", "The candidate's check definition could not be read.");
  }
  return ok(bytes === null ? null : await parseTrustedCheck(bytes, candidate));
}

/** Whether `stored` is the held attempt `grant` approves, approved by no one yet. */
function approvable(stored: AttemptRecord | null, grant: GrantFor<"check.approve">): boolean {
  const { action } = grant;
  if (stored === null || stored.state.kind !== "held") return false;
  if (stored.candidate !== action.candidate || stored.state.digest !== action.digest) return false;
  return stored.approval === null;
}

/** Whether `stored` already carries `grant`'s approval, in whatever state the attempt reached. */
function recordedApproval(stored: AttemptRecord | null, grant: GrantFor<"check.approve">): boolean {
  const { action } = grant;
  return (
    stored !== null &&
    stored.candidate === action.candidate &&
    stored.approval?.grantId === grant.grantId &&
    stored.approval.digest === action.digest
  );
}

// Only the owner module builds a grant, after consuming one passkey proof; these checks keep a
// grant for another repository or a malformed action from approving anything here.
function validApproval(grant: GrantFor<"check.approve">, repoId: RepoId): boolean {
  const { action } = grant;
  return (
    grant.kind === "human" &&
    grant.repoId === repoId &&
    isId("user", grant.userId) &&
    grant.grantId !== "" &&
    isId("checkRun", action.checkRunId) &&
    isCommitSha(action.candidate) &&
    DIGEST.test(action.digest)
  );
}

/** The trusted check on `main`, `null` when main defines none. */
async function trusted(
  source: MainSource | null,
  main: CommitSha,
): Promise<PortResult<TrustedCheck | null>> {
  if (source === null) return fail("unavailable", "Checks have no Artifacts repository.");
  let bytes: Uint8Array | null;
  try {
    bytes = await source.reader.readFile(main, CHECK_DEFINITION_PATH, MAX_DEFINITION_BYTES);
  } catch {
    return fail("unavailable", "The check definition could not be read.");
  }
  if (bytes === null) return ok(null);
  const check = await parseTrustedCheck(bytes, main);
  if (check === null) return fail("invalid_request", "The check definition on main is not valid.");
  return ok(check);
}

// A repeat of `start` for a stored attempt: it never starts a second run.
function repeatStart(
  stored: AttemptRecord,
  identity: AttemptIdentity,
): PortResult<{ attemptId: CheckRunId }> {
  if (!sameIdentity(stored, identity)) {
    return fail("check_mismatch", "This attempt was recorded for another candidate.");
  }
  switch (stored.state.kind) {
    case "held":
      return fail(
        "check_held",
        "The candidate edits protected check paths; a person must approve it.",
      );
    case "started":
    case "reported":
      return ok({ attemptId: stored.attemptId });
    default:
      return unreachable(stored.state);
  }
}

function detailState(state: AttemptRecord["state"]): CheckDetailState {
  switch (state.kind) {
    case "held":
      return { kind: "held", paths: state.paths };
    case "started":
      return { kind: "started", deadline: state.deadline };
    case "reported": {
      const logTail = boundedLog(state.log, MAX_CHECK_DETAIL_LOG_BYTES);
      return {
        kind: "reported",
        result: state.result,
        finishedAt: state.finishedAt,
        logTail,
        logCut: logTail.length < state.log.length,
      };
    }
    default:
      return unreachable(state);
  }
}

function identityOf(attempt: CheckAttempt): AttemptIdentity | null {
  if (
    !isCommitSha(attempt.candidate) ||
    !isCommitSha(attempt.expectedMain) ||
    attempt.definition.source !== attempt.expectedMain
  ) {
    return null;
  }
  return {
    attemptId: attempt.attemptId,
    candidate: attempt.candidate,
    expectedMain: attempt.expectedMain,
    digest: attempt.definition.digest,
  };
}

function sameIdentity(left: AttemptIdentity, right: AttemptIdentity): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.candidate === right.candidate &&
    left.expectedMain === right.expectedMain &&
    left.digest === right.digest
  );
}

function sameDefinition(left: CheckDefinition, right: CheckDefinition): boolean {
  return (
    left.name === right.name &&
    left.source === right.source &&
    left.digest === right.digest &&
    JSON.stringify(left.acceptance) === JSON.stringify(right.acceptance)
  );
}

function validReport(run: CheckRunReport): boolean {
  return (
    isCommitSha(run.candidate) &&
    (run.result === "pass" || run.result === "fail" || run.result === "error") &&
    typeof run.log === "string" &&
    Number.isSafeInteger(run.finishedAt) &&
    run.finishedAt >= 0
  );
}

function unreachable(value: never): never {
  throw new Error(`unhandled check attempt state: ${JSON.stringify(value)}`);
}
