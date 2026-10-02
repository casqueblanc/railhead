import type { UploadTarget } from "../acceptance/checks";

/** How a fake app misbehaves, so the suites can be shown to catch it. */
export type Fault = "none" | "corrupt-byte" | "drop-last-part" | "forget-on-restart";

/**
 * An in-memory app implementing option B's chunked protocol and one-request uploads of any size.
 * It is a test double for the acceptance suites, not an implementation of B.
 */
export function fakeChunkedApp(fault: Fault = "none", partSize = 4_000_000): UploadTarget {
  let files = new Map<string, Uint8Array>();
  const sessions = new Map<string, { size: number; parts: Map<number, Uint8Array> }>();
  let next = 0;
  const newId = () => `fake-${(next += 1)}`;

  const store = (bytes: Uint8Array): string => {
    const id = newId();
    const copy = bytes.slice();
    if (fault === "corrupt-byte" && copy.byteLength > 0) {
      const middle = Math.floor(copy.byteLength / 2);
      copy[middle] = (copy[middle] ?? 0) ^ 0xff;
    }
    files.set(id, copy);
    return id;
  };

  return {
    async fetch(path, init) {
      const method = init?.method ?? "GET";
      const body =
        init?.body === undefined ? new Uint8Array() : await new Response(init.body).bytes();
      if (method === "POST" && path === "/api/uploads") {
        return Response.json({ id: store(body), size: body.byteLength }, { status: 201 });
      }
      if (method === "POST" && path === "/api/uploads/chunked") {
        const request: unknown = JSON.parse(new TextDecoder().decode(body));
        const size =
          typeof request === "object" && request !== null && "size" in request
            ? Number(request.size)
            : NaN;
        const id = newId();
        sessions.set(id, { size, parts: new Map() });
        return Response.json({ id, partSize }, { status: 201 });
      }
      const part = /^\/api\/uploads\/chunked\/([^/]+)\/parts\/(\d+)$/.exec(path);
      if (method === "PUT" && part?.[1] !== undefined && part[2] !== undefined) {
        const session = sessions.get(part[1]);
        if (session === undefined) return new Response(null, { status: 404 });
        session.parts.set(Number(part[2]), body);
        return new Response(null, { status: 204 });
      }
      const complete = /^\/api\/uploads\/chunked\/([^/]+)\/complete$/.exec(path);
      if (method === "POST" && complete?.[1] !== undefined) {
        const session = sessions.get(complete[1]);
        if (session === undefined) return new Response(null, { status: 404 });
        const ordered = [...session.parts.entries()]
          .toSorted(([a], [b]) => a - b)
          .map(([, b]) => b);
        if (fault === "drop-last-part") ordered.pop();
        const joined = new Uint8Array(await new Blob(ordered).arrayBuffer());
        const id = store(joined);
        // Reports the declared size, as a careless implementation might.
        return Response.json({ id, size: session.size }, { status: 201 });
      }
      const read = /^\/api\/uploads\/([^/]+)$/.exec(path);
      if (method === "GET" && read?.[1] !== undefined) {
        const file = files.get(decodeURIComponent(read[1]));
        return file === undefined ? new Response(null, { status: 404 }) : new Response(file);
      }
      return new Response(null, { status: 404 });
    },
    async restart() {
      if (fault === "forget-on-restart") files = new Map();
    },
  };
}

/** An app that answers every one-request upload with `status` and `body`. */
export function fixedResponseApp(status: number, body: unknown): UploadTarget {
  return {
    fetch: async () => Response.json(body, { status }),
    restart: async () => {},
  };
}
