# Once mobile redesign — implementation brief

Target: `apps/mobile` (Capacitor Android/iOS) plus the shared `packages/ui-web`.
Design reference: `Once Mobile.dc.html` (open it in a browser; it needs the sibling
`android-frame.jsx`, `support.js` and `assets/imgs/`).

## How to read the prototype

The file is one page with a turn/option structure. Each option has a visible id badge:

- **1a** — the CURRENT mobile UI, recreated from source. Use it as the "before" baseline.
- **1b** — the redesign as a working prototype. Everything below is demonstrated here:
  drag a story row for the two-stage swipe, tap ⋮ for the anchored menu, tap a story to
  open it inline, use the bottom tabs, walk into Settings → Story sources.
- **1c** — the five swipe plateaus laid out statically, with the pixel offsets.
- **1d** — story-row anatomy, current vs redesigned.

The prototype exposes tweaks (`menuStyle`: popover | inline | sheet, `showChips`,
`showTags`). `menuStyle: popover` is the chosen behaviour; the other two are rejected
alternatives kept for reference only.

All colors, spacings, fonts, badge colors and icons in the prototype were lifted from
the repo — `packages/ui-web/public/static/css/parts/*.css`, `apps/mobile/src/mobile.css`,
and the collector `colors:` tuples. Don't re-derive them; where the prototype shows a
literal (e.g. `rgb(202,202,172)`), it is the light-theme value of an existing variable
(here `--highlight-bg-color`). Implement with the variables, not the literals, so dark
theme keeps working.

## What must not change

The story list keeps its Electron/extension character: same type badges, same tag chips,
same `[comments]` link, same title/meta type scale, same row borders and read/unread
backgrounds. Shared logic stays in `@once/ui-web`; mobile-specific presentation stays in
`apps/mobile/src/mobile.css` and the mobile entry points.

## 1. Story row layout (`StoryListItem.story_html`, `mobile.css`)

Fixed four-slot row so height varies only with title wrapping:

1. `(domain)` — own line, ABOVE the title, monospace, `--text-color`, parens kept,
   ellipsised on overflow. Today the hostname trails the title inline.
2. Title — 16px, 1.3 line-height.
3. Meta line — type badge, `[comments]`, relative time, star glyph when bookmarked.
   The time must be `white-space: nowrap; flex: 0 0 auto` and the line must be allowed
   to wrap (`flex-wrap: wrap`), otherwise "36 mins / ago" splits and overlaps the tags.
4. Tags — always their own line, with a reserved min-height so rows without tags don't
   jump.

`[comments]` stays a plain grey text link (no button chrome) and remains one of the two
primary tap targets in the row.

## 2. Per-story actions

- Add a ⋮ button at the row's right edge, full row height, ~38px wide. It opens the menu
  on TAP, independently of long-press: its own `pointerdown` handler must stop
  propagation so the swipe and long-press handlers never arm.
- The menu is an ANCHORED context menu (not a bottom sheet). It drops 4px below the
  tapped row, right-aligned to the row, and flips to 4px above the row when it would
  collide with the tab bar. The point is that it opens under the thumb that tapped it —
  the user should never reach to the bottom of the screen.
- Long-press (500ms, existing `apps/mobile/src/actionSheet.ts`) opens the SAME menu at
  the same anchor. Keep it, and add a visual indicator while the press is building: a
  2px accent progress line growing along the row's bottom edge over the press duration,
  cancelled as soon as the press is cancelled or turns into a drag.
- Menu contents come from `describeStoryMenu` (`StoryContextMenu.ts`): Open story,
  Open in reader, Skip reading / Mark as unread / Unskip, Bookmark / Remove bookmark,
  Filter source / Edit filter, Search this domain, Copy link address. 44px rows.
- The existing bottom sheet can be retired once the anchored menu ships.

## 3. Two-stage detented swipe (`StoryListItem.swipeable`)

Replace the current free-tracking transform + single 10% threshold with detents:

- Plateaus at 0, ±96px, ±216px. While dragging, the row SNAPS to the nearest plateau
  (`<56px → 0`, `56–199px → stage 1`, `≥200px → stage 2`) with a short transition,
  instead of following the finger 1:1.
- Right: stage 1 = read / open, stage 2 = open in reader.
- Left: stage 1 = skip, stage 2 = filter source (opens the filter action).
- Release on a plateau fires that stage (classic mail-app behaviour), then the row
  springs back. Release below stage 1, or a browser-cancelled gesture, fires nothing.
- The revealed background states the action in words and changes color per stage
  (green → accent blue on the right; red → dark red on the left), reusing the existing
  `.bb_slide` structure.
- Keep `touch-action: pan-y` and the `TouchGestureLock` axis check so vertical scrolling
  and pull-to-refresh are unaffected.

## 4. Inline story viewing (reader + browser)

Today reader mode and the system browser are two separate exits. Manage both in-app,
like Electron does with its webview pane:

- A third bottom tab, "Reading", holds the current story. Story context sits above the
  content:
  - Row 1: back chevron, title, then borderless prev/next story chevrons and ⋮ grouped
    at the right.
  - Row 2 (same block): type badge, plain `[comments]` link, `(domain)`.
- Below that, VISUALLY SEPARATED (hairline + slightly tinted strip), a persistent URL
  bar: current URL (monospace, ellipsised), a reader-mode toggle INSIDE the pill at its
  right end (article glyph, tinted when reader view is active), and a reload button.
  There is no separate Reader/Browser segmented control.
- `[comments]` is a third content mode: the comment thread in the in-app browser. The
  URL bar shows the comment URL and the reader toggle untints.
- Prev/next move through the current story list without leaving the view.

## 5. Reader TTS (`readerTts.ts`, `readerTtsHostBridge.ts`)

Controls move OFF the top of the screen into a dismissable floating pill above the tab
bar:

- Pill: previous, play/pause, next, current rate (e.g. `1.5×`) with a caret, and ×.
- The caret opens a small popover anchored to the pill with the voice list
  (`Default voice` + the platform voices, as today) and speed presets
  1× / 1.25× / 1.5× / 2× / 3×. Rate range stays 0.5–6 and stays persisted to
  `once:reader:tts-rate`.
- A single play glyph at the left of the URL strip starts speech and raises the pill;
  × dismisses it.

## 6. Top bar and filters

- Search field on top, full width, pill-shaped, with the reload button beside it, left integrated into the seach field the global/local search toggle
- The desktop left rail's filters become a horizontally scrolling chip row under the
  search field, combining `[ALL]`, `new`, `stared`, `filtered`, the collector types
  (tinted with each collector's own colors) and the `*group` tags.
- Warnings/errors: a persistent count badge in the top bar (red, error-colored) opening
  a sheet listing the session's issues (title + source URL + dismiss), replacing the
  desktop `#status_surfaces` bubbles on mobile. Bubbles must never overlap the tab bar
  (`mobile.css` already pins `#status_surfaces { bottom: 55px }`).
- Bottom tab bar: Stories · Reading · Settings.

## 7. Settings — flat searchable list with pushed subpages

This one is NOT mobile-only: the same panel split should land in Electron and the
browser extensions, so build it in `packages/ui-web/src/SettingsPanel.ts` /
`public/shell.html` rather than as a mobile skin.

- Replace the single long scroll of `.settings_block`s with a flat list of rows, each
  showing a label plus a one-line summary of its current value, and a search field that
  filters the rows.
- Rows: Story sources · Filters · Redirects · CouchDB Sync · Theme & animations ·
  Cache timing · Reader & speech · Error log · About Once.
- Tapping a row pushes a full-screen subpage with a back arrow (mobile). Desktop and
  extensions should reuse the same sections as a list + detail pane.
- Each subpage that currently holds a raw monospace textarea (sources, filters,
  redirects) gets two modes: a parsed list of entries (one tappable row per entry, with
  its collector badge and an error marker where parsing/loading failed) and an
  "Edit as text" toggle that reveals the existing textarea with its red wavy
  error highlighting and gutter icons intact. The list is generated from the same text;
  the text remains the source of truth.
- Only the Story sources subpage is drawn in the prototype; Filters, Redirects, CouchDB,
  Theme, Cache, Reader & speech, Error log and About still need designs — ask before
  inventing them.

## more stuff

- Dark theme rendering (the prototype is light-theme only, but all should of course work with dark theme and later on custom themes).
