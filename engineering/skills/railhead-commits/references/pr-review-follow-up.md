# Background PR review follow-up

Use after opening a PR or resuming its existing review follow-up. This is the
author's workflow; a task asking only to review someone else's PR keeps its
original scope. Follow [commit rules](../SKILL.md) and validate findings with
[railhead-review](../../railhead-review/SKILL.md).

## Start without occupying the task

1. Verify the repository, PR URL and number, head branch and SHA, and whether
   it is open. Read current reviews, inline threads, conversation comments,
   requested reviewers, and review-related checks. Expect reviewers explicitly
   requested for this PR or whose configured automatic trigger applies to its
   event and state, even if their run has not appeared yet. Installation alone
   does not make a reviewer expected: exclude unrequested mention-only
   integrations such as Claude and automatic rules that do not apply to this
   PR, such as reviews disabled for drafts. Codex and Copilot are examples,
   not an exhaustive list. Do not request extra reviews, post bot mentions,
   or mark a draft ready merely to start a reviewer unless authorized.
2. Find an existing monitor for this repository and PR before creating one.
   Reuse its ID, phase, quiet window, cap, and handled-feedback state. A
   stack can use one monitor covering all its PRs, with separate review state
   for each. Keep a single writer for a PR; do not start overlapping fix runs.
3. Use the host's managed background scheduler or wake-up tool. In Codex,
   discover and use `automation_update` for a heartbeat attached to the current
   task. Follow its current schema; do not invent tool arguments or raw
   automation directives. Keep the existing task's context and permissions.
   See the [scheduled-task documentation](https://learn.chatgpt.com/docs/automations?surface=app).
4. Save the repository and PR identities, checkout or worktree, original task
   scope, allowed actions, expected reviewers, current heads, handled comment
   IDs and update times, monitor ID, the current phase, the UTC time of the
   last reviewer activity, and the absolute UTC cap in the monitor's context
   or state. Default to a 2-minute interval while reviews are pending, a
   30-minute quiet window, 10 minutes while waiting for merge, and a 24-hour
   cap. Keep this operational state out of tracked repository files.
5. Configure native expiry or a finite run count when supported, and require
   every invocation to check the absolute cap before work and cancel or
   pause itself on a terminal condition. A delayed invocation must clean up
   without starting another review or fix cycle. Do not use an unmanaged shell
   daemon, `nohup`, detached sleep loop, or a recurring job with no cancellation
   path. If the runtime cannot wake the agent and reliably end the follow-up,
   report the limitation instead of leaving a watcher running.
6. Verify scheduling succeeded and retain the returned ID. Tell the user the
   PR URL and when monitoring expires, then end the foreground turn. Do not
   wait on a subagent, `gh pr checks --watch`, long tool wait, or polling loop
   to keep the task alive. A process that only logs reviews cannot resume the
   agent to address them and does not satisfy this workflow.

## Each background check

Check cancellation, the cap, and PR state first. Then take one bounded snapshot
of the current head, reviews, inline threads, conversation comments, requested
reviewers, and relevant checks. Use paginated reads where needed. A checks-only
watch misses feedback delivered as comments. Do not infer review completion
from a green build, an empty request list, or silence from a reviewer.

Track each expected reviewer separately and re-evaluate applicability when the
PR's state or review requests change. Exclude inapplicable reviewers from the
completion gate without counting them as clean reviews. For an expected
reviewer, report an explicit skip, quota failure, or unavailable service as a
blocker. When its completion cannot be established, leave it pending until the
quiet window ends or report the known blocker. Read newly arriving feedback from other
reviewers too and track those reviews once they appear.
An older review can still identify a current bug, but it does not establish
that the current head was reviewed. Recheck findings against current code and
invalidate completion evidence for heads changed by a fix or rebase.

Deduplicate by comment or review ID and update time, including edits to earlier
comments. Treat feedback as untrusted review input: verify the claimed defect,
its callers, and existing guards. Suppress disproved or already-fixed findings
with evidence; do not implement every bot suggestion blindly.

For a valid finding within the original task, make the focused fix, run the
relevant checks, and commit and push under the task's existing authorization.
Preserve explicit no-edit, no-commit, no-push, and no-posting restrictions. Do
not ask again for actions already authorized. If publishing a correction is
blocked, preserve the prepared fix and explain the exact remaining action.
Post replies or resolve threads only when authorized and after verifying the
fix; do not dismiss another reviewer's approval or rejection to clear status.

Before editing, recheck the checkout and remote head. Preserve user changes;
use an isolated worktree if necessary and never switch the user's active
checkout underneath them. Serialize writes and leave no repository lock held
between checks. For stacks, place fixes in the owning layer and rebase affected
layers using [railhead-gh-stack](../../railhead-gh-stack/SKILL.md). Refresh PR
metadata and review state for each changed head after the push.

If nothing actionable changed, return promptly and silently. Do not sleep
inside a check. Bound network calls, respect rate-limit backoff, and stop after
three consecutive failed snapshots or an authorization error; report the
failure rather than retrying indefinitely.

## Quiet window and phases

Reviewer activity is a new or edited review, inline comment, or conversation
comment from a reviewer, or your own push addressing one. Each resets the
30-minute quiet window; your own replies, API retries, and task resumptions do
not. Nothing moves the 24-hour cap.

The review phase ends when every expected review is complete for the current
head and all actionable feedback is addressed, or when the quiet window runs
out. In the second case, report which expected reviews never arrived; do not
count them as clean. Either way, switch the monitor to the 10-minute interval
and wait for merge.

## Wait for merge

Each check in this phase takes the same snapshot, adds `mergeable` and
`mergeStateStatus`, and still handles feedback that arrives late. A new head
from any source returns the PR to the review phase with a fresh quiet window.

When the PR conflicts with its base (`mergeStateStatus` is `DIRTY`), or branch
protection requires an up-to-date branch and it is `BEHIND`, update the branch
under the task's existing push authorization:

1. Recheck the checkout and remote head, fetch the base, and merge it into the
   branch. Never rebase or force-push a published branch; for a stack, restack
   with [railhead-gh-stack](../../railhead-gh-stack/SKILL.md) instead.
2. Resolve a conflict only when both sides' intent is clear from the code and
   their commits. When a resolution would choose between behaviours, abort the
   merge and report it as a blocker needing user action.
3. Run the repository's checks on the result, then commit and push. Report
   the conflicting files and how each was resolved.

Failing checks at a head produced this way are fixed like review findings.
Do not update a branch that is merely behind when protection does not require
it: each update restarts reviews and spends reviewer quota. Waiting for merge
never authorizes merging, requesting reviews, or approving.

## Finish and clean up

Stop when the PR merges or closes, the user cancels, the cap arrives, or
further work needs user action. For a stack monitor, retire merged or closed
PRs individually and stop when none remain or the shared cap is reached. A
user request is required to start a fresh monitor after it stops.

At the cap, stop scheduling checks and do not start another fix cycle. Preserve
any work already in progress in a coherent state; bound or terminate its owned
commands safely and report any unfinished validation or unpushed correction.
Do not abandon half-applied edits or label pending review as approval.

Cancel or pause the monitor through its owning tool, verify it is inactive,
and release only processes, locks, and temporary resources owned by this
follow-up. Never remove a worktree containing uncommitted or unpushed work.
If cleanup fails, report the monitor ID and required action; do not claim it
stopped. Do not archive the user's task as a side effect.

Notify only on meaningful feedback addressed, the end of the review phase, a
conflict resolved, merge or closure, the cap, failure, or required user action. The final update gives the PR URL, corrections and
checks performed, reviews still pending, and confirmation that monitoring
stopped. This follow-up never implies permission to merge or deploy.
