# Public design tokens

These custom properties are the supported platform-neutral geometry vocabulary.
Their initial values preserve the pre-token computed styles; changing the scale is
a separate design decision.

| Category | Tokens | Defaults |
|---|---|---|
| Spacing | `--sp-1` … `--sp-6` | `4px`, `8px`, `12px`, `16px`, `24px`, `32px` |
| Type | `--fs-title`, `--fs-body`, `--fs-meta`, `--fs-label` | `16px`, `14px`, `12px`, `10px` |
| Icons | `--icon-sm`, `--icon-md`, `--icon-lg` | `12px`, `16px`, `24px` |
| Touch | `--touch` | `44px` |
| Radius | `--radius-sm`, `--radius-md`, `--radius-lg` | `2px`, `6px`, `8px` |
| Border | `--bw` | `1px` |

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

Component geometry and optical corrections are not automatically snapped to this
scale. They retain their measured value until they are classified and given a
semantic component token.

This Phase 1 catalog applies to the shared shell and its Electron and mobile
platform styles. The separately rendered reader and outline presenter retain
their existing document-local values until their theming scope is decided.
