// The Workflow that runs one check attempt: one sandbox runner through the patched SDK, then a
// report to the repository from outside the sandbox.
//
// Only the checks module starts an instance, named by the attempt, after it admitted the attempt's
// sandbox slot and recorded the attempt (`src/checks/port.ts`). Its parameters come from that trusted
// code: the candidate, the command and timeout of the definition read from main, and the slot. The
// runner step is never retried, so a check that fails once is reported as failed rather than run
// again until it passes; `classifyRunnerFailure` then separates the command's own failure (`fail`)
// from Railhead's (`error`). The report step runs in the Worker, not the sandbox, and is retried a
// bounded number of times: the repository accepts a repeat of the same report and refuses any other.
// The output a run returns is untrusted: it is cut to its end and stored, never logged.

import {
  CIWorkflow,
  cloudflareArtifacts,
  isCiRunnerFailure,
  type CiContext,
  type CiParams,
  type CloudflareArtifacts,
} from "@cloudflare/ci";
import type { CiBindings } from "@cloudflare/ci/worker";
import type { SourceControlAdapter } from "@cloudflare/ci/worker/source-control";
import {
  isCommitSha,
  isId,
  type CheckResult,
  type CheckRunId,
  type CommitSha,
  type RepoId,
} from "@railhead/shared/events";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { CheckRunReport } from "../contracts/train";
import { CANDIDATE_REF_PREFIX } from "../sandbox/policy";
import { boundedLog } from "./attempts";
import { MAX_CHECK_TIMEOUT_MS, MAX_COMMAND_LENGTH, MIN_CHECK_TIMEOUT_MS } from "./definition";
import { classifyRunnerFailure, railheadCheckout, type CheckSlot } from "./sdkCheckout";

/** The runner's name: the Workflow step it runs in, and the first word of its failure. */
export const CHECK_RUNNER = "check";

/** The step that delivers the report to the repository. */
export const REPORT_STEP = "report";

/**
 * Time the runner step allows besides the command: starting the sandbox's shell, the checkout,
 * which the SDK bounds at 5 minutes, and reading the logs.
 */
export const RUN_OVERHEAD_MS = 7 * 60_000;

/** How the report step retries a repository that did not answer. */
export const REPORT_STEP_CONFIG = {
  retries: { limit: 5, delay: 10_000, backoff: "exponential" },
  timeout: 60_000,
} as const;

/** What starts one run. Written by the checks module, never by a client. */
export interface CheckRunParams {
  /** The repository whose `Repo` receives the report. */
  repoId: RepoId;
  /** The attempt. */
  attemptId: CheckRunId;
  /** The exact commit checked. */
  candidate: CommitSha;
  /** SHA-256 of the trusted definition. */
  digest: string;
  /** The definition's command. */
  command: string;
  /** How long the command may run. */
  timeoutMs: number;
  /** The Artifacts namespace. */
  namespace: string;
  /** The Artifacts repository holding the candidate. */
  artifactsRepo: string;
  /** The admitted sandbox slot the run joins. */
  slot: CheckSlot;
}

/** What a run ended with, before it is delivered. */
export interface CheckOutcome {
  result: CheckResult;
  /** Untrusted output, already cut to its end. */
  log: string;
}

/** What delivering a report ended with: the repository's refusal code, or `null` when accepted. */
export interface Delivery {
  refused: string | null;
}

/**
 * The Worker bindings the run reads. The SDK's binding type also names deployment credentials; a
 * check runner never asks for them, so they are absent from Railhead's environment.
 */
export type CheckBindings = Env & CiBindings;

const DIGEST = /^[0-9a-f]{64}$/;
const REPO_ID = /^rep_[0-9a-f]{64}$/;
const ARTIFACTS_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** Validates a run's parameters, or returns `null`. */
export function parseCheckRunParams(value: unknown): CheckRunParams | null {
  if (typeof value !== "object" || value === null) return null;
  const read = (key: string): unknown => Reflect.get(value, key);
  const repoId = read("repoId");
  const attemptId = read("attemptId");
  const candidate = read("candidate");
  const digest = read("digest");
  const command = read("command");
  const timeoutMs = read("timeoutMs");
  const namespace = read("namespace");
  const artifactsRepo = read("artifactsRepo");
  const slot = read("slot");
  if (typeof repoId !== "string" || !REPO_ID.test(repoId)) return null;
  if (typeof attemptId !== "string" || !isId("checkRun", attemptId)) return null;
  if (typeof candidate !== "string" || !isCommitSha(candidate)) return null;
  if (typeof digest !== "string" || !DIGEST.test(digest)) return null;
  if (typeof command !== "string" || command === "" || command.length > MAX_COMMAND_LENGTH) {
    return null;
  }
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_CHECK_TIMEOUT_MS ||
    timeoutMs > MAX_CHECK_TIMEOUT_MS
  ) {
    return null;
  }
  if (typeof namespace !== "string" || !ARTIFACTS_NAME.test(namespace)) return null;
  if (typeof artifactsRepo !== "string" || !ARTIFACTS_NAME.test(artifactsRepo)) return null;
  if (typeof slot !== "object" || slot === null) return null;
  const sandbox: unknown = Reflect.get(slot, "sandbox");
  const deadline: unknown = Reflect.get(slot, "deadline");
  if (typeof sandbox !== "string" || typeof deadline !== "number") return null;
  return {
    repoId,
    attemptId,
    candidate,
    digest,
    command,
    timeoutMs,
    namespace,
    artifactsRepo,
    slot: { sandbox, deadline },
  };
}

/** The SDK's run parameters for `params`: its candidate, in its namespace, in its admitted slot. */
export function ciParams(params: CheckRunParams): CiParams<CloudflareArtifacts> {
  // The checkout reads the slot from here; the SDK passes it through untouched.
  const providerData = { namespace: params.namespace, slot: params.slot };
  return {
    provider: "cloudflare-artifacts",
    providerData,
    event: { type: "push" },
    owner: params.namespace,
    repo: params.artifactsRepo,
    sha: params.candidate,
    trigger: "push",
    ref: `${CANDIDATE_REF_PREFIX}${params.attemptId}/head`,
  };
}

/**
 * Runs the check once and classifies the result. Only the command's own nonzero exit is `fail`;
 * every failure Railhead caused is `error`, with a fixed message in place of its output.
 */
export async function runCheck(ci: CiContext, params: CheckRunParams): Promise<CheckOutcome> {
  try {
    const run = await ci.runner({
      name: CHECK_RUNNER,
      command: params.command,
      config: {
        retries: { limit: 0, delay: 1_000 },
        timeout: params.timeoutMs + RUN_OVERHEAD_MS,
        commandTimeoutMs: params.timeoutMs,
      },
    });
    const stdout = typeof run.logs.stdout === "string" ? run.logs.stdout : "";
    const stderr = typeof run.logs.stderr === "string" ? run.logs.stderr : "";
    return {
      result: "pass",
      log: boundedLog(`=== stdout ===\n${stdout}\n=== stderr ===\n${stderr}`),
    };
  } catch (rejection) {
    const failure = classifyRunnerFailure(rejection);
    switch (failure.conclusion) {
      case "fail":
        return {
          result: "fail",
          log: isCiRunnerFailure(rejection) ? boundedLog(rejection.output) : "",
        };
      case "error":
        return {
          result: "error",
          log:
            failure.reason === "checkout"
              ? "The candidate could not be checked out; the check did not run."
              : "Railhead could not run the check.",
        };
      default:
        return unreachable(failure);
    }
  }
}

/**
 * Delivers `outcome` to the repository. Throws, so the step retries, only while the repository
 * does not answer; a refusal is final and returned.
 */
export async function deliver(
  env: Pick<Env, "REPO">,
  params: CheckRunParams,
  outcome: CheckOutcome,
  finishedAt: number,
): Promise<Delivery> {
  const report: CheckRunReport = {
    attemptId: params.attemptId,
    candidate: params.candidate,
    digest: params.digest,
    result: outcome.result,
    log: outcome.log,
    finishedAt,
  };
  const repo = env.REPO.get(env.REPO.idFromString(params.repoId.slice("rep_".length)));
  const recorded = await repo.reportCheck(report);
  if (recorded.ok) return { refused: null };
  switch (recorded.code) {
    case "unavailable":
    case "internal":
    case "busy":
      throw new Error(`the repository did not record the check report: ${recorded.code}`);
    default:
      return { refused: recorded.code };
  }
}

/** Runs one check attempt and reports it. Exported by the Worker and bound as `CHECKS`. */
export class CheckWorkflow extends CIWorkflow<CloudflareArtifacts, CheckBindings> {
  static override getProvider(): SourceControlAdapter<CloudflareArtifacts> {
    return checkSource();
  }

  #params: CheckRunParams | null = null;

  override async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    const params = parseCheckRunParams(event.payload);
    if (params === null) throw new Error("check run parameters are not valid");
    this.#params = params;
    return super.run({ ...event, payload: ciParams(params) }, step);
  }

  protected override async pipeline(
    _event: WorkflowEvent<CiParams<CloudflareArtifacts>>,
    step: WorkflowStep,
    ci: CiContext,
  ): Promise<void> {
    const params = this.#params;
    if (params === null) throw new Error("check run started without parameters");
    const outcome = await runCheck(ci, params);
    const finishedAt = Date.now();
    const delivery = await step.do(REPORT_STEP, REPORT_STEP_CONFIG, () =>
      deliver(this.env, params, outcome, finishedAt),
    );
    if (delivery.refused !== null) {
      console.error(
        JSON.stringify({
          event: "checks.report_refused",
          attempt: params.attemptId,
          code: delivery.refused,
        }),
      );
    }
  }
}

/**
 * The source-control adapter of every check run: each source gets `railheadCheckout` for its own
 * repository. The repository is the one the checks module named in the run's parameters, which no
 * client writes.
 */
export function checkSource(): SourceControlAdapter<CloudflareArtifacts> {
  const any = cloudflareArtifacts();
  return {
    ...any,
    create: (env) => {
      const forSource = (source: { owner: string; repo: string }) =>
        railheadCheckout({ owner: source.owner, repo: source.repo }).create(env);
      return {
        receiveEvent: async () => null,
        getSourceCheckout: (source) => forSource(source).getSourceCheckout(source),
        listTreeBlobs: (source, paths) => forSource(source).listTreeBlobs(source, paths),
        getStepCredentialEnv: (source) => forSource(source).getStepCredentialEnv(source),
        getPushCredentials: (source) => forSource(source).getPushCredentials(source),
        createPullRequest: async () => ({ status: "skipped" }),
        startStepNotification: async () => null,
      };
    },
  };
}

function unreachable(value: never): never {
  throw new Error(`unhandled runner failure: ${JSON.stringify(value)}`);
}
