import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { describe, test } from "node:test";
import { RefusedDestination, destinationProblem, sendToInstance } from "./request.ts";

const ORIGIN = "https://railhead.mashin.workers.dev";
const CLAIM = `${ORIGIN}/git/acme/upload-app/claims/clm_aaaaaa.git/info/refs`;

/** A `fetch` that records what it was asked to send and answers with `answer`. */
function recorder(answer: () => Response) {
  const sent: { url: string; init: RequestInit | undefined }[] = [];
  const send: typeof fetch = async (input, init) => {
    sent.push({ url: String(input), init });
    return answer();
  };
  return { sent, send };
}

describe("destinationProblem", () => {
  test("accepts an HTTPS URL on the instance's origin", () => {
    assert.equal(destinationProblem(ORIGIN, CLAIM), null);
    assert.equal(destinationProblem(`${ORIGIN}/`, `${ORIGIN}/git/acme/upload-app.git`), null);
  });

  test("refuses another host, plain HTTP, another port and credentials in the URL", () => {
    for (const url of [
      "https://attacker.dev/git/acme/upload-app/claims/clm_aaaaaa.git/info/refs",
      "https://railhead.mashin.workers.dev.attacker.dev/git",
      CLAIM.replace("https:", "http:"),
      CLAIM.replace(".dev/", ".dev:8443/"),
      CLAIM.replace("https://", "https://agent:secret@"),
      "not a url",
    ]) {
      assert.notEqual(destinationProblem(ORIGIN, url), null, url);
    }
  });

  test("refuses every URL when the instance origin itself is not live", () => {
    assert.match(
      destinationProblem("http://localhost:8787", "http://localhost:8787/git") ?? "",
      /instance origin/,
    );
  });
});

describe("sendToInstance", () => {
  test("sends to the instance with redirects refused and returns its answer", async () => {
    const { sent, send } = recorder(() => new Response("denied", { status: 403 }));
    const response = await sendToInstance(
      ORIGIN,
      CLAIM,
      { headers: { authorization: "Basic x" } },
      send,
    );
    assert.equal(response.status, 403);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.url, CLAIM);
    assert.equal(sent[0]?.init?.redirect, "manual");
  });

  test("sends nothing to a clone remote on another host", async () => {
    const { sent, send } = recorder(() => new Response(null, { status: 200 }));
    await assert.rejects(
      sendToInstance(
        ORIGIN,
        "https://attacker.dev/git/acme/upload-app/claims/clm_bbbbbb.git/info/refs",
        { headers: { authorization: "Basic x" } },
        send,
      ),
      (error) => error instanceof RefusedDestination && /another host/.test(error.message),
    );
    assert.deepEqual(sent, []);
  });

  test("refuses a redirect instead of following it", async () => {
    const { sent, send } = recorder(
      () => new Response(null, { status: 302, headers: { location: "https://attacker.dev/x" } }),
    );
    await assert.rejects(
      sendToInstance(ORIGIN, CLAIM, { headers: { authorization: "Basic x" } }, send),
      (error) => error instanceof RefusedDestination && /redirect \(HTTP 302\)/.test(error.message),
    );
    assert.equal(sent.length, 1);
  });

  test("with Node's fetch, a redirect's target never receives the request", async () => {
    const seen: string[] = [];
    const server = createServer((request: IncomingMessage, response) => {
      seen.push(`${request.url} ${request.headers.authorization ?? "none"}`);
      if (request.url === "/start") {
        response.writeHead(307, { location: "/elsewhere" }).end();
      } else {
        response.writeHead(200).end("followed");
      }
    });
    await new Promise<void>((listening) => server.listen(0, "127.0.0.1", listening));
    const address = server.address();
    assert.ok(typeof address === "object" && address !== null);
    const { port } = address;
    try {
      // The destination check passes on the instance's URL; the request is then served locally.
      const local: typeof fetch = (_input, init) => fetch(`http://127.0.0.1:${port}/start`, init);
      await assert.rejects(
        sendToInstance(ORIGIN, CLAIM, { headers: { authorization: "Basic x" } }, local),
        (error) => error instanceof RefusedDestination && /HTTP 307/.test(error.message),
      );
      assert.deepEqual(seen, ["/start Basic x"]);
    } finally {
      await new Promise((closed) => server.close(closed));
    }
  });
});
