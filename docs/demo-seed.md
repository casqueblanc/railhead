# Demo seed and reset

The demo runs on one Railhead repository, `demo/upload-app`: the repository the board opens by default. It holds the full history of [`demo/upload-app`](../demo/upload-app) as its main, and three issues for three agents. `fixtures/demo/seed.json` describes it; `scripts/demoSeed/` plans and checks it.

```sh
node scripts/demoSeed/cli.ts seed --dry-run      # every target the seed writes
node scripts/demoSeed/cli.ts reset --dry-run     # the one repository reset deletes
node scripts/demoSeed/cli.ts bundle --out main.bundle
```

`--revision` picks the source commit (default `HEAD`); the manifest is read from that commit's `fixtures/demo/seed.json`. `--manifest FILE` is an explicit override that reads a manifest from disk instead. `--org` and `--repo` are accepted only as `demo` and `upload-app`; any other repository is refused before anything is planned, and so is a manifest that names one. Reset reads neither the manifest nor the revision: it deletes `demo/upload-app` by name, so a commit whose manifest or acceptance checks are inconsistent cannot block the way back to a clean instance.

## What the seed holds

**Main.** Every commit of this repository that changed `demo/upload-app`, rewritten with that directory as the root, then one commit, `chore: make the app a standalone repository`. Each commit keeps its subject and dates, and the last one takes the dates of the newest commit that changed the directory or a file the overlay copies, so a commit elsewhere in this repository does not change the head; author and committer are `Railhead demo <demo@railhead.dev>`. A commit that deleted the directory becomes a commit with an empty tree, and a revision at which the directory does not exist is refused. The same revision always produces the same head, so a repeated seed recognises a main it already imported, and reset followed by seed lands on the same base. A shallow clone is refused, because it would import a truncated history. Everything is read from the selected commit, including the manifest and the acceptance checks it is validated against, unless `--manifest` overrides the manifest; uncommitted changes never reach the bundle or its validation. The rewrite runs in a scratch repository and writes nothing to this one. It ignores the caller's global and system Git config and inherited `GIT_*` settings, so a setting such as `log.showSignature` cannot change the head.

**Standing alone.** In this monorepo the app takes its versions from the pnpm catalog, its compiler options from the root `tsconfig.json` and its workerd assertion from `@railhead/scripts`. The last commit replaces them, as listed in `scripts/demoSeed/standalone.ts`: `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json` and `vitest.config.ts` from `fixtures/demo/standalone/`, `assert-workerd.ts` from `scripts/`, and `.node-version`; it removes the Vite+ `vite.config.ts`. A clone then runs `pnpm install --frozen-lockfile`, `pnpm run typecheck` and `pnpm run test:run` with nothing else. `standalone.test.ts` fails when these files drift from the catalog or the app's own config. After changing the app's dependencies, update `fixtures/demo/standalone/package.json` then run `pnpm install --lockfile-only` in that directory, which is its own pnpm workspace, to refresh its lockfile from the versions the root install put in the store: `pnpm install --lockfile-only --prefer-offline`, after a root `pnpm install`. The bundle's install test runs offline from that store, so `standalone.test.ts` also fails when the standalone lockfile resolves a package the root lockfile does not lock at the same version and integrity.

**Issues.** Three tasks, matched by title when the seed reconciles:

| Issue                                             | Touches                                                 | Decision    |
| ------------------------------------------------- | ------------------------------------------------------- | ----------- |
| Warn before uploading a file above the size limit | `src/page.ts`, `src/limits.ts`                          | collides    |
| Let people upload files larger than 10 MB         | `src/uploads.ts`, `src/limits.ts`, `src/store.ts`       | collides    |
| Let people delete an upload                       | `src/index.ts`, `src/store.ts`, `__tests__/app.test.ts` | independent |

**The decision.** `upload-size-limit`: what happens to an upload above 10 MB, option `a` (reject with 413, as the app does) or `b` (accept it in parts). Its scope is `src/limits.ts` and `src/uploads.ts`. The seed does not open it: an agent opens it by asking the question while working on one of the first two issues, and the owner answers on the board.

## The decision collision is intentional

Two agents on separate issues reach the same open decision. That is what the demo exists to show: the warning and the large-upload support both depend on the answer, so one answer must reach both agents through their inboxes, and changing it later (`a` to `b`) must reach both again, superseding what each built on the old version. The third issue is independent, so one agent keeps working while the other two wait on the decision.

The manifest check enforces this shape: exactly three issues, exactly two touching the decision's scope, and a decision whose key and options match the tagged suites in the app's `acceptance/checks.json` one for one, which the train runs for the option in force. Every path in the decision's scope, in each issue's `touches` and in each `checks.json` suite must exist in the app at the selected commit, so a renamed file refuses the seed instead of leaving a collision that only the manifest shows, or an option with no suite to run once the decision chooses it. A task touching a directory collides with a scope path inside it, and a scope directory with a task path inside it. The decision must also pass the agent wire's `ask` rules, lowercase option keys included, since an agent opens it by asking; `manifest.test.ts` checks the restated rules against `@railhead/shared` and the `ask` wire fixture.

## Repeatable seed, safe reset

Seed and reset reconcile against a target through the `SeedTarget` port in `scripts/demoSeed/reconcile.ts`. The port has the shape of the backend's `DemoSeedApi` ([#149](https://github.com/casqueblanc/railhead/pull/149)): `read` returns the repository's main or nothing, `seed` imports main and then initializes the repository, and `reset` deletes it.

- Seed reads the target, then seeds only when the repository is missing. A second seed writes nothing.
- `seed` receives the bundle's bytes and the head it was approved for, the input `demo.seed` takes. The bundle carries `refs/heads/main` alone, with no prerequisites, and at most 8 MiB; `seed --dry-run` builds the same bundle in scratch, so it refuses a revision whose bundle is larger. The repository is initialized only after main is in place, so a seed that fails after importing main leaves that main behind a repository `read` does not report. A repeat at the same head completes it; a seed at another head is refused as `action_stale` until a reset. Main is only ever created: a repeat at the same head succeeds without writing, so a seed whose response was lost is safe to run again.
- Seed refuses, writing nothing, when main already holds another head, when the repository exists without a main (a reset that did not finish; the backend answers `action_stale`). Reset first. A seeded title with a different body is not a refusal: the plan marks that issue `edit`, and the owner edits its body on the board. Nor is a seeded title the board shows more than once, for example an issue filed again after its response was lost: the plan marks it `dup` with the count, and the owner closes the extra copies so each task is open once.
- Each backend write needs its own owner passkey assertion. The live target holds it; the port does not carry one.
- `DemoSeedApi` has no issue read, so issues are read through a second port, `BoardIssues`; the live target reads them from the demo repository's board log. Filing an issue is an owner action on the board, so neither port can file one. The plan lists each seeded issue as done when the board shows its title and body, `edit` when it shows the title with another body, `dup` when it shows the title more than once, and an owner step to file otherwise. After the plan, `seed --dry-run` prints the exact title and body of every issue still to file or edit as plain text between `--- issue` marker lines, paragraph breaks as blank lines.
- Other issues are left alone.
- The port takes no lock: run one seed at a time.
- Reset deletes `demo/upload-app` by name. It never lists repositories to choose what to delete, so no other repository can go with it. Reset always calls the target, because `read` cannot see a main left by a failed seed; the target reports whether anything was deleted.

The tests in `scripts/demoSeed/` run these rules against an in-memory target, alongside other repositories that must survive a reset.

## Running it live

`scripts/demoSeed/liveTarget.ts` implements both ports against a deployed Railhead: `SeedTarget` through `DemoSeedApi` ([#149](https://github.com/casqueblanc/railhead/pull/149)) and `BoardIssues` by paging the demo repository's board log, over one Cap'n Web session at `ORIGIN/api`. `--target ORIGIN` selects it. The origin must be `https://`, or `http://` on `localhost` for `pnpm dev-server`; anything else is refused before a session opens.

```sh
node scripts/demoSeed/cli.ts seed --dry-run --target https://railhead.dev   # plan against the instance
node scripts/demoSeed/cli.ts seed --target https://railhead.dev             # stops after prepare
node scripts/demoSeed/cli.ts seed --target https://railhead.dev --assertion approval.json
node scripts/demoSeed/cli.ts reset --target https://railhead.dev [--assertion approval.json]
```

Each write needs its own owner passkey assertion, and the command line cannot sign one yet ([#148](https://github.com/casqueblanc/railhead/issues/148)). So a write without `--assertion` asks the backend for the challenge bound to the action (for a seed, to the head it imports), prints it as a `challenge` JSON line, says nothing was written and exits 3. Sign that challenge with the owner passkey before it expires (two minutes), write `{ "challengeId": ..., "assertion": { "credentialId", "clientDataJson", "authenticatorData", "signature", "userHandle" } }` to a file, binary fields base64url without padding, and run the same command again with `--assertion FILE`. One assertion approves one write. The backend checks that the assertion is for that challenge and that the challenge is for this action, so an assertion for another head or for a reset is refused there. A write runs only when a fresh read of the target still calls for it: a seed whose main is already in place writes nothing and spends no assertion. A write whose answer is lost or times out is not repeated; run the command again and it reads the target first. A refusal (a wrong origin, an invalid or expired assertion, a main at another head) exits 2. A backend failure exits 1 and prints the backend's sentence, for example `prepare failed with unavailable: No owner passkey is enrolled.`; so do a timeout and a connection that fails.

Until #148 lands, the flow is: run the write without `--assertion`, sign the printed challenge with a WebAuthn client for the instance's relying party, then rerun with the assertion. No such client ships in this repository; nothing here reads a secret or creates a Cloudflare resource.

The owner's steps for H03 ([#68](https://github.com/casqueblanc/railhead/issues/68)), on a deployed instance with the `ARTIFACTS` binding and the owner passkey enrolled:

1. From a full clone at the revision to seed, check the plan: `node scripts/demoSeed/cli.ts seed --dry-run --target ORIGIN`. Note the printed head. To inspect the bundle, `node scripts/demoSeed/cli.ts bundle --out main.bundle`, then `git clone --branch main main.bundle`; the bundle names no `HEAD`.
2. Seed: `node scripts/demoSeed/cli.ts seed --target ORIGIN`, sign the printed challenge, then rerun with `--assertion FILE`. Its first line names main at the printed head, and the seed step reads `ok`.
3. On the board, signed in with the owner passkey, file each issue `seed --dry-run` prints, copying the title and the body between its marker lines; do not copy from the JSON in `fixtures/demo/seed.json`, which escapes the line breaks. Filing is an owner action, so each needs a passkey assertion. File only titles the board does not already show; for an issue the plan marks `edit`, correct its body instead, and for one it marks `dup`, keep one copy with the seeded body and close the others. A second `seed --dry-run --target ORIGIN` shows every step `ok`.
4. Invite and confirm the three agents (H03).

To start over, reset with `node scripts/demoSeed/cli.ts reset --target ORIGIN` and its assertion, then repeat from step 2. Without `--target`, `seed` and `reset` plan against an empty instance and refuse to run without `--dry-run`.
