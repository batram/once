# Icon investigation — working material

Archived review material behind the shipped icon contract documented in
[DESIGN_SYSTEM.md](../DESIGN_SYSTEM.md#icon). The shipped icons now use the
accepted candidates; the mechanical audit lives in `tests/e2e/design-system/`.

## Contents

| File | What it is |
|---|---|
| `icon-comparison.html` | Self-contained before/after page. Open it directly; it has a light/dark toggle. Generated — do not hand-edit. |
| `build-icon-compare.js` | Generates the page above, and the rescaled candidates. |
| `measure-icons.js` | Prints the optical-size audit table. Seed for the Phase 0.2 test. |
| `story-candidate.svg` | Redraw of the one off-grid icon on the 16 grid. |
| `candidates/*.svg` | Rescaled variants of the five icons that read small. |

## Running

Both scripts need the repo's Playwright, so run them from the repo root:

```bash
node docs/tmp-icons/measure-icons.js
```

```bash
node docs/tmp-icons/build-icon-compare.js
```

`build-icon-compare.js` rewrites `icon-comparison.html` and everything in `candidates/`.

## What the audit found

Measured against the 20 shipped SVGs in `packages/ui-web/public/static/imgs/`:

- **19 of 20 are consistent** — Bootstrap Icons on a `0 0 16 16` grid. `story.svg` is the
  sole outlier (`0 0 20 20`, fully stroke-drawn at `stroke-width="2"`).
- **`fill="currentColor"` and `width="1em"` are dead attributes** as long as icons are
  consumed via `<img>`: an SVG in an `<img>` is an isolated document and cannot see the host
  page's `color` or `font-size`. This is what forces the `filter: contrast(0%)` and
  `invert(...)` hacks in `vars.css:67` and `base.css:75`.
- **The set is bimodal in optical size.** 10 icons fill their grid completely; 10 sit
  between 50% and 88%; nothing lands in between. `x` covers 50% — an 8px mark inside a 16px
  box, about half its neighbours.

Because the distribution has two modes, a "within N% of the median" rule is the wrong shape:
it would either fail the 100% cluster or pass the 50% outliers. The audit uses a **floor**
instead.

## Measurement gotcha

`getBBox()` is not usable for this. It reports an element's own user space and ignores both
ancestor transforms and stroke width, so it cannot see a `<g transform>` wrapper. An earlier
version of these scripts used it, silently reported the rescaled candidates as unchanged,
and mis-stated the set's shape.

Render each SVG at exactly its viewBox size so 1 user unit = 1 CSS px, then use
`getBoundingClientRect()` — that includes transforms and stroke.

## Accepted decisions

1. **Target fill for clear outliers is 86%.** This sits just above the lower
   cluster rather than at the 100% mode because sparse marks at full extent read
   heavier than dense marks.
2. **`story-candidate.svg` was accepted** at 1.5-unit stroke and 83% extent.

The sheet was reviewed at actual 12, 16, and 24px sizes in both themes.
