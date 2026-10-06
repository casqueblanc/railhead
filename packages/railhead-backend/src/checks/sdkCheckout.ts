// How a check's sandbox gets its commit, and how a failed runner becomes a check outcome, with
// `@cloudflare/ci` patched by `patches/@cloudflare__ci@0.2.0.patch`.
//
// No token enters the sandbox. The checkout carries a grant: a read-only policy for the one
// repository that lapses at the deadline of the sandbox slot the repository admitted for the run
// (`src/sandbox/admission.ts`), and the name of that slot's sandbox. The run's `providerData` carries
// the slot; a run without one never gets a checkout, so no check sandbox exists outside the
// repository's bound. Admission starts that sandbox's fenced incarnation (`src/sandbox/fence.ts`)
// under the same grant, and before its first command the patched runner joins it. The fence routes
// the sandbox's Git requests to the gateway (`src/sandbox/gateway.ts`) and retires it when the
// grant lapses. The gateway serves the grant only while that incarnation is live, and adds a
// short-lived token outside the container. When the run ends the patched runner retires the
// incarnation through its fence, which ends the grant before it destroys the container; a destroy
// that fails fails the run, and the fence keeps retrying it. One slot serves one runner: the patched
// runner refuses a chained runner before it opens the sandbox. The patched runner also stops a run
// whose checkout exits nonzero before the check's command starts. Workspace backups need a
// `BACKUP_BUCKET` R2 binding; without one a runner runs with no backup or cache, and a chained
// runner, which would continue its parent's workspace, ends as an error before it starts.
//
// `classifyRunnerFailure` then separates the change's fault from Railhead's: `fail` only when the
// check's own command exited nonzero, `error` for everything else, so a missing commit, a refused
// fetch or an Artifacts outage never sends a change back.

import { cloudflareArtifacts, isCiRunnerFailure, type CloudflareArtifacts } from "@cloudflare/ci";
import type { SourceControlAdapter } from "@cloudflare/ci/worker/source-control";
import { parseSandboxPolicy, type SandboxGrant } from "../sandbox/policy";

/** The first line the patched runner throws when the checkout exits nonzero. */
const CHECKOUT_FAILED = "source checkout exited with status ";

const SHA = /^[0-9a-f]{40}$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/;
// The names `sandboxName` in `src/sandbox/admission.ts` gives a slot's sandbox.
const SANDBOX_NAME = /^sbx-[0-9a-f]{32}$/;
// The SDK's failure message for a nonzero command exit, after the runner's name. The patch keeps
// this header out of environment redaction; only the output after it is redacted.
const COMMAND_FAILED = /^ failed with exit code ([1-9][0-9]{0,9})\n=== stdout ===\n/;

type Provider = ReturnType<SourceControlAdapter<CloudflareArtifacts>["create"]>;
type Source = Parameters<Provider["getSourceCheckout"]>[0];

/** The checkout a runner receives: no token, and the admitted sandbox and grant it runs under. */
export interface GatewayCheckout {
  kind: "git";
  remote: string;
  sha: string;
  fence: SandboxGrant & { sandbox: string };
}

/** The sandbox slot a repository admitted for one check run. */
export interface CheckSlot {
  /** The slot's sandbox name. */
  sandbox: string;
  /** When the slot's sandbox must be gone, in milliseconds since the Unix epoch. */
  deadline: number;
}

/** The `providerData` of a check run: its Artifacts namespace and its admitted slot. */
export interface CheckProviderData {
  namespace: string;
  slot: CheckSlot;
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
        getSourceCheckout: async (source) =>
          gatewayCheckout(repository, source, env.CLOUDFLARE_ACCOUNT_ID),
        // Cache fingerprints read blob hashes through the Worker's binding, outside the sandbox.
        listTreeBlobs: async (source, paths) => {
          assertRepository(repository, source);
          return delegate.listTreeBlobs(source, paths);
        },
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
 * The checkout for `source` in `repository`: the exact commit, fetched through the gateway under a
 * read-only policy for that repository, in the sandbox the run's slot names, with a grant that
 * lapses at that slot's deadline. Throws, before any sandbox starts, for a source in another
 * repository, a SHA that is not 40 lowercase hex digits, a namespace that does not match the owner,
 * an invalid account or repository name, or a missing or malformed slot.
 */
export function gatewayCheckout(
  repository: CheckRepository,
  source: Source,
  accountId: string,
): GatewayCheckout {
  assertRepository(repository, source);
  if (!SHA.test(source.sha)) throw new Error("check source is not a full commit SHA");
  if (namespaceOf(source.providerData) !== source.owner) {
    throw new Error("check source namespace does not match its owner");
  }
  const host = artifactsHost(accountId);
  if (host === null) throw new Error("invalid Cloudflare account ID");
  const slot = slotOf(source.providerData);
  if (slot === null) throw new Error("check source names no admitted sandbox slot");
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
    fence: { policy, expiresAt: slot.deadline, sandbox: slot.sandbox },
  };
}

/**
 * The Artifacts Git host of a Cloudflare account, or `null` when `accountId` is not 32 lowercase
 * hex digits.
 */
export function artifactsHost(accountId: string): string | null {
  return ACCOUNT_ID.test(accountId) ? `${accountId}.artifacts.cloudflare.net` : null;
}

function assertRepository(repository: CheckRepository, source: Source): void {
  if (source.owner !== repository.owner || source.repo !== repository.repo) {
    throw new Error("check source is not the adapter's repository");
  }
}

function namespaceOf(providerData: unknown): string | null {
  if (typeof providerData !== "object" || providerData === null) return null;
  const namespace: unknown = Reflect.get(providerData, "namespace");
  return typeof namespace === "string" ? namespace : null;
}

function slotOf(providerData: unknown): CheckSlot | null {
  if (typeof providerData !== "object" || providerData === null) return null;
  const slot: unknown = Reflect.get(providerData, "slot");
  if (typeof slot !== "object" || slot === null) return null;
  const sandbox: unknown = Reflect.get(slot, "sandbox");
  const deadline: unknown = Reflect.get(slot, "deadline");
  if (typeof sandbox !== "string" || !SANDBOX_NAME.test(sandbox)) return null;
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline <= 0) return null;
  return { sandbox, deadline };
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
