import { MAX_UPLOAD_BYTES, PART_BYTES, TOO_LARGE_MESSAGE } from "./limits";

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^\d{1,16}$/;

/** A JSON error response with `{ "error": message }`. */
export function errorResponse(status: number, message: string, headers?: HeadersInit): Response {
  return Response.json({ error: message }, { status, ...(headers ? { headers } : {}) });
}

function hex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Option A: stores a file sent as one request body of at most {@link MAX_UPLOAD_BYTES}. A declared
 * length above the limit is refused before the body is read; an undeclared one is refused as soon
 * as the streamed bytes pass it, and the rows already written are deleted.
 */
export async function receiveUpload(request: Request, env: Env): Promise<Response> {
  const declaredHeader = request.headers.get("content-length");
  let declared: number | null = null;
  if (declaredHeader !== null) {
    if (!DECIMAL.test(declaredHeader)) return errorResponse(400, "Invalid Content-Length.");
    declared = Number(declaredHeader);
    if (declared > MAX_UPLOAD_BYTES) return errorResponse(413, TOO_LARGE_MESSAGE);
  }
  if (request.body === null || declared === 0) return errorResponse(400, "The file is empty.");

  const id = crypto.randomUUID();
  const store = env.UPLOADS.get(env.UPLOADS.idFromName(id));
  const digest = new crypto.DigestStream("SHA-256");
  const digestWriter = digest.getWriter();
  const reader = request.body.getReader();
  let buffer = new Uint8Array(PART_BYTES);
  let buffered = 0;
  let parts = 0;
  let total = 0;

  const flush = async () => {
    if (buffered === 0) return;
    await store.putPart(parts, buffer.subarray(0, buffered));
    parts += 1;
    buffer = new Uint8Array(PART_BYTES);
    buffered = 0;
  };
  const abandon = async () => {
    await reader.cancel();
    if (parts > 0) await store.discard();
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_UPLOAD_BYTES) {
        await abandon();
        return errorResponse(413, TOO_LARGE_MESSAGE);
      }
      await digestWriter.write(value);
      let offset = 0;
      while (offset < value.byteLength) {
        const take = Math.min(PART_BYTES - buffered, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + take), buffered);
        buffered += take;
        offset += take;
        if (buffered === PART_BYTES) await flush();
      }
    }
    if (total === 0) return errorResponse(400, "The file is empty.");
    await flush();
    await digestWriter.close();
    const sha256 = hex(await digest.digest);
    const stored = await store.commit(total, sha256);
    return Response.json({ id, size: stored.size, sha256: stored.sha256 }, { status: 201 });
  } catch (error) {
    // Remove partial rows, then let the caller report the original failure, together with the
    // cleanup failure when the rows could not be removed.
    await abandon().catch((cleanup: unknown) => {
      throw new AggregateError([error, cleanup], "The upload failed and was not cleaned up.", {
        cause: error,
      });
    });
    throw error;
  }
}

/** Streams a committed upload back, one stored row at a time. */
export async function readUpload(id: string, env: Env): Promise<Response> {
  if (!UPLOAD_ID.test(id)) return errorResponse(400, "Invalid upload id.");
  const store = env.UPLOADS.get(env.UPLOADS.idFromName(id));
  const upload = await store.describe();
  if (upload === null) return errorResponse(404, "No such upload.");
  let next = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (next >= upload.parts) {
        controller.close();
        return;
      }
      controller.enqueue(await store.readPart(next));
      next += 1;
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/octet-stream",
      "x-upload-size": String(upload.size),
      "x-upload-sha256": upload.sha256,
    },
  });
}
