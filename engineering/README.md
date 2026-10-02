# Railhead engineering

This monorepo owns its engineering guidance. It is imported from Chantier, which
adapted the useful parts of
[Origin89 engineering](https://github.com/origin89hq/engineering), and needs no
external checkout, network refresh or approval service. Preserve the licenses
and [upstream provenance](UPSTREAM.md).

Every new task runs `pnpm run-start`, reads the local working and writing skills,
then loads relevant skills. The command validates local wiring and prints the
policy fingerprint and baseline. Keep that revision for the task. A dispatched
worker runs `pnpm run-start <fingerprint>` to reject different guidance before
starting. Nothing is fetched.

Root `AGENTS.md` is the authority for Railhead architecture and constraints.
`CLAUDE.md` imports it; Claude's SessionStart hook prints the baseline on new,
resumed and cleared sessions. `.agents/skills/` and `.claude/skills/` are tracked
links to these canonical files, so fresh worktrees and hosted checkouts include
all guidance. Copilot's native instructions point to the same tracked source.
Codex and hosted review rely on their native instruction loading; there is no
claim of a universal runtime hook or proof that a model obeyed a rule.

| Skill | Use |
| --- | --- |
| [Working](skills/railhead-working/SKILL.md) | Every task, scope and unfinished work |
| [Writing](skills/railhead-writing/SKILL.md) | Messages and maintained documentation |
| [TypeScript](skills/railhead-typescript/SKILL.md) | Code, strict types and boundaries |
| [Frontend conventions](skills/railhead-frontend-conventions/SKILL.md) | React code organization, component APIs, Kumo and styling rules from Cloudflare OS |
| [Frontend design](skills/railhead-frontend-design/SKILL.md) | Page composition and visual choices for the board |
| [Kumo design](skills/railhead-kumo-design/SKILL.md) | Kumo layout, text and component rules |
| [UI checklist](skills/railhead-ui-checklist/SKILL.md) | Accessibility, focus, forms and motion review of UI code |
| [Testing](skills/railhead-testing/SKILL.md) | Behavioral evidence and failure paths |
| [Review](skills/railhead-review/SKILL.md) | Verified defects and local OCR when configured |
| [Commits](skills/railhead-commits/SKILL.md) | Branches, commits, PRs and bounded follow-up |
| [Stacks](skills/railhead-gh-stack/SKILL.md) | Dependent branches and PRs |
| [Orca](skills/railhead-orca/SKILL.md) | Supervised runs, issue workers, panels and sweeps |
| [TypeSafe](skills/railhead-typesafe/SKILL.md) | Optional measured semantic-triage pilots |

`pnpm engineering:check` validates this setup and exercises startup in disposable
fixtures; `pnpm check` and CI include it. It checks wiring and local artifacts,
not model behavior, Orca settlement or live reviewer quality. The Orca binary's
version-matched guides own its runtime contract. No workers or recurring jobs
start simply because these instructions were installed.

Edit canonical skills here, preserving upstream notices. Update entry points in
the same change when a skill moves. Adding skills, providers, workflows or tools
is reviewed work; it does not grant publication or infrastructure authority.
Dependabot proposes dependency and Actions updates; people review them.
The issue-label workflow clears closed work claims. The PR template requests
actual validation. The CI workflow remains the source of truth for required checks.
