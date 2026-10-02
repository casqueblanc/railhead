/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import agentPub from "../../../fixtures/auth/agent.pub?raw";
import challenge from "../../../fixtures/auth/challenge.txt?raw";
import codeVectors from "../../../fixtures/auth/confirmation-code.txt?raw";
import otherKeySig from "../../../fixtures/auth/other-key.sig?raw";
import otherPub from "../../../fixtures/auth/other.pub?raw";
import rustSig from "../../../fixtures/auth/rust.sig?raw";
import keygenSha256Sig from "../../../fixtures/auth/ssh-keygen-sha256.sig?raw";
import keygenSig from "../../../fixtures/auth/ssh-keygen.sig?raw";
import wrongNamespaceSig from "../../../fixtures/auth/wrong-namespace.sig?raw";
import {
  confirmationCode,
  type Ed25519PublicKey,
  MAX_INVITE_ID,
  MAX_SSHSIG_MESSAGE,
  MAX_SSHSIG_TEXT,
  parsePublicKey,
  SSHSIG_NAMESPACE,
  verifySshSig,
} from "../src/auth/sshsig";

const message = new TextEncoder().encode(challenge);
const enc = new TextEncoder();

function key(line: string): Ed25519PublicKey {
  const parsed = parsePublicKey(line);
  if (parsed === undefined) throw new Error("fixture key did not parse");
  return parsed;
}

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

function str(bytes: Uint8Array): Uint8Array {
  return Uint8Array.of(...u32(bytes.length), ...bytes);
}

function armor(bytes: Uint8Array): string {
  const body = btoa(String.fromCharCode(...bytes));
  return [
    "-----BEGIN SSH SIGNATURE-----",
    ...(body.match(/.{1,70}/g) ?? []),
    "-----END SSH SIGNATURE-----",
  ].join("\n");
}

function unarmor(armored: string): Uint8Array {
  const lines = armored.trim().split("\n");
  return Uint8Array.from(atob(lines.slice(1, -1).join("")), (c) => c.charCodeAt(0));
}

interface Fields {
  magic: Uint8Array;
  version: number;
  publicKey: Uint8Array;
  namespace: Uint8Array;
  reserved: Uint8Array;
  hashAlgorithm: Uint8Array;
  signature: Uint8Array;
}

/** Splits an armored fixture into its SSHSIG fields, trusting the fixture's framing. */
function fields(armored: string): Fields {
  const bytes = unarmor(armored);
  const view = new DataView(bytes.buffer);
  let offset = 6;
  const next = (): Uint8Array => {
    const length = view.getUint32(offset, false);
    const out = bytes.slice(offset + 4, offset + 4 + length);
    offset += 4 + length;
    return out;
  };
  const magic = bytes.slice(0, 6);
  const version = view.getUint32(offset, false);
  offset += 4;
  return {
    magic,
    version,
    publicKey: next(),
    namespace: next(),
    reserved: next(),
    hashAlgorithm: next(),
    signature: next(),
  };
}

/** Re-encodes `armored` after `edit` changes some of its fields; `extra` bytes go at the end. */
function rebuild(
  armored: string,
  edit: (f: Fields) => Partial<Fields>,
  extra = new Uint8Array(),
): string {
  const f = { ...fields(armored), ...edit(fields(armored)) };
  return armor(
    Uint8Array.of(
      ...f.magic,
      ...u32(f.version),
      ...str(f.publicKey),
      ...str(f.namespace),
      ...str(f.reserved),
      ...str(f.hashAlgorithm),
      ...str(f.signature),
      ...extra,
    ),
  );
}

describe("verifySshSig", () => {
  it("accepts the signature made by the Rust signer", async () => {
    await expect(verifySshSig(agentPub, rustSig, message)).resolves.toEqual({ ok: true });
  });

  it("accepts ssh-keygen -Y sign signatures with sha512 and sha256", async () => {
    await expect(verifySshSig(agentPub, keygenSig, message)).resolves.toEqual({ ok: true });
    await expect(verifySshSig(agentPub, keygenSha256Sig, message)).resolves.toEqual({ ok: true });
  });

  it("accepts CRLF armor and a key line with a comment", async () => {
    const crlf = rustSig.replaceAll("\n", "\r\n");
    await expect(verifySshSig(`${agentPub.trim()} agent@host`, crlf, message)).resolves.toEqual({
      ok: true,
    });
  });

  it("rejects the git namespace", async () => {
    expect(new TextDecoder().decode(fields(wrongNamespaceSig).namespace)).toBe("git");
    await expect(verifySshSig(agentPub, wrongNamespaceSig, message)).resolves.toEqual({
      ok: false,
      reason: "namespace-mismatch",
    });
  });

  it("rejects a signature relabelled into the reserved namespace", async () => {
    const relabelled = rebuild(wrongNamespaceSig, () => ({
      namespace: enc.encode(SSHSIG_NAMESPACE),
    }));
    await expect(verifySshSig(agentPub, relabelled, message)).resolves.toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects an altered message", async () => {
    const altered = enc.encode(challenge.replace("3q2", "3q3"));
    await expect(verifySshSig(agentPub, rustSig, altered)).resolves.toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects a signature by a different key", async () => {
    await expect(verifySshSig(agentPub, otherKeySig, message)).resolves.toEqual({
      ok: false,
      reason: "key-mismatch",
    });
    await expect(verifySshSig(otherPub, rustSig, message)).resolves.toEqual({
      ok: false,
      reason: "key-mismatch",
    });
  });

  it("rejects another key's signature whose embedded key was swapped for the expected one", async () => {
    const swapped = rebuild(otherKeySig, () => ({ publicKey: key(agentPub).blob }));
    await expect(verifySshSig(agentPub, swapped, message)).resolves.toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects an unsupported hash algorithm", async () => {
    const sha384 = rebuild(rustSig, () => ({ hashAlgorithm: enc.encode("sha384") }));
    await expect(verifySshSig(agentPub, sha384, message)).resolves.toEqual({
      ok: false,
      reason: "unsupported-algorithm",
    });
  });

  it("rejects malformed signatures", async () => {
    const sigBlob = fields(rustSig).signature;
    const malformed: unknown[] = [
      "",
      "not a signature",
      rustSig.replace("BEGIN SSH SIGNATURE", "BEGIN PGP SIGNATURE"),
      rebuild(rustSig, () => ({}), Uint8Array.of(0)), // trailing byte after the signature
      armor(unarmor(rustSig).subarray(0, -1)), // truncated
      rebuild(rustSig, () => ({ magic: enc.encode("SSHSIH") })),
      rebuild(rustSig, () => ({ version: 2 })),
      rebuild(rustSig, () => ({ reserved: Uint8Array.of(1) })),
      rebuild(rustSig, () => ({ signature: sigBlob.subarray(0, -1) })), // 63-byte Ed25519 signature
      rebuild(rustSig, () => ({ signature: Uint8Array.of(...sigBlob, 0) })), // trailing byte in blob
      rebuild(rustSig, () => ({ namespace: Uint8Array.of(0xff) })), // invalid UTF-8
      rustSig.replace(/\n(.)/, "\n!"), // invalid base64
      rustSig.replace("\nU1NI", "\nU1NI "), // whitespace atob tolerates: non-canonical base64
      42,
      null,
      undefined,
    ];
    for (const sig of malformed) {
      await expect(verifySshSig(agentPub, sig, message)).resolves.toEqual({
        ok: false,
        reason: "malformed-signature",
      });
    }
  });

  it("rejects malformed public keys", async () => {
    const [, data] = agentPub.trim().split(" ");
    const malformed: unknown[] = [
      "",
      `ssh-rsa ${data}`,
      "ssh-ed25519",
      "ssh-ed25519 !!!notbase64",
      `ssh-ed25519 ${btoa("short")}`,
      // A well-formed blob holding a 31-byte key.
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAHwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      undefined,
      {},
    ];
    for (const candidate of malformed) {
      await expect(verifySshSig(candidate, rustSig, message)).resolves.toEqual({
        ok: false,
        reason: "malformed-public-key",
      });
    }
  });

  it("bounds the signature text at MAX_SSHSIG_TEXT", async () => {
    const atLimit = rustSig.padEnd(MAX_SSHSIG_TEXT, " ");
    await expect(verifySshSig(agentPub, atLimit, message)).resolves.toEqual({ ok: true });
    await expect(verifySshSig(agentPub, `${atLimit} `, message)).resolves.toEqual({
      ok: false,
      reason: "malformed-signature",
    });
  });

  it("bounds the public key line at MAX_SSHSIG_TEXT", async () => {
    const atLimit = `${agentPub.trim()} `.padEnd(MAX_SSHSIG_TEXT, "c");
    await expect(verifySshSig(atLimit, rustSig, message)).resolves.toEqual({ ok: true });
    await expect(verifySshSig(`${atLimit}c`, rustSig, message)).resolves.toEqual({
      ok: false,
      reason: "malformed-public-key",
    });
  });

  it("bounds the message at MAX_SSHSIG_MESSAGE", async () => {
    // At the limit the message is checked cryptographically; one byte over is refused unread.
    await expect(
      verifySshSig(agentPub, rustSig, new Uint8Array(MAX_SSHSIG_MESSAGE)),
    ).resolves.toEqual({ ok: false, reason: "bad-signature" });
    await expect(
      verifySshSig(agentPub, rustSig, new Uint8Array(MAX_SSHSIG_MESSAGE + 1)),
    ).resolves.toEqual({ ok: false, reason: "malformed-message" });
  });
});

describe("parsePublicKey", () => {
  it("returns the wire blob and raw key", () => {
    const parsed = key(agentPub);
    expect(parsed.raw).toHaveLength(32);
    expect(parsed.blob).toHaveLength(4 + 11 + 4 + 32);
    expect(fields(rustSig).publicKey).toEqual(parsed.blob);
  });

  it("returns undefined for a non-string", () => {
    expect(parsePublicKey(7)).toBeUndefined();
  });
});

describe("confirmationCode", () => {
  const vectors = codeVectors
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const [code, invite, ...rest] = line.split(" ");
      return { code, invite: invite ?? "", line: rest.join(" ") };
    });

  it("matches every shared vector", async () => {
    expect(vectors.length).toBeGreaterThanOrEqual(4);
    for (const { code, invite, line } of vectors) {
      await expect(confirmationCode(key(line), invite)).resolves.toBe(code);
    }
  });

  it("changes with the invite and the key", async () => {
    const agent = key(agentPub);
    const base = await confirmationCode(agent, "inv_fixture_0001");
    expect(base).toMatch(/^\d{6}$/);
    await expect(confirmationCode(agent, "inv_fixture_0002")).resolves.not.toBe(base);
    await expect(confirmationCode(key(otherPub), "inv_fixture_0001")).resolves.not.toBe(base);
  });

  it("bounds the invite identifier at MAX_INVITE_ID bytes", async () => {
    const agent = key(agentPub);
    await expect(confirmationCode(agent, "a".repeat(MAX_INVITE_ID))).resolves.toMatch(/^\d{6}$/);
    await expect(confirmationCode(agent, "a".repeat(MAX_INVITE_ID + 1))).resolves.toBeUndefined();
    // The bound counts UTF-8 bytes, not characters.
    await expect(
      confirmationCode(agent, "é".repeat(MAX_INVITE_ID / 2 + 1)),
    ).resolves.toBeUndefined();
  });
});

describe("fixtures", () => {
  it("contain no private key material", () => {
    const files = import.meta.glob("../../../fixtures/auth/*", {
      query: "?raw",
      import: "default",
      eager: true,
    });
    const contents = Object.values(files);
    expect(contents.length).toBeGreaterThanOrEqual(10);
    for (const text of contents) {
      expect(typeof text).toBe("string");
      expect(String(text)).not.toMatch(/PRIVATE KEY/);
    }
  });
});
