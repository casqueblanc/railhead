---
name: railhead-kumo-design
description: Choose and compose Kumo components and apply their typography, layout and interaction rules when building or reviewing the Railhead board.
license: MIT
---

# Railhead Kumo design

Adapted from the kumo-design skill in Cloudflare's Kumo repository. See
[NOTICE.md](NOTICE.md) and [LICENSE](LICENSE) for upstream provenance and terms.

## Railhead scope

The board in `packages/railhead-frontend` is built directly on Kumo, so these rules apply to
it as written, with these exceptions:

- Railhead has no brand palette yet. Kumo's default tokens are the look until one is chosen,
  and that choice is made once, in the `@theme` block of
  `packages/railhead-frontend/src/styles.css`. Never restyle a Kumo component per screen and
  never add a colour literal or a feature-local token; change the shared theme and check
  the screens it touches.
- "Product names must be title-cased" means Railhead.

Use these rules together with
[railhead-frontend-conventions](../railhead-frontend-conventions/SKILL.md) for code
organization, [railhead-frontend-design](../railhead-frontend-design/SKILL.md) for visual
direction and [railhead-ui-checklist](../railhead-ui-checklist/SKILL.md) before handing off.

## Choose and compose components

Import from `@cloudflare/kumo` and take icons from `@phosphor-icons/react`. Prefer Kumo's
props and compound components before custom markup or style overrides. Add a shared
`packages/ui` package only when a composition has a second independent consumer; until
then a composition lives with the feature that owns it.

Use the installed version's reference to verify props, defaults and composition:

```sh
pnpm --filter @railhead/frontend exec kumo ls
pnpm --filter @railhead/frontend exec kumo doc Text
pnpm --filter @railhead/frontend exec kumo doc Dialog
```

Replace `Text` or `Dialog` with the component being used. For broader patterns,
use [Kumo's documentation index](https://kumo-ui.com/llms.txt) and read only the
linked pages needed for the task. Online docs can describe a newer API or retain
older examples; resolve discrepancies against installed types and source.

- Use a control's `label`, `description` and `error` props when available, or
  `Field` around a control that needs them. Preserve the documented label and
  control association rather than rebuilding it with adjacent text.
- Choose `Select` for a fixed choice, `Combobox` for searchable choices and
  `Autocomplete` for free-form input with suggestions. Read their composition
  examples before choosing triggers and popup content.
- Use overlay roots, triggers, titles and close controls together. Compose a
  Kumo `Button` with a trigger's `render` prop; preserve the supplied props so
  keyboard, focus and open-state behavior survive composition.
- Use `LayerCard.Primary` and `LayerCard.Secondary` for sections within one card.
  Put the card's own label directly in `Secondary` to inherit its styling. For
  a table under a section heading, use a single `LayerCard className="p-0"`.
- Prefer `Button`'s `variant`, `icon`, `shape` and `loading` props over recreating
  those states. Give an icon-only action an accessible name.
- Use `Empty` for an empty section and `SkeletonLine` for loading at the final
  content's dimensions. Keep status badges neutral unless attention is needed.

Kumo blocks are copied source owned by the application, not package exports.
Review a block's dependencies and adapt it to Railhead's imports and architecture
before adopting it. Do not run setup or install blocks merely to look up a
component. Verify the result in a browser and the relevant UI tests; fix any
Kumo deprecation warning rather than suppressing it.

## Upstream rules

Apply these rules when designing, implementing, or reviewing Cloudflare product interfaces. Follow recommended examples and avoid patterns marked as examples to avoid.

### Rules

#### `content-text-size` Use 14px for content text

Use 14px for ordinary body text, buttons and data. `Text` defaults to 14px body
text; `size="lg"` on body text makes it 16px. Keep the established secondary-label
and key-figure treatments in shared compositions such as `QuoteEditor`; their
amounts are data, not semantic headings. Do not enlarge all data or shrink body
copy merely to imitate those accents.

**Good**

```tsx
<Text>Content text</Text>
```

**Avoid**

```tsx
<Text size="lg">Content text</Text>
```

#### `heading-case` Always sentence case headings

Never capitalize or uppercase headings. Product names must be title-cased.
Choose the semantic `as` level from the document outline, independently of size.
Use `variant="heading"` without `size` for 16px, or with `size="lg"` for 20px.
The heading type accepts only `size="lg"`; `size="base"` is a body-text option.
The supported `Text` heading scale stops at 20px; do not revive the deprecated
`heading1`, `heading2` or `heading3` variants for larger titles. This is the
component's API limit, not a ban on the larger key figures or standalone sign-in
title already owned by shared compositions. Page titles normally use `heading`
with `size="lg"`; section headings use its 16px default. The heading variant
defaults to a `span`, so set `as` explicitly for semantic headings.

**Good**

```tsx
<Text as="h2" variant="heading" size="lg">Recent requests</Text>
```

**Avoid**

```tsx
<Text as="h2" variant="heading" size="lg">Recent Requests</Text>
```

```tsx
<Text as="h2" variant="heading" size="lg" DANGEROUS_className="uppercase">
  Recent requests
</Text>
```

#### `font-tracking` Never change the font's tracking

Do not use the `tracking-*` classes to change the spacing between characters.

**Good**

```tsx
<Text as="h3" variant="heading">Worker metrics</Text>
```

**Avoid**

```tsx
<Text as="h3" variant="heading" DANGEROUS_className="tracking-tight">
  Worker metrics
</Text>
```

#### `font-weight` Never use `font-bold`

Use `font-semibold` for headings and `font-medium` for bold inline text.

**Good**

```tsx
<Text as="h3" variant="heading" size="lg">Account settings</Text>
<Text as="strong" bold>required</Text>
```

**Avoid**

```tsx
<Text as="h3" variant="heading" DANGEROUS_className="font-bold">Account settings</Text>
<Text as="strong" DANGEROUS_className="font-bold">required</Text>
```

#### `related-text-spacing` Put related text closer together

Related text should have smaller spacing around it than the content it belongs to.

**Good**

```tsx
<div className="grid gap-6">
  <div className="grid gap-1.5">
    <Text as="h3" variant="heading">Web analytics</Text>
    <Text>Measure site traffic without changing your code.</Text>
  </div>
  <Button>Configure</Button>
</div>
```

**Avoid**

```tsx
<div className="grid gap-4">
  <Text as="h3" variant="heading">Web analytics</Text>
  <Text>Measure site traffic without changing your code.</Text>
  <Button>Configure</Button>
</div>
```

#### `text-spacing` Optically align spacing around text

Spacing around text should take into account its line height. Typically this means vertical spacing should be slightly smaller than horizontal.

**Good**

```tsx
<LayerCard className="px-5 py-4">...</LayerCard>
```

**Avoid**

```tsx
<LayerCard className="p-5">...</LayerCard>
```

#### `hover-color-transitions` Never transition colors for hover states

Color changes on hover must be immediate. Transitions on fast interactions make the UI feel sluggish.

**Good**

```tsx
<button className="hover:bg-kumo-tint">...</button>
```

**Avoid**

```tsx
<button className="transition-colors duration-300 hover:bg-kumo-tint">
  ...
</button>
```

#### `shadow-borders` Never use borders with drop shadows

Use `ring ring-kumo-line` to create a transparent border that maintains sharp edges.

**Good**

```tsx
<LayerCard className="shadow-md ring ring-kumo-line">...</LayerCard>
```

**Avoid**

```tsx
<LayerCard className="border border-kumo-line shadow-md">...</LayerCard>
```

#### `concentric-border-radius` Use concentric border radii

When borders or rings are 8px or less apart, their corner radii must be mathematically concentric: outer radius = inner radius + padding.

**Good**

```tsx
<div className="rounded-xl p-1">
  <div className="rounded-lg">...</div>
</div>
```

**Avoid**

```tsx
<div className="rounded-xl p-1">
  <div className="rounded-xl">...</div>
</div>
```

#### `icon-alignment` Align icons with the first line of text

Inline icons must be optically the same size as and be center-aligned with text. Use `h-lh flex items-center` for multi-line alignment.

**Good**

```tsx
<div className="flex items-start gap-2">
  <span className="h-lh flex items-center">
    <Icon />
  </span>
  <Text>Text that may wrap onto multiple lines</Text>
</div>
```

**Avoid**

```tsx
<div className="flex items-start gap-2">
  <span className="flex items-center">
    <Icon />
  </span>
  <Text>Text that may wrap onto multiple lines</Text>
</div>
```

```tsx
<div className="flex items-center gap-2">
  <Icon />
  <Text>Text that may wrap onto multiple lines</Text>
</div>
```

#### `inline-monospace-size` Reduce the font size of inline monospaced text

Monospaced text should have a slightly smaller font size (~0.9em) when mixed with regular text.

**Good**

```tsx
<Text>
  Edit <span className="font-mono text-[0.9em]">wrangler.toml</span> to
  continue.
</Text>
```

**Avoid**

```tsx
<Text>
  Edit <span className="font-mono">wrangler.toml</span> to continue.
</Text>
```

#### `sticky-borders` Use `border` to separate sticky elements from the content

**Good**

```tsx
<div className="sticky top-0 border-b border-kumo-line">...</div>
```

**Avoid**

```tsx
<div className="sticky top-0">...</div>
```

#### `collapse-content-size` Maintain content size during collapse animations

Collapsible content must maintain its content size while closing to avoid its content shifting during animations.

**Good**

```tsx
<motion.div animate={{ width: open ? 256 : 0 }}>
  <div className="w-64">...</div>
</motion.div>
```

**Avoid**

```tsx
<motion.div animate={{ width: open ? 256 : 0 }}>
  <div className="w-full min-w-0">...</div>
</motion.div>
```

#### `layer-card-nesting` Never stack `LayerCard` on top of one another

Compose sections with `LayerCard.Primary` and `LayerCard.Secondary` inside a
single `LayerCard` when the content belongs to the same card.

**Good**

```tsx
<LayerCard>
  <LayerCard.Secondary>Request summary</LayerCard.Secondary>
  <LayerCard.Primary>...</LayerCard.Primary>
</LayerCard>
```

**Avoid**

```tsx
<LayerCard>
  <Text as="h3" variant="heading">Recent requests</Text>
  <LayerCard>...</LayerCard>
</LayerCard>
```

#### `dialog-rendering` Never conditionally render dialogs

Conditionally rendering dialogs disables their open/close animation. Use the `open` prop to determine if a dialog should be visible or not.

**Good**

```tsx
<Dialog.Root open={open} onOpenChange={setOpen}>
  <Dialog.Trigger render={(props) => <Button {...props}>Edit worker</Button>} />
  <Dialog size="sm" className="space-y-4 p-6">
    <Dialog.Title className="font-semibold text-lg">Edit worker</Dialog.Title>
    <Dialog.Description>Update this Worker's settings.</Dialog.Description>
    <div className="flex justify-end gap-2">
      <Dialog.Close render={(props) => <Button {...props} variant="ghost">Close</Button>} />
    </div>
  </Dialog>
</Dialog.Root>
```

**Avoid**

```tsx
{
  open && (
    <Dialog.Root open>
      <Dialog>
        <Dialog.Title>Edit worker</Dialog.Title>
      </Dialog>
    </Dialog.Root>
  );
}
```
