---
name: foreman-frontend-design
description: Plan and critique Foreman board pages, interactions and visual hierarchy within Kumo. Use when building or reshaping a board page; finish with foreman-ui-checklist.
license: Apache-2.0
---

# Foreman frontend design

Adapted from Anthropic’s frontend-design skill. See [NOTICE.md](NOTICE.md) and
[LICENSE](LICENSE) for upstream provenance and terms.

## Foreman scope

The brief is already pinned, and the upstream text says the brief wins. Apply its
process and restraint inside these constraints rather than re-deciding them:

- The board is a product interface built on Cloudflare Kumo, not a marketing page.
  Prefer a Kumo component to a new one and follow
  [foreman-kumo-design](../foreman-kumo-design/SKILL.md). Organize the code under
  [foreman-frontend-conventions](../foreman-frontend-conventions/SKILL.md).
- Foreman has no brand palette yet. Until one is chosen, Kumo's default tokens are the
  identity; do not invent a palette, a typeface or a per-screen theme. A brand is one
  application-level decision, made in `packages/foreman-frontend/src/styles.css`.
- The design in issue #1 and its later comments decides what the board shows. Do not
  invent a metric, a state or a promise for persuasive copy, and label anything
  simulated as simulated.
- Check a 360 px viewport, keyboard focus and reduced motion, and take screenshots of
  what you changed. Finish with [foreman-ui-checklist](../foreman-ui-checklist/SKILL.md).

## Design a board page

For the board, this process replaces the upstream palette, typeface and hero
planning steps. Reuse the existing font and tokens; plan the page's composition
within them. Keep the upstream guidance for visual restraint and critique.

Before coding, identify the person using the page, the decision they need to make
and the action that moves the work forward. Inspect the nearest existing screen
and its components, then sketch the hierarchy with realistic copy and synthetic
data. Keep a compact plan in the task conversation: the person and decision,
primary action, desktop and phone arrangement, and applicable states. Do not
write a separate design report.

- Make authority visible. A person should be able to read why something is
  waiting, what exactly a check covered, which decision is pending and why a
  change may or may not merge, without opening a log.
- Put the current situation and next action before supporting detail. Use one
  dominant action per decision area, with quieter secondary actions. Colour,
  spacing and placement should agree about what matters.
- Choose structure from the content: a table for comparisons, a list for work
  items, a timeline for ordered events, or a form for a decision. Group content
  in cards only when it belongs together; avoid a grid of equally prominent
  cards merely to fill the page.
- Establish hierarchy through alignment, whitespace, density and Kumo's type
  scale. Keep comparable values aligned and labels close to their values.
- Plan loading, empty, blocked, stale, failed and recovered states where they
  apply. Preserve entered work after failure and make the next step clear; use
  the same action names throughout.
- Decide what wraps, stacks or scrolls on narrow screens. Keep the primary task
  usable at 360 px with long names and realistic text. Retain information needed
  for decisions instead of hiding it to fit.

Name the object and effect of a consequential action: "Supersede this decision"
is clearer than "Confirm". Keep the action's wording consistent through its
dialog, pending state and outcome. Show failures next to the affected work and
preserve entered values so recovery does not mean starting again.

### Critique the page

Build one coherent page with existing Kumo compositions, then inspect it in a
real browser: `pnpm dev-server` serves the built board and the API on one
origin, and `pnpm dev-client` adds hot reload. Review screenshots at phone and
desktop widths; exercise the primary action, keyboard navigation and applicable
failure states. Judge the screenshots with these questions:

- At a glance, do the situation and next decision stand out before supporting detail?
- Does every accent earn its attention?
- At 360 px, can the person reach the primary action without horizontal page
  scrolling or clipped text?
- Read only headings and buttons: do they explain the flow in the reader's words?

Fix the weakest answer, then inspect again. State the material design choices,
what was actually exercised and any unavailable browser evidence at handoff.
[Kumo design](../foreman-kumo-design/SKILL.md) owns component APIs and
composition; the [UI checklist](../foreman-ui-checklist/SKILL.md) owns the detailed
accessibility and interaction review.

### Verify the flow

Follow [testing](../foreman-testing/SKILL.md) for behavior coverage. Component
and hook tests sit beside their subject and verify local interactions and
outputs. For a changed nontrivial UI flow, cover success, invalid input, a
meaningful boundary and failure or recovery where applicable. Assert the visible
result and resulting state, including forbidden effects for refused actions. A
screenshot or a successful click alone cannot establish that a decision or a
merge worked. The repository has no browser end-to-end suite yet: say which
flows were exercised by hand and which were not.

## Upstream guidance

Approach this as the design lead at a design studio known for giving every client a distinct visual identity that is not mistaken for anyone else's. This client has already rejected proposals that felt cliché or templated, and is paying for a distinctive point of view: make deliberate, opinionated choices about palette, typography, and layout that are specific to this brief, and take aesthetic risk if justified.

### Ground your designs in the subject matter

If the brief does not identify what the product or subject matter is, identify it yourself before designing, and confirm with the client. You can come up with one concrete subject, the design's audience, and the design's primary job, as a proposal. If there's any information in your memory about the client's preferences or context about what they're building, use that as a hint. The subject's industry, subject matter, materials, and vernacular are where distinctive visual choices come from — a design for a toy for girls aged 8–11 will be very aesthetically different from a dashboard for financial analysts. Build with the brief's real content and subject matter throughout.

### Design principles

For web designs, the hero is the first thing viewers will see. Open with the most characteristic thing in the subject's world, in the form that is most appropriate: a headline, an image, an animation, a live demo, an interactive moment, or other treatments. Be deliberate with your choice: a big number with a small label, supporting stats, and a gradient accent is the default treatment, so only use it if that's truly the best option.

Typography carries the personality of the page. You don't need a different typeface for display or headline text and body content: use one family or two, and if two, make them clearly distinct.

Choose your typefaces deliberately, not the default families you would reach for on any other project, and set a clear type scale following the default guidance of The Elements of Typographic Style with intentional weights, widths, and spacing. When type is used as a headline or visual element, use the type treatment itself as an active part of the design, not a neutral delivery vehicle for the content.

Default to line lengths of less than 80 characters. Serif typefaces can have slightly longer line lengths; give serif body text slightly more line-height than a sans-serif.

Avoid these default typographic treatments; they are the commonest tells of a generated page:
- Accenting just a single word or phrase in a headline, like putting one word in italic/bold or a different color.
- Using all caps for labels.
- Adding unnecessary typographic labels above content.

Visual structure is information. Structural devices like outlines, borders, numbering, eyebrows, dividers, labels, etc., encode useful information about the content rather than decorate it. Many generic designs use numbered markers (01 / 02 / 03), but that's only appropriate if the content actually is a sequence — like a stepped process or a timeline. Before adding numbered markers, check the content really is a sequence.

Use non-user-triggered motion sparingly and deliberately, only to draw attention. A single orchestrated moment — one page-load sequence or one reveal — lands better than scattered effects; fade-and-slide-up entrances on each section and hover transitions on every card are the generic default and read as AI-generated. Motion that answers a person's action (opening, expanding, confirming) is welcome when it shows what changed.

Consider written content carefully. Often a design brief may not contain real content, and it's up to you to come up with copy and placeholder content. Copy can make a design feel as templated as the design itself. See the below section on writing for more guidance.

### Process: plan, review against the brief, build, critique

For calibration, AI-generated design right now clusters around some traits:
1. a warm cream background (near #F4F1EA) with a high-contrast serif display and a terracotta or warm-clay accent (often near #D97757 — Anthropic's own Claude-interaction accent, so on a user's brief it reads as a tell);
2. a near-black background with a single bright acid-green or vermilion accent;
3. a broadsheet-style layout with hairline rules, zero border-radius, and dense newspaper-like columns;
4. the SaaS-card kit: content chopped into identical rounded cards, one border-radius on everything regardless of hierarchy, the same soft grey shadow (rgba(0,0,0,.1)) under each, and gradient washes as decoration;
5. template chrome that appears whatever the subject: a tracked-out ALL-CAPS eyebrow label above every heading; meta strings joined with middle dots ('A · B · C'); labels built as 'WORD — fragment' with a spaced em dash; tinted near-black (#0B0B0B, #111) standing in for black; a monospace face for small data labels; a '→' appended to link and button text.

All traits are legitimate for some briefs, but they are defaults rather than choices, and they appear regardless of subject. Where the brief pins down a visual direction, follow it exactly — the brief's own words always win, including when it asks for one of these looks. Where it leaves an axis free, don't spend that freedom on one of these defaults. As with a hired human designer, there's often a careful balance between doing what you're good at and taking each project as a chance to experiment and learn.

Work in two passes. First, brainstorm a short design plan based on the client's design brief: create a compact token system with color, type, layout, and principles.
- Color: describe the core base palette as 4–6 named hex values.
- Type: the typefaces and their roles.
- Layout: a layout concept, using one-sentence prose descriptions and ASCII wireframes to ideate and compare. Include alignment guidance; should the content be left aligned, center aligned, justified?
- Principles: the high-level guidance for what makes this page unique.

Then review that plan against the brief before building: if any part of it reads like the generic default you would produce for any similar page (work through a similar prompt to see if you arrive somewhere similar) rather than a choice made for this specific brief — revise that part, say what you changed and why. Only after you've confirmed the relative uniqueness of your design plan should you start to write the code, following the revised plan.

When writing the code, be careful of structuring your CSS selector specificities. It's easy to generate CSS classes that cancel each other out (especially with a type-based selector like .section and an element-based selector like .cta). This can happen often with padding/margin between sections.

### Restraint and self-critique

Spend your boldness in one place. Let one element be the memorable thing, keep everything around it quiet and disciplined, and cut any decoration that does not serve the brief. Build to a quality floor without announcing it: responsive down to mobile, visible keyboard focus, reduced motion respected, visually accessible, harmonious color palettes. Critique your own work as you build, taking screenshots to review if your environment supports it — a picture is worth 1000 tokens. Consider Chanel's advice: before leaving the house, take a look in the mirror and remove one accessory. Human creatives have memory and always try to do something new, so if you have a space to quickly jot down notes about what you've tried, it can help you in future passes.

### More on writing in design

Words appear in a design for one reason: to make it easier to understand and use. They are design content, not decoration. Bring the same intentionality and minimalism to copywriting that you would bring to spacing and color. Before writing anything, ask what the design needs to say, and how it can best be said to help the person navigate the experience.

Write from the end user's perspective. Name things by what users will understand in simple language, not by how the system is built. A user manages notifications, not webhook config. Describe what something is or does in plain terms rather than selling it. Being specific and legible to new users is always better than being clever.

Use active voice as default. A CTA says exactly what happens when it is used: "Save changes," not "Submit." An action keeps the same name through the whole flow, so the button that says "Publish" produces a toast that says "Published." The vocabulary of an interface is the signposting for someone navigating the product. Cohesion and consistency are how people learn their way around.

Treat failure and emptiness as moments for direction, not mood. Explain what went wrong and how to fix it, in the interface's voice rather than a person's. Errors don't apologize, and they are never vague about what happened. An empty screen is an invitation to act.

Keep the tone conversational: plain verbs, sentence case, no filler, with tone matched to the brand and the audience. Let each written element do exactly one job.
