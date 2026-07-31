# Design System Plan: refactor closeout

Branch: `design-css-impro` · Reworked: 2026-07-30

## Goal

Make layout, alignment, and spacing in this codebase cheap to get right and
expensive to get wrong—for humans and for agents.

The end state is:

1. Common UI shapes have one documented semantic contract.
2. Shared contracts are asserted in tests, while platform-specific behavior is verified in
   the platform where it runs.
3. Design values use a small vocabulary of tokens without erasing intentional component
   geometry.
4. Existing alternatives are removed after their callers migrate.

This plan does not assume that every visual property can be inferred from geometry. Box
geometry, focus behavior, clipping, and token use are mechanically testable. Perceived icon
weight and final visual balance still require a deliberately small visual review surface.

## Governing principles

### Verify contracts, not implementation trivia

Tests should describe the behavior that must remain true:

- controls are semantic, reachable, and visibly focused;
- icon-only controls center a nonzero square icon;
- toolbars and settings rows use a declared layout primitive;
- public tokens can be overridden in supported themes;
- platform styles do not silently undo shared contracts.

Avoid global rules such as “every flexbox must declare `align-items`.” Stretch is sometimes
intentional, and a noisy rule trains contributors to add meaningless declarations. Enforce
alignment on the primitives and component families where alignment is part of the contract.

### Preserve before rationalising

The first token conversion should preserve current computed values. Odd values such as 11,
13, 17, 19, 22, 26, 34, and 38px must be classified before they are changed:

- semantic spacing;
- typography;
- component geometry;
- optical correction;
- a derived relationship suitable for `calc()`;
- unexplained legacy value.

Only semantic spacing should snap to the shared spacing scale. Intentional component
geometry gets a named component token. Unexplained values stay unchanged until measured.

### Shared shell does not mean identical render

All products originate from `shell.html`, but they do not render identically:

- extensions use the shared stylesheet;
- Electron imports `apps/electron/src/electron.css`;
- mobile appends `apps/mobile/src/mobile.css` after the shared stylesheet;
- mobile WebViews add viewport, safe-area, touch, and native-shell behavior;
- the reader document and presenters have separate documents/styles.

Shared primitive tests can run once. Platform override tests must run in each affected
renderer.

### User theming is future product work

The cascade and token contracts reserve a safe extension point, but implementing user themes
is not part of this refactor. Scope, persistence, validation, privacy, and recovery belong to
the separate [`design-system-theming-plan.md`](design-system-theming-plan.md).

---

## Completed work

The measured baseline, implementation history, and completed Phases 0–4 are
archived in [`design-system-completed.md`](design-system-completed.md). This
file retains the governing architecture and closeout criteria.

What Phases 0–4 actually landed — layer order, sheet ownership, primitives,
runtime-style rules, and the checks that enforce them — is documented as a
working contract in [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md).

No additional design-handoff package is required. `DESIGN_SYSTEM.md`,
`design-tokens.md`, `VISUAL_COMPARISON.md`, and `DEVELOPMENT.md` already provide
the styling contract, token catalog, visual-review process, and verification
commands. A separate `DESIGN_HANDOFF.md` and sample artifact would duplicate
those sources and create another contract that could drift.

### Remaining implementation notes

- Keep the visual comparison representative as later phases migrate ownership.
  The matrix captures live notification bubbles and the left-menu status dock
  on both web targets. Electron also captures the active reader `WebContents`
  directly because its native `WebContentsView` is not reliably present in a
  main-window screenshot. Retain native mobile visual acceptance as the final
  gate when mobile presentation changes.

---

## Target contracts

### Cascade

Trusted application CSS uses:

```css
@layer reset, tokens, base, components, platform, user;
```

All trusted stylesheet rules and runtime-generated rules are assigned to a named layer.
Inline styles are reserved for genuinely dynamic geometry/state or setting a documented
custom property; they are not a component styling API. Token defaults belong in the
low-priority `tokens` layer:

```css
@import "./parts/vars.css" layer(tokens);
@import "./parts/base.css" layer(base);
@import "./parts/primitives.css" layer(components);
```

This is essential: normal unlayered declarations outrank every normal named-layer
declaration. Leaving token defaults unlayered would prevent same-element overrides in
`layer(user)`.

Electron and mobile platform declarations must also enter `layer(platform)`. Because those
stylesheets are assembled differently, implementation must choose one explicit mechanism per
target:

- import a platform part through a target entry stylesheet with `layer(platform)`; or
- wrap the platform stylesheet contents in `@layer platform { ... }`.

Do not assume an independently loaded `<link>` or a TypeScript CSS import inherits a layer
from `style.css`.

### Tokens

Start with primitive values that preserve current behavior:

```css
:root {
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 24px;
  --sp-6: 32px;

  --fs-title: 16px;
  --fs-body: 14px;
  --fs-meta: 12px;
  --fs-label: 10px;

  --icon-sm: 12px;
  --icon-md: 16px;
  --icon-lg: 24px;
  --touch: 44px;

  --radius-sm: 2px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --bw: 1px;
}
```

Primitive tokens are not sufficient for every value. Add semantic or component tokens where
the relationship matters, for example `--toolbar-control-size` or
`--story-action-inline-offset`. Do not create aliases such as `--size-13` merely to satisfy
lint.

### Button

The public markup contract is a native `<button>`:

```html
<button type="button" class="button button--icon" aria-label="Reload stories">
  <span class="icon icon--chrome icon--reload" aria-hidden="true"></span>
</button>
```

Rules:

- interactive actions use `<button type="button">`;
- form submission uses `<button type="submit">`;
- links that navigate remain `<a href>`;
- icon-only controls require an accessible name;
- `.button` is the one component class;
- modifiers describe supported variants;
- no `.btn` compatibility selector remains at the end of the migration;
- existing `<input type="button">`, clickable `.sub`, `.btn`, and `icon-btn` callers are
  audited and migrated rather than ignored.

The primitive owns display, centering, gap, typography inheritance, focus-visible styling,
disabled behavior, and icon sizing. The platform layer may adjust density and touch target
without replacing the contract.

### Icon

```css
.icon {
  display: inline-block;
  inline-size: var(--icon-size);
  block-size: var(--icon-size);
  flex: none;
  background-color: currentColor;
  mask: var(--icon) center / contain no-repeat;
  -webkit-mask: var(--icon) center / contain no-repeat;
}

.icon--chrome {
  --icon-size: var(--icon-md);
}

.icon--inline {
  --icon-size: 1em;
  vertical-align: -0.125em;
}
```

Required custom properties intentionally have no fallback. An incomplete icon contract must
render invalidly and fail the geometry test instead of looking plausibly undersized.

Per-icon classes define `--icon`; call sites do not carry inline `style` declarations.
Chrome and inline variants remain separate because fixed control geometry and text baseline
alignment are different contracts.

### Layout primitives

`parts/primitives.css` initially provides only primitives demonstrated by repeated current
use:

- `.row`: non-wrapping inline axis, declared cross-axis alignment and gap;
- `.stack`: block-axis layout and gap;
- `.cluster`: wrapping inline grouping and gap;
- `.field`: label/control relationship;
- `.toolbar`: control group with an explicit alignment contract.

Primitives should be composable and low-specificity. Component CSS owns component geometry.
Do not replace every flex/grid declaration merely to increase primitive adoption counts.

## Verification commands and release gates

Add stable scripts rather than requiring contributors to remember raw Playwright commands:

```text
npm run lint:css
npm run test:design-system
npm run test:design-system:electron
npm run test:design-system:mobile
```

Existing required gates remain:

```text
npm run check
npm run test:extensions
npm run test:electron:e2e
npm run test:mobile:web
```

Native Android/iOS visual and interaction gates are required for changes to safe-area,
touch, keyboard, or native WebView behavior. Web/unit checks do not count as native release
delivery.

Because `npm run check` can replace the mobile `--e2e` bundle, test scripts must rebuild or
verify their expected bundle stamp before running.

---

User theming is tracked separately in
[`design-system-theming-plan.md`](design-system-theming-plan.md). It is not a closeout gate
for this refactor.

## Definition of done

- Primitive-specific lint is at error level.
- Shared, Electron, mobile-web, and applicable native gates are green.
- Native buttons and links express interaction semantics; legacy button alternatives are
  removed.
- Icon integrity is mechanically tested and optical review is explicitly approved.
- Required accessibility/reduced-motion utilities are documented and tested exceptions.
- No icon color-filter hacks remain.

## Non-blocking follow-up

Adding axe-core or an equivalent semantic accessibility pass remains an optional harness
enhancement, not a refactor closeout gate. The icon optical target and odd-geometry
classification decisions were completed in Phases 4 and 1 respectively. The theming owner
decisions moved to [`design-system-theming-plan.md`](design-system-theming-plan.md).
