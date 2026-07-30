# Design System Plan: verifiable CSS, primitives, and user theming

Branch: `design-css-impro` · Written: 2026-07-30

## Goal

Make layout, alignment and spacing in this codebase **cheap to get right and expensive to
get wrong** — for humans and for AI agents — and lay the groundwork for a fully
user-themeable app.

Two things must become true:

1. There is exactly one way to express each common UI shape (a button, an icon, a settings
   row), and the alternatives are removed rather than deprecated.
2. Every property we care about is either impossible to express wrongly, or asserted by a
   test. Nothing important is left in the "you can tell by looking" category.

## The governing principle

> If a design property can only be verified by looking at it, it will regress.

An agent cannot resolve a 1px offset in a screenshot, and neither can a human in review.
This is not hypothetical: while preparing the icon comparison for this plan, a demo written
with full attention on this exact problem still shipped two alignment bugs — a button
implementation that drifted from the correct one written minutes earlier in the same file,
and a `var(--icon-size, 1em)` fallback that silently rendered every icon 19% small. Neither
errored. Both were caught by a human looking at the render.

The app contains a fossil of the same failure: `.bar_btn img { margin-bottom: -1px }` is
someone hitting this precise problem and patching the symptom instead of the structure. The
nudge hid it for years.

**Consequence for sequencing: verification infrastructure lands first (Phase 0), before any
visual refactor.** Otherwise every later phase is done with the same blindness.

## Current state (measured, 2026-07-30)

Evidence gathered on `main` at 7f17cce. Numbers here are load-bearing for the phases below.

### Size and spacing

| Fact | Value |
|---|---|
| Colour tokens in `vars.css` | 25 |
| Size / spacing / type tokens in `vars.css` | **0** |
| Geometry declarations with a raw px literal (13 files) | **644** |
| Uses of the `--m-sp-*` scale | 87, all inside `mobile.css` |
| Distinct px values in use | 1,2,3,4,5,6,7,8,10,11,12,13,14,15,16,17,18,19,20,22,24,26,28,30,34,36,38,40,44… |

`apps/mobile/src/mobile.css` defines a real 4pt scale (`--m-sp-1..5`), a type scale
(`--m-fs-*`) and `--m-touch: 44px`. Nothing outside that file can reach them.

### Cascade and platform layering

| Fact | Value |
|---|---|
| `@layer` usage | **0** |
| `body[data-platform="mobile"]`-prefixed selectors in `mobile.css` | **332** |
| `!important` declarations | **27** (15 `settings.css`, 7 `mobile.css`, 3 `electron.css`, 1 `base.css`, 1 `layout.css`) |
| Width-based media queries, whole repo | **2** (`mobile.css:2215`, `readerDocument.css:216`) |
| Container queries | 4 (all `settings-panel`) |

`mobile.css` loads *after* the full desktop `style.css` over the same `shell.html`
(`apps/mobile/webpack.config.js:116`). It is an override sheet, not a responsive layer: two
sources of truth per component, ~1,800 lines apart, in different packages.

### Buttons

Three conventions coexist inside `packages/ui-web/public/shell.html` alone: 14 `<button>`,
5 `<div class="btn">`, and one `class="icon-btn"` (kebab-case in a snake_case codebase).

Desktop styles the **class** (`.btn`, `base.css:64`); mobile styles the **element**
(`body[data-platform="mobile"] button`, `mobile.css:161`). The sets barely intersect — a
`<div class="btn">` gets no 44px touch target, no radius, no mobile font.

`.btn` declares no `display`, so on a `<div>` it is a block box with no content centring,
while a native `<button>` centres its content. Same class, two behaviours.

`.bar` is `display:flex` with **no `align-items`** (default `stretch`), as is
`#menu .heading`. The resulting misalignment is corrected by hand-tuned nudges:
`.bar_btn img { margin-bottom: -1px }`, `.bar .collapsebutton { margin-left: -17px }`,
`#menu_btn { margin-left: -13px }`.

The 5 `<div class="btn">` are also an accessibility defect: no `tabindex`, no `role`, so the
collapse and cancel-search controls are unreachable by keyboard.

### Icons

20 SVGs in `packages/ui-web/public/static/imgs/`. 19 are Bootstrap Icons on a consistent
`0 0 16 16` grid. Consumed as `<img src="...">`.

**`fill="currentColor"` and `width="1em"` are dead attributes in that path.** An SVG loaded
through `<img>` is an isolated document: it cannot see the host page's `color` or
`font-size`. So the fill resolves to black in both themes, and the em resolves against the
SVG's own 16px default. This is what forces:

- `vars.css:67` — `#menu .sub img { filter: contrast(0%) }` for dark mode
- `base.css:75` — `.active img { filter: invert(42%) sepia(93%) saturate(252%)
  hue-rotate(87deg) brightness(119%) contrast(119%) }`

`.ptr-icon` (`stories.css:51`) already uses `mask` + `background: var(--text-high-color)` and
themes correctly. The good technique exists in the codebase and is used once.

**Optical size audit** (ink extent as a share of viewBox, measured via
`getBoundingClientRect()` so transforms and stroke are included):

| icon | ink fill | mark @16px |
|---|---|---|
| `x` | 50% | 8.0px |
| `play` | 56% | 9.0px |
| `pause` | 56% | 9.0px |
| `chevron-left` | 81% | 13.0px |
| `volume` | 81% | 13.0px |
| **median** | **88%** | **14.1px** |

`story.svg` is the sole off-grid icon (`0 0 20 20`) and the sole fully-stroke-drawn one
(`stroke-width="2"` ≈ 1.6px effective against the set's ~1px).

No CSS rule can fix the optical spread — identical markup yields visibly different sizes
depending on which file it points at. This is a concrete reason icon sizing feels
unlearnable.

---

## Phase 0 — Verification infrastructure

**Lands first. Everything after this is checkable.**

### 0.1 Geometry assertions

New Playwright spec under the existing `tests/e2e/extensions` config — the shell renders
identically in all targets, so one target suffices. Renders `shell.html`, opens each panel,
and asserts on computed geometry:

- every `.icon`: computed `width === height`, and `!== 0`
- every button containing an icon: `|iconCentreY − buttonCentreY| ≤ 0.5px`, same for X on
  icon-only buttons
- no element matching the button/icon contract has a computed negative margin
- every focusable-looking control (`[class*=btn]`, `[role=button]`) is either a `<button>`
  or has `tabindex`

Rationale: `getBoundingClientRect()` resolves exactly what a screenshot cannot.

### 0.2 Icon set audit as a test

Promote the audit script built for this plan into `tests/unit/ui-web/icon-set.test.js`
(matching the existing kebab-case `*.test.js` convention in that directory):

- every icon's `viewBox` is `0 0 16 16`
- every icon's ink fill is within ±8 points of the set median
- no icon file exceeds a size ceiling

Uses Playwright's `getBoundingClientRect()` measurement (`getBBox()` is **not** usable — it
reports an element's own user space and ignores ancestor transforms and stroke width; this
caused a silent no-op while preparing this plan).

### 0.3 Stylelint

Add `stylelint` + `stylelint-config-standard`, wired into `npm run check`. Rules, in the
order they should be enforced:

1. **`declaration-property-value-disallowed-list`** — no raw px on `padding`, `margin`,
   `gap`, `font-size`, `border-radius`. Report-only at first; convert file by file with
   per-file disables; flip to error when the count reaches zero.
2. **Custom rule: `display: flex|grid` requires `align-items`.** This one rule would have
   flagged `.bar` and `#menu .heading` — the origin of every nudge in the codebase.
3. **No negative margins** outside an allowlist. The reliable signature of the failure mode.

### 0.4 Measurement command for agents

`npm run measure -- "<selector>"` → prints box, padding, border, centre offsets against
siblings and parent, and baseline positions for matched elements.

The alignment fix loop must be *measure → change → measure*, not *screenshot → guess*. This
script is the single most useful artifact in Phase 0 for day-to-day agent work.

**Phase 0 exit:** all four land, `npm run check` green, geometry spec passing against
current `main` behaviour (with known failures explicitly skipped and listed here).

---

## Phase 1 — Tokens

### 1.1 Promote the mobile scale to platform-neutral

Into `packages/ui-web/public/static/css/parts/vars.css`:

```css
--sp-1: 4px;  --sp-2: 8px;  --sp-3: 12px;  --sp-4: 16px;  --sp-5: 24px;  --sp-6: 32px;
--fs-title: 16px; --fs-body: 14px; --fs-meta: 12px; --fs-label: 10px;
--icon-sm: 12px; --icon-md: 16px; --icon-lg: 24px;
--touch: 44px;
--radius-sm: 2px; --radius-md: 6px; --radius-lg: 8px;
--bw: 1px;
```

Keep `--m-sp-*` etc. as aliases in `mobile.css` so nothing breaks in a single commit; remove
the aliases at the end of Phase 1.

### 1.2 Convert the part files

Order by leverage: `base.css` → `menu.css` → `layout.css` → `stories.css` → `settings.css` →
`mobile.css`. Each file's conversion is one commit, gated by the stylelint count dropping.

**Open question for the owner:** the current px spread includes 11, 13, 17, 19, 22, 26, 34,
38. Some are intentional optical corrections, most are probably incidental. Where a value
does not map cleanly onto the scale, the default is to snap to the nearest step and note it
in the commit; call out any that must stay exact.

### 1.3 Why this is prerequisite to everything else

- Skins can only recolour until size tokens exist — density is the most-requested skin knob.
- The design handoff (Phase 5) has no vocabulary to design in without a scale, which is why
  the swipe prototype had to invent `padding: 10px 12px 12px`.
- Agents pick spacing at random when 30 values are equally plausible.

---

## Phase 2 — Cascade layers

Declare once at the top of `style.css`:

```css
@layer base, components, platform, user;
```

Assign via the existing imports — no part file needs editing:

```css
@import "./parts/vars.css";                    /* unlayered: tokens must win everywhere */
@import "./parts/base.css"      layer(base);
@import "./parts/layout.css"    layer(components);
/* … */
```

`mobile.css` and `electron.css` move into `layer(platform)`.

**Payoff:** layer order beats specificity outright, so:

- the 332 `body[data-platform="mobile"]` prefixes become plain selectors — mobile wins by
  position, not by out-specifying
- most of the 27 `!important`s become deletable
- `layer(user)` is a free, safe attachment point for Phase 5 skins

**Risk:** this is the highest-blast-radius change in the plan. It must land *after* Phase 0
so the geometry spec catches regressions, and it should be one commit per sheet moved, with
the mobile prefix-stripping as a separate follow-up commit.

**Verify:** all five targets build; geometry spec green on desktop shell and mobile web
(`npm run test:mobile:web`). Watch for the known trap that `npm run check` clobbers the
`--e2e` bundle.

---

## Phase 3 — Primitives

### 3.1 Button

One primitive. `<button>` only — convert the 5 `<div class="btn">` (fixes the keyboard
accessibility defect at the same time), and retire `icon-btn`.

```css
button, .btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-1);
  min-block-size: var(--touch);       /* platform layer relaxes on desktop */
  padding: var(--sp-1) var(--sp-2);
  border: var(--bw) solid var(--border-high-color);
  border-radius: var(--radius-sm);
  background: var(--btn-bg-color);
  font: inherit;
  cursor: pointer;
}
```

Then delete `.bar_btn img { margin-bottom: -1px }`, `.bar .collapsebutton { margin-left:
-17px }` and `#menu_btn { margin-left: -13px }`. Centring makes them unnecessary; the
stylelint negative-margin rule stops them coming back.

**Critical: remove the alternatives.** A primitive only works if hand-rolling is harder than
using it. Leaving `.btn`, `<button>` and a third variant all valid guarantees an agent picks
one at random — that is exactly how the demo bug happened.

### 3.2 Icon

```css
.icon {
  display: inline-block;
  inline-size: var(--icon-size);      /* NO fallback — see below */
  block-size: var(--icon-size);
  background: currentColor;
  -webkit-mask: var(--icon) center / contain no-repeat;
  mask: var(--icon) center / contain no-repeat;
  flex: none;
}
.icon-chrome { --icon-size: var(--icon-md); }      /* fixed box in toolbars/menus */
.icon-inline { --icon-size: 1em; vertical-align: -0.125em; }  /* runs with text */
```

**No fallback on `--icon-size` is deliberate.** `var(--icon-size, 1em)` fails silently and
plausibly — it produced the 19%-small bug. With no fallback an unsized icon renders 0×0 and
is instantly obvious, and the Phase 0 assertion `width !== 0` catches it in CI.

The two variant classes exist because the correct answer genuinely differs: chrome buttons
want a fixed box that does not shrink with a 13px button font; icons in running text want
`1em` and a baseline correction. `vertical-align` is only ever correct for the inline case —
it is ignored inside a flex container, which is what chrome buttons are.

### 3.3 Layout primitives

Extract into a new `parts/primitives.css`: `.row` (inline-flex, centred, gap),
`.stack` (column, gap), `.cluster` (wrap + gap), `.field` (label/control pair). Migrate
`settings.css` onto them — that is where 2,340 of the lines and most of the misalignment
live.

---

## Phase 4 — Icon system

### 4.1 Convert consumption to mask

Every `<img src="imgs/*.svg">` becomes `<span class="icon icon-chrome" style="--icon: …">`,
or a per-icon class in CSS to avoid inline styles. Call sites: `shell.html` plus the TS
builders in `ui-web/src` and `apps/*/src`.

Deletes `vars.css:67` and `base.css:75` outright, and makes active/hover states a single
`color:` declaration.

**The 19 on-grid SVG files need no edits.** Under a mask the existing `fill="currentColor"`
renders black into the alpha channel, which is exactly what is wanted.

### 4.2 Normalise optical size

Rescale the five outliers by wrapping existing paths in a `<g transform>` that scales ink
about the centre to a target fill (~86%). No path is redrawn — one line per file, fully
reversible. Candidates already generated during planning.

**Owner decision required:** the target fill is a taste knob. 86% was chosen over the 88%
median because a sparse mark at full extent reads heavier than a dense one. Review the
rendered candidates before committing.

### 4.3 story.svg

Redraw on the 16 grid at `stroke-width="1.5"`. Candidate exists; proportions are the
owner's call.

### 4.4 Lock it in

Phase 0.2's icon test now enforces grid and optical consistency for every icon added later.

---

## Phase 5 — User theming

Phases 1–3 are the groundwork. This phase is small once they land.

### 5.1 Two-tier contract

- **Tier 1 — tokens.** Users override custom properties only. Cannot break layout, cannot
  desync from a refactor, needs no knowledge of internal class names. This is the promoted
  path and the reason Phase 1 is prerequisite: without size tokens a skin can only recolour.
- **Tier 2 — rules.** Arbitrary CSS in `@layer user`, explicitly "may break on update".

### 5.2 Stable selector surface

Add `data-part` attributes at the ~20 elements that matter (`story`, `story-title`,
`toolbar-button`, `icon`, `settings-row`, …). Document those as the contract; declare class
names internal. This lets us keep refactoring CSS without breaking every skin, and it is the
same attribute surface that makes design-tool markup transfer cleanly (Phase 6).

### 5.3 Injection

One function in `ui-web`, one `<style>` node kept last in `<head>`:

```ts
export function applyUserStyles(css: string): void {
  let el = document.getElementById("user-skin") as HTMLStyleElement | null
  if (!el) {
    el = document.createElement("style")
    el.id = "user-skin"
    document.head.append(el)
  }
  el.textContent = `@layer user {\n${css}\n}`
}
```

Wrapping at injection time means skin authors never write the boilerplate, and a skin
*cannot* escape into a higher layer. Fed from a `customCss` settings key through the
existing store (syncs via Pouch like every other setting), applied on input with a debounce
for live preview.

### 5.4 CSP reality

`shell.html` declares `style-src 'self' 'unsafe-inline'`, so an injected `<style>` works.
Neither extension manifest sets `content_security_policy`, so MV3's default constrains only
scripts and objects.

**One real constraint:** `default-src 'self'` means `font-src` falls back to `'self'` —
**user `@font-face` pointing at an external URL fails silently.** Background images from
`https:` do work (`img-src 'self' data: https:`).

**Decision: keep `font-src` closed.** Widening it lets any shared skin phone home on load.
Offer `data:` URIs or bundled faces, and document it prominently — it will otherwise be the
top support report.

### 5.5 Guardrails

- **Safe mode.** A skin can `display: none` the settings button and lock the user out of the
  UI that would fix it. Needs a recovery path independent of the skinned UI — a keyboard
  chord, or auto-disable after a launch that failed to reach interactive.
- **Scope decision required.** The reader is a separate document
  (`readerDocument.html` + its own CSS, copied as `reader.css`) and presenters render in
  iframes. Either add a second injection site or state explicitly that skins cover the shell
  only. Do not leave this implicit.
- **Ship 2–3 first-party skins** built on the same public token/`data-part` surface. The
  only reliable way to discover what the contract is missing.

---

## Phase 6 — Design handoff rules

New `docs/DESIGN_HANDOFF.md`, pointed at by any design-generation step.

Motivation, from integrating the swipe-actions design: the prototype carried **221** inline
`style="` attributes, **~85** hardcoded hex literals and **zero** `var(--…)` — despite the
values proving the tool had read `vars.css` (`#cfe9e4`/`#1f6b60` are exactly
`--sample-badge-bg`/`--sample-badge-ink`). Every one of those had to be reverse-looked-up by
hand, and the light-only output could not be reviewed in dark mode at all.

Rules:

1. **Reference tokens by name; never inline a resolved value.** If a colour or size has no
   token, define one with `light-dark()` and say so.
2. **Classes in one `<style>` block, not inline style attributes.**
3. **One responsive artifact using container queries**, not one file per breakpoint. The
   swipe design shipped two 27KB prototypes that had to be merged into one component plus a
   `@container` block by hand.
4. **Use `data-part` hooks** (Phase 5.2) so markup transfers near-verbatim.
5. **Keep the two sections that already work**: "details that caused bugs in the prototype"
   and a testable "definition of done".

---

## Sequencing

| Phase | Depends on | Risk | Notes |
|---|---|---|---|
| 0 Verification | — | low | Additive only. **Must be first.** |
| 1 Tokens | 0 | low | Mechanical, incremental, lint-gated |
| 2 Layers | 0 | **high** | One sheet per commit; all five targets must build |
| 3 Primitives | 1, 2 | medium | Deleting alternatives is the point |
| 4 Icons | 0.2, 3 | low | Two owner taste decisions |
| 5 Theming | 1, 2, 3 | low | Small once groundwork lands |
| 6 Handoff | 1 | low | Doc only; can land any time after tokens |

Phases 0 and 1 are worth doing even if nothing else in this plan ever ships.

## Definition of done

- `npm run check` green with stylelint at **error** level for raw-px, flex-without-
  `align-items`, and negative margins
- geometry spec green on desktop shell and mobile web
- icon test enforcing grid and optical consistency
- zero `!important` in `mobile.css`; zero `body[data-platform="mobile"]` prefixes used purely
  for specificity
- zero `filter:` colour hacks on icons
- a token-only skin can change density and colour without touching a class name
- a deliberately hostile skin cannot lock the user out

## Open decisions for the owner

1. Icon optical target fill (86% proposed) and the `story.svg` redraw proportions.
2. Which of the odd px values (11, 13, 17, 19, 22, 26, 34, 38) are intentional optical
   corrections that must not snap to the scale.
3. Whether user skins cover the reader document and presenter iframes, or the shell only.
4. Whether to keep `font-src 'self'` (recommended) and document the limitation, or widen it
   for skin webfonts and accept the privacy leak.
