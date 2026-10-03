# Deploying Railhead for qualification

The **Deploy** workflow (`.github/workflows/deploy.yml`) deploys the `railhead` Worker to its workers.dev host. It exists to qualify Railhead against real Cloudflare services, such as Artifacts, before any demo: there is no custom domain and no demo enrollment. Secrets live in GitHub and reach the Worker only at deploy time, so nobody pastes one into a terminal.

The workflow runs only when started by hand. CI's **Build and test** job instead dry-runs the same deploy on each pull request that changes its inputs (`scripts/ci-changes.mjs`), with placeholder secrets: it builds the board, the Worker bundle, its config and the sandbox image, and uploads nothing.

## Secrets

Set these in the repository's `qualification` environment (**Settings → Environments → qualification → Environment secrets**). The workflow fails before deploying when any of them is missing or empty, or when a Worker secret is shorter than the Worker accepts, and names each such secret.

| Secret                   | What it is                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`   | The API token Wrangler deploys with (permissions below).                                                                                                            |
| `CLOUDFLARE_ACCOUNT_ID`  | The Cloudflare account that holds the Worker. Wrangler deploys to it, and it is also a Worker secret: check sandboxes fetch from that account's Artifacts Git host. |
| `SESSION_SIGNING_SECRET` | Worker secret: at least 32 random characters. Agent login keys derive from it; replacing it ends every session.                                                     |
| `OWNER_BOOTSTRAP_TOKEN`  | Worker secret: at least 32 characters. The one-time token that opens enrollment of the first owner passkey.                                                         |

The Worker secrets are exactly the `secrets.required` list in `packages/railhead-backend/cloudflare.config.ts`. A secret added there must also be added to the environment and to the deploy step's `env` in the workflow; until it is, the deploy fails naming it, and CI's dry run fails until its placeholder is added too.

They are uploaded with the new version through `wrangler deploy --secrets-file`, not set afterwards with `wrangler secret bulk`: Wrangler refuses to create a Worker whose required secrets are not supplied in the same deploy. The file is written with mode 600 under the runner's temporary directory and deleted when the job ends, whether it succeeded or not.

### API token permissions

Create an account API token for the account above with:

- Workers Scripts: Edit
- Containers: Edit
- Artifacts, with write access
- Workers R2 Storage: Edit

The deploy also creates what the config declares and the account does not have yet. The sandbox container application and the `railhead-checks` Workflow come with the Worker. For the `railhead-check-backups` R2 bucket, Wrangler 4.145's deploy creates a bucket with that name when none exists; that reading comes from Wrangler's source, not from a deploy run. Which token permission the Workflow needs has not been checked.

If the token lacks a permission, the deploy step fails with Cloudflare's error for the request that needed it.

## Running a deploy

1. Open **Actions → Deploy → Run workflow**.
2. Enter the Git ref to deploy: a branch, tag or commit SHA. It defaults to `main`, and must resolve to a commit on main's history. Any other commit fails before its code runs: the deploy step hands that code the secrets, and the environment's branch rules only see the ref the workflow was started from, not this input.
3. If the `qualification` environment has required reviewers, a reviewer approves the run.

The job checks that the generated `wrangler.jsonc` matches `cloudflare.config.ts`, builds the board, then runs `wrangler deploy`, which builds and pushes the sandbox image with the runner's Docker. Its summary shows the deployed version ID and URL, and the run links the URL from the environment.

Only one deploy runs at a time, and a running one is never cancelled. GitHub keeps at most one more run waiting; starting another replaces the waiting one.

## Rolling back

To return to an earlier commit of main, run the workflow again with that commit's SHA as the ref. Commits from before this workflow landed lack `scripts/write-worker-secrets.mjs`; the run refuses them before deploying, so use a version rollback for those. This rebuilds and redeploys it through the same checks.

To return to an earlier Worker version without rebuilding, use **Workers & Pages → railhead → Deployments** in the dashboard, or, logged in to the account, from `packages/railhead-backend`:

```sh
pnpm exec wrangler deployments list
pnpm exec wrangler rollback <version-id> --message "<reason>"
```
