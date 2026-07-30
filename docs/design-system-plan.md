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

## Current state (measured 2026-07-30)

Evidence was gathered on `main` at `7f17cce`. Refresh the measurements before implementation
if the base commit changes.

The icon measurements are reproducible with:

```text
node docs/tmp-icons/measure-icons.js
```

The comparison page, candidates, measurement details, and open taste decisions live in
[`docs/tmp-icons/`](tmp-icons/README.md).

### Size and spacing

| Fact | Value |
|---|---:|
| Colour tokens in `vars.css` | 25 |
| Size/spacing/type tokens in `vars.css` | 0 |
| Geometry declarations with a raw px literal (13 files) | 644 |
| Uses of `--m-sp-*` | 87, all inside `mobile.css` |

`apps/mobile/src/mobile.css` already contains a useful 4pt spacing scale, type scale, and
44px touch target. The values are platform-local today.

### Cascade and platform layering

| Fact | Value |
|---|---:|
| `@layer` usage | 0 |
| `body[data-platform="mobile"]` selectors in `mobile.css` | 332 |
| `!important` declarations | 27 |
| Width-based media queries | 2 |
| Container queries | 4, all in the settings panel |

Mobile loads `mobile.css` after the full shared `style.css`. Electron imports a separate
renderer stylesheet. The platform sheets are real test surfaces, not interchangeable copies
of the extension shell.

The application also creates CSS rules at runtime for collector colors and sets inline
styles for gesture positions, drag transforms, transient visibility, and other measured
state. Inline declarations outrank normal layered declarations, so the cascade migration
must inventory these separately rather than pretending that imported stylesheets are the
whole cascade.

Some current `!important` declarations are likely specificity debt. Others enforce
reduced-motion, `[hidden]`, or visually-hidden accessibility behavior and should remain as
documented utility exceptions if they are still required.

### Controls

The shell currently mixes native `<button>`, `<input type="button">`, `<div class="btn">`,
and `icon-btn`. Several clickable `<div>` controls are not keyboard reachable. The sidebar
also uses clickable `.sub` containers whose semantics need auditing.

Desktop styles `.btn`, while mobile broadly styles the `button` element. These sets do not
describe one component contract. `.bar` and `#menu .heading` use flexbox without a declared
cross-axis contract, and local negative margins compensate for visible misalignment.

### Icons

Twenty SVGs live in `packages/ui-web/public/static/imgs/`. Nineteen use a 16×16 viewBox.
`story.svg` uses a 20×20 grid and a heavier stroke.

SVGs consumed through `<img>` cannot inherit the host page's `color`; the current
`currentColor` attributes do not provide host-page theming. This drives filter-based color
hacks. `.ptr-icon` already demonstrates the useful mask/current-color technique.

The current set has large differences in bounding extent. Bounding extent is a useful guard
against grossly undersized, empty, clipped, or off-grid assets, but it is not a complete
measure of perceived weight.

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

## Phase 0 — Baselines and verification infrastructure

Phase 0 is additive. It records the current intentional contract before visual values change.

### 0.1 Define the renderer matrix

Add a short test manifest under `tests/e2e/design-system/` that assigns assertions to:

| Surface | Required coverage |
|---|---|
| Shared Chromium fixture | primitive geometry, icon integrity, keyboard semantics |
| Chrome/Firefox artifacts | shared stylesheet packaging and shell smoke |
| Electron | renderer stylesheet overrides and desktop chrome geometry |
| Mobile web | platform CSS, representative narrow/wide viewports, touch geometry |
| Android/iOS | targeted safe-area, touch, keyboard, and visual release gates |
| Reader/presenter documents | explicitly in or out of theming scope |

Shared assertions may be reused by multiple projects. “One target suffices” applies only to a
contract proven to have no platform override.

### 0.2 Geometry and accessibility assertions

Create shared Playwright helpers that assert, for elements participating in the declared
contracts:

- `.icon` has nonzero equal width and height;
- an icon does not overflow its button;
- icon-only controls center their icon within a documented tolerance;
- `.button` elements are native buttons;
- icon-only buttons have accessible names;
- keyboard traversal reaches migrated controls;
- focus-visible styling is observable;
- touch targets meet the mobile contract;
- declared toolbar/row primitives have their required computed alignment.

Use explicit primitive/data-part selectors, not `[class*=btn]`.

Add axe-core or an equivalent semantic accessibility pass if accepted as a dependency.
Geometry does not replace semantic or keyboard testing.

Known failures must live in a reviewed baseline file with:

- selector/test identity;
- reason;
- tracking phase;
- intended deletion condition.

Do not use anonymous `test.skip()` calls. Phase gates fail if new baseline entries appear.

### 0.3 Icon integrity audit

Promote the measurement work into the Playwright design-system suite rather than the
Node-only unit suite. Assert:

- allowed SVG files have a 16×16 viewBox, with `story.svg` temporarily baselined;
- the rendered mark is nonempty;
- transforms and strokes do not clip;
- file size stays below a justified ceiling;
- bounding extent stays above a conservative gross-error floor.

Keep the rendered comparison sheet as the approval surface for perceived weight. An extent
threshold must not be presented as proof of optical equality.

### 0.4 CSS lint and debt budget

Add `stylelint` and `stylelint-config-standard`, with `npm run lint:css` included in
`npm run check`.

Introduce rules in two categories:

**Immediate errors**

- invalid/unknown CSS;
- duplicate declarations where unsafe;
- forbidden new `!important` outside named utility exceptions;
- primitive-specific contract violations;
- new negative margins in button/icon primitives;
- new raw spacing values in already migrated files.

**Existing debt budget**

A repository script records exact existing raw spacing, negative-margin, specificity-prefix,
and `!important` occurrences. CI fails if:

- a new occurrence appears;
- a removed occurrence returns;
- the total increases.

The baseline is exact and reviewable, not a warning stream or a broad per-file disable. Each
migration commit shrinks it. When a category reaches zero in its intended scope, stylelint
becomes the sole enforcement.

Do not globally require `align-items` on all flex/grid declarations. Enforce it on `.button`,
`.row`, `.toolbar`, and identified component contracts.

### 0.5 Measurement command

Add:

```text
npm run measure -- "<selector>"
```

It prints:

- bounding box;
- padding and border;
- center offsets from parent and relevant siblings;
- overflow/clipping;
- line-height and baseline-related metrics where applicable;
- renderer, viewport, and loaded stylesheet identities.

The tool must use the same fixture/build-stamp checks as the E2E harness so stale bundles do
not masquerade as product behavior.

### Phase 0 exit

- `npm run check`
- shared design-system Playwright project green against the reviewed baseline;
- extension artifact smoke green;
- Electron geometry smoke green;
- `npm run test:mobile:web` green;
- no untracked skips;
- baseline cannot grow.

---

## Phase 1 — Token introduction without visual change

### 1.1 Add the token layer

Add the layer order and import `vars.css` into `layer(tokens)`. Add a test fixture proving
that a value declared in `layer(user)` overrides the default token on the same element.

### 1.2 Promote the mobile scale

Add platform-neutral tokens to `vars.css`. Keep `--m-sp-*`, `--m-fs-*`, and `--m-touch` as
temporary aliases in `mobile.css`. Add a debt-baseline entry for every alias so no new mobile
alias use appears.

### 1.3 Convert without snapping

Suggested order:

1. `base.css`
2. `menu.css`
3. `layout.css`
4. `stories.css`
5. `settings.css`
6. `mobile.css`
7. `electron.css`
8. reader/presenter styles if in scope

Each commit:

- preserves computed values;
- adds semantic/component tokens when needed;
- shrinks the raw-value baseline;
- runs shared geometry plus affected platform tests;
- includes a visual comparison for any deliberate value change.

Rationalising the scale is a separate pass after the preserved-value conversion.

### Phase 1 exit

- public token catalog documented;
- mobile aliases removed;
- no raw spacing values in migrated scopes except reviewed component/optical tokens;
- Tier 1 override fixture green;
- no unintended geometry changes.

---

## Phase 2 — Cascade layers

This is the highest-blast-radius phase.

### 2.1 Layer shared parts incrementally

Move one part file per commit into its target layer. After each move:

- compare computed-style snapshots for representative fixtures;
- run shared design-system tests;
- run affected product smoke tests;
- shrink specificity and `!important` debt only when the new cascade makes it redundant.

### 2.2 Layer platform styles explicitly

Move Electron and mobile CSS into `layer(platform)` using their actual build assembly.
Prove with a fixture that:

- platform rules override component rules;
- user token values override defaults;
- trusted unlayered application rules do not exist.

### 2.3 Audit generated and inline styles

Inventory `document.createElement("style")`, CSS text/rule injection, and direct `.style`
writes.

- Put trusted generated rules, including collector-color rules, in an appropriate named
  layer.
- Keep direct styles only for measured geometry, transient interaction state, or public
  custom-property values.
- Migrate static colors, padding, cursor, display, and other component styling into classes,
  attributes, or tokens.
- Add a structure/debt check so new static inline styling is reviewed.

### 2.4 Remove specificity prefixes separately

Strip `body[data-platform="mobile"]` prefixes only after the equivalent platform-layer rule
is measured and tested. Prefix removal is not part of the same commit that first moves a
sheet into a layer.

### 2.5 Audit `!important`

Delete component-specific specificity overrides. Retain only named, documented utility
exceptions where the behavior genuinely requires priority, such as reduced motion,
canonical hidden behavior, or visually-hidden accessibility utilities.

### Phase 2 exit

- all trusted stylesheet and generated rules are layered;
- remaining inline styles are limited to reviewed runtime geometry/state and custom
  properties;
- no unlayered rule accidentally outranks user tokens;
- mobile prefixes remain only where they express platform identity, not specificity;
- component-specific `!important` debt is zero;
- documented utility exceptions have direct tests;
- extension, Electron, and mobile-web gates are green.

---

## Phase 3 — Semantic primitives

### 3.1 Button migration

Land the native button primitive and migrate one component family at a time:

1. search/reload/collapse controls;
2. sidebar panel controls;
3. settings actions, including `<input type="button">`;
4. reader/TTS controls;
5. dynamically built story and platform controls.

Update event bindings and selectors with each family. Preserve stable `data-testid` hooks.
Add accessible names and keyboard coverage before deleting compatibility styles.

Delete `.btn` and `icon-btn` only after repository search proves zero callers.

### 3.2 Layout primitives

Introduce primitives from repeated proven patterns. Migrate settings in bounded component
families rather than treating the entire large stylesheet as one change.

Keep component geometry in component CSS. A `.row` should not encode story-, settings-, or
platform-specific offsets.

### 3.3 Contract lint

Once migration is complete:

- `.button` is valid only on `<button>`;
- icon-only `.button` requires an accessible name;
- prohibited legacy classes fail structure checks;
- new clickable noninteractive markup fails semantic checks.

### Phase 3 exit

- no clickable `.btn`, `.sub`, or `icon-btn` alternatives remain;
- no `<input type="button">` remains unless explicitly justified;
- migrated controls pass keyboard, focus, and platform geometry tests;
- button/icon nudges are removed rather than allowlisted.

---

## Phase 4 — Icon system

### 4.1 Convert consumption to masks

Replace UI glyph `<img>` elements with the icon primitive and per-icon classes. Keep actual
content images and branded logos as `<img>`.

Call sites include:

- `shell.html`;
- builders in `packages/ui-web/src`;
- mobile/electron-specific builders;
- reader/presenter surfaces if in scope.

Delete icon color filters as their callers migrate. Active and hover states become `color`
changes.

### 4.2 Normalize gross geometry

Move all UI glyphs to the 16×16 grid. Rescale clear extent outliers around the center without
redrawing paths where possible. Verify that mask rendering does not clip.

### 4.3 Review optical balance

Use `docs/tmp-icons/icon-comparison.html` and generated candidates for the owner decision.
The proposed ~86% extent is a starting point, not a mechanical definition of optical
equality. Review at actual 12, 16, and 24px rendered sizes in both themes.

Redraw `story.svg` on the 16 grid only after that review.

### Phase 4 exit

- UI glyphs use masks/current color;
- no icon color-filter hacks;
- grid/nonempty/clipping/file-size tests green;
- comparison sheet approved for both themes and supported sizes;
- content images and logos remain semantically correct.

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
| 0 Baselines/verification | — | low | Trusted, platform-aware gates |
| 1 Tokens without visual change | 0 | low | Shared vocabulary and override proof |
| 2 Cascade layers | 0, 1 | high | Predictable trusted cascade |
| 3 Semantic primitives | 1, 2 | medium | One control/layout contract |
| 4 Icon system | 0, 3 | medium | Themeable, verified glyphs |
| 5 Theming architecture | 1, 2, 3 | high | Supported tokens, explicit advanced-CSS risk |
| 6 Design handoff | 1, 3 | low | Transferable design artifacts |

Phases 0 and 1 remain valuable independently. Phase 5 is not “small”: persistence, platform
adapters, validation, privacy, and recovery make it a product architecture phase.

## Definition of done

- CSS debt baseline is zero in migrated scopes and cannot regress.
- Primitive-specific lint is at error level.
- Shared, Electron, mobile-web, and applicable native gates are green.
- Native buttons and links express interaction semantics; legacy button alternatives are
  removed.
- Icon integrity is mechanically tested and optical review is explicitly approved.
- Trusted stylesheet and generated CSS is fully layered; reviewed runtime inline styles are
  narrowly scoped; user tokens override defaults.
- Component-specific specificity prefixes and `!important` hacks are removed.
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
