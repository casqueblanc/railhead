# TypeSafe skill provenance

The bundled [upstream skill](references/typesafe-ai/SKILL.md) and its
[license](references/typesafe-ai/LICENSE) come from
[typesafe-ai/skills](https://github.com/typesafe-ai/skills/tree/65a39f393687675ce170e6094757de20370365b9/skills/typesafe-ai),
revision `65a39f393687675ce170e6094757de20370365b9`, licensed under MIT.
Copyright (c) 2026 TypeSafe AI. Upstream files are preserved unchanged.
The Origin89 entrypoint and development guidance are also licensed under MIT.

Chantier adapted the entrypoint and development guidance locally, and Foreman
imports that adaptation from casqueblanc/chantier at
`c0add66316e71d786b2e69c0d6e0a0d0cf1c1ae4` with Foreman names and commands. The bundled
upstream reference and its license are preserved. To update, inspect a reviewed
upstream revision in a disposable checkout, replace the reference and license
together, record the revision here and run `pnpm check`. This monorepo uses no
external engineering bootstrap or separate skills lockfile.
