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

`apps/website` reserves the future web composition root. `apps/mobile` is the
Capacitor composition root for Android and iOS; `@once/platform-mobile`
supplies its PouchDB, native networking, secure settings, system UI, and
external-browser adapters.

## Workspace structure and ownership

```text
apps/
  firefox-extension/   Firefox manifest and background entrypoint
  chrome-extension/    Chrome manifest and background entrypoint
  electron/            Electron main, preload, renderer, and packaging
  website/             Future website composition root
  mobile/              Capacitor web bundle and committed Android/iOS projects
packages/
  core/                 Platform-neutral domain models and story logic
  collectors/           Feed collectors, parsers, and collector registry
  app/                  Application orchestration, settings, and events
  persistence/          PouchDB stores, synchronization, and storage contracts
  ui-web/               Shared DOM UI, reader, styles, and static resources
  webext-shell/         Shared browser-extension composition entrypoint
  platform-webext/      Browser-extension implementations of application ports
  platform-electron/    Electron renderer implementations of application ports
  platform-web/         Future website adapters
  platform-mobile/      Capacitor implementations of application ports
```

### Mobile

The Capacitor application embeds the shared Once web UI in WKWebView or Android
WebView. It stores stories and lists in a target-specific PouchDB database,
uses Capacitor's native HTTP patch for collector and CouchDB requests, and
opens ordinary links in the platform browser. Reader documents stay inside a
sandboxed local reader surface.

On Android the reading surface itself is a GeckoView, Firefox's engine,
beside the Capacitor shell's WebView. It runs the same Firefox-style
extensions as Electron (uBlock Origin, Violentmonkey) as GeckoView
built-ins from the APK's assets, which `scripts/fetch-extensions.js` unpacks
against pinned hashes, plus a bridge extension of Once's own that carries
script evaluation for the source picker over native messaging. The surface
adapter's contract in `@once/platform-mobile` is unchanged.

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
`browser` object. Sync URLs are protected through Electron `safeStorage`.

Electron reader mode fetches through the validated bridge and serves sanitized
documents from the isolated `once-reader://` protocol.

Electron also hosts Firefox-style WebExtensions through its own runtime in
`apps/electron/src/extensions` rather than Chromium's extension subsystem; see
[plans/firefox-extensions-plan.md](plans/firefox-extensions-plan.md). Each
loaded extension is a fourth trust zone: its pages run in their own persistent
session at `moz-extension://<host>/` (named as Firefox names it, because
extensions branch on that prefix), with a sandboxed preload that builds
`browser.*` over a single typed IPC channel and no access to the Once bridge.
The runtime owns the browser session's one `webRequest` listener per event
and fans requests out to every extension's blocking listeners. Content
scripts run in per-extension isolated worlds inside tabs, reached only
through the runtime's frame preload; ports join them to the background page.
An extension's own pages (popup, dashboard, its blocked-page) open as tabs
or popup views created in the extension's session, and pages may load only
its `web_accessible_resources`. The synced `filter_lists` and `userscripts`
documents are handed to uBlock Origin and Violentmonkey through their own
message APIs, from a main-process context that behaves like one of the
extension's pages. The extensions that ship are an explicit list in
`apps/electron/src/extensions/bundledExtensions.ts`; their bundles come from
`scripts/fetch-extensions.js` against pinned hashes into `vendor/extensions`
and travel as packaged resources. `ONCE_ELECTRON_EXTENSIONS` adds
directories in unpackaged builds only.

Add-ons are a separate concept from those extensions: additions to Once
itself, described by manifests in the synced `addons` settings document
(`packages/core/src/addons`) and rendered by the shared UI through its
element and action registries. Declarative contributions are URL and text
templates over an allow-listed view of a story, with conditions Once
evaluates. Unpackaged Electron builds also read `ONCE_ADDONS` package
directories (`apps/electron/src/devAddons.ts`), served as
`once-addon://dev/…` and registered without touching the document. A
manifest may also name a script, pinned by sha256 and fetched
per device, never synced; that code runs in a fifth trust zone, a hidden
`<iframe sandbox="allow-scripts">` on an opaque origin whose page carries its
own policy (`packages/ui-web/public/addon-sandbox.html`: its runtime, add-on
code as a blob module, no network). The frame speaks a validated
`postMessage` protocol, every operation it asks for is scoped to the story
the user acted on, and requests time out. On Electron main serves the page
over `once-addon://` because an opaque origin may not load `file:`
subresources; on mobile it is a static asset beside the app with its runtime
inlined; on Chrome it is a manifest `sandbox` page of the extension; on
Firefox, which lets no page under an extension's origin run third-party code,
it is a hosted copy of the self-contained page the build emits, named by the
user and kept in local extension storage, without which Firefox runs
declarative add-ons only. Add-on code is cached per device by its hash and
never synced; an add-on installed from a URL remembers that URL for update
checks.
See [plans/story-addons-plan.md](plans/story-addons-plan.md).

Desktop keyboard behavior is command-driven rather than a collection of DOM
shortcuts. Shared code owns canonical chords, configurable bindings, conflict
checks, shell dispatch, pane focus, and the durable story cursor. Electron's
main process forwards registered page keystrokes into that command layer and
owns recently closed tab history; shells only advertise commands they can
actually deliver.

## Migration history

The Firefox, Chrome, and Electron repositories have been consolidated into this
workspace, and the executable legacy applications have been removed. The
pre-cleanup documentation is preserved by the annotated Git tag
`monorepo-migration-complete`:

```bash
git show monorepo-migration-complete:migration-status.md
git show monorepo-migration-complete:legacy-electron-archive.md
```
