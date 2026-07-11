# Monorepo Migration

## Goal and current state

Firefox and Chrome are working browser-extension targets. Their manifests,
browser-specific background entrypoints, and build outputs live under
`apps/*-extension/`. Both use `OnceApp` with `createWebExtPlatform` and the
shared `@once/webext-shell` side-panel bootstrap and static resources.

Electron is now a working Windows-first desktop target. Website and mobile are
placeholders. Future targets should reuse the shared packages and keep
target-specific entrypoints and packaging inside `apps/*`. The replaced legacy
Chrome and Electron repositories were removed after migration audits. The
Electron audit and source-recovery reference are in
`legacy-electron-archive.md`.

## Package boundaries

- `core`: platform-neutral domain, story, and settings logic; no DOM, platform,
  collector, UI, or persistence dependencies.
- `collectors`: source collectors, parsing helpers, and the collector registry.
- `app`: application orchestration, settings, story state, and client events.
- `ui-web`: shared DOM presentation.
- `persistence`: PouchDB storage and synchronization.
- `platform-*`: target-specific implementations of the ports used by `app`.
- `apps/*`: application composition, entrypoints, assets, and build config.

## Completed

- Created the workspace packages and imported the legacy applications.
- Migrated Firefox to the monorepo and verified development and production
  builds.
- Removed the old root `src/` tree, vendored dependencies, obsolete APIs,
  compatibility shells, forwarding helpers, duplicate exports, and no-op
  backend stubs.
- Consolidated collectors into `@once/collectors` and made `core` DOM-free.
- Added a boundary check that prevents forbidden dependencies in `core`.
- Added package-owned TypeScript builds, declarations, dependencies, and clean
  output handling.
- Made Firefox consume compiled workspace packages through their manifests.
- Added the Chrome Side Panel target and a shared Chrome/Firefox build config.
- Consolidated extension HTML, CSS, images, icons, and the side-panel
  TypeScript entrypoint in `@once/webext-shell`.
- Removed the replaced legacy Chrome application.
- Deferred dynamic collector loading and per-source collector packages until a
  concrete need appears.
- Added a secure Electron 43 application using a trusted Once renderer and
  main-process-owned `WebContentsView` tabs for remote content.
- Added standard tab and navigation controls, bridge-backed HTTP/CouchDB
  requests, encrypted desktop sync settings, a fresh IndexedDB profile, and a
  persistent browser-cookie partition.
- Restored viable legacy Electron browser parity: compact legacy-styled tabs
  and controls, middle-click close, tab reordering and URL drops, live tab
  transfers between detachable Once windows, tab media muting, link-hover
  status, fullscreen coordination, browser mouse history commands, and
  before-unload confirmation.
- Restored native page and tab context menus with edit, selection, link,
  duplicate, close, move-to-window, system-browser, and always-available
  Inspect/DevTools actions while keeping remote pages sandboxed.
- Added secure shared reader mode with Readability extraction, sanitized themed
  documents, Electron and extension delivery, original-page navigation, and
  coordinated text-to-speech controls.
- Audited and removed the legacy Electron application; historical details and
  remaining presenter differences are recorded in
  `legacy-electron-archive.md`.
- Added Electron Forge development, packaging, Squirrel.Windows, ZIP, security
  fuses, unit tests, and a Playwright Electron smoke test.
- Moved the shared HTML, CSS, images, UI mounting, and IndexedDB cache adapter
  into target-neutral shared packages.

## Next steps

1. Expand fake-port coverage for collector-specific successful reloads and
   CouchDB failure/retry scenarios.
2. Implement real mobile ports and build the mobile application.
3. Build the website application.
4. Add complete Electron session restoration (windows, tabs, navigation/page
   state, scroll positions, and recently closed tabs), optional reader
   archive/cache fallback, a working video presenter, signing, and updates as
   separate milestones.

## Validation

- `npm run build:packages`: build all workspace packages.
- `npm run clean:packages`: remove package build output.
- `npm run check`: typecheck, check boundaries, and build Firefox and Chrome
  for development.
- `npm run b2`: build Firefox for production.
- `npm run build:chrome`: build Chrome for production.
- `npm run build:extensions`: build both browser targets for production.
- `npm run start:electron`: run the Electron app in development.
- `npm run build:electron`: build packages and typecheck Electron.
- `npm run test:electron`: run Electron and `OnceApp` unit tests.
- `npm run test:electron:e2e`: package Electron and run the Playwright smoke test.
- `npm run package:electron`: create an unpacked Windows application.
- `npm run make:electron`: create unsigned Squirrel.Windows and ZIP artifacts.
