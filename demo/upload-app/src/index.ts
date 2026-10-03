import { PAGE_HTML } from "./page";
import { errorResponse, readUpload, receiveUpload } from "./uploads";

export { UploadStore } from "./store";

const UPLOAD_PATH = /^\/api\/uploads\/([^/]+)$/;

/** The preflight answer for `POST /api/uploads` from another origin. */
const UPLOAD_PREFLIGHT = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "600",
};

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/") {
    if (request.method !== "GET") {
      return errorResponse(405, "Method not allowed.", { allow: "GET" });
    }
    return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (pathname === "/api/revision") {
    if (request.method !== "GET") {
      return errorResponse(405, "Method not allowed.", { allow: "GET" });
    }
    // Any origin may read it: the board shows it beside main to mark a stale deployment.
    return Response.json(
      { revision: env.APP_REVISION },
      { headers: { "access-control-allow-origin": "*", "cache-control": "no-store" } },
    );
  }
  if (pathname === "/api/uploads") {
    // The board embeds this page in a sandboxed frame with an opaque origin, so the page's own
    // upload arrives cross-origin with `Origin: null`. Uploading is open to anyone already and
    // carries no credentials, so any origin may send one and read the answer.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: UPLOAD_PREFLIGHT });
    }
    if (request.method !== "POST") {
      return errorResponse(405, "Method not allowed.", { allow: "POST" });
    }
    const response = await receiveUpload(request, env);
    const headers = new Headers(response.headers);
    headers.set("access-control-allow-origin", "*");
    return new Response(response.body, { status: response.status, headers });
  }
  const match = UPLOAD_PATH.exec(pathname);
  if (match?.[1] !== undefined) {
    if (request.method !== "GET") {
      return errorResponse(405, "Method not allowed.", { allow: "GET" });
    }
    return readUpload(match[1], env);
  }
  return errorResponse(404, "Not found.");
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (error) {
      // Only the error's type and message: request bodies are never logged.
      console.error(
        JSON.stringify({
          event: "upload.error",
          error: error instanceof Error ? error.name : "unknown",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return errorResponse(500, "The upload failed.");
    }
  },
} satisfies ExportedHandler<Env>;
