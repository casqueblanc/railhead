/**
 * Test files are generated when a check runs, never committed, so the repository stays small. The
 * bytes are pseudo-random but fixed by the seed, so a failure reproduces exactly.
 */

/** `size` bytes from a xorshift32 sequence starting at `seed`. */
export function generateBody(size: number, seed = 0x5eed): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("Body size must be a non-negative integer.");
  }
  if (!Number.isInteger(seed) || seed <= 0 || seed > 0xffff_ffff) {
    throw new RangeError("Seed must be an integer between 1 and 2^32 - 1.");
  }
  const body = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    body[i] = state & 0xff;
  }
  return body;
}

/** SHA-256 of `bytes` in lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Index of the first byte where `a` and `b` differ, or -1 when they are identical. */
export function firstDifference(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.byteLength, b.byteLength);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return a.byteLength === b.byteLength ? -1 : shared;
}
