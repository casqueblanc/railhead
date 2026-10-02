---
name: foreman-working
description: Apply Foreman working standards at the start of every repository task, including maintenance cost, documentation placement, workspace structure, tooling, tests, and authorization. Read this baseline before selecting domain skills.
license: MIT OR Apache-2.0
---

# Foreman working rules

Start coding tasks with `pnpm run-start` and retain its engineering fingerprint.
Hosted review jobs read tracked local skills directly; they run no startup hook
and create no authoring monitor.
Read this baseline and [writing](../foreman-writing/SKILL.md), then relevant
skills. All guidance lives in this checkout; no external refresh or cache is used.
Do not refresh policy midway through work. A worker checks the coordinator
fingerprint with `pnpm run-start <fingerprint>` before starting. If policy
changes during a task, report it and reconcile before continuing.
Root `AGENTS.md`, issue amendments and user scope retain their authority.

Read the current repository instructions, relevant implementation, and callers.
Preserve unrelated work and stronger project constraints. Repository files own
exact commands, runtime constraints and versions; do not maintain snapshots of those
facts in shared guidance. Reconcile conflicting instructions during adoption.

Before asking the user how something behaves, check whether a bounded command,
test, or throwaway prototype can answer it, and run that instead. Ask for product
and preference decisions, missing context, and authorization.

Finish the authorized work. Before running a command, know what it checks and
what it can change. Choose the smallest useful command. Use focused commands
with short timeouts, usually 10–30 seconds. Diagnose a timeout before retrying.
Set a time limit for necessary longer jobs and report progress. Do not waste
time, hide failures, skip required checks, or claim work that did not happen.

Root `package.json` scripts are the commands. Use pnpm and Vite+ only (`vp`
runs tasks, Oxlint and Oxfmt); exact versions, one lockfile, frozen installs in
CI. Read the root `AGENTS.md` for the monorepo layout, the RPC boundary, the
Worker runtime and the backend's authority. Run `pnpm check` before handing off
implementation. Keep platform changes and deployment separate from checks.

Before adding code, dependencies, automation, configuration, or docs, identify its
value and maintenance cost. Prefer one source of truth and automate repeated
upkeep. If that is impractical, simplify or choose another approach. Keep a manual
record only when its value and update trigger are clear. Do not add recurring
checkout audits, version inventories, or status reports that will become stale.

Keep maintained development and operational guidance in this monorepo.
Decisions, RFCs and research stay here or in the owning Foreman issue. Foreman
is published under Apache-2.0: never copy private material from another Casque
Blanc repository (customer data, pricing, unpublished plans) into it.
Do not commit transcripts, session reports or speculative documentation trees.
Preserve required artifact provenance and upstream licenses.

## Track unfinished work

Every confirmed, actionable problem left outside the current fix must have an
issue in the owning repository. A chat note, TODO, or checked-in report is not
enough. Finish the authorized fix first; filing an issue does not excuse leaving
that work incomplete. Do not file speculative improvements or duplicate a defect
already being fixed in the current PR.

Use `gh` with an explicit `--repo owner/repo`, verified from the Git remote:

1. Search with `gh issue list --repo owner/repo --state all --search 'keywords'`.
   Read relevant matches with `gh issue view`. Link an existing open issue when
   it covers the same problem; inspect closed matches before treating it as new.
2. If no open issue covers it, create one:
   `gh issue create --repo owner/repo --title 'Specific problem' --body-file /path/to/issue.md`.
   Replace these example values. Give the trigger or reproduction, expected and
   actual behavior, impact, relevant code or PR links, and a concrete next step.
   Keep the body concise, with one
   physical line per paragraph and no assistant attribution.
3. When the issue cannot start until another open issue lands, add a
   blocked-by link, not only a sentence saying so:
   `gh api --method POST repos/owner/repo/issues/<number>/dependencies/blocked_by -F issue_id=<id>`,
   with the blocking issue's numeric `id`. Scheduled pickup reads only the link.
   Add one whenever a later comment or edit reveals a dependency.
4. Read back the created issue with `gh issue view` and include its URL in the
   handoff. One issue should cover one problem, not every symptom or mention.

When a problem splits into parts that can each be changed, verified, and merged
on their own, file a parent issue with one sub-issue per part so separate agents
can take them. Link each part with
`gh api --method POST repos/owner/repo/issues/<parent>/sub_issues -F sub_issue_id=<id>`,
where `<id>` is the sub-issue's numeric `id` from `gh api repos/owner/repo/issues/<number>`,
not its number. Record ordering with GitHub's blocked-by relationship. Keep
parts that would edit the same files in one issue with a checklist.

Respect explicit read-only or no-posting instructions and private security
reporting rules. If issue creation is unavailable or outside the task's posting
authorization, provide a ready-to-file title and body, explain the blocker, and
state that nothing was filed. Do not change token permissions to bypass it.

## Apply the shared skills

Apply [writing](../foreman-writing/SKILL.md) to every document and message.
Remove AI filler and unsupported claims before delivery. Before creating a branch,
committing, pushing, or writing a PR, read [commits](../foreman-commits/SKILL.md):
`<name-or-nickname>/<what-you-are-working-on>` branches, short conventional commit
and PR titles, and no attribution. Preserve legal notices and Git identity.
Respect the task's commit, push, publish, and equipment authorization; do not ask
again for an action already authorized.

For stacked branches or dependent PRs, also read
[gh-stack](../foreman-gh-stack/SKILL.md). It covers layer placement,
non-interactive commands, and stack recovery within the current task scope.

Read [TypeScript](../foreman-typescript/SKILL.md),
[testing](../foreman-testing/SKILL.md), or [review](../foreman-review/SKILL.md)
when relevant. For React code, read
[frontend conventions](../foreman-frontend-conventions/SKILL.md) first. Read the
official Cloudflare skills named by root `AGENTS.md` before writing Cloudflare
code. Keep provider knowledge behind its owned boundary.

For a multi-model review panel, competing implementations, a parallel sweep, or
work that continues while the user is away, read [Orca](../foreman-orca/SKILL.md).

For TypeSafe integration or a measured semantic-triage pilot, read
[TypeSafe](../foreman-typesafe/SKILL.md). Load it when relevant; installing a
skill alone does not reduce coding-agent token usage.
