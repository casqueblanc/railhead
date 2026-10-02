import { PAGE_HTML } from "./page";
import { errorResponse, readUpload, receiveUpload } from "./uploads";

export { UploadStore } from "./store";

const UPLOAD_PATH = /^\/api\/uploads\/([^/]+)$/;

async function route(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/") {
    if (request.method !== "GET") {
      return errorResponse(405, "Method not allowed.", { allow: "GET" });
    }
    return new Response(PAGE_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (pathname === "/api/uploads") {
    if (request.method !== "POST") {
      return errorResponse(405, "Method not allowed.", { allow: "POST" });
    }
    return receiveUpload(request, env);
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
