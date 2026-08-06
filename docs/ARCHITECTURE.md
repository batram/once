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

The sync URL can contain credentials, so mobile stores it outside the WebView:
iOS uses Keychain and Android encrypts an app-private preference with an
Android Keystore key. Development and release installs use separate bundle IDs
and native flavors/schemes.

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
collector default, then the global default; `0` means always refetch and an
absent value means inherit. A reload pass resolves every window from one read,
and each load states its own policy — `cache-first` or `network-only` — rather
than passing a boolean the caller and the loader read differently.

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
integration. Remote pages receive no preload, Node.js access, or Once bridge.
They run in a persistent, main-process-owned session whose permission requests
are denied by default. Sync URLs are protected through Electron `safeStorage`.

Electron reader mode fetches through the validated bridge and serves sanitized
documents from the isolated `once-reader://` protocol.

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
