# Design System Plan: verifiable CSS, primitives, and user theming

Branch: `design-css-impro` · Reworked: 2026-07-30

## Goal

Make layout, alignment, spacing, and theming in this codebase cheap to get right and
expensive to get wrong—for humans and for agents.

The end state is:

1. Common UI shapes have one documented semantic contract.
2. Shared contracts are asserted in tests, while platform-specific behavior is verified in
   the platform where it runs.
3. Design values use a small vocabulary of tokens without erasing intentional component
   geometry.
4. User theming has an explicit public surface, recovery path, and security/privacy model.
5. Existing alternatives are removed after their callers migrate.

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

### User CSS is either constrained or explicitly unsafe

CSS cascade layers organize trusted styles; they are not a sandbox. Arbitrary CSS can close
an injected wrapper, create unlayered rules, use `!important`, hide recovery UI, and request
remote resources permitted by CSP.

The product therefore exposes two clearly different contracts:

- **Tier 1: supported token themes.** A versioned set of custom properties. These are
  validated before storage. Color themes are safe by construction; density values use
  documented ranges. This is the promoted path.
- **Tier 2: advanced custom CSS.** May break on update, obscure the UI, and make network
  requests through permitted CSS URLs. It is either parsed and restricted, or labelled
  explicitly as unrestricted. A cascade layer alone must never be described as containment.

---

## Completed work

The measured baseline, implementation history, and completed Phases 0–4 are
archived in [`design-system-completed.md`](design-system-completed.md). This
file contains only the governing architecture and remaining work.

What Phases 0–4 actually landed — layer order, sheet ownership, primitives,
runtime-style rules, and the checks that enforce them — is documented as a
working contract in [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md). Phases 5 and 6
below extend that contract; they do not replace it.

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

---

## Phase 5 — Theming architecture

### 5.1 Decide scope

Explicitly choose and document which surfaces are themed:

- shell;
- reader document;
- outline presenter;
- other presenter iframes;
- Electron browser/error surfaces.

Each included separate document needs its own token stylesheet and application/injection
path. Excluded surfaces are stated as product limitations.

### 5.2 Define the public token and selector API

Document:

- supported color tokens;
- supported density/type tokens and accepted ranges;
- stable `data-part` selectors;
- versioning/deprecation policy;
- unsupported internal class names.

Add `data-part` only where a real public styling use case exists. First-party skins should
exercise the same public surface.

### 5.3 Extend settings and persistence deliberately

Add typed APIs for theme mode and custom theme data across:

- core settings types;
- `OnceClient`;
- settings persistence;
- settings-change events;
- platform theme adapters;
- UI restore/save/subscription behavior.

Do not cast `"custom"` to the existing `ThemeName` union.

Decide whether custom theme data syncs through Pouch. Keep the emergency disable flag local
to each installation so a broken synced skin cannot disable recovery everywhere.

The settings UI requires explicit loading, ready, validation-error, save-error, reset, and
preview states.

### 5.4 Tier 1 supported themes

Store a structured token map, not a CSS string. Validate:

- token name is public;
- color syntax is allowed;
- numeric values fall within documented ranges;
- URL-bearing values are rejected;
- unknown tokens are preserved or rejected according to a documented forward-compatibility
  policy.

Render the validated map into `layer(user)`. Add tests proving overrides work on same-element
defaults and across platform layers.

Ship two or three first-party themes, including at least one density variation.

### 5.5 Tier 2 advanced CSS

Choose one model:

**Restricted CSS**

- parse with a real CSS parser;
- reject `@import`, external `url()`, `@font-face`, unapproved at-rules, and disallowed
  selectors/properties;
- reconstruct the accepted AST inside `layer(user)`;
- reject malformed input rather than interpolating it.

**Unrestricted CSS**

- state that layers are organizational, not containment;
- warn that CSS can hide UI, break layout, and request remote resources permitted by CSP;
- do not claim privacy isolation;
- retain a local, out-of-band recovery mechanism.

Do not interpolate an arbitrary string into `@layer user { ${css} }` and describe it as
unable to escape.

### 5.6 Recovery

Provide all of:

- live preview that is not persisted until explicit save;
- automatic rollback of an unconfirmed preview;
- a local “disable custom theme on next start” flag;
- a keyboard recovery chord handled independently of styled controls;
- a startup query/flag or platform menu recovery path where practical;
- last-known-good theme data.

“Reached interactive” is not sufficient health detection: a skin can leave the app running
while hiding the settings entry point.

### Phase 5 exit

- typed settings path with no unsafe theme cast;
- Tier 1 themes validated, synced according to the chosen policy, and tested;
- Tier 2 security/privacy behavior accurately documented and tested;
- hostile theme cannot permanently lock out recovery;
- every in-scope document receives the intended theme;
- first-party themes use only public tokens and `data-part` hooks.

---

## Phase 6 — Design handoff rules

Add `docs/DESIGN_HANDOFF.md` and point design-generation work at it.

Rules:

1. Reference tokens by name; never inline a resolved value.
2. If a value has no token, propose a semantic token and explain its scope.
3. Put classes in one stylesheet/style block, not hundreds of inline attributes.
4. Produce one responsive artifact using container queries where the component owns the
   responsive boundary.
5. Use documented `data-part` hooks.
6. Show all supported themes and representative density settings.
7. Include “details that caused bugs” and a testable definition of done.
8. Identify which checks are mechanical and which require visual approval.

### Phase 6 exit

- handoff document references the actual token catalog and primitives;
- a sample generated artifact passes token/inline-style checks;
- light/dark and narrow/wide review states are present;
- its definition of done maps to repository test commands.

---

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

## Sequencing

| Phase | Depends on | Risk | Primary result |
|---|---|---:|---|
| 5 Theming architecture | 1, 2, 3 | high | Supported tokens, explicit advanced-CSS risk |
| 6 Design handoff | 1, 3 | low | Transferable design artifacts |

Phase 5 is not “small”: persistence, platform
adapters, validation, privacy, and recovery make it a product architecture phase.

## Definition of done

- Primitive-specific lint is at error level.
- Shared, Electron, mobile-web, and applicable native gates are green.
- Native buttons and links express interaction semantics; legacy button alternatives are
  removed.
- Icon integrity is mechanically tested and optical review is explicitly approved.
- Required accessibility/reduced-motion utilities are documented and tested exceptions.
- No icon color-filter hacks remain.
- A first-party token theme changes color and density without internal class names.
- Advanced CSS is either parsed/restricted or accurately labelled unrestricted.
- A hostile or broken theme cannot permanently lock the user out.
- Reader/presenter/theming scope is explicit rather than accidental.

## Owner decisions

1. Which surfaces are in the theming contract: shell, reader, presenters, and Electron
   auxiliary surfaces.
2. Whether Tier 2 CSS is restricted through parsing or intentionally unrestricted.
3. Whether custom theme data syncs; the recovery-disable flag should remain local.
4. Allowed density ranges for Tier 1 tokens.
5. Icon optical target and `story.svg` redraw after reviewing actual-size candidates.
6. Which odd geometry values are intentional component/optical contracts.
7. Whether to add axe-core to the design-system E2E harness.
