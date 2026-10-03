// Session tokens: `<header>.<claims>.<mac>`, each part base64url without padding. The header is
// fixed, the claims are `SessionClaims` as JSON, and the MAC is HMAC-SHA256 over the first two
// parts with a key only the issuing repository uses. Only that repository verifies its tokens, so
// a symmetric key is enough and no other party ever needs to read one.
//
// No key is stored. Each repository's keys are derived at use, with HKDF-SHA256, from the
// instance's signing secret (a Worker secret), the repository id and the key's purpose, so a read
// of a repository's database yields nothing that signs, and replacing the secret ends every session.

import { isSessionTokenForm, SESSION_TTL_MS } from "@railhead/shared/agent-api";
import { isId, type RepoId } from "@railhead/shared/events";
import type { SessionClaims } from "../contracts/principals";
import { decodeBase64Url, encodeBase64Url } from "../modules/owner/encoding";

/** The only header a token carries, already encoded. */
const HEADER = encodeBase64Url(new TextEncoder().encode('{"alg":"HS256","typ":"JWT"}'));

/** Largest claims part read, in bytes; real claims are under 200. */
const MAX_CLAIMS_BYTES = 1024;

/** Fewest characters a signing secret may have; a shorter one leaves sessions unavailable. */
export const MIN_SIGNING_SECRET_LENGTH = 32;

/** HKDF salt shared by every session key. */
const KEY_SALT = new TextEncoder().encode("railhead-session-keys-v1");

/** What a derived key signs: login challenge ids, or session tokens. */
export type SessionKeyPurpose = "challenge" | "token";

const JTI = /^[0-9a-f]{32}$/;

/** Why a token was not accepted. Every case is `unauthenticated` to the caller. */
export type SessionTokenFailure = "malformed" | "bad-mac" | "expired";

/** The outcome of {@link verifySessionToken}. */
export type SessionTokenResult =
  | { readonly ok: true; readonly claims: SessionClaims }
  | { readonly ok: false; readonly reason: SessionTokenFailure };

/**
 * Derives the HMAC key repository `repoId` signs `purpose` with from the instance's `secret`, or
 * `undefined` when `secret` is missing or shorter than {@link MIN_SIGNING_SECRET_LENGTH}. The key
 * cannot be exported.
 */
export async function deriveSessionKey(
  secret: string | undefined,
  repoId: RepoId,
  purpose: SessionKeyPurpose,
): Promise<CryptoKey | undefined> {
  if (secret === undefined || secret.length < MIN_SIGNING_SECRET_LENGTH) return undefined;
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    "HKDF",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: KEY_SALT,
      info: new TextEncoder().encode(`${purpose}\n${repoId}`),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/** Signs `claims` with `key`. */
export async function signSessionToken(key: CryptoKey, claims: SessionClaims): Promise<string> {
  const body = `${HEADER}.${encodeBase64Url(new TextEncoder().encode(JSON.stringify(claims)))}`;
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${encodeBase64Url(new Uint8Array(mac))}`;
}

/**
 * Verifies `token`'s MAC with `key` and returns its claims while `now` is before their expiry. The
 * token is untrusted: its form, header, MAC and every claim are checked here.
 */
export async function verifySessionToken(
  key: CryptoKey,
  token: string,
  now: number,
): Promise<SessionTokenResult> {
  if (!isSessionTokenForm(token)) return { ok: false, reason: "malformed" };
  const [header, payload, macText] = token.split(".");
  if (header !== HEADER || payload === undefined || macText === undefined) {
    return { ok: false, reason: "malformed" };
  }
  const mac = decodeBase64Url(macText, 32);
  if (mac === undefined || mac.length !== 32) return { ok: false, reason: "malformed" };
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    mac,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  if (!valid) return { ok: false, reason: "bad-mac" };
  const claims = parseClaims(payload);
  if (claims === undefined) return { ok: false, reason: "malformed" };
  if (now >= claims.exp) return { ok: false, reason: "expired" };
  return { ok: true, claims };
}

function parseClaims(payload: string): SessionClaims | undefined {
  const bytes = decodeBase64Url(payload, MAX_CLAIMS_BYTES);
  if (bytes === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return undefined;
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const [v, sub, owner, repo, iat, exp, jti] = [
    "v",
    "sub",
    "owner",
    "repo",
    "iat",
    "exp",
    "jti",
  ].map((name): unknown => Object.getOwnPropertyDescriptor(parsed, name)?.value);
  if (
    v !== 1 ||
    typeof sub !== "string" ||
    !isId("agent", sub) ||
    typeof owner !== "string" ||
    !isId("user", owner) ||
    typeof repo !== "string" ||
    !isId("repo", repo) ||
    typeof iat !== "number" ||
    !Number.isSafeInteger(iat) ||
    iat < 0 ||
    typeof exp !== "number" ||
    exp !== iat + SESSION_TTL_MS ||
    typeof jti !== "string" ||
    !JTI.test(jti)
  ) {
    return undefined;
  }
  return { v, sub, owner, repo, iat, exp, jti };
}
