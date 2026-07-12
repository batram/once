# E2E coverage plan: story-list interactions (Electron, Chrome ext, Firefox ext)

## Verified design answers

1. **Story seeding.** No new seam needed anywhere.
   - Extensions: `?once-e2e=1` (packages/webext-shell/src/sidepanel.ts) seeds empty sources + disables initial load; tests add a `json:§§…§§http://127.0.0.1:PORT/feed.json` source through the settings UI (`data-testid="sources"` / `"save-sources"` in packages/ui-web/public/shell.html) — existing chrome.spec.js pattern.
   - Electron: same shell.html renders in the main window, so the _same UI path works_. `ONCE_ELECTRON_DISABLE_STORY_LOADING=1` only disables the initial load (`?disableStoryLoading` → `initialStoryLoad: "disabled"` in apps/electron/src/renderer.ts). Renderer fetch goes through main (`ipcMain.handle(ELECTRON_IPC.fetch)`), which throws while `ONCE_ELECTRON_DISABLE_NETWORK_FETCH=1`; launch story specs with `env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" }` (precedent: core-browser.spec.js:346) and _replace_ the sources textarea with only the local feed line before saving, so no external URL is ever fetched.

2. **"Story opened" verification.**
   - Electron: `open_story(_self)` → `tabs.openUrl` → navigates active tab (TabManager.openUrl disposition "current"); assert `#urlfield` value / `getWindowTabs()` active url. `"middle"` → background tab (`createTab(active=false)`); assert tab count + urls.
   - Chrome ext: both `_self` and `middle` call `browser.tabs.create` (packages/platform-webext/src/webextPorts.ts) → Playwright `context.waitForEvent("page")`.
   - Firefox: new window handle diff (existing firefox.test.js pattern).

3. **Swipe synthesis.** `swipeable()` uses `pointerdown` on the element + `document` `pointermove`/`pointerup`. Playwright `mouse.down/move({steps})/up` emits pointer events via CDP in both Chromium and Electron, headless included. Caveats: `end_swipe` parses `translateX\((-?\d+)px\)` (integers) → use integer coordinates; do ≥3 moves; drag ≥ ~30% of element width (threshold is 10%). Selenium Actions for Firefox is possible but fragile → **swipe (and middle-click, outline) run only on Playwright targets**.

4. **Filter flow.** `.filter_btn` click → `StoryFilterView.show_filter_dialog` prepends an `<input>` prefilled with the hostname (would match every fixture story — overwrite it with a unique token, e.g. `delta-filter`), Enter → app-owned `<dialog>` → click `data-testid="confirm-accept"`. Native `window.confirm` is not shown by the Firefox side panel, including with direct user input, so the production interaction uses DOM controls on every target. Result: `addFilter` → `saveFilterList` → `refilterStories` → story re-renders with class `filtered` (CSS `display:none`; visible via search `[filtered]` which adds `show_filtered`). **Removing**: edit `#filter_area` in settings, click its save button → `refilterStories` deletes `story.filter` → class removed, story visible again.

5. **Rewritten-URL selection (778a258).** Redirect rules are saved via `#redirect_area` in settings, format `match_regex => replacement` (`parseRedirectList`, packages/core/src/settings/defaults.ts). After save: `redirectsChanged` → StoryList `update_redirects()` rewrites `a.title` href and un-hides `a.og_href`. Clicking the title opens the **rewritten** URL (`open_story` → `URLRedirect.redirect_url`), so the active tab URL is the rewritten form and `updateSelected` (packages/ui-web/src/mountOnceUi.ts) must use the `findStoryByUrl` reverse lookup → `#selected_container story-item.selected`. Electron also allows navigating the URL bar directly to the rewritten URL (pure reverse-lookup test). Note: Electron's browser-level `applyRedirects` only runs on in-page `will-navigate` (apps/electron/src/browser/TabEvents.ts:82-93), not on URL-bar/`openUrl` loads — don't rely on it.
   - Extension active-URL plumbing: `createWebExtActiveTab.onSelectedUrlChanged` listens to `tabs.onActivated`/`onUpdated` of the current window; a story opened via `tabs.create({active:true})` fires it. **Pitfall:** bringing the sidepanel _tab_ back to front fires `selectUrl(<extension page url>)` which clears `#selected_container` — assert via `expect.poll` on the backgrounded sidepanel page (Playwright can evaluate background pages). This makes the test infeasible in selenium (switching windows changes focus) → **selected-story tests: Electron + Chrome only**.

6. **Outline button availability.** `presenters/outline.ts` `presenter_options.story_button.value = "always"` and `get_active()` hardcodes the outline presenter → `.outline_btn` is always present. Electron: click → `ReaderView.open` → `client.fetchDocument` (needs network flag "0", article-shaped fixture page) → `tabs.openReader` → tab URL `once-reader://…`. Chrome: click → runtime message `openReader` → `readerBackground.openReaderTab` opens the _story URL itself_ in a new tab and injects `reader.css`/`reader-content.js` (host_permissions `<all_urls>`).

7. **Persistence assertions.** DOM classes (`read`/`skipped`/`stared`/`filtered`) after actions; persistence: extensions reload the sidepanel + click `reload-stories` (existing pattern; PouchDB/IDB survives in the profile). Electron: add optional `userData` reuse to `launchApp` (skip `mkdtemp` when provided) and relaunch the app on the same dir — cleaner than `window.reload()`.

8. **Code reuse.** Firefox uses selenium + node:test, others Playwright → share only **fixture data + HTTP handler + selector constants** in a new CommonJS module `tests/e2e/shared/story-fixture.js`; both the extension local-source server and the Electron page server delegate to it. No shared driver logic.

## New/modified files

### New: `tests/e2e/shared/story-fixture.js`

- `feedJson(origin)` — items:
  - **alpha** `${origin}/story/alpha` (article-shaped page: repeated paragraphs so reader extraction succeeds)
  - **beta** `${origin}/story/beta` with `comments: ${origin}/comments/beta-1`, **plus a second item with the same href** and `comments: ${origin}/comments/beta-2` → `OnceApp.addStory` turns it into a substory (verified: sequential sync map-lookup makes this deterministic)
  - **gamma** `${origin}/story/gamma` (redirect-rule target)
  - **delta** `${origin}/story/delta-filter-target` title "Delta delta-filter story" (unique filter token)
- `sourceLine(origin)` — `json:§§{"stories":{"sel":"items","all":true},"link":{"sel":"href"},"title":{"sel":"title"},"timestamp":{"sel":"published"},"comment_href":{"sel":"comments"},"tags":[]}§§${origin}/feed.json` (json_select supports `comment_href`, verified in packages/collectors/src/collectors/json_select.ts)
- `redirectRule(origin)` — returns `{ line: "<regex-escaped origin>\\/story\\/gamma => ${origin}/rewritten/gamma", original, rewritten }`
- `handleRequest(request, response, origin)` — serves `/feed.json`, `/story/*` (alpha gets `<article>` paragraphs), `/rewritten/*`, `/comments/*`; returns false for unknown paths so callers can chain their own routes
- `SELECTORS` — `story`, `title: "a.title"`, `og: "a.og_href"`, `comment: "a.comment_url"`, `readBtn: ".read_btn"`, `starBtn: ".star_btn"`, `filterBtn: ".filter_btn"`, `outlineBtn: ".outline_btn"`, `selected: "#selected_container story-item.selected"`

### Modified: `packages/ui-web/public/shell.html`

Add testids following the existing convention: `data-testid="filters"` + `data-testid="save-filters"` on the filter textarea/save button; `data-testid="redirects"` + `data-testid="save-redirects"` on the redirect textarea/save button. (Sources block already has them.)

### Modified: `tests/e2e/electron/electron-harness.js`

- `startPageServer`: call `storyFixture.handleRequest` first, keep existing routes.
- `launchApp(options)`: honor `options.userData` (skip mkdtemp) for the relaunch/persistence test; keep default env flags.
- New helpers: `seedLocalSource(window, sourceLine)` (settings-menu → fill sources → save-sources → stories-menu → wait for story items), `saveRedirects(window, lines)`, `saveFilters(window, lines)`.

### Modified: `tests/e2e/extensions/local-source.js`

Add `startStoryFixture()` (or an option on `startLocalSource`) that serves the shared fixture; keep the existing minimal `startLocalSource` untouched so chrome.spec.js / firefox.test.js keep passing.

### Modified: `tests/e2e/extensions/playwright.config.js`

`testMatch: "*.spec.js"` (currently only `chrome.spec.js`).

### Modified: `package.json`

`test:extensions`: append the new firefox file: `node --test tests/e2e/extensions/firefox.test.js tests/e2e/extensions/firefox-stories.test.js`.

### New: `tests/e2e/extensions/chrome-harness.js` (optional but recommended)

Extract the persistent-context bootstrap from chrome.spec.js (extension load, route allowlist that aborts non-fixture origins, sidepanel open, source seeding) so both chrome specs share it.

## Test files & cases

### `tests/e2e/electron/story-list.spec.js` (full matrix; launch each test with `env: { ONCE_ELECTRON_DISABLE_NETWORK_FETCH: "0" }`, seed via settings UI)

1. **open story variants** — title click: `#urlfield` == alpha URL, story `.read` class, no `.skipped`; middle-click beta title: 2 tabs, background tab url beta, address unchanged; main comments link (`a.comment_url` in first `.info`) navigates to `comments/beta-1`; substory comments link (second `.info`) → `comments/beta-2`.
2. **outline button** — click `.outline_btn` on alpha → poll `getWindowTabs`: active tab url starts `once-reader://`, tab title contains "Alpha"; story marked `.read`.
3. **swipe gestures** — swipe-right (~40% width, integer coords, ≥3 `mouse.move` steps) on beta → `#urlfield` == beta, `.read`; swipe-left on gamma → `.skipped` class, no navigation.
4. **skip/star toggle + persistence** — `.read_btn` click → `.read.skipped` + title "unskip"; click again → classes removed; `.star_btn` → `.stared` (+ title "remove bookmark"); close app keeping userData, relaunch with `options.userData`, re-open stories, click reload-stories → `.stared`/`.skipped` restored; unstar → class removed.
5. **filter add/remove** — click `.filter_btn` on delta → input appears (value `127.0.0.1`), fill `delta-filter`, Enter → click `confirm-accept` → story has `.filtered` (hidden); `#filter_area` value contains `delta-filter`; search `[filtered]` shows it (`show_filtered` on `#stories`); remove the line in `#filter_area` + save-filters → `.filtered` gone, story visible.
6. **selected story incl. rewritten URL** — save `redirectRule.line` via redirects textarea; expect gamma `a.title[href]` == rewritten and `a.og_href` visible; click gamma title → active tab url == rewritten AND `#selected_container story-item.selected[data-href="${original}"]` present (the 778a258 path); URL-bar navigate to alpha → selection switches to alpha; URL-bar navigate directly to the rewritten gamma URL → gamma selected again (pure reverse lookup).

### `tests/e2e/extensions/chrome-stories.spec.js` (Playwright persistent context; near-full matrix)

1. **open story variants** — title click → `waitForEvent("page")` url `story/alpha`, `.read`; middle-click → new (background) page beta; comments + substory comments links → pages at `comments/beta-1` / `beta-2`; OG: save redirect rule via redirects textarea → gamma title href rewritten, `a.og_href` visible; click OG → new page at the **original** gamma URL (no rewrite, `useRedirect:false`).
2. **outline button** — click `.outline_btn` on alpha → new tab at `story/alpha`; poll `documentElement[data-once-reader-theme]` (set by readerBackground injection) to prove reader activation; story `.read`.
3. **swipe + skip/star + persistence** — swipe-left → `.skipped`; swipe-right → new active page alpha; `.read_btn` toggle both directions; `.star_btn` → `.stared`; `page.reload()` + reload-stories → `.stared`/`.skipped` persist (PouchDB/IDB), unstar works.
4. **filter add/remove** — same app-owned dialog flow as Electron.
5. **selected story incl. rewritten URL** — click alpha title (new active tab); **without bringToFront**, `expect.poll` sidepanel `#selected_container story-item.selected[data-href]` == alpha; with redirect rule, click gamma title → opened tab url == rewritten, selected item data-href == original gamma URL.
   Keep the existing offline guard (`context.route` aborting non-fixture origins) and pageerror collection.

### `tests/e2e/extensions/firefox-stories.test.js` (selenium + node:test; representative subset)

1. seed rich fixture (existing settings-UI pattern) → alpha title click → new window handle at `story/alpha`; back on panel handle assert story `class` contains `read` (accepting the onActivated churn — reading class attr is safe, only `#selected_container` is focus-sensitive).
2. `.read_btn` click → class contains `skipped`; click again → removed.
3. `.star_btn` → `stared`; `driver.navigate().refresh()` + reload-stories → still `stared`.
4. main comments link → new handle at `comments/beta-1`.
5. filter dialog: click `.filter_btn`, set input value via JS/sendKeys, Enter, click `[data-testid="confirm-accept"]` → class `filtered`.
   Skipped on Firefox by design: swipe, middle-click, outline, OG, selected-story.

## Run / verify

- Electron: `npm run test:electron:e2e` (packages first). Iterating: `npm run package:electron` once, then `npx playwright test --config tests/e2e/electron/playwright.config.js story-list`.
- Chrome: `npm run build:extensions` (or `build:chrome`), then `npx playwright test --config tests/e2e/extensions/playwright.config.js chrome-stories`.
- Firefox: `npm run build:firefox`, then `node --test tests/e2e/extensions/firefox-stories.test.js`.
- Full suite: `npm test` / `npm run test:extensions` after the package.json edit.

## Implementation order

1. shared/story-fixture.js + local-source.js + electron-harness.js changes
2. shell.html testids
3. Electron spec (fastest inner loop, richest assertions)
4. Chrome spec (+ chrome-harness extraction), playwright.config testMatch
5. Firefox subset + package.json script
6. Run all three suites; also run existing chrome.spec.js/firefox.test.js to confirm no fixture regressions

## Known risks / mitigations

- Swipe transform regex expects integer px → integer mouse coords, multi-step moves.
- Firefox side panels suppress native `confirm()` dialogs → keep confirmation app-owned and exercise it through normal DOM controls.
- Animations (`animate_read` waits for transitionend when `animated`) can delay resorting → assert classes (immediate), not DOM order; optionally uncheck `#anim_checkbox` during seeding for stability.
- Electron relaunch-persistence: keep userData until final cleanup (`closeApp` currently rm -rf's it; add a `keepUserData` flag).
- Filter input prefills the fixture hostname `127.0.0.1` — always overwrite with a story-unique token or every fixture story gets filtered.
