---
name: foreman-gh-stack
description: Manage stacked branches and dependent pull requests with gh stack in Foreman repositories. Use for creating, inspecting, editing, submitting, syncing, rebasing, or merging a stack, splitting work into dependent PRs, or changing a layer in an existing stack.
metadata:
  author: github
  version: "0.1.0"
license: MIT
---

# Foreman gh-stack

Adapted from GitHub's gh-stack skill. See [NOTICE.md](NOTICE.md) and
[LICENSE](LICENSE) for upstream provenance and terms.

## Foreman scope

Read [foreman-commits](../foreman-commits/SKILL.md) before branch, commit, push,
or PR operations. Its naming, staging, title, and authorization rules apply to
all examples here and in the references. Use the contributor's established
prefix, such as `alex/auth` and `alex/api`, or the exact requested branch names.
Keep independent work separate; use a stack when the work has dependent layers.

Inspect the working tree, intended trunk, remotes, and existing stack before
changing them. Preserve unrelated staged and unstaged work. Carry existing task
authorization forward: `push`, `submit`, `sync`, `link`, remote `unstack`, and
`merge` have remote effects. `sync` pushes as well as rebases; it is not a
read-only status check. `link` can push branches, create PRs, and change PR bases.
Use `--prune` only when deleting merged local branches is in scope. Verify the
full set of PRs a merge target selects and that merging that set is authorized.

The setup commands below are prerequisites, not task-start actions. Check
`gh stack --help` and existing local configuration first; install the extension
only when needed and within scope. Preserve an existing remote choice and use
the verified remote instead of assuming `origin`. Configure Git locally, not
globally. Check `gh stack <command> --help` if the installed version differs.

`gh stack` is a [GitHub CLI](https://cli.github.com/) extension for stacked branches and pull
requests. A stack is an ordered chain of branches rooted on a trunk, where each branch has one PR
based on the branch below it, so a reviewer sees only that layer's diff.

`gh stack` prints a stack trunk-first, left to right:

```
(main) <- auth <- api <- frontend
```

Left is the **bottom**, right is the **top**. `auth` is based on `main` and merges first;
`frontend` merges last. `up` moves toward the top, away from trunk; `down` moves toward it.
Foundational work belongs at the bottom, code that depends on it above. For how to choose the
layers, read `references/stack-design.md`.

## Setup

```bash
gh extension install github/gh-stack
git config rerere.enabled true         # remember conflict resolutions
git config remote.pushDefault origin   # required if the repo has more than one remote
```

## Non-interactive use

`gh stack` branches on whether **stdout is a TTY**. Piped, most commands error cleanly or print
static text; under a PTY the same commands open a prompt or a full-screen TUI and block forever.
Agent harnesses differ, so always pass the flags below instead of relying on that detection.

**Multiple remotes:** never run `push`, `submit`, `sync`, `rebase`, or `link` without
`--remote <name>` unless `remote.pushDefault` is configured. `checkout` and `trunk` have no
`--remote` flag and require the config.

| Always run | Never run bare | Why |
|---|---|---|
| `gh stack view --json` | `gh stack view` | opens a TUI under a PTY |
| `gh stack submit --auto` | `gh stack submit` | prompts for a title per new PR |
| `gh stack merge <target> --yes` | `gh pr merge` | `gh pr merge` cannot merge a stack |
| `gh stack init <branch>...` | `gh stack init` | prompts for branch names |
| `gh stack add <branch>` | `gh stack add` | prompts for a name, and fails even when piped |
| `gh stack checkout <target>` | `gh stack checkout` | opens a selection menu |
| `gh stack up` / `down` / `top` / `bottom` | `gh stack switch` | `switch` is menu-only |
| — | `gh stack modify` | TUI-only, no non-interactive path |

- `view --short` is safe in both modes, but it is formatted for humans. Use `--json` to parse.
- **`checkout <pr>` when a different local stack already covers those branches** cannot be forced.
  Run `gh stack unstack --local` first (this keeps the stack on GitHub), then retry.

## Branch placement

- **Starting dependent work:** plan the layers before writing files and create the stack when
  branch creation is in scope. Put one dependent concern in each layer, bottom to top.
  When splitting existing work, inspect its changes and preserve them while assigning layers.
- **Editing an existing stack:** check out the layer that owns the change before editing. Never
  commit a lower layer's concern on the current top branch. Run `gh stack view --json`; if
  ownership is unclear, inspect `git log --all -- <path>`. Then check out the owner, edit, commit,
  rebase upstack, and return to top.

```bash
gh stack down                   # or: gh stack checkout alex/api
git add path/to/changed-file
git commit -m "feat: add get-user endpoint"
gh stack rebase --upstack       # replay every branch above onto the change
gh stack top                    # return to where you were
gh stack push
```

## Core loop

```bash
gh stack init alex/auth         # create the stack and check out its branch
git add path/to/auth-file
git commit -m "feat: add auth middleware"
gh stack add alex/api           # next layer, branched from the current one
git add path/to/api-file
git commit -m "feat: add API routes"
gh stack submit --auto          # push every branch and open draft PRs
gh stack view --json            # confirm
```

Add `--open` to `submit` to create PRs ready for review instead of drafts. Branch names are
verbatim — `gh stack add alex/api` creates `alex/api`. Replace example paths,
names, and targets with the actual task values. Review generated PR metadata
against the commit skill; correct titles and bodies with `gh pr edit` and use
`--body-file` for multiline descriptions. Read the published metadata back.

After submission, follow the commit skill's
[background PR review workflow](../foreman-commits/references/pr-review-follow-up.md)
for every PR in the stack. Keep one monitor and preserve its original deadline
when a fix or rebase changes several PR heads.

## Staying in sync

```bash
gh stack sync                   # fetch, reconcile with GitHub, rebase, push, refresh PR state
gh stack sync --prune           # also delete local branches for merged PRs
```

Pruning never happens without `--prune` when non-interactive. If the local and remote stacks have
diverged, `sync` prints both chains, makes no changes, and exits 0 with `Sync aborted` — see
`references/troubleshooting.md`.

## Merging

Scope the merge with an argument:

```bash
gh stack merge 42 --yes          # PR #42 plus every unmerged PR below it
gh stack merge 7 --yes           # every unmerged PR in stack #7
gh stack merge 42 --yes --squash # or --merge, --rebase, --merge-method <method>
```

Pass a PR number to merge that PR and every unmerged PR below it, or a stack number to merge every
unmerged PR in that stack. The operation is all-or-nothing: if any PR in that set cannot merge,
none do.

Without a method flag the last-used method is reused. If the base branch uses a merge queue, the
stack is queued instead and the queue picks the method, ignoring any flag you passed with a
warning; queued PRs may land in separate groups.

## Reading state

`gh stack view --json` writes JSON to **stdout**. Status messages go to **stderr**.
Use exit codes and verify resulting state; `sync` can exit 0 without syncing,
as described above. After a push or submit failure, inspect remote heads and
PRs before retrying: earlier branches may already have updated.

```
trunk           string
currentBranch   string
branches[]      name, head, base, isCurrent, isMerged, isQueued, needsRebase
branches[].pr   number, url, state ("OPEN" | "MERGED" | "QUEUED"); absent when no PR exists
```

`base` is the saved SHA of the parent branch that this branch was last known to contain. It may be
older than the parent's current tip. `needsRebase` is true when the current parent tip is no longer
an ancestor of the branch.

## Exit codes

| Code | Meaning | Recovery |
|---|---|---|
| 0 | Success | — |
| 1 | Generic error | Read stderr |
| 2 | Not in a stack | `gh stack init`, or `gh stack checkout <target>` |
| 3 | Rebase conflict | Follow the Exit 3 recovery below |
| 4 | GitHub API failure | Check `gh auth status`, retry |
| 5 | Invalid arguments | Fix the invocation; see `<command> --help` |
| 6 | Disambiguation required | Branch is in several stacks; check out a non-shared branch |
| 7 | Rebase already in progress | `gh stack rebase --continue` or `--abort` |
| 8 | Stack file locked | Another `gh stack` process is writing; retry after ~5s |
| 9 | Stacked PRs unavailable | Not enabled on the repository; tell the user |
| 10 | Modify recovery required | `gh stack modify --abort` |

**Exit 3 recovery:**

- After `gh stack rebase`: resolve the files, run `git add`, then
  `gh stack rebase --continue`; use `gh stack rebase --abort` to restore the stack.
- After `gh stack sync`: the stack has already been restored. Run `gh stack rebase` to recreate the
  conflict, then resolve and continue as above.

## Constraints

- Stacks are strictly linear: one parent, at most one child. Use separate stacks for parallel work.
- There is no non-interactive reorder or removal. Errors may suggest `gh stack modify`, but it is
  TUI-only — restructure with `unstack` then `init` instead.
- PR titles and bodies are auto-generated. Use `gh pr edit` afterwards to change them.

## More detail

`gh stack <command> --help` is authoritative for flags and arguments. Note that
`gh stack help <command>` does **not** work — it prints the top-level help.

Open the reference whose trigger matches the task; no need to preload all three.

- [Stack design](references/stack-design.md) — read before creating a stack, when deciding how many layers to
  use, what belongs in each one, or whether work belongs in a new stack.
- [Command behavior](references/commands.md) — read when a command fails unexpectedly or you need its preconditions,
  side effects, atomicity, or ordering guarantees.
- [Troubleshooting](references/troubleshooting.md) — read on a rebase conflict, after a squash-merge, on local and
  remote divergence, when restructuring a stack, or when driving stacks from another tool.
