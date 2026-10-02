# Designing a stack

How to decide what goes in each layer. Read this before running `gh stack init`.

## Contents

- [Plan the layers before writing code](#plan-the-layers-before-writing-code)
- [Branch naming](#branch-naming)
- [Staging changes deliberately](#staging-changes-deliberately)
- [When to add a layer](#when-to-add-a-layer)
- [One stack, one story](#one-stack-one-story)

## Plan the layers before writing code

A stack is a dependency chain. If code in one layer depends on code in another, the dependency must
live in the same branch or a lower one. That constraint is much cheaper to satisfy by planning than
by restructuring later, because there is no non-interactive in-place reorder — fixing the order
means `unstack` and `init` again.

Decide the layers first, then write code into them:

```
(main) <- todo-app/models <- todo-app/api <- todo-app/frontend <- todo-app/integration
```

- `todo-app/models` — shared types and schema
- `todo-app/api` — routes that use the models
- `todo-app/frontend` — components that call the routes
- `todo-app/integration` — tests exercising the whole feature

This is illustrative. Infer the stack topic and layer names from the actual task; do not reuse
`todo-app` or these layer names literally.

The failure mode to avoid is writing everything on one branch and trying to split it afterwards.
For new work, create the stack at the start when branch creation is authorized.
For a request to split existing work, preserve it and identify each layer's
changes before restructuring.

## Branch naming

Follow [Railhead's branch rules](../../railhead-commits/SKILL.md): use the
contributor's established prefix and put the topic and concern after it, such
as `alex/billing-schema`, `alex/billing-api`, and `alex/billing-ui`. Exact user
requests take precedence. Example names elsewhere illustrate layer relationships.

Names are used exactly as given — nothing is prepended or transformed, and slashes are kept, so
`gh stack add refactor/foo` creates a branch literally named `refactor/foo`.

If you pass `-m` without a branch name, the name is generated from the commit message in
date-and-slug form (for example `03-24-add_api_routes`). Prefer naming the branch yourself.

## Staging changes deliberately

Use `git add` and `git commit` directly rather than the `add -Am` shortcut. The point is control
over which changes land in which branch. With several modified files in the working tree, stage the
subset that belongs to the current layer, commit it, then create the next branch and stage the rest
there:

```bash
git add internal/models/user.go internal/models/session.go
git commit -m "feat: add user and session models"

gh stack add alex/api-routes
git add internal/api/routes.go internal/api/handlers.go
git commit -m "feat: add user API routes"
```

Multiple commits per branch are fine. What matters is that every commit in a branch serves the same
concern, and that a change belonging to a different concern goes in a different branch.

Note that `gh stack add <branch>` without `-Am` does not touch the working tree, so uncommitted
changes carry over to the new branch. Commit or stash first if you want the new layer to start clean.

## When to add a layer

Add a branch when you start a **different concern that depends on what you have built so far**.
Signals:

- Moving from backend to frontend, or from core logic to tests or documentation
- The next changes have a different reviewer audience
- The current branch's diff is already large enough to review on its own

A layer that cannot be described in one sentence is usually two layers.

## One stack, one story

A stack should read as a coherent progression: a reviewer walks the PRs bottom to top and sees the
feature being built.

**Use a single stack** when every branch serves the same feature or project, even if the layers span
different concerns.

**Start a separate stack** for unrelated work — a different feature, an unrelated bug fix, an
independent refactor. Do not mix efforts into one stack just because you happened to work on both.
Use `gh stack init` for the new effort, or `gh stack checkout <target>` to move between existing
stacks.

A trivial incidental fix can ride along in the current stack. Once it grows into its own project, it
deserves its own stack.
