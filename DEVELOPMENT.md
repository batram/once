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

The platform design, workspace structure, and package dependency rules are
documented in [ARCHITECTURE.md](ARCHITECTURE.md).

`npm run build:packages` compiles the referenced TypeScript packages to local
`dist` directories. Application builds consume those compiled package outputs,
so the root app scripts run the package build first. If generated package files
become stale, use `npm run clean:packages` before rebuilding.

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

```bash
# Development
npm run start:electron

# Static and unit validation
npm run build:electron
npm run test:electron

# Packaged application smoke test
npm run test:electron:e2e

# Explicitly refresh the one live story-source fixture (never run by normal tests)
npm run test:story-sources:refresh

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

Automated tests override the user data directory with a temporary directory so
they do not touch a developer's normal Once profile.

Normal unit and Electron E2E tests do not contact story-source servers. Unit
tests use responses below `tests/fixtures/story-sources`, and window/tab E2E
tests disable initial story loading and the renderer's network-fetch bridge.
`test:story-sources:refresh` is the only live-source test: it is opt-in, makes
one allowlisted request with a timeout and response-size cap, and replaces the
reusable fixture consumed by the unit suite.

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
