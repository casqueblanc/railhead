# Foreman review and coding instructions

Read root [AGENTS.md](../AGENTS.md), including Code Review Rules. Coding tasks
start with `pnpm run-start` and read
`engineering/skills/foreman-working/SKILL.md` and
`engineering/skills/foreman-writing/SKILL.md`. Hosted reviews read the tracked
skills directly and keep review-only scope; no startup or network refresh is needed.
Use [review](../engineering/skills/foreman-review/SKILL.md),
[TypeScript](../engineering/skills/foreman-typescript/SKILL.md),
[testing](../engineering/skills/foreman-testing/SKILL.md) and, for React code,
[frontend conventions](../engineering/skills/foreman-frontend-conventions/SKILL.md)
for the changed behavior.

Trace who may perform an action, capability scope and disposal, whether current
ownership is checked at the time of use, RPC validation, untrusted repository
content and agent text, token handling and uncertain-write recovery through real
callers. Require Worker-runtime tests with real bindings. Report verified defects
with location, trigger, consequence and fix; avoid preferences and speculation.
Keep evidence tied to the current head and disclose unavailable checks or
guidance. pnpm only, Vite+ (Oxlint and Oxfmt) only, no attribution in issues,
commits or PRs. Root project constraints and issue amendments prevail.
