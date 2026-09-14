# Android GeckoView stability and extension management

The Android app shell remains a Capacitor WebView. Remote browsing uses a
GeckoView beside it. Since 2026-09-10 the toolchain (AGP 9.4, Gradle 9.6, platform
37.1) tracks the newest GeckoView release; `variables.gradle` carries the version.

## Ownership

- `GeckoEngine` owns the process-wide runtime and shared built-in installation
  readiness. It is initialized on the first reading/extension operation, not
  while displaying the story list. Initial navigation waits for actual installation completion. A failed
  installation can be retried; a waiting surface operation has a 30-second
  deadline and is cancelled when its surface closes.
- `InAppBrowserSurfacePlugin` owns the activity's reading session, layout,
  visibility, navigation events, and trusted content-script bridge. Lost or
  unresponsive reading sessions are replaced and their views reattached.
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
  Content ports disconnect on pagehide and reconnect on pageshow, including
  back/forward-cache restoration; their media listeners are cleaned up.
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

### Navigation and memory resilience (2026-09-14)

The emulator baseline, repeated fault-test results, public-site observations and
known platform limitation are recorded in
[`artifacts/gecko-stability-2026-09-14/REPORT.md`](../../artifacts/gecko-stability-2026-09-14/REPORT.md).
The physical Samsung comparison and RAM attribution are recorded in
[`artifacts/gecko-samsung-2026-09-14/REPORT.md`](../../artifacts/gecko-samsung-2026-09-14/REPORT.md)
and its accompanying `MEMORY.md`.
The authorized temporary `-gpu swangle` comparison is in
[`artifacts/gecko-swangle-2026-09-14/REPORT.md`](../../artifacts/gecko-swangle-2026-09-14/REPORT.md).
On this Windows headless launch it retained the legacy SwiftShader GLES renderer
and reproduced the minimal Gecko GPU timeout; it is not a demonstrated platform fix.

The reading surface has a native 30-second navigation deadline and a 12-second
response deadline for foreground liveness probes (one probe at a time, normally
five seconds apart). Backgrounding suspends monitoring; foregrounding gives an
incomplete navigation a fresh deadline. A paint plus a responsive interactive or
complete document, or a responsive restored history document, completes readiness
and clears the shell/refresh loading state. A stalled image must not cause a usable
page to be killed. Network PageStop alone does not complete web navigation. A
complete responsive document without paint offers Retry after ten seconds of
confirmed blankness; late content clears that warning without a process reset.
History callbacks from the initial blank session or a superseded document are not
forwarded while waiting for the requested document to start. An empty initial
history URL otherwise makes the real shell clear its address and close the surface.
The shell also tracks an explicit pending destination: old native events cannot
replace it before its own PageStart arrives, even while the navigation ID still
belongs to the previous page.
`onSlowScript` records the report and returns STOP, which was already Gecko's
default; the native watchdog provides the additional recovery behavior.

Recovery preserves the latest explicit destination, discards stale session
callbacks, and allows one automatic retry. A confirmed healthy document resets
the consecutive-failure counter, so recovery remains available after a previous
successful recovery. A repeated failure without that confirmation ends in a native
Retry page screen rather than an unbounded reload loop. Retry and subsequent
navigation do not re-query the extension catalog after initialization. Pending
evaluations are capped at 32 and their timeout callbacks are removed on settlement.
Initialization waiters are capped at 16; superseded navigation waiters settle.

GeckoView 155 has no public session-to-PID API. Last-resort recovery resets the
app's initialized Gecko tab-process pool, matching the app UID, exact Gecko tab
service naming pattern, and Web Content thread. This may also stop auxiliary
extension pages sharing that pool. It never intentionally targets the parent,
GPU, crash helper, another UID, or an uninitialized spare service. Replacement
creation waits for OS process exit and queued Gecko teardown. Auxiliary pages
retain native Close/Reload controls and reattach their view when reopened.

Actual memory-pressure callbacks release hidden reading sessions and hidden
auxiliary pages. One saved Gecko session state is retained for hidden-page
restoration. Active background media is exempt; ordinary UI_HIDDEN alone is not
treated as memory pressure. Hidden pages use default priority instead of retaining
the foreground priority hint. Fission remains disabled to avoid subframe process
fan-out; this does not imply one private process per session.

`GeckoBaselineTest` compares five local loads for bare Gecko, bridge-only,
bridge+uBlock, full bundled extensions, and Android WebView. The bare Gecko
endpoint is contentful paint; bridge modes require DOM evaluation and WebView
requires a document result, so these numbers are not identical render metrics.
The modes share a warmed process/runtime and are not cold-profile benchmarks.
`GeckoSiteBaselineTest` records public-site observations separately; its JUnit
completion does not mean every external site succeeded.
`GeckoReadingJourneyTest` exercises the real shell address form and coordinator,
repeated Android Back/reopen, and visible connection failure followed by a working
address. Direct-plugin tests alone do not establish this normal browsing path.
The production reproduction, failing regression and correction are recorded in
[`artifacts/gecko-real-navigation-2026-09-14/README.md`](../../artifacts/gecko-real-navigation-2026-09-14/README.md).

`GeckoResilienceTest` exercises actual process death, SIGSTOP of initialized
renderers, a never-answering HTTP server, infinite JavaScript, latest-destination
recovery, native Retry, stale callbacks, back/redirect handling, compositor pixels,
extension reattachment, and repeated hidden-page release with a 192 MiB JavaScript
allocation. Pressure callbacks in that test are injected. The Samsung run also
recorded actual lmkd reclaim and content-process death during these allocations;
closing a session does not guarantee immediate process-RAM release. Use an isolated
test profile: the emulator development app or the separately installed
`com.zmarn.once.geckotest.dev` phone app, never a user's production/development profile.

Scope limit: a dead Android graphics service or a blocked application UI/render
thread cannot be made recoverable by a watchdog on that same UI thread. The
September 14 public-site experiment encountered GPU IPC timeouts, a spinning
Android RenderThread, and eventually DeadSystemException in the emulator's
SwiftShader/Lavapipe configuration. Preserve that as a separate platform failure;
do not interpret it as proof of an extension fetch storm or hide it with app prefs.

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
