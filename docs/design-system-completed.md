# Design System Completed Work

This document is the implementation record for completed design-system phases.
The active roadmap and remaining work stay in
[`design-system-plan.md`](design-system-plan.md).

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

## Status (measured 2026-07-31 on `design-css-impro` at `6ae960e`)

The section above records `main` at `7f17cce` and is left as written. This one records where
the branch actually stands.

### Phase progress

| Phase | State |
|---|---|
| 0 Baselines | Landed. Six check scripts in `npm run check`; design-system Playwright project green |
| 1 Tokens | **Complete.** Shared shell (including notifications, dialogs, and search), mobile, Electron, and the Electron error page are migrated; reader/presenter documents are explicitly excluded |
| 2 Cascade layers | **Complete.** Ownership is explicit; platform-prefixed component rules are zero |
| 3 Primitives | **Complete.** Native controls, bounded Settings layout families, and semantic lint use one enforced contract |
| 4 Icon system | **Complete.** UI glyphs use mask/current-color primitives on a normalized 16×16 grid |

### Debt, counted honestly

57 entries. Phase 2 platform branching is closed; the remaining debt is outside
the Phase 2 ownership boundary:

| Category | Count |
|---|---:|
| `raw-geometry-px` | 41 |
| `important` | 13 |
| `negative-margin` | 3 |

All 115 platform prefixes were removed or moved to their platform owner. The 13
`!important` declarations are sanctioned utility exceptions under 2.5: reduced motion,
visually hidden, canonical `[hidden]`, and one drag state. Direct browser tests assert each
utility family. The debt baseline uses stable file, at-rule, selector, and declaration
identities, so unrelated line movement no longer creates baseline churn.

### Contracts now asserted

- a component-owned control keeps its box under `layer(platform)`;
- the platform touch baseline reaches a control with no component box;
- an embedded story keeps its component-owned action boxes when rendered inside Settings;
- every native control adopts `.button` or is a reviewed exception, on the mobile web
  surface where controls built from settings data actually render.

The last one carries a reviewed list split into controls that own their box and use
`<button>` for semantics only, and controls awaiting inspection. Entries that render only in
states the guard cannot reach are marked `conditional` and excluded from its staleness check,
so it never claims coverage it does not have.

### What this phase cost, and why

`layer(platform)` matched the `button` element, so it replaced geometry components declare
and no specificity recovered it. Eight families carried rules that existed only to undo it.
The visual box now belongs to `.button`; touch target and typography stay on the element,
because the user-agent default for a button is 13.333px Arial rather than an inherited font.

The lesson worth keeping: a declaration that looks redundant against component CSS may be
restoring what another platform rule turned off two rules earlier. Verify a removal by
measuring the rendered control before and after, not by comparing declarations.

The first Phase 2.4 family also exposed the inverse problem: a broad ancestor skin can replace
the box of a complete component embedded inside that ancestor. The swipe preview renders a
real story row, so its `.story .button` controls remain owned by `stories.css` and are
explicitly outside the dense Settings action skin. Ownership tests cover both sides of that
boundary.

### Phase 2 closure

No generic desktop sheet was needed. Normal presentation is unguarded beside its component;
space-driven differences stay in component queries; mobile-only filter and swipe-lab rules
live in `mobile.css`; Electron host behavior remains in `electron.css`; and reviewed runtime
geometry/state remains inline. `check:css-debt` rejects any returned positive or negated
platform prefix.

The ownership rule for future work is:

1. **Normal presentation stays with the component.** Space-driven differences use a
   media/container query there; mobile-native/WebView behavior belongs in `mobile.css`;
   Electron host/window behavior belongs in `electron.css`; measured geometry and transient
   state remain reviewed runtime styles.
2. **Keep the debt budget directional.** The non-growth ratchet uses stable identities;
   completed prefix categories are hard-zero checks rather than allowlisted debt.
3. **Keep the Phase 1 boundary explicit.** `notifications.css`, `dialogs.css`, `search.css`
   and `error-page.css` are migrated and enforced scopes. The remaining 41 raw-geometry
   entries are in explicitly excluded reader and presenter documents; they do not block the
   Phase 1 exit.

---

---

## Phase 4 — Icon system — COMPLETE

Shipped UI glyphs now use the `.icon` mask/current-color primitive and named
per-icon classes. Static shell controls, dynamic story and presenter controls,
story-state pseudo-elements, and Electron browser chrome share that contract.
The titlebar and About Once marks remain `<img>` because they are branded logos.

The comparison sheet was reviewed in light and dark at 12, 16, and 24px. The
86% gross-extent candidates were accepted for the clear outliers:
`chevron-left`, `collapse`, `pause`, `play`, `volume`, and `x`. `story.svg`
was redrawn directly on the 16 grid with the accepted 1.5-unit stroke and 83%
extent. Other icons retained their existing geometry because the extent audit
did not identify a gross error.

The icon audit now rejects off-grid, empty, clipped, oversized, or grossly
undersized SVGs. It also rejects UI-glyph `<img>` consumption and the icon
color-filter patterns removed in this phase. The Phase 0 `story.svg`
known-failure entry is gone. Shared, Electron, and mobile visual baselines were
reviewed and updated for the intentional glyph rendering changes.

Phase 4 closed with:

- `npm run lint:css`;
- `node --test tests/e2e/design-system/icon-audit.test.js`;
- `npm run test:design-system`;
- `npm run test:design-system:electron`;
- `npm run test:design-system:mobile`;
- `npm run check`.

---

## Phase 3 — Semantic primitives — COMPLETE

The native button migration has no remaining `.btn`, `.sub`, `icon-btn`, or
`<input type="button">` callers. The `.button` primitive owns semantic control
presentation, gives text buttons useful inline padding, and keeps icon-button
padding square-compatible. Story actions retain their intentionally compact
component-owned box.

Repeated Settings layouts now adopt `.row`, `.stack`, `.cluster`, and
`.toolbar` in bounded families: structured headers and actions, search, source
groups and rows, structured forms, error-log actions, and swipe-settings
controls. Component CSS still owns nonstandard gaps, alignment, and geometry.

`check:semantic-controls` rejects legacy control classes, non-native `.button`
markup, unnamed icon buttons, `<input type="button">`, missing explicit button
types, and clickable noninteractive HTML. Unit tests cover each static
contract; rendered tests cover dynamically built controls, keyboard focus,
accessible names, platform touch geometry, and primitive alignment.

Phase 3 closed with:

- `npm run check`;
- `npm run test:design-system` (21 tests);
- `npm run test:design-system:electron` (4 tests);
- `npm run test:design-system:mobile` (47 tests).

No screenshot baseline changed. The migration preserved computed presentation,
including the story-action box, so it did not trigger a native safe-area,
keyboard, or touch-geometry release gate.

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

## Phase 1 — Token introduction without visual change — COMPLETE

Phase 1 is complete for its defined scope. Reader and presenter styles remain explicitly
out of scope and are not deferred Phase 1 work.

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
6. `notifications.css`
7. `dialogs.css`
8. `search.css`
9. `mobile.css`
10. `electron.css`
11. `error-page.css`

Reader and presenter styles are explicitly excluded from Phase 1 and from its debt gate.

Each commit:

- preserves computed values;
- adds semantic/component tokens when needed;
- shrinks the raw-value baseline;
- runs shared geometry plus affected platform tests;
- includes a visual comparison for any deliberate value change.

Rationalising the scale is a separate pass after the preserved-value conversion.

### Phase 1 exit

- [x] public token catalog documented;
- [x] mobile aliases removed;
- [x] no raw spacing values in migrated scopes except reviewed component/optical tokens;
- [x] Tier 1 override fixture green;
- [x] no unintended geometry changes, including notification surfaces rendered in their real
  sibling containers rather than a synthetic nested fixture.

---

## Phase 2 — Cascade layers — COMPLETE

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

Strip platform prefixes only after the equivalent platform-layer rule is measured and
tested. Prefix removal is not part of the same commit that first moves a sheet into a
layer.

Both forms count. `body[data-platform="mobile"]` is how a sheet says "mobile" and
`body:not([data-platform="mobile"])` is how it says "everything else"; both are a shared
component sheet deciding its own appearance per platform, which `layer(platform)` exists to
express. The negated form is the larger half and was untracked until the debt script
counted it, so measure before assuming a scope is clean.

The negated guard persists partly because there is no desktop platform sheet: mobile and
Electron have one, the extension and desktop web shell do not, so "desktop only" has nowhere
to live except a guard inside component CSS. That does not by itself prove a desktop sheet is
missing. Classify each bounded component family first: normal presentation becomes the
unguarded component default; available-space differences stay with the component in a
media/container query; mobile-native/WebView behavior belongs in `mobile.css`; Electron
host/window behavior belongs in `electron.css`; and explicit platform selectors remain only
where platform identity is the real condition. Add a narrowly named desktop/capability sheet
only if that audit finds a substantial coherent rule set shared by Electron and extensions,
excluded from mobile, and not expressible by those existing owners.

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
- every remaining platform prefix has a documented platform-identity reason;
- the prefix baseline shrinks in each Phase 2.4 cleanup change;
- component-specific `!important` debt is zero;
- documented utility exceptions have direct tests;
- extension, Electron, and mobile-web gates are green.

---
