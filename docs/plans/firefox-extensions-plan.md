# Plan: Firefox extensions and userscripts in the embedded browsers

Status: in progress. Steps 1 to 4 are done. uBlock Origin 1.74.0's Firefox
build boots on the runtime, downloads and compiles its default lists,
strict-blocks a navigation to an ad host and shows its own blocked-page in
the tab, hides elements through generic cosmetic filters, injects its
scriptlets into pages, and its popup opens from the toolbar and reports on
the active tab. Violentmonkey 2.48.0 boots beside it, installs a userscript
through its dashboard, and a `@run-at document-start` script runs while the
document is still `loading` on wikipedia.org (all verified 2026-09-01
through the `ONCE_ELECTRON_EXTENSIONS` dev path). Step 5 is done: the
`filter_lists` and `userscripts` documents sync like every other setting,
have text editors in the shared settings panel, and on Electron reach the
extensions through their own message APIs. Saving a list URL in Once added
it to uBlock's selection without touching its defaults, and a userscript
saved in Once ran through Violentmonkey (verified 2026-09-03). Step 6
(Android on GeckoView) is next.

Findings from step 5: `addListener` must register synchronously, as it does
in Firefox; with async IPC a background page's listeners were still in
flight when its load event resolved, so anything acting on load could miss
them. uBlock registers its port handler while its modules evaluate;
Violentmonkey registers `onMessage` after awaiting its storage, so a
hand-off waits for the listener to appear rather than for the page to load.
Once's filter lists are additions to the extension's own selection, never a
replacement: the applier reads uBlock's list table, maps a URL to its stock
key where one exists, and imports the rest.

Findings from the Violentmonkey run: it reaches synchronous APIs through
the `chrome` global and calls some of them Chrome-style with a trailing
callback, so `chrome` aliases `browser` and every method accepts a callback;
it decides "this is Firefox" from a `moz-` prefix on its own URLs, so the
runtime's scheme is `moz-extension`; it wants `cookies`, `notifications`,
`permissions`, `commands`, the `webRequest.On*Options` constants, and
`contentScripts.register`, which is how it delivers document-start on a
host's second visit once its `ffInject` option is on (the option is off by
default; a user turns it on in its settings). Two runtime faults it exposed:
the frame preload runs before `<html>` exists, so `document_start` now waits
for the root element, and frame contexts are keyed by frame-tree node id so
a navigation replaces the previous document's context.

Findings from the uBlock runs worth keeping: Firefox accepts `file://*/*` as
a match pattern; extension pages need CORS bypassed for permitted hosts or
list downloads fail; uBlock reads `webRequest.ResourceType`, `TAB_ID_NONE`,
`privacy.websites.*`, and subscribes to `onSendHeaders`, `onResponseStarted`,
`onBeforeRedirect`, `onCreatedNavigationTarget`, and `onUpdateAvailable`.
Its pages add helpers onto `browser.i18n`, so the `browser` object must be
extensible, which a raw `contextBridge` copy is not. Its scriptlet injector
confirms main-world execution through Firefox's `wrappedJSObject`; the
content preload answers that with a proxy over
`contextBridge.executeInMainWorld`. It probes `browser.contentScripts` and
falls back to `tabs.executeScript` when absent, which is what runs today.

Once embeds a browser on Electron (`WebContentsView` tabs), Android (`android.webkit.WebView`
inside `InAppBrowserSurfacePlugin`), and iOS (`WKWebView` inside the same plugin). Users want
uBlock Origin and userscripts in those surfaces. The Firefox and Chrome extension targets are
out of scope: users there already run extensions natively beside the side panel.

## Decision

Do not build on Chromium's built-in extension subsystem. Google has removed Manifest V2 from
Chrome (flags stripped in Chrome 151, Web Store purge August 2026), Electron's built-in loader
has no popups, no `declarativeNetRequest`, and only partial `chrome.tabs`, and the community
`electron-chrome-extensions` stack still lists Manifest V3 as pending. All of that is a clock
someone else winds.

Instead:

- **Electron:** write our own runtime for the Firefox flavour of WebExtensions (Manifest V2,
  promise-based `browser.*`, blocking `webRequest`). It stands only on core Electron APIs that
  Electron cannot drop without breaking every app: `session.webRequest`,
  `session.registerPreloadScript`, `webFrame.executeJavaScriptInIsolatedWorld`,
  `contextBridge.executeInMainWorld`, and `protocol.handle`.
- **Android:** replace the browsing surface's `WebView` with GeckoView, which is Firefox's engine
  and runs uBlock Origin unmodified. No shim.
- **iOS:** no extension runtime exists for `WKWebView`. Compile the same filter lists to
  `WKContentRuleList` and inject cosmetics and userscripts as `WKUserScript`. This reuses
  uBlock's lists, not uBlock.
- **Shared:** filter-list subscriptions and userscripts are synced settings documents beside
  redirect rules, so all three targets read one configuration.

The runtime supports an explicit allowlist of extensions, initially uBlock Origin and
Violentmonkey (both ship Firefox MV2 builds). Violentmonkey is what gives us userscripts; we do
not write a `GM_*` layer of our own. This is not a general WebExtensions runtime, and every
extension added later widens the API surface deliberately.

## Why a self-written runtime is the durable choice

What is being sunset is Chromium's extension subsystem running MV2 with blocking `webRequest`.
A runtime we write never loads an extension through Chromium; the manifest is parsed by us, the
background page is a hidden `WebContents` we own, and the network hooks are Electron's own
session API. The extension files themselves are the same WebExtension bundles Mozilla will keep
shipping, since Firefox has committed to MV2 and blocking `webRequest`.

Precedent: `electron-chrome-extensions` and the older Wexond runtime are JavaScript shims of this
kind; ours is Firefox-flavoured and scoped to the allowlist.

## Electron runtime

### Trust-zone change

`ARCHITECTURE.md` currently promises that remote pages receive no preload. That sentence changes
to: remote pages receive one session-registered preload that runs only extension content scripts
in isolated worlds and exposes `browser.runtime` messaging to those worlds. Nothing is exposed
to the page's main world; the Once bridge and IPC surface remain unavailable to pages. The
preload stays sandboxed and context-isolated.

### API mapping

| Extension need | Runtime provides | Where |
| --- | --- | --- |
| Manifest, match patterns, `i18n` message lookup | Platform-neutral parsing and matching | `packages/core/src/webext` |
| Background page | Hidden `WebContents` at `moz-extension://<id>/<page>`; preload implements `browser.*` over IPC to main | `apps/electron/src/extensions/` |
| Extension pages, popup, dashboard | Served by `protocol.handle` on the browser session from the unpacked extension directory; scheme registered standard and secure so storage and fetch behave; popup as an anchored `WebContentsView`, dashboard/options as an ordinary tab | `ReaderProtocol`/`ErrorPageProtocol` siblings; `TabManager` |
| Blocking `webRequest` | One main-process listener per event on `persist:once-browser-v2`, dispatching to every extension in order; `tabId` mapped from `webContentsId` through `TabOwnership`; `cancel`, `redirectURL`, request/response header edits | `apps/electron/src/extensions/webRequest.ts`, wired beside `configureBrowserSession` in `main.ts` |
| Content scripts at `document_start`, `document_end`, `document_idle`, all frames | Frame preload registered on the session; per-extension isolated world via `webFrame.executeJavaScriptInIsolatedWorld`; scriptlets via `contextBridge.executeInMainWorld` | New webpack entry beside `picker-injection` |
| `tabs`, `webNavigation`, `windows` | Adapters over `TabEvents` (`did-navigate`, `did-frame-navigate`, `did-finish-load`), `TabOwnership`, `WindowLifecycle` | `apps/electron/src/extensions/tabs.ts` |
| `storage.local` with `unlimitedStorage` | Main-process file store under `userData`, one directory per extension | `SecureSettings` sibling |
| `runtime` messaging, ports | IPC routing between background, popup, and content-script worlds | runtime core |
| `menus`, `browserAction`, `privacy`, `browserSettings`, `dns` | `browserAction` real (toolbar button, badge); the rest stubbed to the shapes uBlock tolerates | runtime core |

### Known gaps, accepted

- `webRequest.filterResponseData` does not exist in Electron. uBlock's HTML filtering stays
  off; it is an optional feature there.
- Electron allows one listener per `webRequest` event per session. The runtime owns those
  listeners; the reader and error-page protocols already configure the same session, so all
  session configuration converges in one module.
- `chrome.storage.sync` and `managed` are not provided.

### Boundaries

Manifest and match-pattern code is DOM-free and belongs in `core`. Everything that touches
Electron objects is main-process code in `apps/electron/src/extensions/`. The renderer gains
only a toolbar surface and IPC for badge text and popup open/close, exposed through the typed
bridge in `@once/platform-electron/bridge`. Run `npm run check:boundaries` after each step.

## Android: GeckoView surface

Android `WebView` cannot host this: `shouldInterceptRequest` runs synchronously on a network
thread and does not report resource type, and the extension engine would live in JavaScript in
another WebView. GeckoView runs WebExtensions natively; Firefox for Android runs uBlock Origin
on it today.

- Replace the `WebView` created in `InAppBrowserSurfacePlugin.java` with a `GeckoView` backed by
  a `GeckoSession` on a shared `GeckoRuntime`. The Capacitor shell keeps its `WebView`.
- Bundle the allowlisted extensions under `assets/extensions/<id>/` and install them with
  `WebExtensionController.ensureBuiltIn` at runtime creation.
- Map `NavigationDelegate` and `ProgressDelegate` onto the existing `navigationStarted`,
  `navigationCommitted`, `navigationFinished`, `navigationFailed`, and `historyChanged` events so
  `readingSurfaceCoordinator.ts` does not change.
- Surface `browserAction` through GeckoView's action delegate as an item in the existing native
  overlay menu; extension options pages open in the surface.
- Keep `evaluateJavaScript` working through `GeckoSession` for the source picker, or move the
  picker to a content script under the same runtime.

Costs to state up front: a Firefox-sized APK, a second engine on its own update train, and
re-validating the mobile e2e suite against a non-WebView surface (Appium drives it through
accessibility, so most flows should survive).

## iOS: content rules and user scripts

- Convert subscribed filter lists to Apple's content-blocker JSON with `adblock-rust`'s
  content-blocking export, either as a build step for the shipped defaults or on the desktop
  for user-added lists, then compile with `WKContentRuleListStore` and attach to the surface's
  `WKWebViewConfiguration` in `AppDelegate.swift`.
- Inject cosmetic hiding and userscripts as `WKUserScript` at `.atDocumentStart` or
  `.atDocumentEnd`, with `forMainFrameOnly` per script.
- Userscript metadata (`@match`, `@run-at`) is parsed by the shared `core` code; a small
  `GM_addStyle`/`GM_getValue`/`GM_setValue` shim is enough for the site-fixing scripts this
  surface can support. Document this as the platform's limit rather than emulate Violentmonkey.

## Shared configuration

- New versioned settings documents beside `sources` and `cache_timing`: `filter_lists`
  (subscriptions with URL, enabled flag, last fetched) and `userscripts` (source text, enabled
  flag). Owned by `AppSettings`, replicated like the others.
- Settings UI beside the redirect editor in `packages/ui-web/src/settings/structured`.
- On Electron and Android the lists are handed to uBlock through its `storage.local` seeding;
  on iOS they drive the content-rule compile. Userscripts feed Violentmonkey on Electron and
  Android and the `WKUserScript` path on iOS.
- List fetching reuses the existing fetch cache and cache-timing precedence rather than a new
  scheduler.

## Work

### 1. Core: manifest and patterns

Parse `manifest.json` (Firefox MV2 subset: `background`, `content_scripts`, `permissions`,
`browser_action`, `options_ui`, `default_locale`), match patterns, and userscript headers.
Unit tests under `tests/unit`. No Electron code yet.

### 2. Electron: network blocking

Session listener multiplexer, extension registry, background page host, `storage.local`,
`runtime` messaging, `webRequest`, `tabs`, `webNavigation`. Load uBlock Origin's Firefox build
unpacked from a dev directory. Acceptance: a known ad request is cancelled and uBlock's
background logger shows it. Integration test under `tests/integration/electron`.

### 3. Electron: content scripts and UI

Session frame preload, isolated worlds, scriptlet injection, `browserAction` toolbar button and
popup, dashboard as a tab, `moz-extension://` protocol. Rewrite the ARCHITECTURE.md trust-zone
paragraph in the same commit. Acceptance: cosmetic filters hide elements on a fixture page;
the popup opens and toggles per-site blocking.

### 4. Electron: Violentmonkey

Add to the allowlist, cover whatever `browser.*` it calls that uBlock did not, and verify a
`@run-at document-start` userscript runs before page scripts on a fixture.

### 5. Shared settings documents and UI

`filter_lists` and `userscripts` documents, structured editors, sync coverage in the app
tests with fake platform ports.

### 6. Android: GeckoView

Surface swap, delegate mapping, bundled extensions, action delegate, e2e re-validation on
the emulator profile in `run-android-local.js`.

### 7. iOS: content rules and user scripts

List conversion, compile-and-attach, `WKUserScript` injection, minimal `GM_` shim,
e2e coverage.

### 8. Packaging and updates

Decide how extension bundles reach users: pinned versions vendored outside `src` per the
CODEMAP vendored-asset rule, refreshed by a script that verifies Mozilla's signature on the
downloaded XPI. Document in RELEASING.md.

## Risks

- **API surface creep.** Each new extension on the allowlist costs real work. The allowlist is
  the product decision, not a technical limit to work around.
- **uBlock relies on Firefox behaviours** beyond the documented API (CSP header injection
  order, `originUrl`/`documentUrl` on requests). Step 2 will surface these; budget for it.
- **GeckoView size and cadence** may be unacceptable for the Android product. If so, Android
  falls back to the iOS-style path with a native engine (`AdblockAndroid`, LGPL-2.1) in
  `shouldInterceptRequest`, which reuses lists but not extensions.
- **Sandboxed preload capabilities** for `webFrame` and `contextBridge.executeInMainWorld` are
  documented but the latter is marked experimental; verify on Electron 43 in step 3 before
  building the popup on top.

## Not doing

- A general WebExtensions runtime or extension store.
- Chromium's built-in `session.extensions.loadExtension` or `electron-chrome-extensions`.
- Anything in the reader surfaces; `once-reader://` and the mobile reader are already sanitized
  and stay outside the extension runtime.
- Extensions in the Firefox and Chrome side-panel targets.
