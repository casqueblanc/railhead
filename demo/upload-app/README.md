# Upload demo app

The app Railhead's demo agents work on: an upload page and a Worker that stores each file in its own SQLite-backed Durable Object, in rows of 1 MiB. The open decision is what happens to files above 10 MB (10,000,000 bytes).

| Option         | Status                                   | Acceptance (`acceptance/checks.ts`)                                                                                                                       |
| -------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A, reject (v1) | Implemented                              | An 11 MB upload returns 413 with `{"error":"Files above 10 MB are not accepted"}`; a 9 MB upload returns 201 and reads back byte for byte after a restart |
| B, chunk (v2)  | Not implemented; left to the demo agents | An 11 MB file sent in parts reads back byte for byte after a restart; a 9 MB upload still succeeds in one request                                         |

## Interface

- `GET /`: the upload page.
- `POST /api/uploads`: the file as the request body. 201 with `{ "id", "size", "sha256" }`; 413 above 10 MB; 400 when empty.
- `GET /api/uploads/<id>`: the stored bytes, with `x-upload-size` and `x-upload-sha256`.

Option B's suite expects these routes, which do not exist yet:

- `POST /api/uploads/chunked` with `{ "size", "sha256" }`: 201 with `{ "id", "partSize" }`, where `partSize` is at most 10 MB.
- `PUT /api/uploads/chunked/<id>/parts/<index>`: one part, indexes from 0; any 2xx.
- `POST /api/uploads/chunked/<id>/complete`: 201 with `{ "id", "size" }`; the file then reads back from `GET /api/uploads/<id>`.

## Checks

`acceptance/checks.json` tags each suite with its decision option and the decision version that chose it, and names the option in force. The train reads it from main, never from the candidate.

`pnpm --filter @railhead/demo-upload-app test:run` runs the fixture's own tests and the current option's suite. `UPLOAD_ACCEPTANCE=b@2` runs option B's suite instead; a selection that names no tagged suite stops the run before any test starts. The 9 and 11 MB bodies are generated when the tests run, from fixed seeds, and never committed.

`__tests__/suites.test.ts` judges the suites themselves: option B's fails on the current app, passes on an in-memory double of B, and catches a changed byte, a missing part and a file lost on restart.

After changing `wrangler.jsonc`, run `pnpm --filter @railhead/demo-upload-app types:generate`.
