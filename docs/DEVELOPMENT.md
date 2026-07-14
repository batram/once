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

`npm run check` lints the workspace, builds the shared packages, type-checks
the workspace, checks package boundaries, creates development builds for both
browser targets, and type-checks Electron. It does not run the Electron unit or
E2E test suites; run those separately as described below.

## Build commands

```bash
# Production bundles
npm run build:firefox
npm run build:chrome
npm run build:extensions

# Development bundles with inline source maps
npm run build:firefox:dev
npm run build:chrome:dev
npm run build:extensions:dev
```

Outputs are written to:

- `apps/firefox-extension/dist`
- `apps/chrome-extension/dist`

Webpack cleans the selected target's `dist` directory on each extension build.
Production builds are minified and omit source maps; development builds include
inline source maps.

Every build carries a build channel (`release` or `dev`) that is shown next to
the version in the settings panel, as `x.y.z (dev)` on dev builds. Production
extension builds are release-channel; development builds are dev-channel and
additionally rename the extension to "Once Sidepanel (dev)" and switch the
manifest icons to `ic_launcher_dev.png`, so a dev install is distinguishable
from a store install in the toolbar and extension list. The icon sources live
in `packages/ui-web/public/static/imgs/icons/` (`icon.svg`/`icon_dev.svg` plus
the exported `ic_launcher*` files under `mipmap-mdpi/`).

## Load locally

### Firefox

Open `about:debugging`, choose **This Firefox**, select **Load Temporary
Add-on**, and open `apps/firefox-extension/dist/manifest.json`.

For automatic reloads:

```bash
npm run build:firefox:dev
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
```

## Test harness

```bash
# Fast deterministic unit and integration tests (never contact story sources)
npm test

# Collector/parser fixtures only
npm run test:collectors

# Build, validate, and smoke-test installed Chrome and Firefox extensions
npm run test:extensions

# Explicit manual live collector compatibility probes
npm run test:live:collectors

# Refresh exactly one named live capture for review
npm run fixtures:refresh:collectors -- reddit_json
```

On Linux, the Firefox extension smoke runs headlessly. On Windows it opens a
separate headful Firefox instance because current Windows Firefox headless
sessions can discard their initial browsing context. The test uses a temporary
profile, `-no-remote`, a test-owned internal extension UUID, and WebDriver BiDi;
it does not reuse or close a developer's normal Firefox session.

```bash
# Windows outputs
npm run package:electron
npm run make:electron

# Dev-channel Windows outputs, installable next to a release build
npm run package:electron:dev
npm run make:electron:dev
```

`npm run test:electron` executes the shared app and Electron integration tests
after a type-check. `npm run test:electron:e2e` packages the application, then launches
the packaged webpack entry with Playwright. The E2E test currently references
`electron.exe` directly and therefore runs on Windows. Failure traces and other
Playwright artifacts are written below `test-results/`.

`npm run package:electron` creates an unpacked Windows application.
`npm run make:electron` also creates the configured Squirrel installer and ZIP.
Release output is written below `apps/electron/out` and dev-channel output
below `apps/electron/out/dev`, so the two channels never mix make artifacts;
neither variant signs the resulting application.

The Electron build channel is fixed at build time: `npm run start:electron`
runs as dev-channel, `package:electron`/`make:electron` produce release-channel
output, and the `:dev` variants produce a dev-channel bundle. A dev bundle is
branded "Once Dev" (`once-dev.exe`, dev icon, Squirrel package `oncedev`) and
installs alongside a release build with a separate user data profile.
Dev-channel runs also use the dev icon for the window and taskbar. Setting
`ONCE_BUILD_CHANNEL` overrides the default channel for any Electron command.

Automated tests override the user data directory with a temporary directory so
they do not touch a developer's normal Once profile.

### Electron updates

Installed release-channel Windows builds check the public `batram/once` GitHub
Releases feed at startup and once per hour. When an update has downloaded, Once
offers to restart immediately; choosing **Later** applies it on a subsequent app
restart. The version row in Electron settings also provides a manual update
check and reports its current status. Development builds, unpackaged runs,
Forge's unpacked package output, Squirrel's first launch after an install, and
Electron tests do not check for updates; their manual check is disabled. Run
the generated Setup executable to install Squirrel's `Update.exe` and enable
updates.

Updates use Electron's public `update.electronjs.org` service and native
Squirrel.Windows updater. Each non-draft, non-prerelease GitHub release must use
a valid `vX.Y.Z` tag and include the generated `RELEASES`, `*-full.nupkg`, and
setup `.exe` files. The release workflow uploads these files and
`verify:release-artifacts` fails if any required update asset is missing.

The current Windows artifacts are not code-signed. Automatic updates work for
Squirrel.Windows without signing, but production releases should be signed to
establish publisher identity and improve Windows trust and SmartScreen behavior.

Normal unit, integration, extension, and Electron E2E tests do not contact
third-party story-source servers. Tests use responses below `tests/fixtures/collectors`, and window/tab E2E
tests disable initial story loading and the renderer's network-fetch bridge.
`test:live:collectors` is opt-in and makes one allowlisted request per source
with a timeout and response-size cap. `fixtures:refresh:collectors` requires one
source name and writes only that reviewed capture. Live checks are never part
of pull-request CI.

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
