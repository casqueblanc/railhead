// Checks that a deployed demo app runs an exact main commit, then records how it answers 9 MB and
// 11 MB uploads at that commit. Run by the operator after deploying; see
// docs/demo-app-deployment.md.
//
//   node scripts/verify-app-revision.mjs --url <app origin> --expect <main sha> --option <A|B> [--out <file>]
//
// The app's GET /api/revision must report `--expect` before any upload is sent and again after the
// last one, so every observation belongs to that commit. A different, missing or `unknown` revision
// fails without uploading anything. Option A expects 11 MB refused with 413; option B expects it
// accepted in parts. Both expect 9 MB accepted in one request and read back byte for byte.
//
// The record is printed as JSON and, with `--out`, written to that file. Exit codes: 0 every check
// held, 1 a check failed or the app could not be reached, 2 the arguments are invalid. Uploaded
// bytes are random and never logged; only sizes, statuses and SHA-256 digests are recorded.

import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const MB = 1_000_000;
const TOO_LARGE_MESSAGE = "Files above 10 MB are not accepted";
const SHA = /^[0-9a-f]{40}$/;
const UPLOAD_ID = /^[A-Za-z0-9-]{1,128}$/;
const REVISION_TIMEOUT_MS = 10_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const OPTIONS = ["A", "B"];

/** A check that did not hold. The message names what was observed, never the bytes. */
class CheckFailed extends Error {
  name = "CheckFailed";
}

const usage =
  "usage: node scripts/verify-app-revision.mjs --url <app origin> --expect <40-hex main sha> --option <A|B> [--out <file>]";

/** Parses and validates the command line, or returns the reason it is unusable. */
const parseCommandLine = (argv) => {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        url: { type: "string" },
        expect: { type: "string" },
        option: { type: "string" },
        out: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    return { kind: "invalid", reason: error instanceof Error ? error.message : String(error) };
  }
  if (values.url === undefined || values.expect === undefined || values.option === undefined) {
    return { kind: "invalid", reason: "--url, --expect and --option are required." };
  }
  let origin;
  try {
    const url = new URL(values.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { kind: "invalid", reason: "--url must be an http or https URL." };
    }
    origin = url.origin;
  } catch {
    return { kind: "invalid", reason: "--url is not a URL." };
  }
  if (!SHA.test(values.expect)) {
    return {
      kind: "invalid",
      reason: "--expect must be a full 40-character lowercase commit SHA.",
    };
  }
  if (!OPTIONS.includes(values.option)) {
    return { kind: "invalid", reason: "--option must be A or B." };
  }
  return {
    kind: "valid",
    origin,
    expected: values.expect,
    option: values.option,
    out: values.out,
  };
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const request = async (origin, path, init, timeoutMs) => {
  try {
    return await fetch(new URL(path, origin), {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown error";
    throw new CheckFailed(`${init?.method ?? "GET"} ${path} failed: ${reason}.`);
  }
};

const readJson = async (response, what) => {
  let body;
  try {
    body = await response.json();
  } catch {
    throw new CheckFailed(`${what} did not return JSON (status ${response.status}).`);
  }
  if (!isRecord(body)) throw new CheckFailed(`${what} did not return a JSON object.`);
  return body;
};

/** The revision the app reports, or a failure when it reports none. */
const readRevision = async (origin) => {
  const response = await request(origin, "/api/revision", { method: "GET" }, REVISION_TIMEOUT_MS);
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new CheckFailed(`GET /api/revision returned ${response.status}, not 200.`);
  }
  const { revision } = await readJson(response, "GET /api/revision");
  if (typeof revision !== "string") throw new CheckFailed("GET /api/revision named no revision.");
  return revision;
};

const uploadId = (body, what) => {
  if (typeof body.id !== "string" || !UPLOAD_ID.test(body.id)) {
    throw new CheckFailed(`${what} returned no usable upload id.`);
  }
  return body.id;
};

/**
 * Reads upload `id` back and compares its digest with the bytes sent. The body is hashed as it
 * arrives and never held whole: more bytes than were sent fail at once, so an oversized or endless
 * answer cannot exhaust memory. A body that breaks off or outlasts the timeout is a failed check.
 */
const readBack = async (origin, id, sent) => {
  const response = await request(
    origin,
    `/api/uploads/${encodeURIComponent(id)}`,
    { method: "GET" },
    UPLOAD_TIMEOUT_MS,
  );
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new CheckFailed(`Reading upload ${id} back returned ${response.status}.`);
  }
  if (response.body === null) throw new CheckFailed(`Reading upload ${id} back returned no body.`);
  const hash = createHash("sha256");
  let received = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > sent.byteLength) {
        throw new CheckFailed(
          `Upload ${id} read back as more than the ${sent.byteLength} bytes sent.`,
        );
      }
      hash.update(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof CheckFailed) throw error;
    const reason = error instanceof Error ? error.name : "unknown error";
    throw new CheckFailed(
      `Reading upload ${id} back broke off after ${received} bytes: ${reason}.`,
    );
  }
  const storedSha = hash.digest("hex");
  if (received !== sent.byteLength || storedSha !== sha256(sent)) {
    throw new CheckFailed(
      `Upload ${id} read back as ${received} bytes with SHA-256 ${storedSha}, ` +
        `not the ${sent.byteLength} bytes sent.`,
    );
  }
  return storedSha;
};

const nineInOneRequest = async (origin) => {
  const body = randomBytes(9 * MB);
  const response = await request(
    origin,
    "/api/uploads",
    { method: "POST", headers: { "content-type": "application/octet-stream" }, body },
    UPLOAD_TIMEOUT_MS,
  );
  if (response.status !== 201) {
    await response.body?.cancel();
    throw new CheckFailed(`A 9 MB upload returned ${response.status}, not 201.`);
  }
  const id = uploadId(await readJson(response, "The 9 MB upload"), "The 9 MB upload");
  return `201; read back intact (${body.byteLength} bytes, SHA-256 ${await readBack(origin, id, body)})`;
};

const elevenRejected = async (origin) => {
  const response = await request(
    origin,
    "/api/uploads",
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: randomBytes(11 * MB),
    },
    UPLOAD_TIMEOUT_MS,
  );
  if (response.status !== 413) {
    await response.body?.cancel();
    throw new CheckFailed(`An 11 MB upload returned ${response.status}, not 413.`);
  }
  const { error } = await readJson(response, "The 413 response");
  if (error !== TOO_LARGE_MESSAGE) {
    throw new CheckFailed(`The 413 response says ${JSON.stringify(error)}.`);
  }
  return `413 ${JSON.stringify(TOO_LARGE_MESSAGE)}`;
};

const elevenInParts = async (origin) => {
  const body = randomBytes(11 * MB);
  const start = await request(
    origin,
    "/api/uploads/chunked",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ size: body.byteLength, sha256: sha256(body) }),
    },
    UPLOAD_TIMEOUT_MS,
  );
  if (start.status !== 201) {
    await start.body?.cancel();
    throw new CheckFailed(`POST /api/uploads/chunked returned ${start.status}, not 201.`);
  }
  const session = await readJson(start, "Starting a chunked upload");
  const id = uploadId(session, "Starting a chunked upload");
  const { partSize } = session;
  if (!Number.isSafeInteger(partSize) || partSize <= 0 || partSize > 10 * MB) {
    throw new CheckFailed(
      "Starting a chunked upload returned no partSize between 1 byte and 10 MB.",
    );
  }
  const parts = Math.ceil(body.byteLength / partSize);
  for (let index = 0; index < parts; index += 1) {
    const response = await request(
      origin,
      `/api/uploads/chunked/${encodeURIComponent(id)}/parts/${index}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: body.subarray(index * partSize, (index + 1) * partSize),
      },
      UPLOAD_TIMEOUT_MS,
    );
    await response.body?.cancel();
    if (!response.ok) {
      throw new CheckFailed(`Sending part ${index} of ${parts} returned ${response.status}.`);
    }
  }
  const complete = await request(
    origin,
    `/api/uploads/chunked/${encodeURIComponent(id)}/complete`,
    { method: "POST" },
    UPLOAD_TIMEOUT_MS,
  );
  if (complete.status !== 201) {
    await complete.body?.cancel();
    throw new CheckFailed(`Completing the chunked upload returned ${complete.status}, not 201.`);
  }
  const stored = uploadId(
    await readJson(complete, "Completing the chunked upload"),
    "Completing the chunked upload",
  );
  const digest = await readBack(origin, stored, body);
  return `201 in ${parts} parts; read back intact (${body.byteLength} bytes, SHA-256 ${digest})`;
};

/** Runs one check. Any error is its failure, recorded rather than thrown, so the record is kept. */
const observe = async (name, check) => {
  try {
    return { name, ok: true, observed: await check() };
  } catch (error) {
    return { name, ok: false, observed: failureReason(error) };
  }
};

/** A failure's message when it is a {@link CheckFailed}; otherwise only the error's type. */
const failureReason = (error) =>
  error instanceof CheckFailed
    ? error.message
    : `Failed unexpectedly: ${error instanceof Error ? error.name : "unknown error"}.`;

/** Runs every check against `origin` and returns the record. Never throws: a failure is recorded. */
const verify = async ({ origin, expected, option }) => {
  const record = {
    app: origin,
    option,
    expectedRevision: expected,
    observedAt: new Date().toISOString(),
    revisionBefore: null,
    revisionAfter: null,
    observations: [],
    result: "fail",
    reason: null,
  };
  try {
    record.revisionBefore = await readRevision(origin);
  } catch (error) {
    record.reason = failureReason(error);
    return record;
  }
  if (record.revisionBefore !== expected) {
    record.reason = `The app reports revision ${record.revisionBefore}, not ${expected}. Nothing was uploaded.`;
    return record;
  }
  record.observations.push(await observe("9 MB in one request", () => nineInOneRequest(origin)));
  record.observations.push(
    option === "A"
      ? await observe("11 MB in one request", () => elevenRejected(origin))
      : await observe("11 MB in parts", () => elevenInParts(origin)),
  );
  try {
    record.revisionAfter = await readRevision(origin);
  } catch (error) {
    record.reason = `After the uploads: ${failureReason(error)}`;
    return record;
  }
  if (record.revisionAfter !== expected) {
    record.reason = `The app changed to revision ${record.revisionAfter} during the checks, so the observations are not bound to ${expected}.`;
    return record;
  }
  const failed = record.observations.filter((o) => !o.ok).map((o) => o.name);
  if (failed.length > 0) {
    record.reason = `Option ${option} does not hold at ${expected}: ${failed.join(", ")}.`;
    return record;
  }
  record.result = "pass";
  return record;
};

const command = parseCommandLine(process.argv.slice(2));
if (command.kind === "invalid") {
  process.stderr.write(`verify-app-revision: ${command.reason}\n${usage}\n`);
  process.exit(2);
}
const record = await verify(command);
const text = `${JSON.stringify(record, null, 2)}\n`;
process.stdout.write(text);
if (command.out !== undefined) writeFileSync(command.out, text);
if (record.result !== "pass") {
  process.stderr.write(`verify-app-revision: ${record.reason}\n`);
  process.exit(1);
}
