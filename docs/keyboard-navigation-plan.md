# Keyboard navigation for desktop / Electron

Status: approved, implementation in progress.

## Context

Once is currently mouse-driven. There is **no keyboard dispatcher and no keybinding config at all** — every shortcut is a hardcoded `if (event.key === …)` scattered across unrelated feature modules (`StoryHistory` owns Ctrl+Z/Y, `storySearch` owns Ctrl+F, `BrowserShell` owns F11). There is no story cursor: the story list has no `tabindex`, no focus model, and the only notion of a "current" story is `#selected_container`, which mirrors whatever URL the browser pane shows.

The goal is to make the desktop/Electron environment operable with minimal to no mouse input, with the bindings user-configurable. `docs/once_todo.txt:126` and `docs/dreams_of_road.txt:8` already ask for this.

Target bindings (all remappable):

| Context | Default | Command |
|---|---|---|
| Electron | Ctrl+F / Ctrl+L | focus story search / focus urlbar |
| Electron | Ctrl+T / Ctrl+Shift+T / Ctrl+N | new tab / restore closed tab / new window |
| Electron | Ctrl+Tab / Ctrl+Shift+Tab | next / previous tab |
| Desktop | ↑↓ / W S | move story cursor |
| Desktop | ← / A, → / D | run the configured stage-1 left / right swipe action |
| Desktop | Ctrl+← / Ctrl+→ | jump focus between story list and content pane |

### Decisions already taken
- **Comment sidebar / unified comment styling is out of scope**, deferred entirely. (It is greenfield: only `comment_url` strings exist today, no comment fetching or parsing anywhere.)
- Keybinding config is **device-local in `localStorage`**, following the `once-electron-story-position` pattern — not synced through `AppSettings`.
- Electron shortcuts **must work while a web page tab has focus**, via the existing main-process `before-input-event` hook.

---

## 0. Non-focus-stealing Electron test mode (do this first)

Today `npm run test:electron:e2e` launches real Electron windows that raise themselves and take OS focus, so a test run hijacks the desktop. That is already annoying; with keyboard tests it becomes unworkable — a run would fire Ctrl+T and WASD at whatever the user is actually typing into. Note the harness already works around this class of problem once, at `electron-harness.js:294`: `seedLocalSource` sets the textarea value directly rather than typing, "because Electron text-focus/input handling can hang in the non-interactive Windows session".

There are exactly **two** focus-stealing sites:
- `apps/electron/src/TabManager.ts:109` — `window.once("ready-to-show", () => window.show())`
- `apps/electron/src/browser/WindowLifecycle.ts:68-70` — `show()` / `moveTop()` / `focus()`

Everything else is in-process: `TabOwnership.ts:80` and `WindowLifecycle.ts:71` call `webContents.focus()`, which moves focus *inside* the app without raising the window, and Playwright's clicks/fills/`keyboard.press` go through CDP `Input.dispatchKeyEvent` — injected into the renderer, no OS focus required.

**Change (implemented):** a `ONCE_ELECTRON_TEST_BACKGROUND=1` env flag, read via `isBackgroundMode()` in `browser/WindowLifecycle.ts`:
- `main.ts` `createShellWindow` → `focusable: !isBackgroundMode()`;
- `TabManager.ts:109` and `WindowLifecycle.focus()` → `showWindow()`, which uses `showInactive()` in background mode;
- `WindowLifecycle.focus()` also skips `moveTop()`/`window.focus()`, keeping the inner `webContents.focus()` so focus assertions still mean something.

`focusable: false` (WS_EX_NOACTIVATE) is the part that actually works. **`showInactive()` alone is not sufficient on Windows** — measured: the window still came up focused, and `webContents.focus()` (called by `TabOwnership.activate` on every tab switch) kept pulling the foreground back. An explicit `window.blur()` on the `focus` event did not hold either. Injected input still reaches a non-focusable window, since Playwright drives the app through CDP and `sendInputEvent`, not the OS.

**Harness:** `launchApp()` sets the flag **by default**, so every spec stops stealing focus with no per-spec edits. `expectDocumentFocus` is unaffected — `document.activeElement` does not depend on OS window focus. Escape hatch for watching the app by hand: `launchApp({ background: false })`, or `ONCE_ELECTRON_E2E_INTERACTIVE=1` for a whole run.

**Result:** no `@interactive` subset is needed — all 42 existing Electron e2e specs pass in background mode, including `fullscreen.spec.js` and `window-chrome.spec.js`. `npm run test:electron:e2e` is now non-focus-stealing in full.

**Measured constraint for §5's tests:** Playwright's `page.keyboard.press()` on a *tab* page does **not** trigger the main-process `before-input-event` hook (CDP `Input.dispatchKeyEvent` bypasses it); `webContents.sendInputEvent()` from `electronApp.evaluate` does. So keyboard specs must drive the forwarding path with `sendInputEvent`. Keys aimed at the **shell** renderer are ordinary DOM events and `window.keyboard.press()` is fine there.

---

## 1. Chord primitives — `packages/core/src/keyChord.ts` (new)

Serialization: `Ctrl+Alt+Shift+Meta+<Key>`, modifiers in that fixed order, key from `event.code` (layout-independent: physical WASD works on any layout, `Ctrl+Shift+T` is stable). Normalize `KeyF`→`F`, `Digit1`→`1`, keep `ArrowUp`/`Tab`/`F11`.

Must live in `@once/core` because both `packages/ui-web` (a `KeyboardEvent`) and the Electron **main process** (an `Electron.Input`) need the same normalizer, and `scripts/check-boundaries.js` forbids ui-web from importing `@once/platform-*`. Exports `chordFromParts`, `formatChord`, `parseChord`, `isModifiedChord`; thin adapters `chordFromEvent` (ui-web) and `chordFromInput` (`TabEvents.ts`) call it. `Electron.Input` carries `.code`/`.key`/`.control`/`.alt`/`.shift`/`.meta`, so the adapters are symmetric.

## 2. Dispatcher — `packages/ui-web/src/keyboard/`

New: `commands.ts`, `KeyboardDispatcher.ts`, `keybindingStore.ts`, `conflicts.ts`.

```ts
interface KeyCommandDefinition {
  id: KeyCommandId
  label: string                  // shown in settings, harvested by settings search
  group: "stories" | "browser" | "panes" | "history" | "search"
  context: "global" | "stories" | "browser"
  defaultKeys: string[]          // two entries where arrows + WASD both apply
  allowInTextEntry: boolean
  shells?: readonly ShellId[]     // omitted = every shell; see below
}
```

### Shell availability

`shells` is the answer to "can this shell even do that?", and it is enforced, not
decorative: `availableKeyCommands()` filters by the shell named in `mountOnceUi({ shell })`,
and `KeyboardSettingsView`, `defaultKeybindings()`, `bindingsFrom()` and `conflicts.ts` all
read that rather than `keyCommands()`. So an unavailable command has no settings row, holds
no chord, and blocks nobody from taking one.

The `browser`, `panes` and `window` commands are `["electron"]` because a sidepanel extension
cannot deliver them at all — not merely because nothing registered a handler:

- Its `keydown` listener only fires while focus is inside the panel document, and the browser
  consumes `Ctrl+T/W/N/Shift+T/Tab`, `Ctrl+L` and `F11` before it ever gets there. `tabs.*`,
  `windows.create` and `sessions.restore` exist, but only on chords a user would have to
  invent, so they were left out rather than half-wired.
- There is no API in either browser to focus the address bar, and no second pane to focus.

The only shortcut that reaches Once while a *page* has focus is a manifest `commands` entry:
Firefox's built-in `_execute_sidebar_action`, and `open-side-panel` in the Chrome manifest,
whose background handler calls `chrome.sidePanel.open({ windowId })` — permitted because a
keyboard command is the user gesture that API demands, and taken from the tab the listener is
handed rather than an awaited lookup that would outlive the gesture. Both suggest `Ctrl+Shift+Y`.
The browser owns those keys, so the sidepanel reads the live values with `commands.getAll()` and
lists them read-only (`MountOnceUiOptions.browserShortcuts`) alongside
`chrome://extensions/shortcuts` / `about:addons`. Neither address can be linked to from an
extension page, so both are offered as copyable text; Chrome additionally allows
`tabs.create` for its own settings page, so there the address gets an Open button too.

**Opening the panel and focusing it are separate things.** Measured by hand, since no driver
can dispatch a browser-level accelerator: `Ctrl+Shift+Y` in Chrome opens the side panel *and*
gives it the keyboard, while in Firefox it opens the sidebar and leaves focus in the page.
That is [bug 1502713](https://bugzilla.mozilla.org/show_bug.cgi?id=1502713), still open — a
`sidebarAction.open({ focus: true })` patch was proposed and never landed — so do not assume
the panel has the keyboard after summoning it in Firefox.

Moving focus the other way, from the panel back to the page, has no API at all in either
browser; [w3c/webextensions#693](https://github.com/w3c/webextensions/issues/693) requests one
and carries supportive labels from Chrome, Firefox and Safari. The browsers' own `F6` /
`Shift+F6` cycles between the content area and the panel (Windows and Linux; on macOS
⌘+Option+Up/Down reaches only the sidebar switcher). That is the answer for both directions in
Firefox, and it is why no Once command tries to do it — everything available would be a
fudge that closes the panel or flickers a tab round-trip.

### Switching between a story and its comments

`story.toggle-comments` (`Alt+Shift+C`) acts on **the open page**, not the keyboard cursor:
`story/selectedStoryToggle.ts` reads the row already mirrored into `#selected_container` and
picks the other side with `Story.matches_comment_url()` / `matches_story_url()`. It returns null
when the open URL matches neither — a mirror that lags the tab must not navigate the user
somewhere they never asked for. The last selected URL is kept in that module because the
mirrored row says *which* story is open, not which of its two URLs.

It navigates through the new `"current"` open target rather than `openStoryUrl`, which marks
the URL it is handed as read — that key is a story href, and half the time this passes a
comments URL. In Electron `"current"` is `resolveOpenDisposition`'s existing in-place branch;
in the extensions it is `tabs.update` on the active tab, because there `"_self"` means a new tab.

The extensions declare it as a manifest command as well, since the whole point is that the user
is reading the page and the panel does not have the keyboard. The background cannot answer it —
it has no story database — so `keyCommandBackground.ts` relays it to the panel, which runs the
command through `dispatcher.run()`. With the panel closed nothing happens, which is correct:
no panel, no selected story.

**Chrome's manifest command is `Alt+Shift+K`, not `Alt+Shift+C`.** Chrome silently declines to
assign `Alt+Shift+C`: the manifest loads without complaint and `commands.getAll()` simply
reports no shortcut. Measured against a loaded extension, it rejects `Ctrl+Shift+C` as well
while accepting `Alt+Shift+K`, `Ctrl+Shift+K`, `Alt+Shift+1` and a bare `Alt+C` — so it is the
letter under Shift that is reserved (`Ctrl+Shift+C` is DevTools' inspect-element), not the
modifier pattern. Firefox takes `Alt+Shift+C` without objection, and so does the in-app binding
in every shell, since that is an ordinary DOM keydown rather than a browser command. The
divergence is Chrome's alone and the `chrome.spec.js` assertion pins it, a silent refusal having
no other symptom.

- **Exactly one** `window.addEventListener("keydown", handler, true)`, installed from `mountOnceUi`. Capture, matching what `StoryHistory` does today.
- `register(id, handler): () => void` — feature modules attach behaviour; an unhandled command is inert but still listed in settings.
- `dispatchChord(chord)` — second entry point used by the Electron main→renderer forwarding path (§5).
- **Text-entry guard** `isTextEntryTarget()`: `textarea`, `select`, non-checkbox/radio/range/button `input`, `[contenteditable]`, `[role="slider"]`. The `role="slider"` clause is what preserves `SwipeSettingsLabView.ts:395`'s arrow-key slider. A command fires there only when `allowInTextEntry` (Ctrl+F/L/T yes; bare WASD **no**, and the pane jumps only in one-line fields, so word-navigation in `#urlfield` survives).
- **Blockers** `registerBlocker(() => boolean)`. Ordering trap: `window` capture fires *before* the `document` capture handlers in `menu/storyAnchoredMenu.ts:125` and `picker/sourcePicker.ts:131`, so the dispatcher must stand down while those overlays are open. Wire both blockers in the same change; the settings key-capture control reuses the mechanism via `suspend()`/`resume()`.
- **Context resolution**: ordered set from `#left_panel[active_panel]`, whether `document.activeElement` is inside `#right_panel`, plus `"global"` last. First binding matching chord + active context wins. `preventDefault()`/`stopPropagation()` **only when a handler ran**.

### Migrating the existing ad-hoc handlers (double-fire risk)

| Site | Action |
|---|---|
| `story/StoryHistory.ts:36-50` (Ctrl+Z/Y, window capture) | **Delete the listener**, including the stray `console.log("left_panel keydown", e)` at `:39`. Register `history.undo`/`history.redo` instead. The `mouseup` button 3/4 handler at `:27` stays. |
| `story/storySearch.ts:21` (Ctrl+F, window **keyup**, no preventDefault) | **Delete.** Replaced by `search.focus`; left in place it would fire *in addition to* the dispatcher. |
| `storySearch.ts:40` field Esc/Enter | Keep — element-scoped and guarded. |
| `BrowserShell.ts:253` F11/Escape | Migrate to `window.toggle-fullscreen` / `window.exit-fullscreen`. |
| `SettingsPanel.ts:97`, `settingsControlBindings.ts:23,82`, `structured/FlatSettingsEditors.ts:202` (Esc/Ctrl+S) | Keep. Add `Ctrl+S`, `Escape`, `Enter`, `Tab`, `F5`, `Ctrl+Q`, `Alt+F4`, `Ctrl+Shift+I` to a **reserved chord list** the remap UI refuses. |
| `BrowserShell.ts:138` urlfield Enter, `:333` tab Enter/Space | Keep. |

## 3. Story cursor — `packages/ui-web/src/story/storyCursor.ts` (new)

**State is an href, not an element** — `StoryListItem.update_complete_story_el()` wipes `innerHTML`, `refilter()` calls `replaceWith(new StoryListItem(...))`, and `sortStories`/`resortSingle` reparent rows, so any element reference dies.

```ts
class StoryCursor {
  private href: string | null
  private lastIndex = 0
  private bucket: "stories" | "global_search_results" | "filtered_stories"
  element(): StoryListItem | null   // #<bucket> > story-item.story[data-href] via CSS.escape
  moveBy(delta: number): void
  refresh(): void
}
```

- **One bucket at a time**, derived from live search state. Never `#selected_container` — it duplicates a row for the open story and would yield two matches per href.
- **Ordering source**: refactor `storyList.ts:230` — extract `visibleStoryElements(bucket): StoryListItem[]` holding the existing `.nomatch`/`.filtered`/`display:none` filter, and reimplement `visibleStories()` as `.map(r => r.story)`. Memoize per keypress (it calls `getComputedStyle` per row).
- **Recovery**: if the stored href vanished (skipped and re-sorted away, purged, refiltered), fall back to `clamp(lastIndex + delta)`.
- **Rebuild resilience**: a `childList` `MutationObserver` on the active bucket re-applies the marker after `refilter()`/reload.
- **Relationship to `.selected`**: orthogonal. `.selected` = open in the browser pane; `.cursor` = keyboard focus. Subscribe to `selectedUrlChanged` and move the cursor onto that href when present, so clicking then pressing Down continues from there.
- **a11y — roving tabindex**, not `aria-activedescendant`: rows are compound widgets containing real `<a>`/`<button>` children, so a listbox/option model would misdescribe them. Cursor row gets `tabindex="0"` + `aria-current="true"` + `.cursor`; previous row reset to `-1`. Then `el.focus()` and `revealElement(el, { block: "nearest" })` from `scrollReveal.ts` — **never `scrollIntoView`**.
- **Left/right**: `commitSwipeAction(row, SwipeConfig.actionAt(1, -1 | +1))`. Nothing new — `swipe/commit.ts` already routes through `executeStoryMenuAction` and records undo history, and `actionAt(1, dir)` is exactly the user's "first action".
- **Visuals**: `parts/stories.css`, `story-item.cursor` outline + `:focus-visible`. Use `--sp-*`/`--radius-*` tokens (`check:css-debt` rejects raw px on radius/spacing).

## 4. Electron closed-tab history — `apps/electron/src/browser/ClosedTabs.ts` (new)

`TabOwnership.finalizeClosed()` currently deletes the entry with no record kept.

```ts
interface ClosedTabRecord {
  url: string; title: string; windowId: number; index: number
  history: { entries: { url: string }[]; index: number } | null
  closedAt: number
}
const CLOSED_TAB_LIMIT = 25
```

- **Capture** in `finalizeClosed(entry)` *before* `owner.tabs.splice(...)` and before `releaseErrorPages(...)`, so index and error state are intact. Also record every tab in `closeWindow(owner)` so Ctrl+Shift+T recovers a closed window's tabs.
- **Navigation history must be snapshotted eagerly** — `finalizeClosed` runs on `destroyed`, when `webContents` is gone. Add `historySnapshot` to `TabEntry` in `browser/BrowserState.ts`, refreshed in the `did-navigate` handler from `contents.navigationHistory.getAllEntries()`/`getActiveIndex()`. Electron is pinned at 43.x so `navigationHistory.restore({entries, index})` is available — restore is full-fidelity, not just the URL.
- **Skip rule**: don't record `about:blank` tabs with ≤1 history entry, else Ctrl+Shift+T mostly resurrects blanks.
- **Restore** — `BrowserCoordinator.restoreClosedTab(state)`: take newest for this window (else newest overall) → `createTab` → `ownership.reorder` to `record.index` → apply the history snapshot.

### IPC surface
Constants in `packages/platform-electron/src/types.ts` (`once:<domain>:<kebab-action>`), bridge methods in `preload.ts`, handlers in the noted `IpcHandlers.ts` group, all behind the existing `requireWindow()` sender check.

| Constant | Value | Bridge | Group |
|---|---|---|---|
| `tabsRestoreClosed` | `once:tabs:restore-closed` | `tabs.restoreClosed()` | `registerTabLifecycle` |
| `tabsFocusContent` | `once:tabs:focus-content` | `tabs.focusContent()` | `registerTabTools` |
| `windowCreate` | `once:window:create` | `window.create()` | `registerStoryAndWindowHandlers` |
| `windowFocusShell` | `once:window:focus-shell` | `window.focusShell()` | `registerStoryAndWindowHandlers` |
| `windowSetForwardedKeys` | `once:window:set-forwarded-keys` | `window.setForwardedKeys(chords)` | `registerStoryAndWindowHandlers` |
| `windowKeyCommand` | `once:window:key-command` | `window.onKeyCommand(fn)` (push) | main→renderer `webContents.send` |

`setForwardedKeys` validates: array, ≤100 entries, ≤40 chars each, strict chord pattern. **Ctrl+Tab needs no IPC** — `BrowserShell` already mirrors the tab list and can call `bridge.tabs.activate(next.id)`.

## 5. `before-input-event` forwarding

`tests/integration/electron/browser-ownership.test.js:198` asserts exactly one `before-input-event` listener per tab. **Do not add a second** — extend the existing one at `TabEvents.ts:144`, splitting the body into two private methods to stay under the `check:structure` function-length budget:

```ts
contents.on("before-input-event", (event, input) => {
  if (input.type !== "keyDown" || input.isAutoRepeat) return
  const owner = this.actions.ownerFor(entry)
  if (!owner) return
  if (this.handleFullscreenKey(event, input, entry, owner)) return  // existing F11/Escape, unchanged
  this.forwardShellChord(event, input, owner)
})
```

`forwardShellChord` computes `chordFromInput(input)`, and if it is in `owner.forwardedKeys` (a new `Set<string>` on `WindowEntry`, populated by the renderer at startup and on every settings change) calls `event.preventDefault()` + `owner.window.webContents.send(ELECTRON_IPC.windowKeyCommand, chord)`.

**Hard guard enforced in main, not just the renderer**: refuse any chord with no modifier that isn't a function key. Without this, a user who binds `S` to "next story" has every `s` keystroke stolen from every web page. F11/Escape stay in main as-is — they must work without a renderer round-trip.

## 6. Remap settings UI

Markup in the shared `packages/ui-web/public/shell.html`:

```html
<div class="settings_block" id="keyboard_settings" hidden>
  <div id="keyboard_shortcuts" data-testid="keyboard-shortcuts"></div>
</div>
```

`SettingsPanel.installSettingsNavigation()` skips `hidden` blocks, so unhide **before** `new SettingsPanel(...)` — the `bindStoryPosition()` trick at `BrowserShell.ts:79`. Do it in `mountOnceUi` when `document.body.dataset.platform !== "mobile"`. Register in `settingsSectionDefinitions.js`:

```js
["keyboard", "Keyboard shortcuts", "#keyboard_shortcuts", "electron"],
```

**View** — `packages/ui-web/src/settings/KeyboardSettingsView.ts`, modelled on `SwipeSettingsLabView.ts` (same local element builders, same host-element + onChanged constructor shape). One row per command, grouped by `group`:
- command label `<span>`;
- a `<button type="button" class="keybinding_capture" data-command="…">` per chord slot showing the chord as **direct text**, plus `aria-label="Shortcut for <label>: <chord>"` and `title`. This is what keeps the section **findable by settings search** — `settingsSearch.ts:75-136` harvests direct text, `aria-label` and `title`; a bare custom control yields zero segments;
- per-row reset button and a section-level "Reset all shortcuts".

Capture flow: click/Enter → `aria-pressed="true"`, "Press a key…", `dispatcher.suspend()`, temporary capture listener. Escape cancels, Backspace/Delete clears, reserved chords are refused with an inline `role="alert"`.

**Conflicts** (`conflicts.ts`, pure + unit-tested): two commands conflict when they share a chord *and* their contexts overlap (`global` overlaps everything; `stories` and `browser` don't overlap each other). A conflicting capture is **refused** with a message naming the other command — deterministic, no silent shadowing.

**Storage** (`keybindingStore.ts`), overrides only:
```json
{ "version": 1, "bindings": { "story.cursor-next": ["ArrowDown", "S"] } }
```
Loader merges over defaults and treats stored data as untrusted (drop unknown ids, malformed chords, non-arrays) in the style of `normalizeSwipeSettings`.

**Propagation**: each change → `dispatcher.setBindings(...)` → persist → panel refresh (`updateSettingsSummaries()`, `refreshSettingsSearch()`) → a new `MountOnceUiOptions.onKeyBindingsChanged?: (chords: string[]) => void`. `apps/electron/src/renderer.ts` supplies it and calls `window.onceElectron.window.setForwardedKeys(chords)` — that indirection is how ui-web reaches main without importing `@once/platform-electron` (`check:boundaries`).

Add a `keyboard` entry to `settingsSummaries.ts` ("Default" / "N customised") and `.keybinding_row` / `[aria-pressed="true"]` / `.keybinding_conflict` styles to `parts/settings.css`.

---

## Work order

0. **Non-focus-stealing Electron test mode** — `main.ts`, `TabManager.ts`, `browser/WindowLifecycle.ts`, `tests/e2e/electron/electron-harness.js`, `@interactive` tags, `package.json` script. Everything after this is developed and verified under `test:electron:e2e:bg`.
1. **Chord primitives + dispatcher + handler migration** — `packages/core/src/keyChord.ts`, `keyboard/*`, `mountOnceUi.ts`, delete the listeners in `StoryHistory.ts` and `storySearch.ts`, export from `packages/ui-web/src/index.ts`.
2. **Story cursor** — `story/storyCursor.ts`, extract `visibleStoryElements` in `storyList.ts`, `parts/stories.css`.
3. **Closed-tab history (main only, no UI)** — `browser/ClosedTabs.ts`, `BrowserState.ts`, `TabOwnership.ts`, `TabEvents.ts` snapshot, `TabManager.ts`, IPC constants/preload/handlers.
4. **`before-input-event` forwarding + focus IPC** — `TabEvents.ts`, `BrowserState.ts`, IPC surface.
5. **Electron shell command wiring** — `BrowserShell.bindKeyboardCommands()`, migrate the `bindWindowState` F11/Escape block, `renderer.ts`. Note: Ctrl+L / Ctrl+F handlers must call `bridge.window.focusShell()` **before** `.focus()` — while a `WebContentsView` owns native focus, a renderer-side `focus()` silently does nothing. `panes.focus-right` → `tabs.focusContent()`; `panes.focus-left` → `focusShell()` then focus the cursor row (or `#searchfield` when there is none).
6. **Remap settings UI** — `shell.html`, `settingsSectionDefinitions.js`, `settingsSummaries.ts`, `KeyboardSettingsView.ts`, `parts/settings.css`, `mountOnceUi.ts`, `renderer.ts`.

## Verification

Per step:
0. Run `npm run test:electron:e2e:bg` while working in another window: no focus theft, same results as a normal run. Probe spec confirming CDP key dispatch reaches `before-input-event`.
1. `tests/unit/ui-web/key-chord.test.js` (round-trip, layout independence, shift+digit) and `keyboard-dispatcher.test.js` (linkedom, following the `app-update-controls.test.js` require-from-`dist` pattern): text-entry guard, context filtering, blocker suspension, `preventDefault` only when handled, **undo fires exactly once** after migration.
2. `tests/unit/ui-web/story-cursor.test.js`: cursor survives `update_complete_story_el()`, survives `sortStories`, recovers when its row becomes `.nomatch`, ignores the `#selected_container` duplicate, and left/right call `commitSwipeAction` with `SwipeConfig.actionAt(1, ∓1)` (spy).
3. Extend `tests/integration/electron/browser-ownership.test.js`: records url/title/index on `finalizeClosed`, caps at 25, `take()` prefers the same window, `closeWindow` records all tabs, blank-tab skip rule.
4. Same file: emitting `{type:"keyDown", control:true, code:"KeyT"}` calls `preventDefault()` and sends `["once:window:key-command","Ctrl+T"]`; an unregistered chord is untouched; a modifier-less chord is refused even when in `forwardedKeys`; **`listenerCount("before-input-event")` is still 1**.
6. `tests/unit/ui-web/keybinding-settings.test.js` (capture, conflict refusal, reset, schema round-trip, unknown-id rejection); an addition to `settings-search.test.js` asserting the section is findable by both `"new tab"` and `"Ctrl+T"`; new `tests/e2e/electron/keyboard-navigation.spec.js` on `electron-harness.js` (`seedLocalSource`, `expectDocumentFocus`, `openSettingsSection`): ArrowDown moves `.cursor`, ArrowRight runs the stage-1 right action, Ctrl+T / Ctrl+Shift+T / Ctrl+L / Ctrl+→ behave, then remap `story.cursor-next` to `J` and assert the new key drives the cursor.

Gates: `npm run check` (eslint, stylelint, `check:structure`, `check:semantic-controls`, `check:boundaries`, `check:cascade`, `check:css-debt`, knip). **Trap:** `npm run check` clobbers the e2e bundle — rebuild before running the Electron e2e specs, and again after any `check` run.

Manual pass in Electron: navigate the whole story list, act on stories, switch panes, open/close/restore tabs, and reach the urlbar without touching the mouse.

## Keyboard layout: keycap first, position second

The original design read every chord from `event.code` alone, on the reasoning that physical WASD should survive a layout change. That is right for movement and **wrong for mnemonics**: on a German layout the Z-labelled key sits at the US Y position, so `Ctrl+Z` arrived as `Ctrl+Y` and ran redo instead of undo.

`@once/core` now exposes both readings — `chordFromKey` (the character the key produced, i.e. the keycap) and `chordFromParts` (the physical position). `chordsFor(event)` returns them keycap-first, and the dispatcher, the settings capture control and the main-process forwarder all resolve in that order:

- `Ctrl+Z` follows the Z key on any layout, because the keycap chord matches first.
- Bare `W`/`A`/`S`/`D` stay a cluster under the left hand: on a layout where those positions produce something else, the keycap chord matches nothing and the positional fallback wins.

## Revisions after the first review

- **The cursor does not follow an acted-on story.** `runSwipeAction` resolves the successor row before committing, then steps onto it: once a story is skipped it is dealt with, and the read-state re-sort would otherwise drag the highlight down the list. `selectedUrlChanged` no longer moves the cursor either — clicking a row does that explicitly instead.
- **Clicking a story adopts it as the cursor**, and focuses the row unless the click landed on a link or button inside it.
- **The highlight is a background, not an outline** — `--cursor-bg-color` / `--cursor-idle-bg-color` in `vars.css`, outranking `.read` and `.selected`.
- **`body[data-pane-focus]`** (`shell/paneFocus.ts`) says which pane the keyboard is driving. The active Electron tab takes the same highlight when it is "browser", so one colour answers "where will my keys land"; the story cursor drops to the idle tint.
- **`allowInTextEntry` became a three-level reach** (`never` / `field` / `always`). The pane jumps reach single-line inputs — otherwise the search box was a keyboard dead end — while textareas, sliders and contenteditable keep word navigation.
- **The pane jumps are `Alt+Shift+Arrow`, not `Ctrl+Arrow`.** `Ctrl+←/→` is Mission Control's switch-a-space on macOS, which an app cannot win; on Windows and Linux it is only a text-editing convention, so the collision was survivable but the Mac one is not. `Alt+Shift+Arrow` is unclaimed by both browsers and by every window manager we care about. It is not free everywhere either — it is word-select in macOS text fields, and Left Alt+Shift is the Windows input-language toggle on machines with two layouts — which is why these stay `field`-level and never reach a textarea.
- **Main reports focus hand-offs** over `once:window:native-focus-changed`. Opening a story moves native focus into the page with no DOM event the shell can observe, so the story cursor would otherwise keep claiming a keyboard that had already left. `openUrl` (foreground dispositions only), `focusContent` and `focusShell` report it deterministically; a `webContents` `focus` listener catches the rest, such as clicking into a page. The deterministic reports are what make it testable — a non-focusable window in background test mode never fires the OS-level focus event.
- **Enter opens the cursor row, and stays reserved.** The handler lives on `story-item` and only fires when the row itself is the event target, mirroring the tab strip. Enter is not a bindable chord: the dispatcher listens in the capture phase, so a global binding would shadow the address bar, the search field, the inline settings editors and every button — including the shortcut-capture control.
- **Every forwarded chord reclaims shell focus first.** A renderer-side `focus()` is ignored while a `WebContentsView` owns native focus, which is why `Ctrl+F` from a page appeared to do nothing while `Ctrl+L` worked; `panes.focus-left` and `browser.focus-urlbar` do the same for keys pressed in the shell.

## Risks

- **Bare-letter forwarding is the sharp edge** — the main-process modifier guard in §5 is not optional.
- **Overlay ordering** — `window` capture beats `document` capture, so the anchored menu and source picker lose Escape unless their blockers land with the dispatcher.
- **Ctrl+←/→ must stay `allowInTextEntry: false`** or word-navigation in `#urlfield` and every settings textarea breaks.
- **`refilter()` replaces rows wholesale** — the cursor's MutationObserver is the only thing keeping the marker alive across a filter-settings change.
