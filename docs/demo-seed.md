# Demo seed and reset

The demo runs on one Railhead repository, `demo/upload-app`: the repository the board opens by default. It holds the full history of [`demo/upload-app`](../demo/upload-app) as its main, and three issues for three agents. `fixtures/demo/seed.json` describes it; `scripts/demoSeed/` plans and checks it.

```sh
node scripts/demoSeed/cli.ts seed --dry-run      # every target the seed writes
node scripts/demoSeed/cli.ts reset --dry-run     # the one repository reset deletes
node scripts/demoSeed/cli.ts bundle --out main.bundle
```

`--revision` picks the source commit (default `HEAD`). `--org` and `--repo` are accepted only as `demo` and `upload-app`; any other repository is refused before anything is planned, and so is a manifest that names one.

## What the seed holds

**Main.** Every commit of this repository that changed `demo/upload-app`, rewritten with that directory as the root. Each commit keeps its subject and dates; author and committer are `Railhead demo <demo@railhead.dev>`. The same revision always produces the same head, so a repeated seed recognises a main it already imported, and reset followed by seed lands on the same base. A shallow clone is refused, because it would import a truncated history. The rewrite runs in a scratch repository and writes nothing to this one.

**Issues.** Three tasks, matched by title when the seed reconciles:

| Issue                                             | Touches                                                 | Decision    |
| ------------------------------------------------- | ------------------------------------------------------- | ----------- |
| Warn before uploading a file above the size limit | `src/page.ts`, `src/limits.ts`                          | collides    |
| Let people upload files larger than 10 MB         | `src/uploads.ts`, `src/limits.ts`, `src/store.ts`       | collides    |
| Let people delete an upload                       | `src/index.ts`, `src/store.ts`, `__tests__/app.test.ts` | independent |

**The decision.** `upload-size-limit`: what happens to an upload above 10 MB, option A (reject with 413, as the app does) or B (accept it in parts). Its scope is `src/limits.ts` and `src/uploads.ts`. The seed does not open it: an agent opens it by asking the question while working on one of the first two issues, and the owner answers on the board.

## The decision collision is intentional

Two agents on separate issues reach the same open decision. That is what the demo exists to show: the warning and the large-upload support both depend on the answer, so one answer must reach both agents through their inboxes, and changing it later (A to B) must reach both again, superseding what each built on the old version. The third issue is independent, so one agent keeps working while the other two wait on the decision.

The manifest check enforces this shape: exactly three issues, exactly two touching the decision's scope, and a decision whose key and options match the tagged suites in the app's `acceptance/checks.json`, which the train runs for the option in force.

## Repeatable seed, safe reset

Seed and reset reconcile against a target through the `SeedTarget` port in `scripts/demoSeed/reconcile.ts`:

- Seed reads the target, then writes only what is missing: the repository, its main, each issue. A second seed writes nothing. A seed that failed halfway, including a write whose response was lost, finishes on the next run without filing an issue twice.
- Seed refuses, writing nothing, when main already holds another head or a seeded title carries a different body. Reset first.
- Issues the seed did not file are left alone.
- Reset deletes `demo/upload-app` by name. It never lists repositories to choose what to delete, so no other repository can go with it. Reset of an absent repository writes nothing.

The tests in `scripts/demoSeed/` run these rules against an in-memory target, alongside other repositories that must survive a reset.

## Running it live

There is no live target yet. The Worker has no entry that initializes a repository or imports its main, and no Artifacts binding; [#142](https://github.com/casqueblanc/railhead/issues/142) adds them and makes them the live `SeedTarget`. Until then `seed` and `reset` refuse to run without `--dry-run`, and nothing here creates a Cloudflare resource or reads a secret.

The owner's steps for H03 ([#68](https://github.com/casqueblanc/railhead/issues/68)), once #142 has merged and been deployed:

1. From a full clone at the revision to seed, check the plan and build the bundle: `node scripts/demoSeed/cli.ts seed --dry-run`, then `node scripts/demoSeed/cli.ts bundle --out main.bundle`. Note the printed head.
2. Seed `demo/upload-app` from `main.bundle` through the entry #142 adds, and confirm its main is the printed head.
3. On the board, signed in with the owner passkey, file the three issues with the titles and bodies in `fixtures/demo/seed.json`. Filing is an owner action, so each needs a passkey assertion. File only titles the board does not already show.
4. Invite and confirm the three agents (H03).

To start over, reset `demo/upload-app` through the same entry and repeat from step 2. The bundle can be reused: the head does not change unless the revision does.
