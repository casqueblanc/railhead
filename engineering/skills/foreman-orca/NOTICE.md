# Upstream notice

This skill adapts material from pstack by Lauren Tan (poteto),
licensed under MIT. The full upstream license is included in LICENSE.

Reviewed revision: `ecc249f1e306fc64ddf83c7bed16cacf7c2239db` (2026-09-25).

- https://github.com/cursor/plugins/blob/ecc249f1e306fc64ddf83c7bed16cacf7c2239db/pstack/skills/interrogate/SKILL.md
- https://github.com/cursor/plugins/blob/ecc249f1e306fc64ddf83c7bed16cacf7c2239db/pstack/skills/arena/SKILL.md
- https://github.com/cursor/plugins/blob/ecc249f1e306fc64ddf83c7bed16cacf7c2239db/pstack/skills/swarm/SKILL.md
- https://github.com/cursor/plugins/blob/ecc249f1e306fc64ddf83c7bed16cacf7c2239db/pstack/skills/poteto-mode/playbooks/autonomous-run.md
- https://github.com/cursor/plugins/blob/ecc249f1e306fc64ddf83c7bed16cacf7c2239db/pstack/docs/guide/07-overnight.md

Origin89 modifications: Orca orchestration workers and automations replace
Cursor subtasks, cloud agents, and `/loop`; agent families replace per-role model
configuration; review verification follows `origin89-review`; workers inherit the
coordinator's authorization and never operate equipment; decision logs stay
uncommitted. pstack's model defaults, Cursor rules, playbook router, and
principle skills are not adopted.

Foreman modifications: imported through casqueblanc/chantier at
`c0add66316e71d786b2e69c0d6e0a0d0cf1c1ae4`, with Foreman names, pnpm commands and review focus in place of
Chantier's.
