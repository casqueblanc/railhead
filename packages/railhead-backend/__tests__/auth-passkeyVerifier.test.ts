import type { OwnerAction, PasskeyAssertion } from "@railhead/shared/board-api";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ACTION_DIGEST_DOMAIN,
  type ActionBinding,
  actionChallenge,
  boardErrorFor,
  MAX_CLIENT_DATA_BYTES,
  type PasskeyFailure,
  type RelyingParty,
  relyingParty,
  type StoredCredential,
  verifyActionAssertion,
} from "../src/auth/passkeyVerifier";

// A software authenticator stands in for Touch ID: it builds the clientDataJSON a browser would,
// the authenticator data and a DER ECDSA P-256 signature, so each field can be tampered with.

const enc = new TextEncoder();
const NOW = 1_800_000_000_000;

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

function derInteger(raw: Uint8Array): number[] {
  let start = 0;
  while (start < raw.length - 1 && raw[start] === 0) start += 1;
  const body = [...raw.subarray(start)];
  if ((body[0] ?? 0) & 0x80) body.unshift(0);
  return [0x02, body.length, ...body];
}

function toDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = [...derInteger(raw.subarray(0, 32)), ...derInteger(raw.subarray(32))];
  return Uint8Array.from([0x30, body.length, ...body]);
}

/** The ES256 COSE_Key for a P-256 public key: {1: 2, 3: -7, -1: 1, -2: x, -3: y}. */
function coseKey(x: Uint8Array, y: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from([
    0xa5,
    0x01,
    0x02,
    0x03,
    0x26,
    0x20,
    0x01,
    0x21,
    0x58,
    32,
    ...x,
    0x22,
    0x58,
    32,
    ...y,
  ]);
}

interface Authenticator {
  privateKey: CryptoKey;
  credential: StoredCredential;
}

async function newAuthenticator(): Promise<Authenticator> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in pair)) throw new Error("ECDSA generateKey returned a single key");
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("raw export is not bytes");
  const raw = new Uint8Array(exported);
  return {
    privateKey: pair.privateKey,
    credential: {
      credentialId: b64url(crypto.getRandomValues(new Uint8Array(16))),
      publicKey: coseKey(raw.subarray(1, 33), raw.subarray(33)),
      userHandle: b64url(enc.encode("owner")),
      signCount: 0,
    },
  };
}

interface AssertOptions {
  challenge?: string;
  type?: string;
  origin?: string;
  extraClientData?: Record<string, unknown>;
  rpId?: string;
  flags?: number;
  signCount?: number;
  userHandle?: string | null;
  signer?: CryptoKey;
}

async function assert(
  auth: Authenticator,
  party: RelyingParty,
  challenge: string,
  options: AssertOptions = {},
): Promise<PasskeyAssertion> {
  const clientDataJson = enc.encode(
    JSON.stringify({
      type: options.type ?? "webauthn.get",
      challenge: options.challenge ?? challenge,
      origin: options.origin ?? party.origin,
      crossOrigin: false,
      ...options.extraClientData,
    }),
  );
  const authData = new Uint8Array(37);
  authData.set(await sha256(enc.encode(options.rpId ?? party.rpId)), 0);
  authData[32] = options.flags ?? 0x05;
  new DataView(authData.buffer).setUint32(33, options.signCount ?? 1, false);
  const signed = Uint8Array.from([...authData, ...(await sha256(clientDataJson))]);
  const raw = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      options.signer ?? auth.privateKey,
      signed,
    ),
  );
  return {
    credentialId: auth.credential.credentialId,
    clientDataJson: b64url(clientDataJson),
    authenticatorData: b64url(authData),
    signature: b64url(toDer(raw)),
    userHandle: options.userHandle === undefined ? auth.credential.userHandle : options.userHandle,
  };
}

function rp(host: string): RelyingParty {
  const party = relyingParty(host);
  if (party === undefined) throw new Error(`${host} is not a relying party host`);
  return party;
}

const party = rp("railhead.dev");
const action: OwnerAction = { kind: "agent.confirm", agentId: "agt_atlas", code: "123456" };
const binding: ActionBinding = {
  repoId: "repo_demo",
  challengeId: "pkc_0123456789abcdef",
  nonce: b64url(Uint8Array.from({ length: 16 }, (_, i) => i)),
  expiresAt: NOW + 120_000,
  action,
};

async function challengeFor(b: ActionBinding, p: RelyingParty = party): Promise<string> {
  const result = await actionChallenge(p, b);
  if (!result.ok) throw new Error("binding refused");
  return result.challenge;
}

let auth: Authenticator;
let challenge: string;

beforeAll(async () => {
  auth = await newAuthenticator();
  challenge = await challengeFor(binding);
});

async function verify(
  assertion: PasskeyAssertion,
  overrides: Partial<{
    relyingParty: RelyingParty;
    binding: ActionBinding;
    credential: StoredCredential;
    now: number;
  }> = {},
) {
  return verifyActionAssertion({
    relyingParty: party,
    binding,
    credential: auth.credential,
    assertion,
    now: NOW,
    ...overrides,
  });
}

function refused(reason: PasskeyFailure) {
  return { ok: false, reason };
}

describe("relyingParty", () => {
  it("fixes the RP ID to the exact instance host and the origin to https on it", () => {
    expect(relyingParty("railhead.dev")).toEqual({
      rpId: "railhead.dev",
      origin: "https://railhead.dev",
    });
    expect(relyingParty("railhead.mashin.workers.dev")).toEqual({
      rpId: "railhead.mashin.workers.dev",
      origin: "https://railhead.mashin.workers.dev",
    });
  });

  it("refuses any other host, suffix or parent domain", () => {
    for (const host of [
      "flareforge.dev",
      "evil.railhead.dev",
      "workers.dev",
      "mashin.workers.dev",
      "RAILHEAD.DEV",
      "railhead.dev.",
      "https://railhead.dev",
      "",
    ]) {
      expect(relyingParty(host)).toBeUndefined();
    }
  });
});

describe("actionChallenge", () => {
  it("is SHA-256 over the domain, RP ID, binding and action fields in order", async () => {
    const fields = JSON.stringify([
      ACTION_DIGEST_DOMAIN,
      "railhead.dev",
      "repo_demo",
      "pkc_0123456789abcdef",
      binding.nonce,
      NOW + 120_000,
      "agent.confirm",
      "agt_atlas",
      "123456",
    ]);
    expect(challenge).toBe(b64url(await sha256(enc.encode(fields))));
    expect(fromB64url(challenge)).toHaveLength(32);
  });

  it("changes with every field of every action kind and with the relying party", async () => {
    const actions: OwnerAction[] = [
      { kind: "invite.create", name: "atlas" },
      { kind: "invite.create", name: "atlaS" },
      { kind: "agent.confirm", agentId: "agt_atlas", code: "123457" },
      { kind: "agent.confirm", agentId: "agt_other", code: "123456" },
      { kind: "agent.revoke", agentId: "agt_atlas" },
      { kind: "issue.file", title: "t", body: "b" },
      { kind: "issue.file", title: "tb", body: "" },
      { kind: "decision.record", decisionId: "dec_1", option: "a", expectedVersion: null },
      { kind: "decision.record", decisionId: "dec_1", option: "a", expectedVersion: 0 },
      { kind: "decision.record", decisionId: "dec_1", option: "b", expectedVersion: 0 },
      {
        kind: "check.approve",
        checkRunId: "chk_1",
        candidate: "a".repeat(40),
        digest: "c".repeat(64),
      },
      {
        kind: "check.approve",
        checkRunId: "chk_2",
        candidate: "a".repeat(40),
        digest: "c".repeat(64),
      },
      {
        kind: "check.approve",
        checkRunId: "chk_1",
        candidate: "b".repeat(40),
        digest: "c".repeat(64),
      },
      {
        kind: "check.approve",
        checkRunId: "chk_1",
        candidate: "a".repeat(40),
        digest: "d".repeat(64),
      },
    ];
    const seen = new Set([challenge]);
    for (const other of actions) seen.add(await challengeFor({ ...binding, action: other }));
    seen.add(await challengeFor({ ...binding, repoId: "repo_other" }));
    seen.add(await challengeFor({ ...binding, challengeId: "pkc_other" }));
    seen.add(await challengeFor({ ...binding, expiresAt: binding.expiresAt + 1 }));
    seen.add(await challengeFor({ ...binding, nonce: b64url(new Uint8Array(16)) }));
    seen.add(await challengeFor(binding, rp("railhead.mashin.workers.dev")));
    expect(seen.size).toBe(actions.length + 6);
  });

  it("refuses a nonce under 16 bytes, a non-canonical nonce and a bad expiry", async () => {
    const bad: ActionBinding[] = [
      { ...binding, nonce: b64url(new Uint8Array(15)) },
      { ...binding, nonce: `${binding.nonce}=` },
      { ...binding, nonce: "AAAAAAAAAAAAAAAAAAAAAB" },
      { ...binding, expiresAt: Number.NaN },
      { ...binding, expiresAt: 1.5 },
      { ...binding, expiresAt: -1 },
    ];
    for (const b of bad) {
      expect(await actionChallenge(party, b)).toEqual(refused("invalid-binding"));
    }
  });
});

describe("verifyActionAssertion", () => {
  it("accepts a user-verified assertion for the exact action and reports its counter", async () => {
    const assertion = await assert(auth, party, challenge, { signCount: 7 });
    expect(await verify(assertion)).toEqual({ ok: true, signCount: 7 });
  });

  it("accepts on the development instance and with no user handle returned", async () => {
    const dev = rp("railhead.mashin.workers.dev");
    const devChallenge = await challengeFor(binding, dev);
    const assertion = await assert(auth, dev, devChallenge, { userHandle: null });
    expect(await verify(assertion, { relyingParty: dev })).toEqual({ ok: true, signCount: 1 });
  });

  it("accepts DER signatures of every integer length the signer produces", async () => {
    // About half of ECDSA r and s values have the high bit set and need a leading zero in DER.
    for (let i = 0; i < 24; i += 1) {
      const assertion = await assert(auth, party, challenge);
      expect(await verify(assertion)).toEqual({ ok: true, signCount: 1 });
    }
  });

  it("refuses an assertion for another action, repository or challenge id", async () => {
    const assertion = await assert(auth, party, challenge);
    const others: ActionBinding[] = [
      { ...binding, action: { kind: "agent.confirm", agentId: "agt_atlas", code: "654321" } },
      { ...binding, action: { kind: "agent.revoke", agentId: "agt_atlas" } },
      { ...binding, repoId: "repo_other" },
      { ...binding, challengeId: "pkc_other" },
    ];
    for (const other of others) {
      expect(await verify(assertion, { binding: other })).toEqual(refused("challenge-mismatch"));
    }
  });

  it("refuses the wrong origin, a cross-origin call and an embedded call", async () => {
    const cases: AssertOptions[] = [
      { origin: "https://railhead.mashin.workers.dev" },
      { origin: "https://evil.railhead.dev" },
      { origin: "http://railhead.dev" },
      { origin: "https://railhead.dev:8443" },
      { extraClientData: { crossOrigin: true } },
      { extraClientData: { topOrigin: "https://evil.example" } },
    ];
    for (const options of cases) {
      const assertion = await assert(auth, party, challenge, options);
      expect(await verify(assertion)).toEqual(refused("origin-mismatch"));
    }
  });

  it("refuses authenticator data for another RP ID", async () => {
    for (const rpId of ["flareforge.dev", "railhead.mashin.workers.dev", "evil.railhead.dev"]) {
      const assertion = await assert(auth, party, challenge, { rpId });
      expect(await verify(assertion)).toEqual(refused("rp-mismatch"));
    }
  });

  it("refuses an assertion without user verification or without user presence", async () => {
    const presentOnly = await assert(auth, party, challenge, { flags: 0x01 });
    expect(await verify(presentOnly)).toEqual(refused("user-not-verified"));
    const verifiedOnly = await assert(auth, party, challenge, { flags: 0x04 });
    expect(await verify(verifiedOnly)).toEqual(refused("user-not-present"));
  });

  it("refuses a backed-up credential that is not backup eligible", async () => {
    const assertion = await assert(auth, party, challenge, { flags: 0x15 });
    expect(await verify(assertion)).toEqual(refused("backup-state-invalid"));
  });

  it("accepts every valid backup eligibility and backup state combination", async () => {
    for (const flags of [0x05, 0x0d, 0x1d]) {
      const assertion = await assert(auth, party, challenge, { flags });
      expect(await verify(assertion)).toEqual({ ok: true, signCount: 1 });
    }
  });

  it("refuses at and after expiry, and accepts one millisecond before", async () => {
    const assertion = await assert(auth, party, challenge);
    expect(await verify(assertion, { now: binding.expiresAt - 1 })).toEqual({
      ok: true,
      signCount: 1,
    });
    expect(await verify(assertion, { now: binding.expiresAt })).toEqual(refused("expired"));
    expect(await verify(assertion, { now: binding.expiresAt + 60_000 })).toEqual(
      refused("expired"),
    );
  });

  it("refuses a signature by another key and a signature over tampered data", async () => {
    const other = await newAuthenticator();
    const forged = await assert(auth, party, challenge, { signer: other.privateKey });
    expect(await verify(forged)).toEqual(refused("bad-signature"));

    const genuine = await assert(auth, party, challenge, { signCount: 1 });
    const authData = fromB64url(genuine.authenticatorData);
    authData[36] = 2;
    const tampered = { ...genuine, authenticatorData: b64url(authData) };
    expect(await verify(tampered)).toEqual(refused("bad-signature"));
  });

  it("refuses another credential id and a mismatched user handle", async () => {
    const assertion = await assert(auth, party, challenge);
    const otherId = { ...assertion, credentialId: b64url(new Uint8Array(16)) };
    expect(await verify(otherId)).toEqual(refused("unknown-credential"));
    const otherUser = await assert(auth, party, challenge, { userHandle: b64url(enc.encode("x")) });
    expect(await verify(otherUser)).toEqual(refused("user-mismatch"));
  });

  it("refuses a counter that does not advance, and accepts authenticators that never count", async () => {
    const counted = { ...auth.credential, signCount: 7 };
    for (const signCount of [7, 6, 0]) {
      const assertion = await assert(auth, party, challenge, { signCount });
      expect(await verify(assertion, { credential: counted })).toEqual(
        refused("counter-regressed"),
      );
    }
    const zero = await assert(auth, party, challenge, { signCount: 0 });
    expect(await verify(zero)).toEqual({ ok: true, signCount: 0 });
  });

  it("refuses a registration response and malformed client data", async () => {
    const create = await assert(auth, party, challenge, { type: "webauthn.create" });
    expect(await verify(create)).toEqual(refused("wrong-type"));

    const genuine = await assert(auth, party, challenge);
    const malformed: PasskeyAssertion[] = [
      { ...genuine, clientDataJson: b64url(enc.encode("not json")) },
      { ...genuine, clientDataJson: b64url(enc.encode("[]")) },
      { ...genuine, clientDataJson: b64url(Uint8Array.of(0xff, 0xfe)) },
      { ...genuine, clientDataJson: b64url(new Uint8Array(MAX_CLIENT_DATA_BYTES + 1)) },
      { ...genuine, clientDataJson: `${genuine.clientDataJson}=` },
      { ...genuine, authenticatorData: b64url(new Uint8Array(36)) },
      { ...genuine, signature: b64url(fromB64url(genuine.signature).subarray(1)) },
      { ...genuine, signature: b64url(new Uint8Array(64)) },
      { ...genuine, signature: "" },
      { ...genuine, signature: "!!" },
    ];
    for (const assertion of malformed) {
      expect(await verify(assertion)).toEqual(refused("malformed"));
    }
  });

  it("refuses a DER signature padded with an unneeded zero byte", async () => {
    const genuine = await assert(auth, party, challenge);
    const der = fromB64url(genuine.signature);
    const rLength = der[3] ?? 0;
    const r = der.subarray(4, 4 + rLength);
    const rest = der.subarray(4 + rLength);
    // Pad r with a zero byte when it does not need one, or a second one when it does.
    const padded = Uint8Array.from([0x02, rLength + 1, 0, ...r, ...rest]);
    const signature = b64url(Uint8Array.from([0x30, padded.length, ...padded]));
    expect(await verify({ ...genuine, signature })).toEqual(refused("malformed"));
  });

  it("refuses a relying party built outside relyingParty() and a bad stored binding", async () => {
    const assertion = await assert(auth, party, challenge);
    // The type admits pairing one instance's RP ID with the other's origin; the verifier does not.
    const mixed: RelyingParty = {
      rpId: "railhead.dev",
      origin: "https://railhead.mashin.workers.dev",
    };
    expect(await verify(assertion, { relyingParty: mixed })).toEqual(refused("invalid-binding"));
    expect(await verify(assertion, { binding: { ...binding, nonce: "" } })).toEqual(
      refused("invalid-binding"),
    );
  });

  it("reports an unusable stored key as a backend failure, not a proof failure", async () => {
    const assertion = await assert(auth, party, challenge);
    const notOnCurve = coseKey(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2));
    const truncated = auth.credential.publicKey.subarray(0, 40);
    for (const publicKey of [notOnCurve, truncated, new Uint8Array(0)]) {
      const result = await verify(assertion, { credential: { ...auth.credential, publicKey } });
      expect(result).toEqual(refused("credential-unusable"));
      if (!result.ok) expect(boardErrorFor(result.reason)).toBe("internal");
    }
  });
});

describe("boardErrorFor", () => {
  it("reports expiry as proof_expired and assertion failures as proof_invalid", () => {
    expect(boardErrorFor("expired")).toBe("proof_expired");
    expect(boardErrorFor("bad-signature")).toBe("proof_invalid");
    expect(boardErrorFor("origin-mismatch")).toBe("proof_invalid");
    expect(boardErrorFor("backup-state-invalid")).toBe("proof_invalid");
    expect(boardErrorFor("invalid-binding")).toBe("internal");
  });
});
