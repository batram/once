# Development

Run all commands from the repository root. The project is an npm workspace; one
root install supplies every app and package. The platform design and package
rules are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Prerequisites

- Node.js 24 (`.nvmrc`) and npm
- Firefox for Firefox extension testing; Chrome 120+ for Chrome extension testing
- Windows for Electron packaging and end-to-end tests
- Android Studio 2025.2.1+, Android SDK platform 37.1 with build-tools 37,
  Android Gradle plugin 9 and JDK 21 for Android (pinned in
  `apps/mobile/android/variables.gradle`)
- macOS with Xcode 26+ for iOS

```bash
npm ci
```

Use `npm install` only when intentionally changing dependencies. Browser tests
install their Chromium automatically; Linux CI also runs `npm run test:setup:ci`.

Application builds consume the compiled packages (`npm run build:packages`); the
app scripts build them first. Run `npm run clean:packages` if package output
goes stale.

## Validate

```bash
npm run check
```

`npm run check` lints, type-checks, validates structure, dead code and package
boundaries, and makes development builds of every target. It runs no test
suites; see [Test harness](#test-harness).

The pre-commit hook runs staged-file checks; the pre-push hook builds packages
and runs static checks and the unit suite against the pushed commit. On macOS two
unit tests compile Swift harnesses with `xcrun --sdk macosx swiftc`; don't work
around SDK mismatches by setting `SDKROOT` or skipping them.

## Styling

Read [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) before changing CSS; tokens are in
[design-tokens.md](design-tokens.md). The style checks inside `npm run check` can
run alone:

```bash
npm run lint:css
npm run check:css-debt
npm run check:cascade
npm run check:semantic-controls
npm run measure -- "<selector>"
```

Rendered geometry and screenshot baselines are covered by
`npm run test:design-system` and its `:electron` and `:mobile` variants.

## Browser extensions

```bash
npm run build:extensions        # production: build:firefox, build:chrome
npm run build:extensions:dev    # development, inline source maps
```

Output goes to `apps/{firefox,chrome}-extension/dist/{dev,release}`. Builds are
one-shot (no watch mode). Dev builds are named "Once Sidepanel (dev)" with the
dev icon, and the settings panel shows a build identifier next to the version.

- **Firefox:** `about:debugging` → This Firefox → Load Temporary Add-on →
  `apps/firefox-extension/dist/dev/manifest.json`, or
  `npx web-ext run --source-dir ./apps/firefox-extension/dist/dev`.
- **Chrome:** `chrome://extensions` → Developer mode → Load unpacked →
  `apps/chrome-extension/dist/dev`.

Package and sign Firefox:

```bash
npm run build:firefox
npm run package:firefox
npx web-ext sign --source-dir ./apps/firefox-extension/dist/release --channel unlisted --api-key "<jwt issuer>" --api-secret "<jwt secret>"
```

## Electron

```bash
npm run start:electron          # dev-channel run
npm run build:electron
npm run test:electron           # type-check, shared app and integration tests
npm run test:electron:e2e       # package, then Playwright against the compiled app

npm run package:electron        # unpacked release-channel app
npm run make:electron           # plus Squirrel installer and ZIP
npm run package:electron:dev    # dev channel ("Once Dev"), installs next to release
npm run make:electron:dev
```

Output is in `apps/electron/out` (dev: `apps/electron/out/dev`), unsigned.
Packaging stops a running app of the same channel; pass `-- --nokill` to keep
it. `ONCE_BUILD_CHANNEL` overrides the channel of any command. Each unpacked or
ZIP copy gets a profile keyed to its directory; installed builds keep the
channel's normal profile. On Windows, packaging from a restricted sandbox can
fail with `EPERM`; retry under the normal user before deleting anything.

Environment switches, all off by default:

- `ONCE_ELECTRON_EXTENSIONS`, `ONCE_ADDONS`: PATH-style lists of unpacked
  WebExtensions and add-on packages under development (unpackaged runs only;
  add-ons reload on change, see [ADDONS.md](ADDONS.md)).
- `ONCE_ELECTRON_EXTENSION_LOG=1`: print every extension console line.
- `ONCE_ELECTRON_TEST_USER_DATA=<dir>`: use that directory as the profile.
- `ONCE_ELECTRON_REMOTE_DEBUGGING=1`: open CDP on the channel's port (below).
- `ONCE_ELECTRON_E2E_INTERACTIVE=1`: run the Playwright suite headed;
  `ONCE_ELECTRON_E2E_ATTACH_LOGS=1` keeps every test's app log.
- `ONCE_TEST_AMO_EXTENSIONS=1`: enable the live Mozilla Add-ons test;
  `ONCE_PDF_TEST_DARK_READER=<dir>` adds Dark Reader to the PDF viewer spec.

### DevTools ports

| Port | What listens |
| --- | --- |
| 9223 | Packaged release app started with `--remote-debugging-port=9223` |
| 9224 | The Android WebView through `adb forward` |
| 9225 | A dev-channel run with `ONCE_ELECTRON_REMOTE_DEBUGGING=1` |

DevTools MCP servers read their endpoint once at start; reload them after
changing it.

### macOS signing

Packaging signs with the first "Apple Development" identity in the Keychain
(`ONCE_MACOS_SIGN_IDENTITY` picks another, `-` forces ad-hoc). Answer the first
Keychain prompt with "Always Allow". Self-signed and ad-hoc builds get a new
signature per package, so `safeStorage` loses its Keychain key and the sync URL
and tokens are stored unencrypted until a stable identity is used or the stale
`<app name> Safe Storage` item is deleted.

### Updates

Installed release-channel Windows builds update from the `batram/once` GitHub
Releases feed via `update.electronjs.org` (Squirrel.Windows). Each release needs
a `vX.Y.Z` tag with `RELEASES`, `*-full.nupkg` and the setup `.exe`;
`verify:release-artifacts` checks this. Other builds offer **Check latest
release** instead. `ONCE_ELECTRON_DISABLE_NETWORK_FETCH=1` disables both.
Windows artifacts are not code-signed yet.

## Capacitor mobile apps

The native projects are committed under `apps/mobile/android` and
`apps/mobile/ios`; don't recreate them with `cap add`. The wrapper builds
packages and runs `cap sync`.

```bash
npm run mobile -- doctor android                       # also: ios
npm run mobile -- web --channel dev                    # web bundle only; also: release
npm run mobile -- run android --channel dev            # also: ios
npm run mobile -- open android --channel dev           # also: ios
npm run mobile -- serve android --channel dev          # live reload; also: ios
npm run mobile -- package android --channel dev        # internal QA artifacts; also: ios
npm run package:mobile:android                         # unsigned production AAB
npm run package:mobile:ios                             # unsigned Once.xcarchive
npm run deploy:mobile:android
npm run deploy:mobile:ios
```

Android has two engines (`docs/plans/once-lite-plan.md`): the GeckoView app
and Once Lite on the system WebView. `--engine lite` (or
`ONCE_MOBILE_ENGINE=lite`) selects Lite for every `mobile` command, the e2e
runners and the `*:lite` scripts; the default is `gecko`. iOS has one engine.

| App | Channel | Package | Name | Gradle flavour | Debug APK |
| --- | --- | --- | --- | --- | --- |
| GeckoView | release | `com.zmarn.once` | Once | `geckoProduction` | `apk/geckoProduction/debug/app-gecko-production-debug.apk` |
| GeckoView | dev | `com.zmarn.once.dev` | Once Dev | `geckoDevelopment` | `apk/geckoDevelopment/debug/app-gecko-development-debug.apk` |
| Once Lite | release | `com.zmarn.once.lite` | Once Lite | `liteProduction` | `apk/liteProduction/debug/app-lite-production-debug.apk` |
| Once Lite | dev | `com.zmarn.once.lite.dev` | Once Lite Dev | `liteDevelopment` | `apk/liteDevelopment/debug/app-lite-development-debug.apk` |

iOS release identity is `com.zmarn.once` / "Once"; dev is `com.zmarn.once.dev`
/ "Once Dev". Set `ONCE_BUILD_NUMBER` to an increasing integer in CI.
Production artifacts stop before store signing.

```bash
npm run run:mobile:android:lite                        # Once Lite Dev on a device or emulator
npm run package:mobile:android:lite                    # unsigned Once Lite production AAB
npm run deploy:mobile:android:lite                     # replaces com.zmarn.once.lite on the paired phone
npm run test:mobile:e2e:android:lite:local             # the smoke suite against Once Lite
npm run test:mobile:e2e:android:lite:tier2:local       # the smoke suite with DevTools forced off (Tier 2)
npm run inspect:mobile:android:lite
cd apps/mobile/android && ./gradlew lintLiteDevelopmentDebug testLiteDevelopmentDebugUnitTest
ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedLiteDevelopmentDebugAndroidTest -PonceDeployAbis=arm64-v8a  # LiteDevToolsTest, LiteExtensionEngineTest, LiteTier2Test
npm run test:mobile:e2e:android:lite:extensions:local  # the Lite extension acceptance suite
```

The Gecko sources live in `apps/mobile/android/app/src/gecko`, Lite's in
`src/lite` (its DevTools client under `devtools/`, the extension runtime's
Java half under `lite/`: `LiteExtensionEngine` with the broker WebView,
files, packages, cookies, the DevTools fan-out and extension pages), and
`src/main` holds what both share; `src/main` and `src/lite` import nothing
from `org.mozilla`. Once Lite keeps `WebView.setWebContentsDebuggingEnabled(true)`
on in every build: its extension runtime drives Chromium through the app's own
DevTools socket, and Settings shows Allow Web Inspector as on and locked there.
The broker (`apps/mobile/src/lite`, built into `lite-runtime.html` and the
`lite-*.js` bundles with the web assets) and Java speak the protocol in
`docs/plans/once-lite-broker-protocol.md`; the bundled uBlock Origin and
Violentmonkey come from `vendor/extensions` (the plain upstream copies, under
`assets/extensions/`), which `scripts/fetch-extensions.js` provides for both
engines.

Without a usable DevTools connection Lite runs in Tier 2 (the plan's degraded
mode, see "Once Lite (WebView)" in `docs/EXTENSION_COMPATIBILITY.md`): Java
enforces uBlock Origin Lite's default rulesets and the synced lists from
`shouldInterceptRequest` and injects cosmetics and userscripts at document
start, with no full extension loaded. To test it on a working WebView,
switch DevTools off for debuggable builds before the runtime starts (the app
reads the property once per runtime start; release builds ignore it):

```bash
adb -s emulator-5554 shell setprop debug.once.lite.devtools off   # then force-stop and reopen Once Lite Dev
adb -s emulator-5554 shell setprop debug.once.lite.devtools ""    # back to DevTools (Tier 1)
```

`npm run test:mobile:e2e:android:lite:tier2:local` sets and clears it around
the smoke suite, and `LiteTier2Test` does the same around its in-process
runtime restart. Logcat's `OnceLite` tag reports the compiled rule counts
(`Tier 2 rules {...}`); the static rulesets are compiled once per install and
cached under `files/lite-extensions/tier2-rules/`. The extension acceptance
suite (`test:mobile:e2e:android:lite:extensions:local`) is Tier 1 only: it
drives uBlock Origin's and Violentmonkey's own pages, which Tier 2 does not
load.

`deploy:mobile:android` builds the release-channel production flavor with the
local debug signature, for the device's ABI only, and replaces `com.zmarn.once`
with `adb install -r` (app data is kept). Pair the phone under Wireless debugging
first; the address comes from `ONCE_ANDROID_WIRELESS_ADDRESS`, then
`adb mdns services`, then `.env.android.local` (copy `.env.android.example`).
`-- --target <serial>` picks a device. Optional settings, in the environment or
`.env.android.local`:

| Setting | Default | Alternatives |
| --- | --- | --- |
| `ONCE_ANDROID_DEPLOY_ABIS` | `auto` | `all`, `arm64-v8a`, `x86_64`, `arm64-v8a,x86_64` |
| `ONCE_ANDROID_INSTALL_MODE` | `push` | `streaming`, `fastdeploy` (experimental, usually slower) |
| `ONCE_ANDROID_GRADLE_DAEMON` | `true` | `false` |
| `ONCE_ANDROID_SERIAL` | wireless discovery | an explicit ADB serial |
| `ONCE_ANDROID_ADB` | SDK `platform-tools/adb` | another adb for the install step |

`deploy:mobile:ios` builds the `Once` scheme in Release with release-channel
content and installs it with `xcrun devicectl` on `ONCE_IOS_DEVICE`, replacing
`com.zmarn.once`. iOS commands read `.env.ios.local` (copy `.env.ios.example`):
`ONCE_IOS_DEVICE` from `npx cap run ios --list` in `apps/mobile`, and
`DEVELOPER_DIR` if xcode-select points at the Command Line Tools.

### Debug a running release build

- **Settings → Error log → Show console messages** lists console errors and
  warnings, uncaught errors and unhandled rejections (the last 300).
- **Allow Web Inspector**, below it, lets a trusted computer attach to the
  running app: Safari → Develop on iOS, `chrome://inspect` for the Android
  shell and Once Lite's pages, `about:debugging` in Firefox for GeckoView
  pages. Debug builds, and every Once Lite build, are always inspectable.

`npm run inspect:ios --` reaches the app on an iPhone from the command line,
over USB or Wi-Fi, through
[pymobiledevice3](https://github.com/doronz88/pymobiledevice3)'s CDP bridge
(`pip install pymobiledevice3` in a venv; found via `$PYMOBILEDEVICE3`,
`~/.local/share/pymobiledevice3/bin` or `PATH`). No sudo is needed; the phone
must be unlocked, trust this Mac and have Web Inspector on (Settings → Apps →
Safari → Advanced). USB is used when plugged in, otherwise the Wi-Fi tunnel
macOS keeps to a paired phone (it shows in Xcode → Devices with a network icon);
`--transport usb|wifi` forces one. While a Wi-Fi bridge runs, Xcode can briefly
lose the phone; `stop` releases it.

```bash
npm run inspect:ios -- targets
npm run inspect:ios -- eval "document.body.dataset.buildChannel"
npm run inspect:ios -- console --levels error,warning --eval "location.reload()"
npm run inspect:ios -- log
npm run inspect:ios -- stop
```

Pass `--target "Once Dev"` when both apps are inspectable. Each page takes one
connection, so a new command takes over from a running `console`. Only the
foreground app answers, and a new bridge lists a suspended app only after it
has been brought to the front.

### Inspect the Android WebView

Dev builds and the deployed `productionDebug` APK are debuggable. With the app
open, find the serial with `adb devices -l`, open `chrome://inspect/#devices`
in Chrome and inspect **Once** or **Once Dev**. For a raw CDP endpoint, forward
the app's socket (its PID changes on every restart):

```bash
adb -s <serial> shell cat /proc/net/unix | grep webview_devtools_remote
adb -s <serial> forward tcp:9224 localabstract:webview_devtools_remote_<pid>
curl http://127.0.0.1:9224/json/list
adb -s <serial> forward --remove tcp:9224
```

Never enable WebView debugging in a store-signed build.

### Mobile tests

```bash
npm run test:mobile                       # adapter checks
npm run test:mobile:web                   # phone-sized browser suite
npm run test:mobile:e2e:android           # Appium; install the pinned driver from CI first
npm run test:mobile:e2e:ios
npm run test:mobile:e2e:ios:extension-management -- <simulator UUID>  # offline install/update/rollback regressions
npm run test:mobile:e2e:ios:extension-compat -- <simulator UUID>  # installs popular AMO add-ons in a throwaway host app
npm run test:mobile:e2e:android:local     # sets up SDK/JDK/driver, builds and runs
npm run inspect:mobile:android            # manual visual pass with a fixture feed
npm run inspect:mobile:ios
```

The runners rebuild the dev app when it is missing, stale or not built with
`--e2e`; `ONCE_MOBILE_APP` tests a given bundle. Android APKs carry only the
device's ABI, and the runner frees emulator `/data` space when needed (if it
still can't, raise the emulator's storage and cold boot with Wipe Data).
Physical and network ADB devices work through `adb reverse`; with several
devices, set `ONCE_ANDROID_UDID`. iOS honours `ONCE_MOBILE_DEVICE`,
`ONCE_IOS_VERSION` and `ONCE_IOS_UDID`. `ONCE_MOBILE_TEST_PORT` and
`ONCE_MOBILE_TEST_DATA_DIR` pin the test server's port and keep its database.
The visual pass keeps running to serve its fixtures; press Ctrl-C when done.

The test server's `express-pouchdb@4.2.0` needs the scoped `uuid@3.4.0`
override in the root `package.json`.

Before distributing either channel to testers, check on a physical Android
device and iPhone:

- Name, icon, version, startup, safe areas, portrait and landscape layouts.
- A source and authenticated sync URL survive a restart without appearing in
  plaintext files or device logs.
- Opening a story and reader mode, and closing them with Back/Done.
- Offline restart keeps cached stories and read/skip state; changes converge
  after reconnecting.

## Test harness

```bash
npm test                                   # unit and integration tests, no network
npm run test:collectors                    # collector/parser fixtures
npm run test:extensions                    # build and smoke-test Chrome and Firefox
npm run test:firefox                       # already-built Firefox extension only
npm run test:live:collectors               # opt-in live probes, one request per source
npm run refresh:fixtures:collectors -- reddit_json
```

Tests never contact story sources; they use `tests/fixtures/collectors`. Live
probes are never part of CI. For deterministic built-app screenshots see
[VISUAL_COMPARISON.md](VISUAL_COMPARISON.md).

On Windows, Electron E2E, story-debug, design-system Electron, native-rendering
and Firefox runs happen on a private desktop through `scripts/run-hidden.js`,
which requires `~/tools/agent-scripts/Invoke-OnHiddenDesktop.ps1`. Logs go to
`artifacts/hidden-tests/` and `test-results/firefox-logs/`; `run-hidden.js`
echoes the log while the run goes. Hidden runs set `ONCE_HIDDEN_DESKTOP=1`:
the Electron harness then launches with `--disable-gpu`, because the GPU
process crash-loops there and a canvas drawn meanwhile reads back blank (OCR
fixtures), and the `@interactive` specs run too, since no window can reach
the visible desktop. Use
`npm run test:electron:e2e:run -- <spec-path>` against an existing build, or
`node scripts/run-hidden.js --visible node_modules/@playwright/test/cli.js test --config tests/e2e/electron/playwright.config.js`
to watch. Firefox tests use a temporary profile and open the panel as a normal
tab through `tests/e2e/extensions/firefox-panel.js`, because Firefox 153+
WebDriver can't navigate to `moz-extension://` URLs.

Renderer changes, including the add-on and PDF sandboxes
(`packages/ui-web/src/addons/sandboxRuntime.ts`,
`packages/platform-web/src/pdfSandboxRuntime.ts`), need a repackage before
rerunning E2E.

CI runs Electron E2E in six shards; reproduce one with
`npm run test:electron:e2e -- --shard=1/6`. `ONCE_RENDERING_ITERATION` (`0`–`2`)
selects one native-rendering calibration pair; without it all three run.

## Generated files

These are build or test outputs, ignored by Git; don't edit them:
`packages/*/dist`, `apps/*-extension/dist`, `apps/electron/.webpack`,
`apps/electron/out`, `apps/mobile/dist`, copied Capacitor web assets and native
build directories, `test-results`, `web-ext-artifacts`.

### Once Lite runtime performance probes

`LiteRuntimePerformanceTest#cspBodyTransportBenchmark` alternates the former
broker-body transfer algorithm and the native CDP path on the same local CSP
fixtures, after warming both paths. It records three samples per path for
64 KiB, 512 KiB and 2 MiB bodies. Use the `navigationMs` values from its
`RESULTS` log; `ms` includes instrumentation overhead. The native path must
send zero body characters through the broker channel. The same suite covers
extension-page reload, renderer termination, and watchdog recovery.

For a host-JVM DNR allocation/throughput probe, first build the Lite JVM tests
(to resolve RE2/J), fetch the extension bundles, and set `JAVA_HOME` to the
JDK used for the Android build. Then run:

```sh
node scripts/benchmark-lite-dnr.js
```

The optional first argument selects another checkout's Java sources for a
comparison; the harness and ruleset files always come from this checkout.
Results are JSON with five samples after warmup, for roughly 100-character
and 32 KB URLs. Allocation uses the host JVM's thread allocation counter.
These are microbenchmarks, not physical-device memory or battery measurements.
