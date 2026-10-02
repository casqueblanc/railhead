# Upstream notice

This skill adapts the frontend-design skill from anthropics/skills by Anthropic,
licensed under Apache-2.0. The full upstream license is included in LICENSE.

Reviewed revision: `41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f` (2026-09-03).

- https://github.com/anthropics/skills/tree/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/frontend-design
- https://github.com/anthropics/skills/blob/41bbe19d1a1a7eaab5e7bb9050a417e5c6cffc8f/skills/frontend-design/LICENSE.txt

Chantier modifications: namespaced discovery, a scope section that pins the Casque
Blanc brand, components, vocabulary and product rules, and a hand-off to
chantier-ui-checklist. The upstream guidance follows unchanged under its own heading.

When updating, review the upstream entrypoint and update this provenance.

Railhead modifications: imported through casqueblanc/chantier at
`c0add66316e71d786b2e69c0d6e0a0d0cf1c1ae4`. The scope and page-design sections are rewritten for the
Railhead board: Kumo's default tokens instead of the Casque Blanc brand, and no Storybook,
Playwright or Québec French rules. The upstream guidance still follows unchanged.
