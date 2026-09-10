# Android GeckoView stability and extension management

The Android app shell remains a Capacitor WebView. Remote browsing uses a
GeckoView beside it. GeckoView remains pinned to 153.0.20260810162159; this work
does not change the Android SDK/Gradle upgrade requirement for newer engines.

## Ownership

- `GeckoEngine` owns the process-wide runtime and shared built-in installation
  readiness. Navigation waits for actual installation completion. A failed
  installation can be retried; a waiting surface operation has a 30-second
  deadline and is cancelled when its surface closes.
- `InAppBrowserSurfacePlugin` owns the activity's reading session, layout,
  visibility, navigation events, and trusted content-script bridge. Closed
  sessions are reopened on reload or navigation after a crash/process kill.
  Pending script calls fail on navigation, closure, process loss, or a
  ten-second response timeout. A stale port disconnect cannot cancel work on
  the replacement port. Scroll and back state reset when the surface closes.
- `GeckoExtensionManager` owns activity-scoped extension delegates, permission
  dialogs, and management operations. It restores the runtime's installed
  catalog, including disabled extensions, instead of assuming only built-ins.
  Catalog reads do not emit catalog-change events back into a refresh loop.
- `GeckoExtensionPages` owns separate sessions for extension tabs and popups.
  `tabs.create` returns a fresh unopened session for Gecko to open; action
  popups receive an opened session. `tabs.update` authorizes Gecko's own
  navigation rather than loading the same URL twice. Extension tabs can close
  themselves; the story-owned reading surface cannot be closed by an extension.
  Auxiliary pages have close/reload controls and a twelve-session limit.
- The bridge extension reconnects its background native-messaging port after
  activity loss. Closing a reading page does not discard that background port.
  Its built-in version advances so `ensureBuiltIn` replaces the previous code.

## User flow

On Android, Settings → Browser Extensions lists installed extensions. Users can
install from a Firefox Add-ons listing or choose a local XPI through Android's
document picker. AMO resolution requires an Android-compatible release. Local
XPIs are copied to a bounded temporary cache file (32 MiB maximum) and deleted
after installation finishes. Gecko verifies signatures and compatibility.

The native installation prompt shows the package identity, version, requested
permissions, origins, and data-collection permissions before approval. Cancelling
does not install. Private-browsing access is not granted. Updates and optional
permission requests use native permission prompts as well.

Each extension has enable/disable, its options page or action popup, a manual
update check, and removal with a confirmation that its data will be removed.
Built-ins can be disabled but are updated with Once and cannot be removed.
The trusted Once bridge is deliberately excluded from user management.
The three-dot button beside the reading address replaces the standalone reload
button. It opens a native browser sheet above GeckoView, with Back, Forward,
and Reload across the top. Extensions expands inline to show enabled extension
actions/options and Manage extensions. Go remains available while editing an
address. Back/Forward follow the native session's history availability.

## Boundaries

This is Firefox-for-Android extension hosting, not complete desktop Firefox
compatibility. Gecko validates manifests and APIs; installation alone does not
prove an extension's behavior. This work does not implement desktop-only APIs,
arbitrary extension storage sync, Firefox Account sync, a browser history or
bookmarks database, or a general Android downloads manager. Extension pages
are auxiliary sessions, not a full user-facing browser tab strip.

The existing synced filter-list/userscript bridge remains separate from bundled
uBlock/Violentmonkey storage. Its conservative filtering and small GM API are
unchanged. Third-party extension installations and their state stay local.
iOS retains WebKit content rules and userscripts; it cannot use this GeckoView
installation path.

## Validation

The mobile unit suite covers management, disabled entries, explicit removal,
installation errors/cancellation, settings-bridge reconnection, and the existing
surface/settings contracts. `GeckoRecoveryTest` uses the real engine and a local
HTTP fixture on the device. It closes the session before delivering crash/kill
callbacks, then verifies that reload restores both the page and its content
bridge across three cycles. This is deterministic recovery coverage, not a
measurement of spontaneous engine crashes or Android memory pressure.

Native test APK: `:app:assembleDevelopmentDebugAndroidTest`. Run only against
`com.zmarn.once.dev.test/androidx.test.runner.AndroidJUnitRunner`, with
`-e class com.zmarn.once.GeckoRecoveryTest`. The test rejects production targets.

On 2026-09-10, the Samsung phone running the separate Once Dev package passed
the recovery test on two successive builds (three recovery cycles per run;
8.617 seconds and 7.133 seconds). The final native build, all 62 mobile unit
tests, mobile TypeScript checks, targeted ESLint/Stylelint, structure, semantic
controls, line endings, and package boundaries passed.

Physical-device checks installed Dark Reader 4.9.130 from AMO and SponsorBlock
6.1.7 through Android's document picker using a signed XPI. The native permission
review, cancellation, disable/re-enable, manual update check, and persistence
across app restart were exercised. Dark Reader injected its styles into
`https://example.com/`; its popup displayed that actual tab and its enabled
state. SponsorBlock's first-run tab and full options page rendered. These checks
also exercised the reading toolbar's native menu and its Dark Reader action.
They do not establish live YouTube segment skipping or every API used by either add-on.
Removal reached its explicit confirmation on the phone. Automatic approval
review blocked the destructive confirmation, so the installed extension was
preserved; confirmed deletion has unit coverage but was not exercised live.

The existing Once Dev profile reported a CouchDB fetch failure during validation;
its sync configuration and data were preserved. The offline emulator was not
used. Production Once was not modified.

The subsequent browser-menu change was tested on `Pixel_7_API_36_AOSP` using
Once Dev. The emulator used ports 5556/5557 with user approval because a Windows
portproxy rule occupies port 5555; that host rule was preserved. The native
build and 63 mobile tests passed, as did targeted lint, CSS, structure, semantic
controls, package boundaries, and line-ending checks. Live checks verified the
three-dot/reload replacement, address editing's Go action, expandable extension
list, uBlock popup with current-page context, Manage extensions, Back/Forward
with correct enabled states, and Reload's start/finish navigation events.
Screenshots are in `artifacts/gecko-work/menu-collapsed.png` and
`artifacts/gecko-work/menu-expanded.png`.

Extension cards use the shared `--sp-*` spacing tokens (16px padding, 12px
between cards), with smaller version/status text and 20px title icons. Gecko
decodes each extension's own icon to a small cached PNG, shared by settings and
the native browser menu. Missing images use a puzzle fallback. The menu also
shows icons for Extensions and Manage extensions. Emulator screenshots are in
`artifacts/gecko-work/extensions-styled.png` and `artifacts/gecko-work/menu-icons.png`;
the native build, 63 mobile tests, and lint/structural checks passed.
