---
name: foreman-commits
description: Prepare branches, commits, pushes, and pull requests in Foreman repositories, including bounded background follow-up on PR reviews. Use before branch, commit, push, or PR operations and when handling feedback on a PR you opened; preserve task authorization and use short messages without attribution.
license: Apache-2.0
---

# Foreman branches, commits, and pull requests

Adapted from Sentry's commit skill. See [NOTICE.md](NOTICE.md) and
[LICENSE](LICENSE) for upstream provenance and terms.

## Branches and authorization

Name branches `<name-or-nickname>/<what-you-are-working-on>`, such as
`alex/batch-readings` or `sam/fix-release`. Use the contributor's established
prefix when known. Otherwise, suggest their name, username, or nickname as the
prefix. Follow an exact branch name when the user requests one. Put the kind of
change in the commit prefix.

Start independent work from the current remote default branch unless the task
selects another base. Preserve unrelated work with an isolated worktree when
needed. Before creating a branch, check its name and base. Do not silently
rename an existing published branch or replace an open PR to fix its name.

For dependent branches and stacked PRs, also read
[foreman-gh-stack](../foreman-gh-stack/SKILL.md). Each layer builds on its
parent; the default-branch rule above applies to independent work.

Preparing changes does not authorize a commit or push. Carry authorization
already given in the task forward, including later corrections, and keep any
instruction to leave work uncommitted or unpushed in force until changed.

## Commit and PR title rules

- Use a short, imperative subject that names the change. Aim for 50 characters;
  stay within 72. No trailing period.
- Use a familiar prefix such as `fix:`, `feat:`, `docs:`, `test:`,
  `refactor:`, or `chore:`. Add a scope only when it makes the subject clearer.
- Prefer a subject alone. Add a short body only to explain a reason or constraint
  that the diff and subject cannot convey. Put detailed validation in the PR.
- Follow [no assistant references](#no-assistant-references) for all commit
  and PR text, including titles, bodies, and comments.
- Use the configured Git author and signing settings. The message rule does not
  change authorship metadata or require rewriting existing commits.
- Use these same rules for the PR title: squash merges use it as the commit
  subject. Include `perf:`, `build:`, `ci:`, `style:`, or `revert:` where appropriate.
- Routine Worker deployment follows the existing CI path; a commit prefix
  does not authorize infrastructure changes or publication.

Examples:

```text
fix: reject unscoped connector reads
feat: add delivery report storage
docs: add local run guidance
```

## No assistant references

Except for the explicitly requested review command below, never include Claude,
Codex, or other AI assistant references in commit subjects or bodies, PR titles
or descriptions, or PR comments. This includes assistant names, session or chat
URLs (such as `claude.ai/code/session_*`), transcript links, badges, signatures,
`Co-authored-by` or generated-by footers, and claims that an assistant wrote,
implemented, tested, reviewed, or completed the work. Describe the change and
its evidence directly, without claiming assistant credit.

The sole exception is a review-bot command in a PR conversation comment when the
user explicitly requests that bot invocation, such as `@claude review` or
`@codex review`.
Include only the bot mention and requested review instructions. Do not infer
authorization from an installed integration, a reviewer suggestion, or this rule.
Attribution, session links, and claims of doing the work remain forbidden in
the command and surrounding text.

Apply this rule to text supplied by tools, templates, and copied drafts as well
as text you write. Inspect the final content before publishing.

## Preparing the commit

Read the status and diff, including anything already staged. Group changes
around one purpose and stage only the intended files or hunks. Preserve unrelated
work and existing staged changes. Run the repository's relevant checks and
inspect the staged diff before committing.

After a requested commit, confirm its message and the resulting working-tree
state. Push, amend, rebase, or rewrite history only when included in the task.

## Push and PR checks

Before opening a PR or requesting review, run the local self-review in
[foreman-review](../foreman-review/SKILL.md), including its Open Code Review pass
when `ocr` is configured. Fix verified findings within the task's scope first.

Before pushing, inspect the commits ahead of the selected base and their full
messages, the diff, the destination remote, and the branch name. Push an explicit
branch ref. After a push, verify that the remote head and PR contain the commits
that were checked. A local pass is not evidence about an older remote head.
When an authorized rebase needs a force push, use a lease against the previously
observed remote head; never force-push the default branch.

Keep one result per PR. Describe the problem and resulting behavior, then the
checks actually run and any material compatibility or rollout constraint. A
small change usually needs one or two paragraphs plus validation. Summarize
covered paths; do not paste every test name, create a table full of `n/a`, or
recount the work session. Use a table only when it makes comparisons clearer.

Write each prose paragraph in a GitHub PR, issue, or comment on one physical
line. GitHub renders those newlines as visible breaks, so do not hard-wrap at
80 columns or copy README source wrapping into the body. Use blank lines between
paragraphs and preserve intentional Markdown lists, tables, and code blocks.
Commit body wrapping and repository Markdown formatting follow their own rules.

Pass multiline bodies through a file or structured API, then read back the
published title and body to verify their content and the no-assistant-references
rule. If tooling appended a forbidden reference, remove it and verify the saved
content again. If a later commit changes behavior or validation, update the PR
around its final state.

## Follow up after opening a PR

After opening a PR, arrange background follow-up for its reviews and address
actionable feedback within the original task. Read
[PR review follow-up](references/pr-review-follow-up.md) before scheduling it.
This applies to ordinary PRs and each PR created by a stack submission. Track
reviews explicitly requested for the PR or whose automatic trigger applies to
it, including Codex, Copilot, other bots, and requested humans. An installed
mention-only integration such as Claude is expected only when invoked for this
PR. Do not stop after the first expected reviewer responds.

The follow-up has two phases. While reviews are pending, check every
**2 minutes**. The review phase ends when every expected review is complete for
the current head and its feedback is addressed, or after **30 minutes without
reviewer activity**: a new review, inline comment, or conversation comment from
a reviewer, or a push of yours addressing one, starts a fresh 30-minute window.
Report reviews still missing when a quiet window ends. Then watch every
**10 minutes** until the PR merges or closes: address feedback that still
arrives, and resolve merge conflicts by merging the base into the branch. A
conflict fix is a new head, so its reviews start over. Whatever the phase, stop
at an absolute **24-hour cap** from initial monitor creation. Respect an
explicit user duration. API retries and task resumptions extend nothing. Use a
managed scheduler that can wake the agent and stop the follow-up. End the
foreground turn once the monitor is confirmed; never occupy it with sleeps or
polling loops.

Report the PR URL and the cap when monitoring starts. Stop and clean up on
merge, closure, cancellation, the cap, or a blocker requiring user action. If
the runtime cannot provide bounded background follow-up, say it was not started
and return the PR's current state. Keep explicit restrictions on fixes,
commits, pushes, and posting; this rule does not authorize merging.
