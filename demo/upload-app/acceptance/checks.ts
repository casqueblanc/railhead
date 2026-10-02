/**
 * The acceptance checks for each option of the upload-size decision, written against the app's
 * HTTP interface so they run unchanged against the Worker, a deployed app or a test double. The
 * expected statuses, paths and message are spelled out here, from the decision, rather than
 * imported from the app: a check must not move when the code it judges moves.
 */
import { firstDifference, generateBody, sha256Hex } from "./bodies";

/** What a check exercises: HTTP requests, and a restart of whatever holds the stored files. */
export interface UploadTarget {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Drops in-memory state so a later read must come from durable storage. */
  restart(): Promise<void>;
}

/** A check found the app does not behave as its option requires. */
export class AcceptanceFailure extends Error {
  override name = "AcceptanceFailure";
}

const MB = 1_000_000;
const TOO_LARGE_MESSAGE = "Files above 10 MB are not accepted";

function fail(message: string): never {
  throw new AcceptanceFailure(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    fail(`${what} did not return JSON (status ${response.status}).`);
  }
  if (!isRecord(body)) fail(`${what} did not return a JSON object.`);
  return body;
}

function uploadId(body: Record<string, unknown>, what: string): string {
  const { id } = body;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(id)) {
    fail(`${what} returned no usable upload id.`);
  }
  return id;
}

/**
 * Reads upload `id` back after a restart and compares it with `expected` byte for byte, so a pass
 * means the file was stored durably and intact.
 */
export async function verifyStored(
  target: UploadTarget,
  id: string,
  expected: Uint8Array,
): Promise<void> {
  await target.restart();
  const response = await target.fetch(`/api/uploads/${encodeURIComponent(id)}`);
  if (response.status !== 200) fail(`Reading upload ${id} back returned ${response.status}.`);
  const stored = new Uint8Array(await response.arrayBuffer());
  const at = firstDifference(stored, expected);
  if (at !== -1) {
    fail(
      `The stored file differs from the original at byte ${at} ` +
        `(stored ${stored.byteLength} bytes, sent ${expected.byteLength}).`,
    );
  }
}

/** Sends `body` as one request and returns the stored upload's id, failing unless it is stored. */
async function uploadInOneRequest(target: UploadTarget, body: Uint8Array): Promise<string> {
  const response = await target.fetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
  if (response.status !== 201) {
    fail(`A ${body.byteLength}-byte upload in one request returned ${response.status}, not 201.`);
  }
  const result = await json(response, "The upload");
  if (result.size !== body.byteLength) {
    fail(`The upload reported size ${String(result.size)}, not ${body.byteLength}.`);
  }
  return uploadId(result, "The upload");
}

/** A and B: a 9 MB file is accepted in one request and stored intact. */
export async function checkNineMegabytesInOneRequest(target: UploadTarget): Promise<void> {
  const body = generateBody(9 * MB, 9);
  const id = await uploadInOneRequest(target, body);
  await verifyStored(target, id, body);
}

/** A: an 11 MB file is refused with 413 and the exact message. */
export async function checkElevenMegabytesRejected(target: UploadTarget): Promise<void> {
  const response = await target.fetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: generateBody(11 * MB, 11),
  });
  if (response.status !== 413) {
    fail(`An 11 MB upload returned ${response.status}, not 413.`);
  }
  const result = await json(response, "The 413 response");
  if (result.error !== TOO_LARGE_MESSAGE) {
    fail(
      `The 413 response says ${JSON.stringify(result.error)}, not ${JSON.stringify(TOO_LARGE_MESSAGE)}.`,
    );
  }
}

/**
 * B: an 11 MB file is accepted in parts and the reassembled file matches the original.
 *
 * The protocol: `POST /api/uploads/chunked` with `{ "size": n }` returns 201 and
 * `{ "id", "partSize" }`; each part `i` is sent as `PUT /api/uploads/chunked/<id>/parts/<i>`; then
 * `POST /api/uploads/chunked/<id>/complete` returns 201 and `{ "id", "size" }`, and the file reads
 * back from `GET /api/uploads/<id>`.
 */
export async function checkElevenMegabytesInParts(target: UploadTarget): Promise<void> {
  const body = generateBody(11 * MB, 12);
  const start = await target.fetch("/api/uploads/chunked", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ size: body.byteLength, sha256: await sha256Hex(body) }),
  });
  if (start.status !== 201) {
    fail(
      `Chunked uploads are not supported: POST /api/uploads/chunked returned ${start.status}, not 201.`,
    );
  }
  const session = await json(start, "Starting a chunked upload");
  const id = uploadId(session, "Starting a chunked upload");
  const { partSize } = session;
  if (
    typeof partSize !== "number" ||
    !Number.isSafeInteger(partSize) ||
    partSize <= 0 ||
    partSize > 10 * MB
  ) {
    fail("Starting a chunked upload returned no partSize between 1 byte and 10 MB.");
  }
  const parts = Math.ceil(body.byteLength / partSize);
  if (parts < 2) fail(`An 11 MB file was not split: the server asked for ${parts} part.`);

  for (let index = 0; index < parts; index += 1) {
    const part = body.subarray(index * partSize, (index + 1) * partSize);
    const response = await target.fetch(
      `/api/uploads/chunked/${encodeURIComponent(id)}/parts/${index}`,
      { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: part },
    );
    if (!response.ok) fail(`Sending part ${index} of ${parts} returned ${response.status}.`);
    await response.body?.cancel();
  }

  const complete = await target.fetch(`/api/uploads/chunked/${encodeURIComponent(id)}/complete`, {
    method: "POST",
  });
  if (complete.status !== 201) {
    fail(`Completing the chunked upload returned ${complete.status}, not 201.`);
  }
  const result = await json(complete, "Completing the chunked upload");
  if (result.size !== body.byteLength) {
    fail(`The chunked upload reported size ${String(result.size)}, not ${body.byteLength}.`);
  }
  await verifyStored(target, uploadId(result, "Completing the chunked upload"), body);
}
