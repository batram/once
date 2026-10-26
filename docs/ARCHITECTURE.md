# Architecture

This document describes the stable structure and design boundaries of Once.
For commands and local workflows, see [DEVELOPMENT.md](DEVELOPMENT.md). For
planned work, see [ROADMAP.md](ROADMAP.md).

## Platform design

Once collects stories through shared domain and application code, presents them
through a shared web UI, and supplies platform capabilities through adapters.
Applications are composition roots: they select the appropriate adapters and
own only target-specific entrypoints, permissions, and packaging.

The implemented targets are:

- **Firefox extension:** a Firefox sidebar with a target-specific background
  script and manifest.
- **Chrome extension:** a Chrome Side Panel with a target-specific service
  worker and manifest.
- **Electron:** a Windows-first desktop application combining the Once UI with
  isolated browser tabs.
- **Android and iOS:** a Capacitor application, `apps/mobile`, with a native
  reading surface (GeckoView on Android, WKWebView on iOS);
  `@once/platform-mobile` supplies its PouchDB, native networking, secure
  settings, system UI, and browser-surface adapters.
- **Once Lite:** a second Android app from the same Capacitor project, whose
  reading surface is the system `android.webkit.WebView` instead of GeckoView
  and whose browser extensions run in Once's own runtime over Chromium's
  DevTools protocol; see [Mobile](#mobile) below.

`apps/website` reserves the future web composition root.

## Workspace structure and ownership

```text
apps/
  firefox-extension/   Firefox manifest and background entrypoint
  chrome-extension/    Chrome manifest and background entrypoint
  electron/            Electron main, preload, renderer, and packaging
  website/             Future website composition root
  mobile/              Capacitor web bundle and committed Android/iOS projects
    src/lite/          Once Lite's extension broker, page and world bootstraps
    android/app/src/   main (shared), gecko (GeckoView) and lite (WebView,
                       DevTools client, extension runtime host) source sets
packages/
  core/                 Platform-neutral domain models and story logic
  collectors/           Feed collectors, parsers, and collector registry
  app/                  Application orchestration, settings, and events
  persistence/          PouchDB stores, synchronization, and storage contracts
  ui-web/               Shared DOM UI, reader, styles, and static resources
  webext-shell/         Shared browser-extension composition entrypoint
  webext-runtime/       Host-neutral runtime for Firefox-style WebExtensions (Electron main, Once Lite broker)
  platform-webext/      Browser-extension implementations of application ports
  platform-electron/    Electron renderer implementations of application ports
  platform-web/         Future website adapters
  platform-mobile/      Capacitor implementations of application ports
```

### Mobile

The Capacitor application embeds the shared Once web UI in WKWebView or Android
WebView. It stores stories and lists in a target-specific PouchDB database,
sends cross-origin collector and CouchDB requests through Capacitor's native
HTTP plugin (`nativeFetch` in platform-mobile; Capacitor's own fetch patch
stays off, since its proxy path would serve remote scripts at the app's
origin), and opens ordinary links in the platform browser. Reader documents stay inside a
sandboxed local reader surface.

On Android the reading surface itself is a GeckoView, Firefox's engine,
beside the Capacitor shell's WebView. It runs the same Firefox-style
extensions as Electron (uBlock Origin, Violentmonkey) as GeckoView
built-ins from the APK's assets, which `scripts/fetch-extensions.js` unpacks
against pinned hashes, plus a bridge extension of Once's own that carries
script evaluation for the source picker over native messaging. The surface
adapter's contract in `@once/platform-mobile` is unchanged. Users can install
further Mozilla-signed extensions through GeckoView's own installer, and an
opt-in setting keeps media on the reading page playing in the background
behind an Android media notification; see
[Android reading media](android-background-playback.md).

Once Lite is the second Android app: Gradle's `engine` flavour dimension
(`gecko`, `lite`; `apps/mobile/android/app/build.gradle`) pairs with the
`environment` one, so `liteProduction` is `com.zmarn.once.lite` and
`liteDevelopment` is `com.zmarn.once.lite.dev`, installable beside the
GeckoView app. The GeckoView dependency, its asset task and its Java live in
`src/gecko`, Lite's in `src/lite`, and `src/main` holds what both share; each
flavour's `EngineSurface` registers its plugins under the same names, so the
shell and `@once/platform-mobile` do not know which engine they drive. Lite's
reading surface is one system WebView per tab (`LiteSurfacePlugin`,
`LiteSurfaceHost`), with the GeckoView plugin's tab routing, events and
bounded recovery mapped onto `WebViewClient`/`WebChromeClient`. The APK is
tens of megabytes rather than Firefox-sized and the engine updates with the
OS; see [plans/once-lite-plan.md](plans/once-lite-plan.md).

WebView has no extension subsystem and its public client API cannot see
request bodies, edit response headers, create isolated worlds or rewrite
bodies, so Lite's privilege boundary is the Chrome DevTools Protocol:
Chromium serves it on the abstract socket `webview_devtools_remote_<pid>`
once `WebView.setWebContentsDebuggingEnabled(true)` is set, and admits the
same uid, so the app attaches to its own WebViews without adb
(`src/lite/.../devtools/DevToolsClient.java`: one browser-level connection,
`Target.setAutoAttach` flattened over every WebView). The `Fetch` domain
pauses every request of a page target at the request and response stage
with its resource type, body and headers; `Page.addScriptToEvaluateOnNewDocument`
with a `worldName` gives each extension an isolated world in every frame
before the page's scripts run; `Runtime.addBinding` scoped to that world is
the only channel out of it. That setting is process-wide and therefore stays
on in release builds of Once Lite: Settings shows Allow Web Inspector as on
and locked, and the exposure is the existing "USB debugging enabled" one,
since only the same uid, shell and root may connect to the socket. The
residual risk is real: anything running as shell (a computer the user
authorised for USB debugging, an app the user granted Shizuku) or as root
can drive every WebView of the app, the Capacitor shell with its native
plugins included, and read its cookies and storage. Debugging is not tied to
whether any full extension is enabled, because Once's bridge world (PiP,
media session, image text) needs the same connection in every tab, and the
broker settles its tier once per page start; a release build in Tier 2,
where nothing uses the socket, switches debugging off again unless the user
turned the Web Inspector on.

The runtime itself is `@once/webext-runtime`, the same host-neutral half
Electron uses, loaded by the **broker** (`apps/mobile/src/lite`, built into
`lite-runtime.html` and the `lite-*.js` bundles): a hidden WebView Java keeps
in a 1×1 visible container so Blink does not throttle its timers. Java
(`src/lite/.../lite/`: `LiteExtensionEngine`, `BrokerChannel`, `LiteTargets`,
`LitePage`, `LiteFiles`, `LitePackages`, `LiteCookies`) is deliberately dumb
I/O: it owns the WebViews, the DevTools connection, files, the network and
dialogs, forwards the DevTools events the broker subscribed to over a
`WebMessageListener` channel, and issues the `Fetch.*`, `Runtime.evaluate`
and page commands the broker answers with. The protocol is
[plans/once-lite-broker-protocol.md](plans/once-lite-broker-protocol.md)
(`src/lite/protocol.ts` is its typed form), and because the broker never
touches a WebView, a file or the network itself, it is unit-tested in Node
against a fake Java (`tests/unit/mobile/lite-broker.test.js`).

Extension pages (background, popup, options, the element picker) load in
their own WebViews at the synthetic origin
`https://<host>.moz-extension.localhost/`, served from the package through
the same `Fetch` interception. A custom `moz-extension://` scheme is not
usable: WebView's non-standard-scheme handling discards the host, so every
extension would share one origin; `*.localhost` is loopback, a secure context,
one tuple origin per extension with its own storage, and resolved before
DNS. The page bootstrap keeps `runtime.getURL` on the `moz-extension://`
form (extensions branch on that prefix) while `location` shows the https
form; content worlds get the https form so URLs they put into the DOM load.
Content scripts run in the world `once-ext:<host>` of every tab frame from
one registration per extension that carries all of its content scripts; the
bootstrap matches them against `location` in the frame itself, so injection
is race-free for `about:blank`, `srcdoc` and restored frames. A
DevTools-created world has no CSP of its own, so uBlock's scriptlets (a
`<script>` the world inserts) would be judged by the page's policy: the
broker adds a per-document nonce, `sha256(token | url)`, to `script-src` at
the response stage of every document request, the world stamps it on what it
inserts, and a document with only a `<meta>` policy gets its scriptlets
through main-world `Runtime.evaluate` instead, which the page's CSP does not
govern. The token is a secret only the broker and the extension worlds
hold; nothing in a page's main world derives from it. Once's own page
features (source picker evaluation, image text, media snapshots, the PiP
polyfill) run in a Once-owned world `once-bridge` over the `onceLiteBridge`
binding, which Java answers with the Gecko-era handlers; this replaces the
Gecko bridge extension and its native-messaging port. The main-world helper
the PiP polyfill needs talks to that world through events scoped by a
second token, which a page can learn, so the bridge world relays nothing
from it but a PiP request (entering only with the page's user activation).
Content worlds' synchronous requests (registered scripts, Violentmonkey's
blobs) are answered by Java from what the broker prepared for that
document, under a key derived from the secret and the document's URL; and
because every WebView shares one renderer main thread, Java continues a
paused request itself when the broker stops answering (a page's
synchronous XMLHttpRequest or a JS dialog blocks it), rather than hold the
whole app. Pauses have generation IDs, so a late command cannot resolve a
new pause with the same CDP request ID. Released request stages skip response
interception to avoid a second watchdog delay. Synchronous answers are scoped
to the requesting target/frame and bounded by entry count, bytes and age.
CSP document bodies are fetched and fulfilled directly in Java; only headers
cross the broker channel. This removes duplicate body transfers through the
broker renderer, although CDP still buffers each document in full.

Extensions' hosts are random per install, as Firefox's per-install UUIDs
are, so a page cannot recognise an extension by a host every install shares;
an extension with data from before keeps the host it had.

Lite therefore has four trust zones: the Capacitor shell at
`https://localhost/` (the Once UI and its plugins, as on GeckoView); reading
pages, which see no Once bridge and reach Java only through the bindings of
the worlds installed over them; extension pages and worlds, which reach the
broker over a frame-authenticated channel or a world-scoped binding and get
`browser.*` built by the shared `PreloadApi` with the same allowlists as
Electron; and the broker, at an origin of its own
(`https://broker.once-lite.localhost/`, so it shares no storage with the
shell), which may ask Java for anything in the protocol but holds no file,
socket or WebView of its own. Where the DevTools connection
cannot be made the surface still works in the plan's Tier 2: no full
extension loads, the broker compiles uBlock Origin Lite's default rulesets
and the synced lists into rules Java's own DNR evaluator applies from
`shouldInterceptRequest`, and cosmetics and userscripts are page scripts Java
registers at document start (`liteTier2.ts`, `LiteTier2.java`); the
catalogue lists the full extensions as limited.

The sync URL can contain credentials, so mobile stores it outside the WebView:
iOS uses Keychain and Android encrypts an app-private preference with an
Android Keystore key. Source tokens (see `docs/COLLECTORS.md`, "Authenticated
sources") go through the same stores, behind the app's `secretStore` port, and
never enter the synced settings. Development and release installs use separate
bundle IDs and native flavors/schemes.

Shared behavior belongs in `packages/*`. Target-specific permissions,
lifecycles, background processes, native bridges, and packaging belong in
`apps/*`. Static HTML, CSS, images, and icons used by both extensions have one
canonical source in `packages/ui-web/public`; extension builds copy them into
the target output beside only that target's manifest.

Styling has its own ownership rules: a shared component sheet describes normal
presentation, and platform sheets own platform behavior through a cascade layer
rather than through selector specificity. See
[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md).

## Settings navigation

`SettingsNavigation` owns one session history of settings locations: the index,
a section overview, or a page within a section. Header Back, mouse Back/Forward,
Escape outside an input, and mobile native Back/Forward traverse that same
history. A new visit after Back clears the Forward branch. Back at the entry
boundary returns to the shell panel Settings was opened from; Forward restores
Settings before replaying its later visits. Selecting another shell panel
directly ends that return path.

Views register an overview renderer and open pages with `openSettingsPage`.
Each page supplies its identity, title, renderer, and optional draft-detachment
and validity callbacks. This includes structured source/group/filter/redirect
editors, their text mode, add-on pages, sync pages, userscripts, and desktop and
mobile browser-extension management. Views do not intercept the shared Back
button or maintain their own Back/Forward stacks.

Back retains unfinished drafts without saving or prompting. Forward reattaches
the original editor where possible, and history restores focus and scroll.
Save or Cancel calls `completeSettingsPage` to retire the draft. Deleted items
and structured drafts whose underlying list changed are pruned rather than
replayed against a different row. Search and deep links enter pages through the
same history, while focusing a match in the current editor keeps that editor.
An unsaved userscript deleted elsewhere stays available with its conflict
notice, so navigation does not discard the user's work.
Disclosure groups, switches, modal confirmations, and shortcut capture are
interaction state within a location, rather than separate navigation visits.

## Feature boundaries

Package boundaries prevent invalid dependency directions; feature boundaries
keep individual files understandable. UI features should expose a small facade
while keeping rendering, interaction state, persistence binding, and
platform coordination in separate modules. In particular:

- settings navigation composes source, group, filter, redirect, search, and
  persistence bindings;
- story-list rendering composes story markup/actions with an independent swipe
  interaction controller;
- `OnceApp` is the public application facade over source loading, the bounded
  working set, persistence reconciliation, settings, and events;
- Electron window/tab ownership is separate from navigation, reader, picker,
  menu, and IPC routing;
- mobile reading UI is separate from the native browser-surface adapter and
  native bridge implementations.

See [CODEMAP.md](CODEMAP.md) for concrete entrypoints and source
classifications.

## Package boundaries

Dependencies flow from composition and presentation toward application and
domain code:

```text
apps -> shells / UI / platform adapters -> app -> collectors -> core
                                  |                    |
                                  +-> persistence ----+
```

- `core` must remain platform-neutral and DOM-free. It must not depend on UI,
  collectors, persistence, application orchestration, or platform adapters.
- `collectors` may depend on `core`, but not on application, persistence, UI,
  or platform packages.
- `app` coordinates domain behavior and collectors through platform-facing
  ports; it does not select a concrete target.
- `persistence` implements shared storage and synchronization concerns on top
  of domain contracts.
- `ui-web` may use application, collector, and domain APIs, but it must not
  select a platform adapter.
- `platform-*` packages implement target capabilities and may combine
  application, domain, and persistence APIs as required.
- `webext-shell` composes the shared UI and web-extension adapter; each
  extension app supplies only its browser-specific background integration.
- `webext-runtime` hosts third-party WebExtensions (uBlock Origin,
  Violentmonkey, installed XPIs) for shells that embed a browser engine; it
  depends on `core` alone, reaches files, stores, cookies and the network only
  through interfaces its host implements (`packages/webext-runtime/README.md`),
  and no platform or UI package imports it.

`scripts/check-boundaries.js` enforces the most important import directions and
the DOM-free core rule. Existing accepted violations are recorded in
`scripts/core-boundary-baseline.json`; the baseline is migration debt, not an
extension point for new violations.

## Runtime composition

### Browser extensions

Firefox and Chrome share the side-panel bootstrap, UI, persistence, collectors,
and web-extension adapters. Their background entrypoints differ because Firefox
uses `browser.sidebarAction` and a background script while Chrome uses
`chrome.sidePanel` and a service worker.

Story data and settings are stored in browser IndexedDB through PouchDB. Remote
synchronization uses the configured CouchDB-compatible endpoint. Reader mode
fetches the source, extracts readable content with Mozilla Readability,
sanitizes the generated document, and opens it using extension APIs.

Story sources are stored only in the versioned `sources` document as typed
objects with durable source and group ids. `AppSettings` waits for the initial
settings replication signal before creating local defaults, so an absent local
document cannot overwrite a remote one. Collector configuration is validated
once by `resolveStorySource`; no shell decodes collector configuration from
source strings.

How long a fetched body stays fresh is answered per source. `effectiveCacheMinutes`
in `packages/app/src/cacheTiming.ts` resolves the source override, then the user's
per-collector override from the versioned `cache_timing` document, then a shipped
collector default (Hacker News, both Reddit collectors 4 minutes; Lobsters 10),
then the global default of an hour; `0` means always refetch and an absent value
means inherit. A reload pass resolves every window from one read, and each load
states its own policy — `cache-first` or `network-only` — rather than passing a
boolean the caller and the loader read differently.

Launching is cache-first, so opening the app is not a fetch of every feed at
once; the reload gestures still separate the two policies (a click, `R`, and
pull-to-refresh against a double-click or `Shift+R`, which force the network).
When a request fails, `SourceLoader` falls back to the cached body however old
it is and reports an "Offline Copy" warning, so being offline shows stale
stories rather than none. Cache upkeep lives in `cacheMaintenance.ts`: what is
cached and when it was fetched (read from the payload, which already carries
the timestamp), a full clear, and eviction of what a deleted source leaves
behind — skipping any URL a remaining source still fetches, since the cache is
keyed on the URL and two sources can share one.

Known limits of that design, all deliberate: there is no in-flight
deduplication, so two sources sharing a URL can miss, fetch, and write
together; two sources sharing a body each judge it against their own window, so
the shorter one effectively wins; a forced request re-stamps the entry; and
nothing schedules a refetch, so a window only decides what the next reload
does. `IndexedDbCacheStore` still has no `onblocked` handling, which would
matter if the store ever gained a version.

### Stored content

A story can hold its article as a PouchDB attachment named `content`, with a
small `stored_content` field saying where it came from (`feed` or `page`) and
when. Attachments keep story lists light: `get` and `allDocs` return stubs,
and the html is read lazily through `getStoryContent` on the story store when
the reader opens it. Sync carries the attachment with the document, so a copy
saved on one device reads offline on another.

Content arrives three ways. Feed collectors attach the text a feed includes
(see [Collectors](COLLECTORS.md)). The "Save for offline" story action (menu,
swipe and keyboard) fetches the page, runs it through Readability and stores
the sanitized article. And the app asks for that same extraction on its own
when a bookmarked story has none and the "Save bookmarks offline" setting is
on, or when a source's "Save for offline" option is set, once per story; it
publishes `storyContentRequested`, and `reader/storedContent.ts` in `ui-web`
serves those a couple at a time. A page extraction always wins over feed text.

`PouchStoryStore.saveStory` never puts html inline: the document goes out with
the stubs the database already holds (a put without them would delete the
attachment), then `putAttachment` writes new html and one `get` refreshes the
stubs on the in-memory story. `ReaderView` shows a stored article as it is,
sanitized again on the way out, and only fetches for a story without one. The
extensions cannot inject into a page they never load, so there the panel
renders the reader document and the background opens the extension's own
`static/reader.html`, handing the document over under a one-time token.

Initial and live CouchDB replication use bounded 1,000-document batches with
at most two batches in memory. Directional checkpoints live on the receiving
side (pull locally and push remotely), avoiding redundant remote checkpoint
round trips when an existing client must reconcile a long changes history.

### Electron

Electron has three trust zones:

- The main process owns windows, native menus, IPC handling, browser sessions,
  and remote `WebContentsView` tabs.
- The preload exposes a restricted, typed bridge to the trusted local renderer.
- The renderer composes `OnceApp`, the shared UI, desktop adapters, and its
  IndexedDB-backed PouchDB database.

The local renderer uses context isolation and sandboxing without Node.js
integration. Remote pages receive no Node.js access and no Once bridge. They
run in a persistent, main-process-owned session whose permission requests are
denied by default. The one preload that session registers for every frame is
the extension content-script runner: it exposes nothing to the page's own
world, and gives each loaded extension an isolated world with its own
`browser` object. Sync URLs and source tokens are protected through Electron
`safeStorage`; when the OS refuses its key (an ad-hoc signed macOS build, a
Linux desktop without a secret service), `SecureSettings` keeps them
unencrypted in the profile, warns once, and re-encrypts on the next save that
succeeds.

Electron reader mode fetches through the validated bridge and serves sanitized
documents from the isolated `once-reader://` protocol.

The reader reads aloud on every platform (`packages/ui-web/src/reader/readerTts.ts`).
Its segmenter is inlined into the reader document, so it stays self-contained;
the voice list offers the platform's Web Speech voices plus **Wafli SLT —
offline**, a WebAssembly build of Flite and the CMU SLT voice from
[`batram/wafli`](https://github.com/batram/wafli) (`reader/wafli.ts`; the
module, its licenses and the pinned commit sit in `reader/wafli-licenses/`).
Wafli synthesizes into an `AudioContext` behind the same speech-synthesis
shape, so the play, step and rate controls do not know which engine speaks.

Find in page has one command and two engines: on Electron `browser.find-in-page`
takes Ctrl+F while the content pane holds the keyboard and `browser/FindBar.ts`
drives Chromium's own find over tab IPC; on mobile the browser sheet's Find
control drives Gecko's finder in browser mode on Android, presents the system
find panel over the WKWebView on iOS 16 and later (it searches PDFs in the
native viewer too, which have no DOM for a script to walk), and a small runtime
inside the sandboxed reader frame in reader mode (`apps/mobile/src/readerFind.ts`).

Electron also hosts Firefox-style WebExtensions through Once's own runtime
rather than Chromium's extension subsystem: the host-neutral half lives in
`packages/webext-runtime` (contexts, the `browser.*` handler table, the
webRequest router and DNR enforcement, storage, package validation, the
settings hand-off, the preload-side `browser` builder), and
`apps/electron/src/extensions` keeps the Electron adapters (sessions,
`WebContents` and `WebFrameMain` contexts, `session.webRequest` and
`session.protocol`, cookies, the popup and the toolbar menu); see
[plans/firefox-extensions-plan.md](plans/firefox-extensions-plan.md) and
[plans/once-lite-plan.md](plans/once-lite-plan.md), whose Android WebView
broker is the runtime's second host. Each
loaded extension is a fourth trust zone: its pages run in their own persistent
session at `moz-extension://<host>/` (named as Firefox names it, because
extensions branch on that prefix), with a sandboxed preload that builds
`browser.*` over a single typed IPC channel and no access to the Once bridge.
The runtime owns the browser session's one `webRequest` listener per event
and fans requests out to every extension's blocking listeners; before they
run, each request passes the Manifest V3 `declarativeNetRequest` rules of
every extension (`webext-runtime`'s `dnrBridge.ts` over the pure matcher in
`packages/core/src/webext/dnrMatcher.ts`, with rulesets loaded and persisted
by its `DnrRulesets.ts`). Content
scripts run in per-extension isolated worlds inside tabs, reached only
through the runtime's frame preload; ports join them to the background page.
An extension's own pages (popup, dashboard, its blocked-page) open as tabs
or popup views created in the extension's session, and pages may load only
its `web_accessible_resources`. A web-accessible page a tab shows in a frame
(uBlock's element picker) is the extension's page inside the tab: the frame
preload gives it the page API in its main world, the page's CSP does not
apply to it, and the webRequest hook grants the requests that frame makes
for the rest of the extension. The synced `filter_lists` and `userscripts`
documents are handed to uBlock Origin and Violentmonkey through their own
message APIs, from a main-process context that behaves like one of the
extension's pages. For userscripts that hand-off is an exchange rather than a
write: Violentmonkey's dashboard edits the same scripts, so
`extensions/userscriptReconcile.ts` compares both sides against what the last
hand-off left behind, writes what the document changed, and returns what the
dashboard changed for the shell to save into the document — which is how an
edit, a switch, an install or a delete made there reaches the other devices. The extensions that ship are an explicit list in
`apps/electron/src/extensions/bundledExtensions.ts`; their bundles come from
`scripts/fetch-extensions.js` against pinned hashes into `vendor/extensions`
and travel as packaged resources. `ONCE_ELECTRON_EXTENSIONS` adds
directories in unpackaged builds only. Beyond the bundles, the user can
install any Firefox MV2 or MV3 extension from a Mozilla Add-ons listing or a local
XPI (`extensions/ExtensionManager.ts` reviews, unpacks and activates it;
`ExtensionPackage.ts` bounds the archive). Installed extensions appear in an
extensions panel beside the address bar, from which an action can be pinned
to the toolbar; installation stays local to the device while selected
storage keys can sync. [Extension compatibility](EXTENSION_COMPATIBILITY.md)
lists what the runtime does and does not provide.

Add-ons are a separate concept from those extensions: additions to Once
itself, described by manifests in the synced `addons` settings document
(`packages/core/src/addons`) and rendered by the shared UI through its
element and action registries. Declarative contributions are URL and text
templates over an allow-listed view of a story, with conditions Once
evaluates. Unpackaged Electron builds also read `ONCE_ADDONS` package
directories (`apps/electron/src/devAddons.ts`), served as
`once-addon://dev/…` and registered without touching the document. A
manifest may also name a script, pinned by sha256 and fetched
per device or included in the encrypted addon vault; that code runs in a fifth trust zone, a hidden
`<iframe sandbox="allow-scripts">` on an opaque origin whose page carries its
own policy (`packages/ui-web/public/addon-sandbox.html`: its runtime, add-on
code as a blob module, no network). The frame speaks a validated
`postMessage` protocol, every operation it asks for is scoped to the story
the user acted on, and requests time out. On Electron main serves the page
over `once-addon://` because an opaque origin may not load `file:`
subresources; on mobile it is a static asset beside the app with its runtime
inlined; on Chrome it is a manifest `sandbox` page of the extension; on
Firefox it is the packaged `static/addon-sandbox.html` page. Firefox uses MV2
with `script-src 'self' blob:` in its manifest; the shell narrows its own
scripts to `'self'`, while the sandbox permits blob modules and denies direct
network access. The iframe has no same-origin permission or extension APIs.
The PDF sandbox (see PDF retrieval) is served the same way under its own page.
No user-provided hosting is involved. Add-on code is cached per device by its hash;
an add-on installed from a URL remembers that URL for update
checks.
With [encrypted addon sync](addon-sync-vault.md), `AddonSync` replaces the legacy
`addons` document with one authenticated `addon_vault` snapshot containing
approved packages, settings, storage and connection tokens. `AddonVault` owns
unlocking and conflict review; dedicated PouchDB revision writes reject stale
parents. The host injects tokens only for approved endpoint-bound connections.
See [plans/story-addons-plan.md](plans/story-addons-plan.md).

An add-on may also own a *tray*: a conversation region under a story row that
the host renders from validated views (`packages/core/src/addons/trayProtocol.ts`)
while the add-on's script answers in the sandbox. The tray's conversation can
continue on a larger surface without leaving the sandbox: an Electron tab
(`once-addon://conversation`), an extension page, or the mobile reading view
attach to it by its key (addon, tray, story) and relay commands back to the
shell that owns the sandbox; the shell tells them when the conversation ends.
Extension conversation URLs also name the originating panel instance. Only
that panel answers the broadcast runtime connection; another open panel cannot
replace its transcript or receive its commands. The tab reconnects to its owner
if Firefox disconnects the shared port when an unrelated panel closes. Reloading
the owning panel creates a new instance, so continue from its tray to open a
fresh tab. Both extension targets resolve conversation URLs back to their story
for the selected-story row. A page action chosen from the browser's context
menu while no panel is open in that window opens the conversation page with
`run=<action>` instead; that page owns the run itself
(`packages/ui-web/src/addons/pageActionHost.ts`): it builds the app client
without starting it and mounts the stored add-ons page-only, so the sandbox,
options and tokens are the panel's, while the story list, database sync and
collectors never start. The page follows the add-on document and vault as the
panel changes them, restarting the run when options change, and asks for the
vault passphrase when the synced add-ons are locked. The menu entries exist
before any panel has run: the background registers the bundled add-ons'
actions at install, keeps the list a panel last published, and rebuilds it
on every start.
`examples/addons/what-wait-who-why` is the shipped example, an AI assistant
over the story's article with optional web search.

Add-on registrations are reconciled per identity. Storage-only changes preserve
running frames; options changes use the settings message. The sandbox owner
retains startup/recovery state across disposable frames, and story objects retain
their invocation identity across asynchronous work. Package updates are reviewed
and verified before installation and preserve user storage and compatible options.
See [EXTENSION_COMPATIBILITY.md](EXTENSION_COMPATIBILITY.md) for browser settings
ownership, the conservative mobile filter subset, and platform validation limits.

Desktop keyboard behavior is command-driven rather than a collection of DOM
shortcuts. Shared code owns canonical chords, configurable bindings, conflict
checks, shell dispatch, pane focus, and the durable story cursor. Electron's
main process forwards registered page keystrokes into that command layer and
owns recently closed tab history; shells only advertise commands they can
actually deliver. Main also writes every window's open tabs and position to
`open-tabs.json` as they change (`browser/OpenTabs.ts`). A window closed while
the app keeps running puts its tabs on the reopen stack and leaves the file;
the windows open at a quit (or a crash, which never closes them) stay in it,
and the next start restores each of them with its tabs, active tab and
position, the way Firefox and Chrome do. Reopen closed tab then reaches the
tabs closed before the session ended.

## Migration history

The Firefox, Chrome, and Electron repositories have been consolidated into this
workspace, and the executable legacy applications have been removed. The
pre-cleanup documentation is preserved by the annotated Git tag
`monorepo-migration-complete`:

```bash
git show monorepo-migration-complete:migration-status.md
git show monorepo-migration-complete:legacy-electron-archive.md
```

### Document text retrieval

`OnceClient.retrieveDocument(url)` retrieves an HTTP(S) resource and returns a
platform-neutral `RetrievedDocument`. HTML/XHTML results have `kind: "html"`
and preserve their source markup for Readability. Image results have
`kind: "text"`, `method: "ocr"`, the original media type and source URL, plus
plain `text`, reconstructed `paragraphs`, and original `lines` in the recognition engine's reading order. OCR text is
untrusted content and must never be inserted as HTML.

Platforms add OCR by implementing the optional
`OncePlatformPorts.textRecognition.recognizeImage(Uint8Array)` port, returning
`{ lines: string[], lineBounds?: TextLineBounds[] }`. Bounds are aligned with
lines and use upright image coordinates (x rightwards, y downwards, common units
for both axes). macOS shares its Apple Vision helper with native image
text selection; iOS uses Vision through the trusted Capacitor shell bridge.
Android uses Google ML Kit text recognition (proprietary but free) with its
bundled Latin model, through the same bridge method, so no Play services or
model download is involved. Windows has the macOS arrangement with
Windows.Media.Ocr: a C++/WinRT helper (`apps/electron/native/ImageText.cpp`,
built by `scripts/build-native.js` with MSVC and shipped beside the asar)
takes bytes on stdin and answers the Swift helper's JSON, so image text
selection works there too. Linux and browser extensions report unavailable
image OCR until they supply a backend. Recognition runs on device, with a
32 MiB image limit, an 80-megapixel dimension limit, EXIF orientation applied,
and downsampling to a 4096 px longest side.

Image text selection ("Select Text in Image" in Electron's context menu on
macOS and Windows, "Select text in image" in Android's long-press menu, or a
double click or double tap on an image: Electron's frame preload and Android's
bridge content script report trusted ones only, and a page or link that takes
the clicks first wins) is one shared overlay, `packages/ui-web/src/imageText/`. Electron hangs it on the
image from an isolated world of the image's frame (`imageTextAnchor.ts`, run
by `apps/electron/src/browser/ImageTextHost.ts`): the words live in a
cross-origin frame of the app's own scheme (`once-image-text:`, which bypasses
the page's CSP and is served only while a selection is open), held to the
image with CSS anchor positioning, so the page's compositor moves them in the
same frame as the image through any scrollers; app-owned views over the tab
trailed a scroll by a frame. The page sees two closed hosts and cannot read
the words or the selection. Android's shell (`apps/mobile/src/mobileImageText.ts`)
evaluates it through the surface's content-script bridge. Recognition stays native and only
the chosen image is recognized: Electron sends its bytes to the helper, Android
has Gecko fetch the image with the page's cookies and referrer (as Copy image
does) and ML Kit adds word corners (`recognizeImage({ url, referrer })`). The
overlay lays transparent words over the image, groups them with the Reader's
OCR reflow (`ocrParagraphLines`) so a triple-click selects a paragraph and
copying joins wrapped lines, and on touch offers a Copy button. While open
it takes the image's input (`imageTextPointer.ts`), so the image's own drag,
click-to-zoom, link and menu behaviour pause: a mouse drag anywhere on the
image sweeps a selection (character-precise in words, snapping to the nearest
word over gaps, autoscrolling at the viewport edge), Ctrl/Cmd+A selects all
recognized text, and wheel input reaches the image's scroll container.
Android selects with GeckoView's native carets, handles, magnifier and
toolbar instead (`imageTextLayer.ts`): the words sit in an iframe over the
image, so a selection never runs into page text, laid out gaplessly to Gecko's
caret rules (lines as grid items in one cell, each line box reaching halfway
to its neighbours, words stretched vertically so a long press always hits
text). Electron's touchscreens keep the overlay's own model, since native
carets hit-test the image or page between its sparse words: tap or long-press
a word, then drag two handles by whole words. Android's pull-to-refresh only
takes drags Gecko reports as browser-handled overscroll (`ReadingGeckoView`),
never ones page content consumed, such as caret handles. The bar sits outside the image when there is
room, else in the corner covering the fewest words. iOS needs none of this:
WebKit's Live Text already selects text in images.

The existing `fetchDocument` method adapts this result for Reader, offline
story storage and addon `getStoryContent()`. For recognized text its `html`
field contains escaped paragraphs and its `mediaType` is `text/plain`, marking
already-extracted text that must bypass article-length heuristics. HTML pages
continue through Readability. Addons retain their existing saved/live/fetched
precedence; a live image document falls through to image retrieval because its
HTML contains no article text. The addon text limit and capability checks are
unchanged. A shared deterministic pass joins wrapped lines using their vertical
spacing, alignment, overlap and text size; larger gaps, headings, list starts
and column boundaries remain separate. Backends without geometry conservatively
join lowercase sentence continuations. `text` separates reconstructed paragraphs
with blank lines, and Reader renders one paragraph per group so speech does not
pause at every image line wrap. Raw `lines` remain available. This reflows prose;
it does not reconstruct tables, typography or arbitrary multi-column layouts.

### PDF retrieval

`OncePlatformPorts.pdfText` is an optional local PDF extraction port. Its
`extract(bytes, recognition?)` method returns ordered pages with recognized lines,
optional line bounds, and per-page `embedded` or `ocr` provenance. The shared
retrieval API recognizes `application/pdf` by MIME type; a missing or generic
download type (`application/octet-stream` and the like) counts as a PDF when the
URL or the `Content-Disposition` file name ends in `.pdf`, or when the body starts
with the `%PDF-` signature (`@once/app` `pdfMediaType.ts`, which the extensions'
navigation probe shares). A browser saves such a response as a download and
closes the tab it opened for it, so the extensions open the reader in a tab of
its own and cancel and erase that download (the `downloads` permission), only
ever one that started after the reader was asked for. It bounds decoder input to 64 MiB, and reconstructs each page's paragraphs independently. First-line and hanging
indents are treated as line wrapping when spacing and overlap agree; a new indent
after a completed sentence preserves a paragraph boundary. `method` on the
combined result is `embedded`, `ocr`, or `mixed`; PDF metadata can supply the
reader title. Original lines remain available, and pages are never joined into
a single paragraph across a page boundary.

The bundled browser adapter lives at `@once/platform-web/pdf`. Electron,
Capacitor and extensions use PDF.js 6.4.299's legacy build; the inactive website
composition root can reuse the same adapter when it is implemented. PDF.js is
treated as untrusted code handling untrusted input: it runs only inside the PDF
sandbox, a hidden `<iframe sandbox="allow-scripts">` on an opaque origin whose
page (`packages/ui-web/public/pdf-sandbox.html`, runtime
`@once/platform-web/pdf-sandbox`) carries its own policy: its bundled runtime,
the parser as a blob module built from code the shell hands over (PDF.js runs
it as a worker where the host allows one; Chromium refuses workers to an
opaque origin, so there it imports the module onto the frame's own thread,
still outside the shell), `'wasm-unsafe-eval'` for the image decoders, and no
network, storage, bridge or PDF scripting (the QuickJS engine is not shipped).
The shell posts the bytes and the parser's source, answers the frame's requests for encoding maps,
standard fonts and decoders from its own origin (file names of known kinds
only), runs the optional native OCR port on the bitmaps it sends back, and
validates every message (`pdfSandboxProtocol.ts`: page count, line shapes,
bounds, title length, image size) so a compromised parser can at most return
wrong text. A fresh frame serves each PDF and is removed afterwards. The page is
served like the add-on sandbox: `once-addon://pdf/` on Electron, the inlined
`pdf-sandbox.html` asset on mobile, a manifest `sandbox` page on Chrome and the
packaged `static/pdf-sandbox.html` on Firefox.

The adapter prefers each page's text layer and rasterizes only pages without
usable alphanumeric text, once, with annotations disabled; a uniform bitmap is
a blank page, anything else goes to the optional native OCR port. Rasterization
is bounded to a 2600-pixel longest side, and pages are processed sequentially
with canvas/page/worker cleanup. Extraction is limited to 200 pages and two
minutes, with explicit password, scan-support and recognition errors. An
unreadable scan fails extraction rather than returning an incomplete article.
A page with a small amount of embedded text over a larger scan currently uses
that text layer; detecting incomplete text layers is a separate improvement.

Document bodies are bounded before a decoder sees them. Retrieval reads at most
`MAX_DOCUMENT_BYTES` (64 MiB) and uses `OncePlatformPorts.documentFetch` where
the platform's ordinary fetch would buffer a whole body first: Electron streams
document bodies from main, and the Capacitor apps download them through their
own native method (`fetchDocument` on the surface plugin, URLSession on iOS and
HttpURLConnection on Android) which stops reading at the cap as bytes arrive, so
a misreported or absent Content-Length cannot fill memory.

macOS/iOS OCR scanned pages with Apple Vision, Android with ML Kit and Windows
with Windows.Media.Ocr. Linux and extensions can extract embedded text now;
scanned pages need a future image-recognition implementation. The PDF port
also permits native
backends such as PDFKit without changing Reader or addon consumers. Android's
native text API requires API 35, so PDF.js keeps older devices on the same text
retrieval path.

Extension reader actions open the source tab and read its main-frame response
headers through `webRequest` (`webext-shell/src/pdfSource.ts`); a PDF response
moves the tab to the extension's own reader page, so no extra request reaches
the site before the user's navigation and extensionless PDF URLs are handled.
This avoids injecting into Chromium/Firefox's privileged PDF viewer. Only a
navigation the browser served without reporting headers (a cached document)
falls back to a credential-less HEAD probe once loaded. HTML sources retain the
existing live content-script reader path. Reader links still identify their
original source URL, and addons retrieve PDF text through the same
capability-gated article content API.

Reference implementations: [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html),
[Apple PDFPage](https://developer.apple.com/documentation/pdfkit/pdfpage), and
[Android PdfRenderer.Page](https://developer.android.com/reference/android/graphics/pdf/PdfRenderer.Page).
