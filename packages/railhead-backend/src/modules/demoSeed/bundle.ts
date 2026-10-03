// Reads the Git bundle the demo seed imports: `git bundle create FILE refs/heads/main` over a full
// history, as `scripts/demoSeed/cli.ts bundle` writes it.
//
// A v2 bundle is a text header followed by a packfile. The header names the bundle's refs, one
// `<sha> <ref>` line each, and the commits a receiver must already have, one `-<sha>` line each,
// and ends at an empty line. The seed accepts exactly one ref, `refs/heads/main`, and no
// prerequisites, so the pack alone holds every object main reaches. The pack itself is not parsed
// here: Artifacts checks it when it is pushed, and refuses a push whose pack lacks main's history.

import { isCommitSha, type CommitSha } from "@railhead/shared/events";

/** The ref a demo bundle must carry, and the only one. */
export const BUNDLE_REF = "refs/heads/main";

/** The longest bundle header the seed reads before it gives up looking for its end. */
const MAX_HEADER_BYTES = 4096;

const SIGNATURE = "# v2 git bundle\n";
const PACK_SIGNATURE = [0x50, 0x41, 0x43, 0x4b]; // "PACK"
/** A pack's 12-byte header and 20-byte trailing checksum. */
const MIN_PACK_BYTES = 32;

/** A bundle the seed can push. */
export interface DemoBundle {
  /** The commit `refs/heads/main` names. */
  readonly head: CommitSha;
  /** The packfile, from its `PACK` signature to its checksum. */
  readonly pack: Uint8Array;
}

/** Why a bundle was refused. */
export type BundleFailure = "not_a_bundle" | "prerequisites" | "wrong_refs" | "no_pack";

/** Splits a v2 Git bundle into its main head and its pack, or says why it is not a demo bundle. */
export function readBundle(
  bytes: Uint8Array,
): { ok: true; bundle: DemoBundle } | { ok: false; reason: BundleFailure } {
  const end = headerEnd(bytes);
  if (end === undefined) return { ok: false, reason: "not_a_bundle" };
  const header = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(
    bytes.subarray(0, end),
  );
  if (!header.startsWith(SIGNATURE)) return { ok: false, reason: "not_a_bundle" };

  // The header without its signature and its terminating empty line.
  const lines = header.slice(SIGNATURE.length, -1).split("\n");
  let head: CommitSha | undefined;
  for (const line of lines) {
    if (line.startsWith("-")) return { ok: false, reason: "prerequisites" };
    // An `@capability` line belongs to v3 bundles, which the signature check already refused.
    const [sha, ref, ...rest] = line.split(" ");
    if (sha === undefined || !isCommitSha(sha) || ref !== BUNDLE_REF || rest.length > 0) {
      return { ok: false, reason: "wrong_refs" };
    }
    if (head !== undefined) return { ok: false, reason: "wrong_refs" };
    head = sha;
  }
  if (head === undefined) return { ok: false, reason: "wrong_refs" };

  const pack = bytes.subarray(end + 1);
  if (pack.length < MIN_PACK_BYTES || PACK_SIGNATURE.some((byte, i) => pack[i] !== byte)) {
    return { ok: false, reason: "no_pack" };
  }
  return { ok: true, bundle: { head, pack } };
}

/** The index of the newline that ends the header's empty line, within the header limit. */
function headerEnd(bytes: Uint8Array): number | undefined {
  const limit = Math.min(bytes.length, MAX_HEADER_BYTES);
  for (let i = 1; i < limit; i += 1) {
    if (bytes[i] === 0x0a && bytes[i - 1] === 0x0a) return i;
  }
  return undefined;
}
