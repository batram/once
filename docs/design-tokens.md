# Public design tokens

This is the token catalog. For how tokens fit into the cascade, when to use one
instead of a literal, and the rest of the styling contract, see
[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

These custom properties are the supported platform-neutral geometry vocabulary.
Their initial values preserve the pre-token computed styles; changing the scale is
a separate design decision.

| Category | Tokens | Defaults |
|---|---|---|
| Spacing | `--sp-0-5`, `--sp-1`, `--sp-1-5`, `--sp-2` … `--sp-6` | `2px`, `4px`, `6px`, `8px`, `12px`, `16px`, `24px`, `32px` |
| Type | `--fs-label`, `--fs-caption`, `--fs-meta`, `--fs-dense`, `--fs-body`, `--fs-title` | `10px`, `11px`, `12px`, `13px`, `14px`, `16px` |
| Icons | `--icon-sm`, `--icon-md`, `--icon-lg` | `12px`, `16px`, `24px` |
| Touch | `--touch` | `44px` |
| Radius | `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-xl`, `--radius-pill` | `2px`, `4px`, `6px`, `8px`, `999px` |
| Border | `--bw` | `1px` |

Spacing is a 2px-based scale. The `--sp-0-5` and `--sp-1-5` half-steps are real
steps, not a courtesy to legacy values: 2px and 6px are load-bearing in dense
desktop chrome.

The type scale covers **text only**. A `font-size` that sizes a text glyph used
as an icon — a `⋮`, a `+`, a chevron — is icon geometry and takes an
`--icon-*` token or a component token instead.

> **Renamed 2026-07-31.** The radius scale was rationalised to 2/4/6/8.
> `--radius-md` changed from `6px` to `4px` and `--radius-lg` from `8px` to
> `6px`; the previous values are now `--radius-lg` and `--radius-xl`. All
> in-repo call sites moved in the same change, so no rendered radius changed,
> but an external stylesheet referencing these names by their old values needs
> updating.

The existing color properties in `parts/vars.css` remain public theme inputs.
Application defaults are loaded into `layer(tokens)`, so a supported theme can
override a token on the same element from `layer(user)`.

The current color catalog is:

- Surfaces: `--main-bg-color`, `--second-bg-color`,
  `--highlight-bg-color`, `--input-bg-color`, `--unread-bg-color`,
  `--read-bg-color`, `--editing-bg-color`, `--sample-badge-bg`
- Borders and separators: `--border-color`, `--border-high-color`,
  `--sep-color`
- Text and state: `--text-high-color`, `--text-color`,
  `--text-muted-color`, `--error-color`, `--warning-color`,
  `--sample-badge-ink`
- Controls: `--selected_bg_color`, `--btn-bg-color`
- Swipe actions: `--swipe-open-color`, `--swipe-open-reader-color`,
  `--swipe-skip-color`, `--swipe-filter-color`,
  `--swipe-toggle-read-color`, `--swipe-toggle-bookmark-color`,
  `--swipe-label-color`

Values in the migrated scopes now resolve to this scale. Geometry that a scale
step cannot express keeps a **named component token declared where the
relationship lives** and read by the rules that depend on it — for example
`--reading-card-control-inset`, `--couch-toggle-inset`, `--m-fab-clearance`,
and the `--status-glyph-size-*` family. Each of those is derived from something
concrete (a control cluster's width, a floating button's position, the inner
box of an 11px ring), so snapping it would break an alignment rather than
adjust a spacing choice. These internal tokens are not part of the supported
Tier 1 theme API.

A custom property that is declared and read exactly once by the same rule is
not a component token — it restates where the value already was while hiding it
from the raw-value gate. `check:css-debt` rejects that shape.

This catalog applies to the shared shell (including notifications, dialogs, and
search), its Electron and mobile platform styles, and the standalone Electron
error page. Because the error page is a separate document, its stylesheet
declares the subset of public geometry tokens that it consumes, and
`check:cascade` fails if it consumes one it does not declare.

Reader and presenter documents are explicitly outside Phase 1. They retain
their existing document-local values and are not part of the Phase 1 debt gate
or exit criteria.
