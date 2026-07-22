# Development

Run all commands in this document from the repository root. The project is an
npm workspace; a single root install supplies every app and package.

## Prerequisites

- Node.js and npm
- Firefox for Firefox extension testing
- Chrome 114 or newer for Chrome extension testing
- Windows for the current Electron packaging and end-to-end test workflows
- Android Studio 2025.2.1+, Android SDK 36, and JDK 21 for Android
- macOS with Xcode 26+ for iOS

Install the locked dependency set with:

```bash
npm ci
```

Browser tests install their matching Chromium build automatically when run.
Linux CI additionally installs Chromium's system libraries through
`npm run test:setup:ci`. Firefox extension tests use the locally installed
Firefox application.

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

## Capacitor mobile apps

The committed native projects live below `apps/mobile/android` and
`apps/mobile/ios`. Do not recreate them with `cap add`; normal development uses
the repository wrapper, which builds shared packages and always runs `cap sync`.

```bash
# Validate one native toolchain
npm run mobile -- doctor android
npm run mobile -- doctor ios

# Build only the embedded web bundle
npm run mobile -- web --channel dev
npm run mobile -- web --channel release

# Run or open a synchronized development app
npm run mobile -- run android --channel dev
npm run mobile -- run ios --channel dev
npm run mobile -- open android --channel dev
npm run mobile -- open ios --channel dev

# Webpack live reload on a selected simulator/device
npm run mobile -- serve android --channel dev
npm run mobile -- serve ios --channel dev

# Internal QA artifacts (debug APK or unsigned simulator app)
npm run mobile -- package android --channel dev
npm run mobile -- package ios --channel dev
```

The iOS packaging command resolves the public Capacitor Swift package with
system Git, disables Git credential helpers and interactive prompts, and tells
Xcode to use netrc rather than the login Keychain for package authorization.
The public dependency does not require GitHub credentials.

Release channel identity is `com.zmarn.once` / “Once”; development and internal
QA use `com.zmarn.once.dev` / “Once Dev”. Set `ONCE_BUILD_NUMBER` to a positive,
monotonically increasing integer in CI. Production packaging intentionally
fails until store signing is implemented.

Run `npm run test:mobile` for adapter checks and `npm run test:mobile:web` for
the phone-sized browser suite. Native Appium suites use
`test:mobile:e2e:android` and `test:mobile:e2e:ios`; install the pinned Appium
driver listed in CI first. The runner rebuilds the dev app automatically when
the installed bundle is missing, older than the sources, or was not packaged
with `--e2e` (tracked via a build stamp in `apps/mobile/dist`); set
`ONCE_MOBILE_APP` to test a specific prebuilt bundle instead. The test
environment listens on port 3211, serves only reviewed fixtures, and exposes
its authenticated CouchDB-compatible endpoint below `/db`.

With an Android emulator already running, `npm run test:mobile:e2e:android:local`
configures the local SDK and JDK paths, installs the pinned UiAutomator2 driver
when needed, builds the E2E APK, and runs the Android Appium suite.
The runner also supports physical and network-connected ADB devices: it pins
Appium to the selected serial and uses `adb reverse` so the app can reach the
host-only test server at `127.0.0.1`. If more than one device is connected, set
`ONCE_ANDROID_UDID` to the serial shown by `adb devices`.

Before either channel is distributed to internal testers, run this checklist on
at least one physical Android device and one physical iPhone:

- Confirm the development name, icon, version, startup, safe areas, and both
  portrait and landscape layouts.
- Configure a fixture/source and authenticated sync URL, restart, and confirm
  both story state and the secure URL survive without appearing in app-private
  plaintext files or device logs.
- Open an original story and return, then open reader mode and close it with the
  platform Back/Done interaction.
- Disable connectivity, restart, and confirm cached stories and read/skip state
  remain usable; reconnect and confirm local and remote mutations converge.

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

The Firefox tests drive the panel as an ordinary browser tab, opened through a
helper (`tests/e2e/extensions/firefox-panel.js`). This is a deliberate
workaround for Firefox 153+: WebDriver may no longer navigate to
`moz-extension://` URLs — the classic `driver.get()` is rejected as "not allowed
in this context" and a BiDi `browsingContext.navigate` silently lands on
about:blank — and the panel's real `sidebar_action` surface is not automatable
because the revamped sidebar hosts it in a nested browsing context that
WebDriver/BiDi cannot address as a first-class target. Instead the helper
switches to the privileged chrome context and lets the browser itself open the
panel URL with the system principal (a navigation Firefox still permits), then
drives that normal content tab. This requires granting system access to the
geckodriver process via its `--allow-system-access` flag (wired up by the
helper's `systemAccessService()` and `Builder.setFirefoxService`). Note it must
be given to geckodriver, not to Firefox: geckodriver 0.36+ owns that flag and
rejects the Firefox arg `-remote-allow-system-access` when passed through
capabilities ("can't be set via capabilities"), which is why the older
capabilities form failed on macOS/Linux CI. The helper also hides the sidebar
that auto-opens on install, and "reloads" by closing and reopening the tab,
because WebDriver refresh is likewise rejected for `moz-extension://` pages.

```bash
# Windows outputs
npm run package:electron
npm run make:electron

# Dev-channel Windows outputs, installable next to a release build
npm run package:electron:dev
npm run make:electron:dev
```

Package and make commands stop a running packaged app from the same channel so
Windows can replace its output directory. Pass `--nokill` after npm's argument
separator to preserve it, for example
`npm run package:electron:dev -- --nokill`; the build will then fail if the
running app still locks an output file. npm 11 also accepts the shorthand
`npm run package:electron:dev --nokill`, though npm warns that shorthand will
stop working in its next major version.

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

Each unpacked or ZIP distribution has a profile keyed to its containing
directory. Copies extracted to different directories can run at the same time
without sharing Chromium state or the Once database. Launching the executable
from the same directory again retains the usual single-instance behavior and
opens a window in the running process. Moving a portable distribution gives it
a new profile. Squirrel-installed builds keep the channel's historical profile
path so application updates do not move or reset user data.

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
- `apps/mobile/dist`
- copied Capacitor web assets and native build directories
- `test-results`
- `web-ext-artifacts`

They are ignored by Git and can be recreated from the commands above.
