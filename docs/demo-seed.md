# Demo seed and reset

The demo runs on one Railhead repository, `demo/upload-app`: the repository the board opens by default. It holds the full history of [`demo/upload-app`](../demo/upload-app) as its main, and three issues for three agents. `fixtures/demo/seed.json` describes it; `scripts/demoSeed/` plans and checks it.

```sh
node scripts/demoSeed/cli.ts seed --dry-run      # every target the seed writes
node scripts/demoSeed/cli.ts reset --dry-run     # the one repository reset deletes
node scripts/demoSeed/cli.ts bundle --out main.bundle
```

`--revision` picks the source commit (default `HEAD`); the manifest is read from that commit's `fixtures/demo/seed.json`. `--manifest FILE` is an explicit override that reads a manifest from disk instead. `--org` and `--repo` are accepted only as `demo` and `upload-app`; any other repository is refused before anything is planned, and so is a manifest that names one.

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

The manifest check enforces this shape: exactly three issues, exactly two touching the decision's scope, and a decision whose key and options match the tagged suites in the app's `acceptance/checks.json` one for one, which the train runs for the option in force. The decision must also pass the agent wire's `ask` rules, lowercase option keys included, since an agent opens it by asking; `manifest.test.ts` checks the restated rules against `@railhead/shared` and the `ask` wire fixture.

## Repeatable seed, safe reset

Seed and reset reconcile against a target through the `SeedTarget` port in `scripts/demoSeed/reconcile.ts`. The port has the shape of the backend's `DemoSeedApi` ([#149](https://github.com/casqueblanc/railhead/pull/149)): `read` returns the repository's main or nothing, `seed` imports main and then initializes the repository, and `reset` deletes it.

- Seed reads the target, then seeds only when the repository is missing. A second seed writes nothing.
- `seed` receives the bundle's bytes and the head it was approved for, the input `demo.seed` takes. The bundle carries `refs/heads/main` alone, with no prerequisites, and at most 8 MiB. The repository is initialized only after main is in place, so a seed that fails after importing main leaves that main behind a repository `read` does not report. A repeat at the same head completes it; a seed at another head is refused as `action_stale` until a reset. Main is only ever created: a repeat at the same head succeeds without writing, so a seed whose response was lost is safe to run again.
- Seed refuses, writing nothing, when main already holds another head, when the repository exists without a main (a reset that did not finish; the backend answers `action_stale`). Reset first. A seeded title with a different body is not a refusal: the plan marks that issue `edit`, and the owner edits its body on the board.
- Each backend write needs its own owner passkey assertion. The live adapter obtains it ([#148](https://github.com/casqueblanc/railhead/issues/148)); the port does not carry one.
- `DemoSeedApi` has no issue read, so issues are read through a second port, `BoardIssues`. Filing an issue is an owner action on the board, so neither port can file one. The plan lists each seeded issue as done when the board shows its title and body, `edit` when it shows the title with another body, and an owner step to file otherwise. After the plan, `seed --dry-run` prints the exact title and body of every issue still to file or edit as plain text between `--- issue` marker lines, paragraph breaks as blank lines.
- Other issues are left alone.
- The port takes no lock: run one seed at a time.
- Reset deletes `demo/upload-app` by name. It never lists repositories to choose what to delete, so no other repository can go with it. Reset always calls the target, because `read` cannot see a main left by a failed seed; the target reports whether anything was deleted.

The tests in `scripts/demoSeed/` run these rules against an in-memory target, alongside other repositories that must survive a reset.

## Running it live

There is no live target yet. The Worker has no entry that initializes a repository or imports its main, and no Artifacts binding; [#142](https://github.com/casqueblanc/railhead/issues/142) adds them and wires `DemoSeedApi` as the live `SeedTarget`, with a board issue read as `BoardIssues`. Until then `seed` and `reset` refuse to run without `--dry-run`, and nothing here creates a Cloudflare resource or reads a secret.

The owner's steps for H03 ([#68](https://github.com/casqueblanc/railhead/issues/68)), once #142 has merged and been deployed:

1. From a full clone at the revision to seed, check the plan and build the bundle: `node scripts/demoSeed/cli.ts seed --dry-run`, then `node scripts/demoSeed/cli.ts bundle --out main.bundle`. Note the printed head. The bundle names no `HEAD`, so inspect it with `git clone --branch main main.bundle`.
2. Seed `demo/upload-app` from `main.bundle` through the entry #142 adds, and confirm its main is the printed head.
3. On the board, signed in with the owner passkey, file each issue `seed --dry-run` prints, copying the title and the body between its marker lines; do not copy from the JSON in `fixtures/demo/seed.json`, which escapes the line breaks. Filing is an owner action, so each needs a passkey assertion. File only titles the board does not already show; for an issue the plan marks `edit`, correct its body instead.
4. Invite and confirm the three agents (H03).

To start over, reset `demo/upload-app` through the same entry and repeat from step 2. The bundle can be reused: the head changes only when the app or a file the overlay copies changes.
