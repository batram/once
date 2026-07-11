# Development

## Source layout

The Chrome and Firefox extensions are thin packaging targets:

```text
apps/
  chrome-extension/
    public/manifest.json      Chrome-only manifest
    src/background.ts         Chrome Side Panel setup
  firefox-extension/
    public/manifest.json      Firefox-only manifest
    src/background.ts         Firefox sidebar and context menu setup
packages/
  webext-shell/
    src/sidepanel.ts          Browser-extension composition entrypoint
  platform-webext/            Shared browser storage, tabs, theme, and database ports
  ui-web/
    public/                   Shared HTML, CSS, images, and application icons
    src/                      Shared DOM components and UI mounting
scripts/
  webpack.webext.config.js    One target-parameterized extension build
```

Static resources have one canonical source in
`packages/ui-web/public`. Webpack copies those resources into each
target's `dist/static` directory and then copies only the target's manifest.
Do not add target-local copies of shared HTML, CSS, or images.

The complete side-panel TypeScript bootstrap is shared. Only background code
remains target-specific because Chrome uses `chrome.sidePanel` and a service
worker, while Firefox uses `browser.sidebarAction` and a background script.

## Install and validate

```bash
npm install
npm run check
```

`npm run check` type-checks the workspace, checks package boundaries, and
creates development builds for both browser targets.

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

## Load locally

### Firefox

Open `about:debugging`, choose **This Firefox**, select **Load Temporary
Add-on**, and open `apps/firefox-extension/dist/manifest.json`.

For automatic reloads:

```bash
npx web-ext run --source-dir ./apps/firefox-extension/dist
```

### Chrome

Open `chrome://extensions`, enable **Developer mode**, choose **Load
unpacked**, and select `apps/chrome-extension/dist`.

The Chrome build requires Chrome 114 or newer because it uses the Side Panel
API.

## Package and sign Firefox

Create an unsigned archive in `web-ext-artifacts/`:

```bash
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

Unpacked applications and distributables are written below
`apps/electron/out`. Development, production, and automated tests use fresh v2
storage and do not import the legacy Electron database. The browser cookie
partition persists normally; open tabs are intentionally not restored yet.
