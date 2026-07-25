# Once mobile redesign — implementation plan

## Context

`apps/mobile` today is a thin skin over the desktop UI: story rows are the Electron
layout squeezed narrower, all per-story actions hide behind a 500 ms long-press bottom
sheet that proxies hidden `.button_group .btn` elements, swipe is a single free-tracking
10 %-threshold gesture, and every "open" is an exit — either a full-screen Capacitor
`Browser` Custom Tab (outside the app's DOM entirely) or a `srcdoc` reader overlay.
Settings is one long scroll of raw monospace textareas.

`docs/Mobile app redesign with swipe/` holds a working prototype (`Once Mobile.dc.html`,
option **1b**) plus `MOBILE_REDESIGN_BRIEF.md`. This plan implements that brief.

Intended outcome: a mobile app whose story list keeps the Electron/extension character
(same type badges, tag chips, `[comments]` link, row borders, read/unread backgrounds)
but is driven by thumb-reachable, detented gestures, with reading — reader mode, live
web, and comment threads — happening *inside* the app rather than as an exit.

### Decisions taken up front

- **In-app browser**: a custom Capacitor plugin hosting a native `WebView`/`WKWebView`
  positioned behind a transparent hole in the app layout. `@capacitor/browser` cannot be
  embedded (it is a full-screen system overlay) and an `<iframe>` is blocked by
  `X-Frame-Options`/`frame-ancestors` on HN, Reddit, Lobsters and most sources.
- **Settings (§7)**: restructured in the shared `packages/ui-web` now, with Electron and
  the extensions rendering the same sections as list + detail. Not a mobile skin.
- **Undesigned subpages**: only Story sources gets the designed treatment. Filters,
  Redirects, CouchDB, Theme, Cache, Reader & speech, Error log, About push a subpage that
  hosts today's existing `.settings_block` markup behind a back arrow. Nothing invented.
- **Sequencing**: staged. Each stage lands independently with the mobile suites green.
- **Swipe scope** (decided during stage 3): the detented swipe is shared by every
  platform, *and* it is user-configurable — enable/disable the second stage, set both
  stages' thresholds and resting offsets, and choose the action for each of the four
  direction/stage slots. Settings live in `packages/app/src/swipeSettings.ts`, are stored
  through the existing synced `getListSetting`/`setListSetting` path, and are edited in a
  new "Swipe actions" settings block.

### Shared constraints (apply to every stage)

- Implement with CSS variables, never the prototype's literals. `rgb(202,202,172)` is
  `--highlight-bg-color`, `rgb(246,246,239)` is `--unread-bg-color`/`--main-bg-color`,
  `#ccc` is `--read-bg-color`, `#828282` is `--text-color`, `#342b20` is `--m-ink`.
  Every stage must be checked in dark theme (`body[data-theme="dark"]`), not just light.
- Shared logic stays in `@once/ui-web`; mobile-only presentation stays in
  `apps/mobile/src/mobile.css` and the mobile entry points.
- Keep `touch-action: pan-y` on `.story` and the `getTouchGestureAxis` check
  ([TouchGestureLock.ts](packages/ui-web/src/TouchGestureLock.ts)) so vertical scroll and
  `attachPullToRefresh` are unaffected.

---

## Stage 1 — Story row layout (§1)

**Files**: [StoryListItem.ts](packages/ui-web/src/StoryListItem.ts) (`story_html`,
`info_block`), [mobile.css](apps/mobile/src/mobile.css),
[stories.css](packages/ui-web/public/static/css/parts/stories.css)

Today `story_html()` builds `.title_line` = title + `[OG]` + `(hostname)` inline, and
`info_block()` builds `.info` = type + `[comments]` + time + tags on one wrapping line.
Restructure into four fixed slots so height varies only with title wrapping:

1. `(domain)` moves out of `.title_line` onto its own line **above** the title —
   monospace, `--text-color`, parens kept, `text-overflow: ellipsis`. Keep the existing
   `hostname` element and its `search:domain:` `bindLinkBehavior` handler; only its DOM
   position and CSS order change. Prefer reordering with CSS `order` on the mobile
   selectors over restructuring `title_line`, so Electron/extension layout is untouched.
2. Title — `--m-fs-title` (16px), `line-height: 1.3`.
3. Meta line — type badge, `[comments]`, relative time, star glyph when `.stared`.
   `.info` gets `flex-wrap: wrap`; `.info .time` gets
   `white-space: nowrap; flex: 0 0 auto` — without both, "36 mins / ago" splits and
   overlaps the tags. Note `stories.css` currently sets `.info .time { min-width: 65px }`,
   which must not fight the nowrap rule on mobile.
4. `.tags_container` — forced onto its own line (`flex-basis: 100%`) with a reserved
   `min-height` so rows without tags don't jump.

`[comments]` stays a plain grey text link, no button chrome — it remains one of the two
primary tap targets. The star glyph in the meta line is presentation only; the real
bookmark toggle stays in the menu.

**Verify**: `npm run test:mobile:web` (row geometry assertions in
[mobile-web.spec.js](tests/e2e/mobile/mobile-web.spec.js)); visually diff against
prototype option **1d** in both themes; confirm Electron rows are unchanged via
`npm run test:electron:e2e`.

---

## Stage 2 — ⋮ button and anchored context menu (§2)

**New file**: `packages/ui-web/src/StoryAnchoredMenu.ts` (shared — the extensions and
Electron use native menus, so this is the DOM fallback mobile needs).
**Files**: [StoryContextMenu.ts](packages/ui-web/src/StoryContextMenu.ts),
[StoryListItem.ts](packages/ui-web/src/StoryListItem.ts),
[actionSheet.ts](apps/mobile/src/actionSheet.ts), [main.ts](apps/mobile/src/main.ts)

- Add a ⋮ button in `story_html()` at the row's right edge — full row height, ~38px wide.
  Its own `pointerdown` handler must `stopPropagation()` so neither the swipe handler in
  `swipeable()` nor the long-press timer in `installStoryActionSheet` ever arms. It opens
  on **tap**, not long-press.
- Build the menu from `describeStoryMenu()` rather than by proxying hidden buttons.
  `StoryMenuPlatform` already has a `"mobile"` member but no visibility rules for it —
  add them so the mobile menu is exactly: Open story, Open in reader, Skip reading /
  Mark as unread / Unskip, Bookmark / Remove bookmark, Filter source / Edit filter,
  Search this domain, Copy link address. Hide `open-new-tab`, `open-background-tab`,
  `undo`/`redo`. Actions dispatch through the existing `executeStoryMenuAction`, so all
  persistence stays in `@once/ui-web`. Rows are 44px.
- Positioning: 4px below the tapped row, right-aligned to it; flip to 4px above when it
  would collide with the tab bar (`--m-tabbar-h`). Port `positionMenu()` from the
  prototype (line ~500 of `Once Mobile.dc.html`). The point is that it opens under the
  thumb that tapped it.
- Long-press (500 ms, existing detector in `actionSheet.ts` with its `MOVE_TOLERANCE_PX`
  and click-suppressor) opens the **same** menu at the same anchor. Keep the suppressor
  logic verbatim — it is subtle and already correct.
- Add a press-progress indicator: a 2px accent line growing along the row's bottom edge
  over the 500 ms, cancelled on pointer cancel or as soon as movement exceeds tolerance
  and the gesture becomes a drag.
- Retire the bottom sheet (`.once-sheet*` markup, CSS and the `triggerButton` proxy) once
  the anchored menu ships. `.button_group { display: none }` stays.

**Test churn**: `openStorySheet()` and every `sheet-*` testid in
[mobile-web.spec.js](tests/e2e/mobile/mobile-web.spec.js) and
[mobile.smoke.js](tests/e2e/mobile/mobile.smoke.js) must be rewritten against the new
menu. Give menu rows stable testids derived from `StoryMenuActionId`
(`story-menu-open-reader`, …) rather than from button classnames.

**Verify**: `npm run test:mobile:web`; `npm run test:mobile` (unit);
`node --test tests/unit/ui-web/story-context-menu.test.js` extended with mobile-platform
visibility cases. Manual: tap ⋮ near the bottom of the list and confirm the flip.

---

## Stage 3 — Two-stage detented swipe (§3)

**Files**: [StoryListItem.ts](packages/ui-web/src/StoryListItem.ts) (`swipeable`),
[stories.css](packages/ui-web/public/static/css/parts/stories.css) (`.bb_slide`),
[mobile.css](apps/mobile/src/mobile.css)

Replace the free-tracking transform + single `threshold = 0.1` with detents:

- Plateaus at `0`, `±96`, `±216` px. Stage from raw drag distance: `<56 → 0`,
  `56–160 → 1`, `>160 → 2`. While dragging the row **snaps** to the plateau with a short
  transition (`transform 90ms ease-out` dragging, `200ms cubic-bezier(.2,.8,.2,1)`
  springing back) rather than following the finger 1:1.
- Right: stage 1 = read / open, stage 2 = open in reader.
  Left: stage 1 = skip, stage 2 = filter source (`showFilterAction`).
- Release **on** a plateau fires that stage, then the row springs back. Release below
  stage 1, or a browser-cancelled gesture (`pointercancel`/`touchcancel` → existing
  `cancel_swipe`), fires nothing. Note the current `end_swipe` re-parses the shift out of
  the inline `transform` string — replace that with tracked state.
- The revealed background reuses the existing `.bb_slide` structure but states the action
  in words and changes color per stage: green → accent blue on the right, red → dark red
  on the left. Map to variables (accent blue is the dark-theme `--highlight-bg-color`
  family; the greens/reds need two new mobile variables rather than the prototype's
  literal `#4050ac` / `#8f0000`).
- Keep the existing mouse path (`mouse_swipe`) working for the Playwright web suite;
  keep the `pointerType === "touch"` early return that prevents double-handling.
- Coordinate with Stage 2: exceeding ~8px of movement must cancel the long-press timer.

Configurability (added at the user's request): a `SwipeSettings` model in
`packages/app/src/swipeSettings.ts` with defaults matching the numbers above, normalized
on every read and write because the document is CouchDB-synced and may come from another
version. `SwipeConfig` in `StoryListItem.ts` holds the live copy for all rows;
`mountOnceUi` seeds it and refreshes it on `settingsChanged`. A generated "Swipe actions"
block in `SettingsPanel` edits it. Reveal colours are keyed by *action*, not by stage, so
a reconfigured swipe keeps its colour meaning.

**Verify**: `npm run test:mobile:web` with new detent assertions (synthesised
`Touch`/`TouchEvent` sequences, as the existing pull-to-refresh test already does);
`npm run test:mobile:e2e:android` for real-device gesture behaviour. Explicitly test that
a vertical scroll and a pull-to-refresh still fire nothing. The desktop swipe helpers in
`tests/e2e/electron/story-list.spec.js` and `tests/e2e/extensions/chrome-stories.spec.js`
drag "40% of row width", which is a stage-2 distance on a wide row — they take an explicit
stage instead.

---

## Stage 4 — Native in-app browser plugin

**New**: `apps/mobile/android/app/src/main/java/com/zmarn/once/InAppWebViewPlugin.java`
(+ registration in [MainActivity.java](apps/mobile/android/app/src/main/java/com/zmarn/once/MainActivity.java),
alongside the existing `SecureSettingsPlugin`), a TS wrapper in
`packages/platform-mobile/src/`, and the iOS `WKWebView` counterpart.

This is the foundation for Stage 5 and the only part with no existing basis in the repo.
Ship it as its own stage, behind the existing exits, before rewiring any UI.

- Plugin API: `open(url)`, `loadUrl(url)`, `reload()`, `goBack()`, `setBounds(rect)`,
  `setVisible(bool)`, `close()`; events `urlChanged`, `loadStart`, `loadEnd`, `error`,
  `canGoBackChanged`.
- The native view is added to the Capacitor `BridgeActivity`'s content view *behind* the
  Capacitor WebView, which is made transparent in the region the JS layout reserves.
  JS calls `setBounds` with the CSS rect of the reserved hole (× device pixel ratio) on
  every layout change, orientation change and keyboard show/hide.
- Wire the Android hardware back button in [main.ts](apps/mobile/src/main.ts) — it
  currently closes the reader then exits; it must now also drive `goBack()` first.
- Keep `bridge.openExternal` / `@capacitor/browser` as the fallback for platforms without
  the plugin (the webpack dev server used by `test:mobile:web` has no native layer), so
  `activeTab.openUrl` in [platform-mobile/src/index.ts](packages/platform-mobile/src/index.ts:118)
  degrades rather than breaking.

**Verify**: `npm run run:mobile:android` and load a site with `X-Frame-Options: DENY`
(news.ycombinator.com) to prove the iframe limitation is genuinely bypassed. Confirm the
hole tracks the layout on rotate and on keyboard open. iOS parity via
`npm run run:mobile:ios`.

---

## Stage 5 — Reading tab (§4)

**New**: `packages/ui-web/src/ReadingView.ts` (shared shell) + mobile wiring.
**Files**: [shell.html](packages/ui-web/public/shell.html) (third panel + tab),
[menu.ts](packages/ui-web/src/menu.ts) (`open_panel` already handles arbitrary panels),
[ReaderDocumentHost.ts](packages/ui-web/src/ReaderDocumentHost.ts),
[mobile.css](apps/mobile/src/mobile.css)

Bottom tab bar becomes **Stories · Reading · Settings** (currently Settings · Stories,
rendered from `#menu .sub` in `shell.html` and bound by `Menu.init`). The reader overlay
(`.once-reader-host`) stops being a full-screen overlay and becomes the Reading panel's
content layer, so the tab bar stays visible.

Story context block above the content:
- Row 1: back chevron, title, then borderless prev/next chevrons and ⋮ grouped right.
- Row 2 (same block): type badge, plain `[comments]` link, `(domain)`.

Below, **visually separated** by a hairline + slightly tinted strip, a persistent URL bar:
current URL (monospace, ellipsised), a reader-mode toggle *inside* the pill at its right
end (article glyph, tinted when reader view is active), a reload button, and a single
play glyph at the left that starts TTS (Stage 6). No segmented Reader/Browser control.

Three content modes over one surface:
- `reader` — the existing `srcdoc` iframe from `ReaderDocumentHost` / `ReaderView.open`.
- `browser` — the Stage 4 native WebView, bounds set to the content rect.
- `comments` — the same native WebView at `story.comment_url`; URL bar shows the comment
  URL, reader toggle untints. `[comments]` in the story row and in row 2 both route here
  instead of calling `openStoryUrl`.

Prev/next walk the current story list without leaving the view. There is no ordered-list
accessor today — add one to [StoryList.ts](packages/ui-web/src/StoryList.ts) beside the
existing `sortStories`/`resortSingle`, honouring `.nomatch`/`.filtered` visibility so
next/prev follows what the user actually sees.

**Verify**: `npm run test:mobile:web` (reader mode only — no native layer in the browser
harness); `npm run test:mobile:e2e:android` for browser and comments modes. Check the
back button ordering: WebView history → Reading tab → Stories tab → exit.

---

## Stage 6 — Reader TTS pill (§5)

**Files**: [readerTts.ts](packages/ui-web/src/reader/readerTts.ts),
[readerDocument.html](packages/ui-web/src/reader/readerDocument.html),
[readerTtsHostBridge.ts](apps/mobile/src/readerTtsHostBridge.ts),
[readerTtsProtocol.ts](apps/mobile/src/readerTtsProtocol.ts)

Controls today live *inside* the sandboxed reader document (`.tts-controls` in
`readerDocument.html`, driven by `installReaderTts` in the frame; native speech reaches
it through the `once-reader-tts` postMessage bridge). Move the **controls** to the host
while leaving segmentation and highlighting in the frame:

- Host renders a dismissable floating pill above the tab bar: previous, play/pause, next,
  current rate (`1.5×`) with a caret, and ×.
- The caret opens a small popover anchored to the pill: voice list (`Default voice` + the
  platform voices already delivered by the bridge's `voices` request) and speed presets
  1× / 1.25× / 1.5× / 2× / 3×. Rate range stays 0.5–6, still persisted to
  `once:reader:tts-rate`.
- Extend `ReaderTtsRequest`/`ReaderTtsEvent` with host→frame control messages
  (`play`, `pause`, `prev`, `next`, `setRate`, `setVoice`) and frame→host state
  (`playing`, `rate`, `segment`). Today the protocol is frame→host only; this is the main
  code change. Hide `.tts-controls` in the frame when a host is present, and keep the
  in-frame controls for the extension/Electron reader, which has no host pill.
- A single play glyph at the left of the URL strip starts speech and raises the pill;
  × dismisses it.

**Verify**: `node --test tests/unit/mobile/reader-tts-bridge.test.js`, extended for the
new message types; manual playback on device (`npm run run:mobile:android`) checking that
paragraph transitions stay gapless (`QueueStrategy.Add`) and that a cancel still bumps the
generation counter.

---

## Stage 7 — Top bar, filter chips, warnings badge (§6)

**Files**: [shell.html](packages/ui-web/public/shell.html) (`#search_bar`),
[mobile.css](apps/mobile/src/mobile.css), [menu.ts](packages/ui-web/src/menu.ts),
[search.ts](packages/ui-web/src/search.ts),
[LoaderInsights.ts](packages/ui-web/src/LoaderInsights.ts),
[CollectorStyles.ts](packages/ui-web/src/CollectorStyles.ts)

- Search field full width, pill-shaped, with the reload button beside it. The
  local/global toggle (`#search_scope`, today a `<select>`) integrates into the left end
  of the field.
- The desktop left rail's `#menu #types` / `#menu #groups` are `display: none` on mobile
  today. Replace with a horizontally scrolling chip row under the search field, combining
  `[ALL]`, `new`, `stared`, `filtered`, the collector types and the `*group` tags —
  reusing the entries `Menu.add_type`/`add_group` already create and the collector color
  tuples `addCollectorColorStyles` already emits. Chips reuse the existing click
  behaviour (set scope local, set searchfield, `Search.searchStories`).
- Warnings/errors: a persistent red count badge in the top bar opening a sheet listing the
  session's issues (title + source URL + dismiss), replacing the desktop
  `#status_surfaces` bubbles on mobile. `mobile.css` already pins
  `#status_surfaces { bottom: 55px }` — bubbles must never overlap the tab bar.

**Verify**: `npm run test:mobile:web` (the existing test asserts ≥12px gap between
`#searchfield` and `#reload_stories_btn` — update it for the new pill); confirm chip
colors in both themes; trigger a source error and confirm the badge/sheet.

---

## Stage 8 — Settings: flat searchable list with pushed subpages (§7)

**Files**: [SettingsPanel.ts](packages/ui-web/src/SettingsPanel.ts),
[shell.html](packages/ui-web/public/shell.html),
[settings.css](packages/ui-web/public/static/css/parts/settings.css),
[electron.css](apps/electron/src/electron.css), [mobile.css](apps/mobile/src/mobile.css)

This is cross-platform: `shell.html` is the single settings markup, consumed by Electron
([forge.config.js:50](apps/electron/forge.config.js:50)), mobile
([webpack.config.js:104](apps/mobile/webpack.config.js:104)) and the extension sidepanel.
`SettingsPanel`'s constructor reaches for `#sources_area`, `#filter_area`,
`#redirect_area`, `#couch_input`, `#theme_select`, `#cache_time_input`, `#error_log` via
`requireElement` and throws if any is missing — so all sections must stay in the DOM;
only their *containment* changes.

- Wrap each existing `.settings_block` in a `<section data-settings-section="…">` and add
  a flat row list above: **Story sources · Filters · Redirects · CouchDB Sync · Theme &
  animations · Cache timing · Reader & speech · Error log · About Once**, each row showing
  a label plus a one-line summary of its current value, plus a search field filtering the
  rows.
- Mobile: tapping a row pushes the section full-screen with a back arrow. Desktop and
  extensions: the same rows render as a list beside a detail pane. One `SettingsSections`
  model, two presentations — keep `requireElement` lookups valid in both.
- **Story sources** subpage (the only one designed) gets two modes: a parsed list of
  entries — one tappable row per source line with its collector badge and an error marker
  where parsing/loading failed, generated from `sourceErrors` which `SettingsPanel`
  already maintains — and an "Edit as text" toggle revealing the existing `#sources_area`
  with its red wavy highlighting and gutter icons intact. **The text stays the source of
  truth**; the list is derived from it.
- Every other row pushes a subpage hosting its existing `.settings_block` unchanged,
  behind a back arrow. No invented designs.
- `highlight_filter`, `highlightSource`, `showErrorLog`, `showSourceErrorLog` all call
  `menu.open_panel("settings")` then scroll to an element — each must additionally open
  the right subpage before scrolling.

**Verify**: `npm run check` (types + boundaries + all three product builds);
`npm run test:electron:e2e` — [source-picker.spec.js](tests/e2e/electron/source-picker.spec.js)
and [story-list.debug.js](tests/e2e/electron/story-list.debug.js) both drive
`#sources_area` directly and will need the subpage opened first;
`npm run test:extensions`; `npm run test:mobile:web`.

---

## Stage 9 — Dark theme and polish

Sweep every stage in `body[data-theme="dark"]` and under
`@media (prefers-color-scheme: dark)`. Any literal that slipped in from the prototype
gets replaced with its variable. Add the two new swipe-stage color variables to
[vars.css](packages/ui-web/public/static/css/parts/vars.css) using `light-dark()`, matching
the existing convention, so later custom themes have a hook.

**Verify**: `npm run check && npm test`, then
`npm run test:mobile:web && npm run test:mobile:e2e:android`, with a manual pass through
each surface in both themes.

---

## Rejected alternatives kept for reference

The prototype exposes `menuStyle: popover | inline | sheet`. Only `popover` is
implemented; `inline` and `sheet` are rejected. `showChips` / `showTags` are both on.
