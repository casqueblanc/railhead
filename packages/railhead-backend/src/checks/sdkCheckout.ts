// How a check's sandbox gets its commit, and how a failed runner becomes a check outcome, with
// `@cloudflare/ci` patched by `patches/@cloudflare__ci@0.2.0.patch`.
//
// No token enters the sandbox. The checkout names the Git gateway (`src/sandbox/gateway.ts`) with
// a grant: a read-only policy for the one repository that lapses after the longest sandbox
// lifetime. The patched runner selects that handler before its first command; the gateway adds a
// short-lived token outside the container. The patched runner also stops a run whose checkout exits
// nonzero before the check's command starts.
//
// `classifyRunnerFailure` then separates the change's fault from Railhead's: `fail` only when the
// check's own command exited nonzero, `error` for everything else, so a missing commit, a refused
// fetch or an Artifacts outage never sends a change back.

import { cloudflareArtifacts, isCiRunnerFailure, type CloudflareArtifacts } from "@cloudflare/ci";
import type { SourceControlAdapter } from "@cloudflare/ci/worker/source-control";
import { MAX_SANDBOX_LIFETIME_MS } from "../sandbox/admission";
import { parseSandboxPolicy, type SandboxGrant } from "../sandbox/policy";

/** The `RailheadSandbox` outbound handler that serves Git for a grant. */
export const CHECKOUT_OUTBOUND_HANDLER = "gitGateway";

/**
 * How long a checkout's grant lasts from the moment the runner asks for it: no sandbox outlives
 * `MAX_SANDBOX_LIFETIME_MS`, so the gateway refuses the sandbox's Git requests after that.
 */
export const CHECKOUT_GRANT_MS = MAX_SANDBOX_LIFETIME_MS;

/** The first line the patched runner throws when the checkout exits nonzero. */
const CHECKOUT_FAILED = "source checkout exited with status ";

const SHA = /^[0-9a-f]{40}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
// The SDK's failure message for a nonzero command exit, after the runner's name.
const COMMAND_FAILED = /^ failed with exit code ([1-9][0-9]{0,9})\n=== stdout ===\n/;

type Provider = ReturnType<SourceControlAdapter<CloudflareArtifacts>["create"]>;
type Source = Parameters<Provider["getSourceCheckout"]>[0];

/** The checkout a runner receives: no token, and the gateway handler with its grant. */
export interface GatewayCheckout {
  kind: "git";
  remote: string;
  sha: string;
  outbound: { handler: typeof CHECKOUT_OUTBOUND_HANDLER; params: SandboxGrant };
}

/** One Artifacts repository a check reads: `owner` is its namespace. */
export interface CheckRepository {
  owner: string;
  repo: string;
}

/**
 * The source-control adapter for Railhead's checks over one repository. Checkouts go through the
 * gateway; runners never receive repository credentials, and push events never start a run.
 */
export function railheadCheckout(
  repository: CheckRepository,
): SourceControlAdapter<CloudflareArtifacts> {
  const sdk = cloudflareArtifacts({ owner: repository.owner, repo: repository.repo });
  return {
    ...sdk,
    create: (env) => {
      const delegate = sdk.create(env);
      return {
        // Railhead starts each run for an exact candidate; an Artifacts push never starts one.
        receiveEvent: async () => null,
        // The SDK asks for the checkout in the same step that starts the sandbox, so the grant
        // runs from then.
        getSourceCheckout: async (source) =>
          gatewayCheckout(source, env.CLOUDFLARE_ACCOUNT_ID, Date.now()),
        // Cache fingerprints read blob hashes through the Worker's binding, outside the sandbox.
        listTreeBlobs: (source, paths) => delegate.listTreeBlobs(source, paths),
        getStepCredentialEnv: () => Promise.reject(new Error(NO_CREDENTIALS)),
        getPushCredentials: () => Promise.reject(new Error(NO_CREDENTIALS)),
        createPullRequest: async () => ({ status: "skipped" }),
        startStepNotification: async () => null,
      };
    },
  };
}

const NO_CREDENTIALS = "railhead checks never hand repository credentials to a runner";

/**
 * The checkout for `source`: the exact commit, fetched through the gateway under a read-only policy
 * for its repository that lapses `CHECKOUT_GRANT_MS` after `now`. Throws, before any sandbox
 * starts, for a SHA that is not 40 lowercase hex digits, a namespace that does not match the owner,
 * an invalid account or repository name, or a time that is not whole milliseconds.
 */
export function gatewayCheckout(source: Source, accountId: string, now: number): GatewayCheckout {
  if (!SHA.test(source.sha)) throw new Error("check source is not a full commit SHA");
  if (namespaceOf(source.providerData) !== source.owner) {
    throw new Error("check source namespace does not match its owner");
  }
  if (!ACCOUNT_ID.test(accountId)) throw new Error("invalid Cloudflare account ID");
  if (!Number.isSafeInteger(now)) throw new Error("invalid checkout time");
  const host = `${accountId}.artifacts.cloudflare.net`;
  const policy = parseSandboxPolicy({
    host,
    namespace: source.owner,
    read: [source.repo],
    write: null,
  });
  if (policy === null) throw new Error("check source names an invalid repository");
  return {
    kind: "git",
    remote: `https://${host}/git/${source.owner}/${source.repo}.git`,
    sha: source.sha,
    outbound: {
      handler: CHECKOUT_OUTBOUND_HANDLER,
      params: { policy, expiresAt: now + CHECKOUT_GRANT_MS },
    },
  };
}

function namespaceOf(providerData: unknown): string | null {
  if (typeof providerData !== "object" || providerData === null) return null;
  const namespace: unknown = Reflect.get(providerData, "namespace");
  return typeof namespace === "string" ? namespace : null;
}

/** What a runner's rejection means for the check. */
export type RunnerFailure =
  /** The check's own command exited nonzero: the change failed the check. */
  | { conclusion: "fail"; runner: string; exitCode: number }
  /** Railhead could not run the check: the change is not to blame. */
  | { conclusion: "error"; runner: string | null; reason: "checkout" | "infrastructure" };

/**
 * Classifies a rejection from `ci.runner` or a chained `runner`. Only the SDK's report of a nonzero
 * command exit, at the start of the message for that runner, is a `fail`; command output follows
 * it and cannot change the result. A checkout failure, a timeout, a lost sandbox or anything that
 * is not a runner failure is an `error`.
 */
export function classifyRunnerFailure(rejection: unknown): RunnerFailure {
  if (!isCiRunnerFailure(rejection)) {
    return { conclusion: "error", runner: null, reason: "infrastructure" };
  }
  const runner = rejection.runner.name;
  // The cause holds the whole message; `output` keeps only its tail once it passes 20,000
  // characters, which would drop the leading line.
  const message = rejection.cause instanceof Error ? rejection.cause.message : rejection.output;
  if (message.startsWith(CHECKOUT_FAILED)) {
    return { conclusion: "error", runner, reason: "checkout" };
  }
  const code = message.startsWith(runner)
    ? COMMAND_FAILED.exec(message.slice(runner.length))?.[1]
    : undefined;
  if (code === undefined) return { conclusion: "error", runner, reason: "infrastructure" };
  return { conclusion: "fail", runner, exitCode: Number(code) };
}
