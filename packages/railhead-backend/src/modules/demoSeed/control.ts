// The owner authority over the demo seed. It runs in the `Repo` object named `DEMO_SEED_CONTROL`,
// which never becomes a repository, so its seal key and spent challenges survive a reset of the demo
// repository.
//
// It uses the owner module's sealed, single-use challenges, bound to the demo repository's
// identifier. `perform` opens the seal, checks the bundle, spends the proof and only then hands the
// action to the demo repository. A proof authorizes at most one attempt, whatever the attempt does.

import {
  MAX_DEMO_BUNDLE_BYTES,
  type ActionChallenge,
  type DemoSeedAction,
  type DemoSeedResult,
  type PasskeyAssertion,
} from "@railhead/shared/board-api";
import { isCommitSha, type CommitSha } from "@railhead/shared/events";
import { fail, ok, type PortResult } from "../../contracts/result";
import {
  isSealedChallengeId,
  notAChallenge,
  type SealedChallengeContext,
  type SealedChallengeKind,
  sealedChallenges,
} from "../owner/sealedChallenge";
import { migrate } from "../../repo/storage";
import { readBundle, type BundleFailure } from "./bundle";

/** What the control hands the demo repository once a proof is spent. */
export interface SeedTargetCalls {
  /** Seeds main at `head` from `pack`. */
  seed(head: CommitSha, pack: Uint8Array): Promise<PortResult<DemoSeedResult>>;
  /** Resets the demo repository. */
  reset(): Promise<PortResult<DemoSeedResult>>;
}

/** What the control needs. */
export interface SeedControlContext extends SealedChallengeContext {
  /** The demo repository. */
  readonly target: SeedTargetCalls;
}

/** The owner's seed and reset of the demo repository. */
export interface SeedControl {
  /** Issues a challenge bound to `action`. */
  prepare(action: DemoSeedAction): Promise<PortResult<ActionChallenge>>;
  /** Performs the action the challenge names, if `assertion` verifies for it; at most once. */
  perform(
    challengeId: string,
    assertion: PasskeyAssertion,
    bundle: Uint8Array | null,
  ): Promise<PortResult<DemoSeedResult>>;
}

/** The largest seed action, in bytes of its JSON; a seed action is under a hundred. */
const MAX_SEED_ACTION_BYTES = 256;

/** The control's challenges; its seal domain differs from the owner module's, so neither opens the other's. */
const SEED_CHALLENGE: SealedChallengeKind<DemoSeedAction> = {
  domain: "railhead-demo-seed-challenge-v1",
  idPrefix: "dsc",
  keyTable: "demo_seed_key",
  spentTable: "demo_seed_spent",
  maxActionBytes: MAX_SEED_ACTION_BYTES,
  decodeAction: (json) => parseAction(JSON.parse(json)),
};

/** The migration owner name of the control's tables. */
const CONTROL_OWNER = "demo_seed_control";

/** Released schema steps. Append a step to change it; never edit one. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE demo_seed_key (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    key BLOB NOT NULL
  ) STRICT`,
  `CREATE TABLE demo_seed_spent (
    challenge_id TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  ) STRICT`,
];

/**
 * Refuses a `perform` whose challenge id is not shaped like a seed challenge or whose bundle is over
 * `MAX_DEMO_BUNDLE_BYTES`. It is stateless, so the Worker runs it before any call reaches the
 * control object: an unauthenticated caller cannot hand that one object a malformed id or an
 * oversized bundle. It checks no seal; the control does that.
 */
export function checkPerformInput(
  challengeId: string,
  bundle: Uint8Array | null,
): PortResult<void> {
  if (!isSealedChallengeId(SEED_CHALLENGE, challengeId)) return notAChallenge();
  if (bundle !== null && bundle.length > MAX_DEMO_BUNDLE_BYTES) return bundleTooLarge();
  return ok(undefined);
}

/** Builds the control and migrates its tables. */
export function createSeedControl(context: SeedControlContext): SeedControl {
  migrate(context.storage, CONTROL_OWNER, MIGRATIONS);
  const { target } = context;
  const challenges = sealedChallenges(SEED_CHALLENGE, context);

  return {
    async prepare(action) {
      const parsed = parseAction(action);
      if (parsed === undefined) return fail("invalid_request", "That is not a demo seed action.");
      return challenges.prepare(parsed);
    },

    async perform(sealedId, assertion, bundle) {
      const opened = await challenges.open(sealedId);
      if (!opened.ok) return opened;
      const binding = opened.value;
      // The bundle is checked before the proof is spent, so a wrong file costs no passkey prompt.
      const input = actionInput(binding.action, bundle);
      if (!input.ok) return input;
      const signed = await challenges.spend(binding, assertion);
      if (!signed.ok) return signed;
      return input.value === null
        ? target.reset()
        : target.seed(input.value.head, input.value.pack);
    },
  };
}

/** `value` as a demo seed action with a well-formed head, or `undefined`. */
function parseAction(value: unknown): DemoSeedAction | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const kind: unknown = Reflect.get(value, "kind");
  if (kind === "demo.reset") return { kind };
  if (kind !== "demo.seed") return undefined;
  const head: unknown = Reflect.get(value, "head");
  return typeof head === "string" && isCommitSha(head) ? { kind, head } : undefined;
}

/** The pack a seed pushes, or `null` for a reset, after checking the bundle fits the action. */
function actionInput(
  action: DemoSeedAction,
  bundle: Uint8Array | null,
): PortResult<{ head: CommitSha; pack: Uint8Array } | null> {
  switch (action.kind) {
    case "demo.reset":
      return bundle === null ? ok(null) : fail("invalid_request", "A reset takes no bundle.");
    case "demo.seed": {
      if (bundle === null) return fail("invalid_request", "A seed needs the main bundle.");
      if (bundle.length > MAX_DEMO_BUNDLE_BYTES) return bundleTooLarge();
      const read = readBundle(bundle);
      if (!read.ok) return fail("invalid_request", bundleMessage(read.reason));
      if (read.bundle.head !== action.head) {
        return fail("invalid_request", "The bundle's main is not the head the passkey approved.");
      }
      return ok(read.bundle);
    }
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

function bundleTooLarge(): PortResult<never> {
  return fail("invalid_request", "The bundle is too large.");
}

function bundleMessage(reason: BundleFailure): string {
  switch (reason) {
    case "not_a_bundle":
      return "That is not a v2 Git bundle.";
    case "prerequisites":
      return "The bundle must hold main's full history, with no prerequisites.";
    case "wrong_refs":
      return "The bundle must carry refs/heads/main and nothing else.";
    case "no_pack":
      return "The bundle has no pack.";
    default: {
      const unreachable: never = reason;
      return unreachable;
    }
  }
}
