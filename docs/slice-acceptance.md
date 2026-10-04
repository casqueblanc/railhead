# Slice acceptance (A40)

A40 (#63) accepts the three-agent slice in two parts. The offline test shows the production modules are wired together in one Worker. The live gate shows the same flow on a deployed instance with real Artifacts, real Git and a real check. Only the live gate counts as qualification: nothing the offline test passes with is evidence about Artifacts, and the harness refuses a local or fake target.

## Offline: the assembled Worker

`packages/railhead-backend/__tests__/verticalSlice.test.ts` runs in workerd against the generated `wrangler.jsonc`:

```sh
pnpm --filter @railhead/backend test:run -- verticalSlice
```

Requests enter through the Worker's own entry and reach the real `Repo` binding, which composes every module from its production entry. Three agents join over `/join`, log in with SSHSIG challenges, take three issues into three forks and push through the Git gateway. Atlas readies first and lands alone; birch and cedar ready while atlas's check is pending and land together as one two-change batch. Each batch is composed on main, checked once on its exact candidate, authorized and moved by a compare-and-swap of main.

The other cases cover a check report for another candidate and a ready for a commit the fork lacks (both refused, nothing recorded), a foreign push that moves main before the landing (`train.main` reports `rejected` with the foreign commit, main is left alone), an update whose response is lost after it applied (settled from main's state with exactly one write), and a failed check (main does not move).

What is faked, in `__tests__/sliceWorld.ts`: Artifacts (`FakeArtifacts` for forks, `FakeMainRepo` for main's compare-and-swap as measured on #158), the Git endpoint, the sandbox container (it answers the merge script as Git would for a clean merge) and the check Workflow (the test reports each run through `Repo.reportCheck`, as the Workflow does). The owner's passkey is replaced by grants made inside the Repo; `ownerActions.test.ts` covers the passkey.

The test fails while any module it needs is still the unavailable stub, so it cannot pass on a partial composition.

## Live gate

The operator runs `scripts/qualify-slice.mjs` in three steps and keeps the two reports as the evidence. Run it from the repository root with the workspace installed (`pnpm install`).

### 1. Binding cases on a throwaway probe

The probe (`packages/railhead-backend/qualify/probe.ts`) is a separate Worker on its own Artifacts namespace. It imports the production main-ref adapter, so the main-ref cases exercise the code the main writer runs. It never touches Railhead's `railhead` namespace, and every repository it creates is deleted at the end of the run.

```sh
node scripts/qualify-slice.mjs probe-config --namespace railhead-qual --dir ~/railhead-qual-probe
pnpm exec wrangler deploy --config ~/railhead-qual-probe/wrangler.json --secrets-file ~/railhead-qual-probe/probe-secrets.json
CLOUDFLARE_API_TOKEN=<token> CLOUDFLARE_ACCOUNT_ID=<account id> \
  node scripts/qualify-slice.mjs binding --probe <probe URL> --secrets ~/railhead-qual-probe/probe-secrets.json --namespace railhead-qual --out binding.json
pnpm exec wrangler delete --config ~/railhead-qual-probe/wrangler.json
```

`probe-config` writes the Wrangler config and a random `PROBE_SECRET` (mode 600) and prints these commands; it deploys nothing. The deploy needs an API token with Workers Scripts edit and Artifacts write on the account. The `binding` run takes about three minutes and needs `git` on the path. It reads the REST token listing with `CLOUDFLARE_API_TOKEN`, which needs Artifacts read; the token is sent only to `api.cloudflare.com` and is not written to the report. Neither Wrangler nor the REST API deletes a namespace, so the empty `railhead-qual` namespace stays after the run.

### 2. The slice on the deployed instance

Deploy the qualification instance (docs/deploy.md), enrol the owner and three agents (H03), and file at least three issues. Each agent runs `rh work`, commits and pushes. Ready one agent first; while its check is running, ready the other two, so the train composes them into one batch. When both batches have landed, give the harness each agent's claim clone:

```sh
node scripts/qualify-slice.mjs slice --origin https://railhead.mashin.workers.dev --repo <org>/<name> \
  --clone <atlas clone> --clone <birch clone> --clone <cedar clone> --out slice.json
```

It reads the repository's public event log over the board session, runs `git ls-remote` in each clone through its `rh` credential helper, asks the helper for the first agent's session in memory, and sends three requests the instance must refuse. It writes nothing to the instance; the refused push names a branch, `qualify-denied`, that the instance never creates.

### 3. The gate

```sh
node scripts/qualify-slice.mjs gate binding.json slice.json
```

It exits 0 only when both reports are present and every check in both passed. Attach both reports to #63 or the H04 issue as the evidence.

## Checks

| Check                                           | Source    | Passes when                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slice.live`                                    | #63       | The origin is public HTTPS, not loopback, a private address or a reserved name.                                                                                                                                                                                                        |
| `slice.agents`                                  | #63       | Three clones are held by three distinct confirmed agents, each clone's `railhead.identity` matching its claim's holder in the log.                                                                                                                                                     |
| `slice.forks`                                   | #63       | The three clones name three distinct claims on the instance's origin, and each answers `git ls-remote`.                                                                                                                                                                                |
| `slice.batch`                                   | #63       | A `train.intent` of two or more claims has a passing `train.check` for its exact candidate and check run, a `train.main` updating main to that candidate, and a `claim.merged` at that commit for each claim. The report records the check run, candidate, expected main and new main. |
| `slice.main`                                    | #63       | Git reports main at the commit of the log's last landing.                                                                                                                                                                                                                              |
| `slice.no-token`                                | #63       | No Artifacts token (`art_v1_…`) appears in the event log, in any clone's Git files, `ls-remote` output or credential helper answer.                                                                                                                                                    |
| `slice.proxy-denial`                            | #63       | The instance refuses a push to main's remote (403) and a read of another agent's claim (403 or 404) with an agent's session, and an unauthenticated read (401).                                                                                                                        |
| `listing.live`                                  | #161      | The probe's repository is on a live Artifacts Git host.                                                                                                                                                                                                                                |
| `listing.page`                                  | #161      | With 31 live tokens the page holds 30 and `total` is 31.                                                                                                                                                                                                                               |
| `listing.order`                                 | #161      | The page is ordered by `createdAt`, newest first.                                                                                                                                                                                                                                      |
| `listing.revoked`                               | #161      | A revoked token is gone from the next listing and from `total`.                                                                                                                                                                                                                        |
| `listing.expired`                               | #161      | A 60-second token is gone from a listing taken after its `expiresAt`.                                                                                                                                                                                                                  |
| `listing.no-options`                            | #161      | `listTokens` called with paging or state options returns the plain listing.                                                                                                                                                                                                            |
| `listing.rest-active`                           | #161      | The binding's `total` equals the REST route's `state=active` `total_count`.                                                                                                                                                                                                            |
| `main.live`                                     | #158      | The probe's main is on a live Artifacts Git host.                                                                                                                                                                                                                                      |
| `main.refuses-rewind`, `main.refuses-unrelated` | #158      | The adapter refuses a `next` that does not descend from `expected` before minting a token; main and the token list are unchanged.                                                                                                                                                      |
| `main.updates`                                  | #158      | A forward update applies and leaves no live write token.                                                                                                                                                                                                                               |
| `main.compare-and-swap`                         | #158      | An update from a stale expected commit is `rejected` with main's actual commit, and main is unchanged.                                                                                                                                                                                 |
| `main.lost-response`                            | #63, #158 | An update whose answer is lost after it applied is `uncertain`, main shows the new commit, and resending it gets `stale ref`.                                                                                                                                                          |
| `main.race`                                     | #158      | Of several concurrent raw updates from one commit, exactly one lands and the rest get `stale ref`.                                                                                                                                                                                     |
| `main.refuses-foreign-token`                    | #158      | While another write token on main is live, the adapter refuses to update.                                                                                                                                                                                                              |
| `main.detects-foreign-push`                     | #158      | After another token force-pushes main, the adapter's next update is `rejected` with the pushed commit, without a retry.                                                                                                                                                                |
| `main.revoke-fence`                             | #158      | An update whose body completes after its token was revoked does not apply.                                                                                                                                                                                                             |
| `main.eviction`                                 | #158      | A Durable Object evicted with an adapter update in flight leaves main unchanged and no live write token once the token's lifetime has passed.                                                                                                                                          |

A failed `listing.*` check means the token bound (`MAX_LIVE_FORK_TOKENS`, `TOKEN_PAGE_SIZE`) must be re-qualified before release and takeover rely on it. A failed `main.*` check means main's ref no longer holds a guarantee the main writer depends on.

## Known gaps

- The `cf.artifacts.repo.pushed` event is not qualified here. It needs a Queue and an event subscription on the account, and nothing in Railhead relies on it (#158's adopted spec, rule 5).
- Sandbox outbound denial (a check command reaching Artifacts or the internet directly) is covered by the sandbox gateway's workerd tests, not by this harness.
