# Deploying the demo app

The upload demo app (`demo/upload-app`) is deployed by the instance owner, by hand, as its own Worker. Railhead never deploys it and holds no binding, token or secret for it. This page is the procedure for H05 (option A) and H06 (option B, once it lands).

The deployed app reports the main commit it was built from at `GET /api/revision`. The board's **Demo app** section compares that with main as the train last read it, and marks the deployment **Stale deployment** when they differ. `scripts/verify-app-revision.mjs` checks the same revision, refuses to continue on any other one, and records how the app answers 9 MB and 11 MB uploads at that commit.

## What the app holds

Its `wrangler.jsonc` declares the `UPLOADS` Durable Object and one plain-text var, `APP_REVISION`, which defaults to `unknown`. Nothing else. Do not add a secret, a service binding to Railhead, or any Railhead token to it: the app's code is written by agents and its revision route is readable from any origin.

## Deploy a landed commit

1. Wait until the change has landed: the board's **Train** section shows it as landed and **Main** shows the commit.
2. Clone the demo app's repository, `demo/upload-app` (see [demo-seed.md](demo-seed.md)), from Railhead with stock Git. Its main is the landed commit. Confirm the tree is clean and the commit is main on the board:

   ```sh
   git clone https://<railhead host>/git/demo/upload-app.git demo-app
   cd demo-app
   git rev-parse HEAD            # must equal main on the board
   git status --porcelain        # must print nothing
   ```

3. Install the app's own pinned tools and deploy, logged in to the owner's Cloudflare account, passing the commit as `APP_REVISION`:

   ```sh
   pnpm install --frozen-lockfile
   SHA=$(git rev-parse HEAD)
   pnpm exec wrangler deploy --var APP_REVISION:$SHA
   ```

   Deploying without `--var` leaves the revision `unknown`; the board then says **Revision not reported** and the check below fails.

4. Note the URL Wrangler prints, such as `https://railhead-demo-upload.<account subdomain>.workers.dev`.

## Verify and record

From a Railhead checkout, with `SHA` still set:

```sh
node scripts/verify-app-revision.mjs \
  --url https://railhead-demo-upload.<account subdomain>.workers.dev \
  --expect $SHA --option A --out h05-app-A.json
```

Use `--option B` for H06. The script:

- reads `/api/revision` and exits 1, uploading nothing, unless it is exactly `--expect`;
- uploads 9 MB in one request and reads it back, comparing SHA-256;
- for A, sends 11 MB in one request and expects 413 with `Files above 10 MB are not accepted`; for B, sends 11 MB through the chunked routes and reads it back;
- reads `/api/revision` again and fails if the deployment changed during the run.

It prints the record as JSON and writes it to `--out`. Exit 0 means every check held; 1 means one failed or the app could not be reached; 2 means the arguments are invalid. Keep the file with the run's evidence.

Running it with the previous commit's SHA after a new deploy, or the new SHA against an app not yet redeployed, must exit 1. That is the check that the app on screen is the landed commit.

## Show the app on the board

The board reads the app's URL when it is built, from `VITE_DEMO_APP_URL`:

```sh
VITE_DEMO_APP_URL=https://railhead-demo-upload.<account subdomain>.workers.dev pnpm build
```

Then deploy Railhead as usual. A board built without it says **No app configured**; one whose URL is the board's own origin is refused, since the embed lets the app run scripts. The section embeds the app and checks its revision every 30 seconds and whenever main moves, so a redeploy shows without a reload.

## What this does not prove

The board badge and this script observe the deployed app. Neither records adaptation: that is A41's acceptance check on the landed commit for the current decision version. The script reads files back without restarting the app's Durable Objects, so unlike the acceptance suite it does not prove the bytes survived an eviction.
