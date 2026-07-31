# Design system

This is the working reference for styling Once: where a rule belongs, what the
cascade guarantees, which primitives exist, and what the automated checks
enforce. Read this before adding CSS.

Related pages:

- [design-tokens.md](design-tokens.md) — the public token catalog.
- [design-system-plan.md](design-system-plan.md) — refactor closeout and the
  governing principles behind these rules.
- [design-system-theming-plan.md](design-system-theming-plan.md) — future user
  theming product work; it is not part of the current refactor.
- [design-system-completed.md](design-system-completed.md) — the implementation
  record. History, not guidance; do not treat it as the current contract.
- [VISUAL_COMPARISON.md](VISUAL_COMPARISON.md) — screenshotting built apps when
  a change is meant to look different.

## Where does this rule go?

Answer these in order and stop at the first match.

| The rule expresses | It belongs in |
| --- | --- |
| Normal presentation of a component | That component's sheet, unguarded |
| A difference driven by available space | A `@container`/`@media` query **in the same component sheet** |
| Mobile-native or WebView behavior (safe area, touch, native shell) | `apps/mobile/src/mobile.css` |
| Electron host or window behavior (titlebar, tabs, window chrome) | `apps/electron/src/electron.css` |
| A value measured at runtime, or transient interaction state | A reviewed inline style — see [Runtime styles](#runtime-styles) |
| A shape repeated across components | A primitive in `parts/primitives.css` |

The rule that matters most: **normal presentation stays with the component.**
A component sheet must not decide its own appearance per platform. Adopting
cascade layers removed 399 `body[data-platform="mobile"]` and
`body:not([data-platform="mobile"])` guards for exactly this reason, and
`check:css-debt` fails on either form. If a component looks different on a
platform, either the difference is really about space (use a query) or the
platform owns it (put it in that platform's sheet).

There is deliberately no generic "desktop" sheet. The WebExtension shell has a
narrow platform sheet for host-owned differences; the ordinary desktop web shell
has none. A rule shared by Electron and extensions but excluded from mobile still
needs a capability-named owner rather than a guard in component CSS. Add one only
when an audit finds a substantial coherent rule set that is not expressible by
the existing owners.

## The cascade

Trusted CSS declares one layer order, in
[`style.css`](../packages/ui-web/public/static/css/style.css):

```css
@layer reset, tokens, base, components, platform, user;
```

| Layer | Holds |
| --- | --- |
| `reset` | Reserved; currently unused |
| `tokens` | `parts/vars.css` — token and colour defaults |
| `base` | `parts/base.css`, and the separate reader/outline documents |
| `components` | Every shared part, plus runtime-generated trusted rules |
| `platform` | `mobile.css`, `electron.css`, `webext.css`, `error-page.css` |
| `user` | Reserved for future user theming; nothing writes it yet |

Two properties this buys, both asserted by tests:

- Token defaults live in the lowest-priority named layer, so `layer(user)` can
  override a token **on the same element**. Unlayered declarations outrank every
  named layer, so leaving `vars.css` unlayered would have made user theming
  impossible without `!important`.
- Platform declarations beat component declarations by layer order, not by
  selector weight. That is what let the platform prefixes go.

### How each sheet enters its layer

A stylesheet does **not** inherit a layer from the sheet that happens to load
before it. Each target states its own:

| Sheet | Loaded by | Mechanism |
| --- | --- | --- |
| Shared parts | `<link>` to `style.css` | `@import "./parts/x.css" layer(components)` |
| `mobile.css` | Its own `<link>`, after `style.css` | Self-wrapped in `@layer platform { … }` |
| `electron.css` | `import "./electron.css"` in `renderer.ts` | Self-wrapped in `@layer platform { … }` |
| `webext.css` | Generated `<link>`, after `style.css` | Self-wrapped in `@layer platform { … }` |
| `error-page.css` | Served as `once-error://style/<token>` | Self-wrapped in `@layer platform { … }` |
| `readerDocument.css`, `outline_style.css` | Separate documents | Self-wrapped in `@layer base { … }` |

`check:cascade` fails if a shared import lacks `layer(...)`, or if any of those
six files is not exactly one top-level `@layer` block of the expected name.

## Stylesheet map

Shared shell, under `packages/ui-web/public/static/css/`:

| File | Owns |
| --- | --- |
| `parts/vars.css` | Token defaults, colour catalog, `color-scheme` |
| `parts/base.css` | `html`/`body`, scrollbars, `.bar`, drag state |
| `parts/primitives.css` | `.button`, `.icon`, `.row`/`.stack`/`.cluster`/`.field`/`.toolbar`, panel titlebar |
| `parts/layout.css` | Shell frame: titlebar, panels, splitter, webtab |
| `parts/animations.css` | Keyframes and animation toggles |
| `parts/menu.css` | Left panel and sidebar filter list |
| `parts/stories.css` | Story rows, swipe reveal, story state glyphs |
| `parts/settings.css` | Settings panel, structured lists, forms, swipe lab |
| `parts/search.css` | Search bar, scope, global results |
| `parts/notifications.css` | Status bar, status dock, issue bubbles |
| `parts/dialogs.css` | `.once-confirm-dialog` |

Platform and separate documents:

| File | Owns |
| --- | --- |
| `apps/mobile/src/mobile.css` | Touch shell, tab bar, reading tab, mobile settings presentation |
| `apps/electron/src/electron.css` | Titlebar, tabs, window chrome |
| `packages/webext-shell/src/webext.css` | Extension-host search geometry and host stylesheet corrections |
| `apps/electron/src/browser/error-page.css` | The standalone Electron error document |
| `packages/ui-web/src/reader/readerDocument.css` | Reader document |
| `packages/ui-web/src/presenters/outline/outline_style.css` | Outline presenter |

Reader and presenter documents are **explicitly outside** the token migration
and its debt gate. They are separate documents with their own values. Bringing
them into a theme contract is future product work, not deferred refactor work.

## Tokens

Public geometry tokens (`--sp-1`…`--sp-6`, `--fs-*`, `--icon-*`, `--touch`,
`--radius-*`, `--bw`) and the colour catalog are listed in
[design-tokens.md](design-tokens.md). Use a token for semantic spacing and type.

Spacing is a 2px-based scale and the type scale covers text only; a `font-size`
that sizes a glyph takes an `--icon-*` or component token. See
[design-tokens.md](design-tokens.md) for the full catalog.

Component geometry does not have to snap to the scale, but the bar is that the
value is **derived from something concrete** — a control cluster's width, a
floating button's position, the inner box of a ring. Then give it a named
component token that says what it is for (`--reading-card-control-inset`,
`--m-fab-clearance`, `--couch-toggle-inset`), declare it where the relationship
lives, and read it from the rules that depend on it.

Do not declare a custom property and read it once in the same rule:

```css
/* Not a token. The name restates the selector, nothing else can set it or
   read it, and the raw value is now invisible to check:css-debt. */
#settings_panel .settings_block {
  --settings-settings_panel-settings_block-padding: 15px;
  padding: var(--settings-settings_panel-settings_block-padding);
}
```

`check:css-debt` rejects that shape. Either the value belongs to the public
scale, or it is derived geometry that should be declared where the relationship
lives — and if it is neither, the literal with a comment is more honest than a
name that only repeats the selector.

## Primitives

### Button

The markup contract is a native `<button>`:

```html
<button type="button" class="button button--icon" aria-label="Reload stories">
  <span class="icon icon--chrome icon--reload" aria-hidden="true"></span>
</button>
```

- Interactive actions use `<button type="button">`; form submission uses
  `type="submit"`; navigation stays an `<a href>`.
- `.button` is the only control class. `.btn`, `.sub`, `icon-btn`, and
  `<input type="button">` are gone and are rejected by `check:semantic-controls`.
- Icon-only controls need an accessible name.
- The primitive owns display, centering, gap, typography inheritance,
  `:focus-visible`, disabled behavior, and icon sizing.

A control may use `<button>` for semantics while owning its own box — a settings
row body, a slider handle, a status dot. That is legitimate, but it must be
recorded in
[`button-adoption-exceptions.json`](../tests/e2e/mobile/button-adoption-exceptions.json)
with a reason and a removal condition, or the guard fails.

### Icon

```html
<span class="icon icon--chrome icon--star" aria-hidden="true"></span>
```

Icons are CSS masks tinted with `currentColor`, never `<img>`, and never
recoloured with `filter`. `.icon` requires `--icon-size` and `--icon` with no
fallback on purpose: an incomplete icon renders invalidly and fails the geometry
test instead of looking plausibly undersized.

- `.icon--chrome` — fixed control geometry (`--icon-md`).
- `.icon--inline` — `1em`, baseline-aligned, for icons inside running text.
- `.icon--<name>` — supplies `--icon`. Call sites carry no inline `style`.

Source SVGs live in `packages/ui-web/public/static/imgs/` on a 16×16 grid. The
icon audit rejects off-grid, empty, clipped, oversized, and grossly undersized
files. Branded marks (titlebar logo, About Once) stay `<img>` and are exempt.

### Layout

Low-specificity, composable, and only for shapes that actually repeat. Component
CSS still owns nonstandard gaps, alignment, and geometry.

| Class | Contract |
| --- | --- |
| `.row` | Non-wrapping inline axis, centered cross-axis, `--sp-2` gap |
| `.stack` | Block axis, `--sp-2` gap |
| `.cluster` | Wrapping inline grouping, centered, `--sp-2` gap |
| `.field` | Label/control grid pair |
| `.toolbar` | `.row` starting at the inline start |

Adopting a primitive is not a goal in itself. Do not replace a working flex
declaration to raise an adoption count.

## Runtime styles

Inline styles are for genuinely dynamic values, not a styling API.
`check:cascade` enforces this against `packages/ui-web/src`, `apps/electron/src`,
and `apps/mobile/src`:

- `element.style.<prop> = …` is allowed only for a reviewed property set:
  `flex`, `flexBasis`, `height`, `left`, `lineHeight`, `maxHeight`, `minWidth`,
  `opacity`, `top`, `transform`, `transition`, `width`. Anything else fails.
  There is one named exception, the transient drag `cursor` in
  `story/swipe/gesture.ts`; extending the set is a review, not a formality.
- `setProperty()` may only set custom properties (`--*`).
- `cssText` is forbidden.
- Generated stylesheets must name their layer. `collectorStyles.ts` and
  `picker/overlayStyles.ts` emit `@layer components { … }`.

Static colour, padding, cursor, or display belongs in a class or a token.

## Utility exceptions

`!important` is allowlisted by `file|selector|property` in
[`check-cascade-contract.js`](../scripts/check-cascade-contract.js). Thirteen
declarations are sanctioned, all behaviour that genuinely requires priority:

- `prefers-reduced-motion` overrides in `mobile.css`;
- canonical `[hidden]` behavior in `settings.css`;
- the `.visually_hidden` accessibility utility;
- `pointer-events` during an active drag.

Each family has a direct test. Adding a new `!important` requires adding it to
the allowlist, which is a review, not a formality.

## What the checks enforce

All of these run inside `npm run check`.

| Command | Guards |
| --- | --- |
| `npm run lint:css` | Stylelint: invalid CSS, unsafe duplicates, primitive contract rules |
| `npm run check:css-debt` | Zero platform prefixes; zero raw geometry px in migrated scopes; zero single-use wrapper properties; no growth against `scripts/css-debt-baseline.json` |
| `npm run check:cascade` | Layer assignment, `!important` allowlist, inline-style and generated-CSS rules, separate documents declaring the tokens they consume |
| `npm run check:semantic-controls` | Native controls, accessible names, explicit button types, no clickable non-interactive HTML |

Rendered behavior, which the static checks cannot see:

```bash
npm run test:design-system
```

```bash
npm run test:design-system:electron
```

```bash
npm run test:design-system:mobile
```

To inspect a rendered box while working:

```bash
npm run measure -- "<selector>"
```

`npm run check` can replace the mobile `--e2e` bundle, so re-run the mobile
suite after it rather than trusting an earlier pass.

### Reviewed exception files

| File | Records |
| --- | --- |
| `scripts/css-debt-baseline.json` | Every tolerated debt occurrence, by stable identity |
| `tests/e2e/design-system/known-failures.json` | Contract failures accepted for now — currently empty |
| `tests/e2e/mobile/button-adoption-exceptions.json` | Controls using `<button>` for semantics but owning their box |

Every entry carries a reason and the condition under which it goes away.
Anonymous `test.skip()` is not an acceptable substitute. If a check fails
because you removed debt, shrink the baseline in the same change —
`node scripts/check-css-debt.js --write-baseline` rewrites it.

### Changing how something looks

The design-system suites compare screenshots. A deliberate visual change means
reviewing and updating the baselines, and saying so in the commit. Changes to
safe-area, touch, keyboard, or native WebView behavior additionally require a
native Android/iOS check — web and unit gates do not stand in for it.

## Known gaps

Honest limits of the current system, so nobody mistakes a green check for
completeness:

- **The raw-px gate covers `margin`, `padding`, `gap`, `font-size`, and
  `border-radius` only.** Sizing and positioning (`width`, `height`, `min-*`,
  `max-*`, `inset`, `line-height`) are unchecked, and raw px remains common
  there.
- **`settings.css` is ~2300 lines with almost no section structure**, and it
  hosts the global `.visually_hidden` and `[hidden]` utilities, which are not
  settings concerns.
- **User theming is not implemented.** `layer(user)` is reserved and the
  override path is tested, but no settings surface writes it. See the separate
  [future theming plan](design-system-theming-plan.md).
