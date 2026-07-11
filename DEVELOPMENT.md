# Development

Run all commands in this document from the repository root. The project is an
npm workspace; a single root install supplies every app and package.

## Prerequisites

- Node.js and npm
- Firefox for Firefox extension testing
- Chrome 114 or newer for Chrome extension testing
- Windows for the current Electron packaging and end-to-end test workflows

Install the locked dependency set with:

```bash
npm ci
```

Use `npm install` instead when intentionally changing dependencies and
`package-lock.json`.

## Source layout

The implemented application targets are Firefox, Chrome, and Electron. The
website and mobile app directories are placeholders and do not currently have
build or run commands.

```text
apps/
  chrome-extension/
    public/manifest.json      Chrome-only manifest
    src/background.ts         Chrome Side Panel setup
  firefox-extension/
    public/manifest.json      Firefox-only manifest
    src/background.ts         Firefox sidebar and context menu setup
  electron/
    src/main.ts               Main process, windows, IPC, and browser session
    src/preload.ts            Restricted renderer bridge
    src/renderer.ts           Once application and shared UI composition
    forge.config.js           Packaging, makers, and Electron security fuses
  mobile/                     Packaging placeholder
  website/                    Packaging placeholder
packages/
  core/                       Platform-neutral story/domain logic
  collectors/                 Feed collectors, parsers, and registry
  app/                        Once application orchestration and event bus
  persistence/                PouchDB/IndexedDB stores and sync adapters
  ui-web/                     Shared DOM UI, reader, HTML, CSS, and images
  platform-webext/            Browser-extension platform adapters
  platform-electron/          Electron renderer-side platform adapters
  platform-web/               Website adapter placeholder
  platform-mobile/            Mobile adapter placeholder
  webext-shell/               Shared browser-extension composition entrypoint
scripts/
  webpack.webext.config.js    One target-parameterized extension build
  check-boundaries.js         Package dependency and DOM boundary check
tests/
  electron/                   Node-based Electron and application unit tests
  electron-e2e/               Playwright packaged-app smoke tests
```

`npm run build:packages` compiles the referenced TypeScript packages to local
`dist` directories. Application builds consume those compiled package outputs,
so the root app scripts run the package build first. If generated package files
become stale, use `npm run clean:packages` before rebuilding.

`npm run check:boundaries` keeps `core` DOM-free and checks selected package
dependency directions. Any accepted legacy violations must be recorded in
`scripts/core-boundary-baseline.json`; do not add entries merely to make a new
violation pass.

### Browser-extension assets

Static resources have one canonical source in
`packages/ui-web/public`. Webpack copies those resources into each
target's `dist/static` directory and then copies only the target's manifest.
Do not add target-local copies of shared HTML, CSS, or images.

The complete side-panel TypeScript bootstrap is shared. Only background code
remains target-specific because Chrome uses `chrome.sidePanel` and a service
worker, while Firefox uses `browser.sidebarAction` and a background script.

## Install and validate

```bash
npm run check
```

`npm run check` builds the shared packages, type-checks the workspace, checks
package boundaries, creates development builds for both browser targets, and
type-checks Electron. It does not run the Electron unit or E2E test suites; run
those separately as described below.

## Build commands

```bash
# Production bundles
npm run build:firefox
npm run build:chrome
npm run build:extensions

# Development bundles with inline source maps
npm run build-dev:firefox
npm run build-dev:chrome
npm run build:extensions:dev
```

Outputs are written to:

- `apps/firefox-extension/dist`
- `apps/chrome-extension/dist`

The compatibility aliases `npm run b1`, `npm run build-dev`, and `npm run b2`
continue to build Firefox.

Webpack cleans the selected target's `dist` directory on each extension build.
Production builds are minified and omit source maps; development builds include
inline source maps.

## Load locally

### Firefox

Open `about:debugging`, choose **This Firefox**, select **Load Temporary
Add-on**, and open `apps/firefox-extension/dist/manifest.json`.

For automatic reloads:

```bash
npm run build-dev:firefox
npx web-ext run --source-dir ./apps/firefox-extension/dist
```

Rebuild after source changes; the documented webpack commands are one-shot
builds and do not run in watch mode.

### Chrome

Open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked**, and select `apps/chrome-extension/dist`.

The Chrome build requires Chrome 114 or newer because it uses the Side Panel
API.

## Package and sign Firefox

Build Firefox first, then create an unsigned archive in `web-ext-artifacts/`:

```bash
npm run build:firefox
npm run webex
```

For an unlisted signed build, obtain AMO API credentials and run:

```bash
npx web-ext sign --source-dir ./apps/firefox-extension/dist --channel unlisted --api-key "your_jwt_issuer_key" --api-secret "your_jwt_secret"
```

## Electron

Electron uses the same Once UI and application packages as the extensions. The
trusted local renderer owns `OnceApp` and its IndexedDB PouchDB database. Remote
pages are isolated in main-process-owned `WebContentsView` tabs and have no
preload, Node.js, or Once bridge access.

The local Once renderer runs with context isolation, sandboxing, and no Node.js
integration. Sync URLs are stored through Electron `safeStorage`. The persistent
remote-page session denies permission requests by default.

```bash
# Development
npm run start:electron

# Static and unit validation
npm run build:electron
npm run test:electron

# Packaged application smoke test
npm run test:electron:e2e

# Windows outputs
npm run package:electron
npm run make:electron
```

`npm run test:electron` executes the Node test files in `tests/electron` after a
type-check. `npm run test:electron:e2e` packages the application, then launches
the packaged webpack entry with Playwright. The E2E test currently references
`electron.exe` directly and therefore runs on Windows. Failure traces and other
Playwright artifacts are written below `test-results/`.

`npm run package:electron` creates an unpacked Windows application.
`npm run make:electron` also creates the configured Squirrel installer and ZIP.
Both write below `apps/electron/out`; neither signs the resulting application.

Development, production, and automated tests use v2 storage and do not import
the legacy Electron database. The browser cookie partition persists normally;
open tabs are intentionally not restored yet. Automated tests override the user
data directory with a temporary directory so they do not touch a developer's
normal Once profile.

## Generated files

The following paths are build or test outputs and must not be edited directly:

- `packages/*/dist`
- `apps/firefox-extension/dist`
- `apps/chrome-extension/dist`
- `apps/electron/.webpack`
- `apps/electron/out`
- `test-results`
- `web-ext-artifacts`

They are ignored by Git and can be recreated from the commands above.
