import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type {
  ActionChallenge,
  EnrollmentChallenge,
} from "../../packages/railhead-shared/src/board-api.ts";
import {
  actionChallenge,
  enroll as enrollOn,
  isRecord,
  relyingParty,
  verifyActionAssertion,
  type Enrolled,
} from "./backendVerifier.ts";
import { keyHost, OwnerKeyRefusal, register, sign, type SignedChallenge } from "./ownerKey.ts";

const HOST = "railhead.mashin.workers.dev";
const scratch = mkdtempSync(join(tmpdir(), "railhead-owner-key-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let files = 0;
function keyPath(): string {
  files += 1;
  return join(scratch, `owner-${files}.json`);
}

function enrollment(rpId = HOST): EnrollmentChallenge {
  return {
    challengeId: "enr_1",
    challenge: randomBytes(32).toString("base64url"),
    rpId,
    userHandle: randomBytes(16).toString("base64url"),
    expiresAt: Date.now() + 60_000,
  };
}

/** A binding the backend would store, and the challenge `prepare` would return for it. */
async function prepare(
  credentialId: string,
  rpId = HOST,
): Promise<{ binding: Record<string, unknown>; challenge: ActionChallenge }> {
  const binding = {
    repoId: "rep_demo",
    challengeId: `oc_${randomBytes(4).toString("hex")}`,
    nonce: randomBytes(16).toString("base64url"),
    expiresAt: Date.now() + 60_000,
    action: { kind: "demo.reset" },
  };
  const computed = await actionChallenge(await relyingParty(HOST), binding);
  assert.ok(isRecord(computed) && typeof computed.challenge === "string");
  return {
    binding,
    challenge: {
      challengeId: binding.challengeId,
      challenge: computed.challenge,
      rpId,
      allowCredentials: [credentialId],
      expiresAt: binding.expiresAt,
    },
  };
}

async function verify(
  credential: Enrolled,
  binding: Record<string, unknown>,
  signed: SignedChallenge,
): Promise<unknown> {
  return verifyActionAssertion({
    relyingParty: await relyingParty(HOST),
    binding,
    credential,
    assertion: signed.assertion,
    now: Date.now(),
  });
}

function enroll(path: string): Promise<Enrolled> {
  return enrollOn(path, enrollment());
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** Signs `challenge` with `path` in a separate node process. */
function signInChild(path: string, challenge: ActionChallenge): SignedChallenge {
  const script = `import { sign } from ${JSON.stringify(new URL("./ownerKey.ts", import.meta.url).href)};
process.stdout.write(JSON.stringify(sign(process.argv[1], JSON.parse(process.argv[2]))));`;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script, path, JSON.stringify(challenge)],
    { encoding: "utf8" },
  );
  assert.equal(child.status, 0, child.stderr);
  const parsed: unknown = JSON.parse(child.stdout);
  assert.ok(isRecord(parsed) && isRecord(parsed.assertion));
  const { credentialId, clientDataJson, authenticatorData, signature, userHandle } =
    parsed.assertion;
  assert.ok(
    typeof parsed.challengeId === "string" &&
      typeof credentialId === "string" &&
      typeof clientDataJson === "string" &&
      typeof authenticatorData === "string" &&
      typeof signature === "string" &&
      typeof userHandle === "string",
  );
  return {
    challengeId: parsed.challengeId,
    assertion: { credentialId, clientDataJson, authenticatorData, signature, userHandle },
  };
}

test("the backend's verifier accepts the key's registration and its assertion", async () => {
  const path = keyPath();
  const credential = await enroll(path);
  assert.equal(fileMode(path), 0o600);
  assert.equal(keyHost(path), HOST);

  const { binding, challenge } = await prepare(credential.credentialId);
  const signed = sign(path, challenge);
  assert.equal(signed.challengeId, challenge.challengeId);
  const clientData: unknown = JSON.parse(
    Buffer.from(signed.assertion.clientDataJson, "base64url").toString("utf8"),
  );
  assert.deepEqual(clientData, {
    type: "webauthn.get",
    challenge: challenge.challenge,
    origin: `https://${HOST}`,
    crossOrigin: false,
  });
  assert.deepEqual(await verify(credential, binding, signed), { ok: true, signCount: 1 });

  // The same assertion over another action's challenge is refused there.
  const other = await prepare(credential.credentialId);
  assert.deepEqual(await verify({ ...credential, signCount: 1 }, other.binding, signed), {
    ok: false,
    reason: "challenge-mismatch",
  });
});

test("the counter advances on every signature, across processes", async () => {
  const path = keyPath();
  const enrolled = await enroll(path);
  let credential = enrolled;
  for (const expected of [1, 2, 3]) {
    const { binding, challenge } = await prepare(enrolled.credentialId);
    // The third signature is made by another process reading the same file.
    const signed = expected === 3 ? signInChild(path, challenge) : sign(path, challenge);
    assert.deepEqual(await verify(credential, binding, signed), { ok: true, signCount: expected });
    credential = { ...credential, signCount: expected };
  }
  const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(isRecord(stored));
  assert.equal(stored.signCount, 3);
  assert.equal(fileMode(path), 0o600);
  // Each write renamed its temporary file over the key; none is left beside it.
  assert.deepEqual(
    readdirSync(scratch).filter((name) => name.endsWith(".tmp")),
    [],
  );

  // A signature from a copy of the key file taken before the counter advanced is refused.
  const stale = keyPath();
  writeFileSync(stale, JSON.stringify({ ...stored, signCount: 1 }), { mode: 0o600 });
  const { binding, challenge } = await prepare(enrolled.credentialId);
  assert.deepEqual(await verify(credential, binding, sign(stale, challenge)), {
    ok: false,
    reason: "counter-regressed",
  });
});

test("a challenge for another host or credential is refused and the counter is kept", async () => {
  const path = keyPath();
  const { credentialId } = await enroll(path);
  const before = readFileSync(path, "utf8");

  const { challenge } = await prepare(credentialId, "railhead.example.workers.dev");
  assert.throws(() => sign(path, challenge), OwnerKeyRefusal);
  assert.throws(() => sign(path, { ...challenge, rpId: "railhead.dev" }), /signs only for/);
  const forOther = (await prepare(randomBytes(16).toString("base64url"))).challenge;
  assert.throws(() => sign(path, forOther), /does not allow the credential/);
  assert.throws(
    () => sign(path, { ...forOther, allowCredentials: [credentialId], challenge: "" }),
    /not base64url/,
  );
  assert.equal(readFileSync(path, "utf8"), before);
});

test("a railhead.dev key is refused at enrollment and when signing", async () => {
  for (const host of ["railhead.dev", "board.railhead.dev"]) {
    const path = keyPath();
    assert.throws(() => register(path, enrollment(host)), /never acts on/);
    assert.equal(existsSync(path), false);
  }
  assert.throws(() => register(keyPath(), enrollment("Railhead.Dev")), /not a relying-party host/);

  // A qualification key edited to name railhead.dev signs nothing, even its own challenge.
  const path = keyPath();
  const { credentialId } = await enroll(path);
  const stored: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(isRecord(stored));
  writeFileSync(path, JSON.stringify({ ...stored, rpId: "railhead.dev" }));
  const { challenge } = await prepare(credentialId, "railhead.dev");
  assert.throws(() => sign(path, challenge), /never acts on railhead\.dev/);
  assert.throws(() => keyHost(path), /never acts on railhead\.dev/);
});

test("an unreadable, group-readable, missing or malformed key file is refused", async () => {
  const path = keyPath();
  const { credentialId } = await enroll(path);
  const { challenge } = await prepare(credentialId);
  const before = readFileSync(path, "utf8");

  chmodSync(path, 0o640);
  assert.throws(() => sign(path, challenge), /readable by others/);
  chmodSync(path, 0o604);
  assert.throws(() => sign(path, challenge), /readable by others/);
  chmodSync(path, 0o000);
  assert.throws(() => sign(path, challenge), /not a readable key file/);
  chmodSync(path, 0o600);
  assert.equal(readFileSync(path, "utf8"), before);

  assert.throws(() => sign(join(scratch, "missing.json"), challenge), /not a readable key file/);
  const malformed = keyPath();
  for (const contents of [
    "not json",
    "[]",
    JSON.stringify({ ...JSON.parse(before), version: 2 }),
    JSON.stringify({ ...JSON.parse(before), signCount: -1 }),
    JSON.stringify({ ...JSON.parse(before), privateKey: { kty: "EC", crv: "P-384" } }),
  ]) {
    writeFileSync(malformed, contents, { mode: 0o600 });
    assert.throws(() => sign(malformed, challenge), /is not a key file/);
  }
  const notOnCurve: unknown = JSON.parse(before);
  assert.ok(isRecord(notOnCurve) && isRecord(notOnCurve.privateKey));
  writeFileSync(
    malformed,
    JSON.stringify({ ...notOnCurve, privateKey: { ...notOnCurve.privateKey, x: "AAAA" } }),
    { mode: 0o600 },
  );
  assert.throws(() => sign(malformed, challenge), /usable P-256 key/);
});

test("enrollment never overwrites a key and never writes inside a Git checkout", () => {
  const path = keyPath();
  register(path, enrollment());
  const before = readFileSync(path, "utf8");
  assert.throws(() => register(path, enrollment()), /already exists/);
  assert.equal(readFileSync(path, "utf8"), before);

  const checkout = join(scratch, "checkout");
  const inside = join(checkout, "nested", "owner.json");
  mkdirSync(join(checkout, "nested"), { recursive: true });
  mkdirSync(join(checkout, ".git"));
  assert.throws(() => register(inside, enrollment()), /inside the Git checkout/);
  assert.equal(existsSync(inside), false);
  assert.throws(
    () => register(join(scratch, "absent", "owner.json"), enrollment()),
    /does not exist/,
  );
  assert.throws(
    () => register(keyPath(), { ...enrollment(), userHandle: "not base64url!" }),
    /must be base64url/,
  );
});
