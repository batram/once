# Extension compatibility and recovery

Once add-ons extend the story UI and collectors. Browser extensions run in the
embedded browsing surface. Their configuration and runtime ownership are separate.

| Surface | Once add-ons | Browser filtering and userscripts |
| --- | --- | --- |
| Electron | Declarative contributions and sandboxed scripts | Bundled extensions plus user-installed Firefox MV2 and MV3 XPIs; see the management and API limits below |
| Android | Declarative contributions and sandboxed scripts in the app shell | GeckoView built-ins and user-installed signed Firefox extensions; synced additions handled by Once's bridge |
| Android Lite | The same app shell | Bundled uBlock Origin and Violentmonkey plus user-installed Firefox XPIs in Once's own runtime over the system WebView; see [Once Lite (WebView)](#once-lite-webview) |
| iOS | Shared add-on implementation; device validation remains required | Bundled WebKit-adapted extensions plus user-installed Firefox XPIs through `WKWebExtensionController`, with supplemental content rules and the small GM shim; see [iOS](#installing-and-managing-firefox-extensions-on-ios) |
| Chrome side panel | Declarative contributions and sandboxed scripts | Browser-native extensions remain the user's browser configuration |
| Firefox side panel | Declarative contributions and sandboxed scripts in the packaged MV2 extension; no hosting setup | Browser-native extensions remain the user's browser configuration |

## Browser settings ownership

Electron applies settings independently and serially for each extension. Pending
obsolete applications are skipped; an obsolete result cannot replace the shell's
current document. The toolbar's extension tooltip reports applying, applied, or
failed, with the failure detail. Saved configuration and successful application
are different states.

Once records the selection of each filter-list URL before managing it. Removing
the subscription restores that selection. Independently selected lists stay in
place. Existing subscriptions from before this ownership record was introduced
cannot be retrospectively identified as Once imports; their first observed
selection becomes the baseline.

Violentmonkey storage changes trigger a debounced reconciliation without waiting
for another settings edit. A marker in extension storage and the reconciliation
record distinguish deleting the last script from storage reset. Legacy records
without that marker retain the conservative storage-loss behavior for their first
handoff. Simultaneous dashboard and synced source edits still use the documented
synced-source precedence; this is not a multi-version script merge system.

## Scriptlets on Electron

Network filters alone do not remove YouTube's video ads; uBlock strips them
with scriptlets that must run in the page's own world before its scripts.
uBlock's Firefox build injects them from its content script world by
inserting a `<script>` element, and registers them per hostname for later
documents. Two host behaviours make that work the way it does in Firefox:

- Every content-script world declares its own (empty) Content Security
  Policy, the way Chrome treats MV2 content scripts. Chromium checks an
  inserted script against the inserting world's policy, so the page's CSP
  and its Trusted Types requirement do not apply. Without this, YouTube's
  headers silently block both the inline injection and the blob fallback.
- A document's `onResponseStarted` is raised while its headers are still
  held and is awaited before the response continues, so that a
  `contentScripts.register` made from that listener is in place before the
  renderer creates the document. Firefox's parent process orders these the
  same way; Electron's own event would arrive after the document exists,
  and the first visit to a hostname in a session would then be unfiltered.

## Supplemental mobile filter lists

The portable subset consists of ordinary URL patterns (including anchors and
wildcards), ordinary network exceptions, and simple global cosmetic selectors.
Rules with options, domain-scoped cosmetics, regular-expression rules, scriptlets,
or procedural selectors are skipped as whole rules. A rule is never made broader
by stripping its constraints. Console diagnostics report supported and skipped
rule counts.

An unsupported network exception or `badfilter` directive means the parser cannot
safely preserve that list's network behavior: its supplemental blocking rules are
withheld. Cosmetic exceptions likewise withhold the affected list's cosmetics.
On iOS the exporter receives the combined fetched text, so this conservative
decision applies to that combined input. This deliberately trades filtering
coverage for avoiding incorrect blocking. Android's bundled uBlock configuration
continues independently with its full extension behavior.

Android serializes settings generations and discards a superseded download before
committing it. Failed downloads keep the previously applied rules. Script and CSS
registrations are prepared before their predecessors are removed; a failed new
registration is cleaned up. Changes to content scripts affect future documents.

Android registers the supplemental blocking listener only while effective network
rules exist. Domain-anchored rules use hostname buckets; generic patterns retain
a linear fallback. On iOS, download/export work runs off the main actor, equal
selections and downloaded text are reused for one hour, and compiled rule lists
are cached by content hash (four recent identifiers). An empty list clears the
installed rules; failed compilation preserves the working rules.

The iOS host loads bundled uBlock Origin Lite, Dark Reader, SponsorBlock and
Violentmonkey contexts, then the user's installed packages. It awaits uBO
background readiness before navigation; the other backgrounds wake through
WebKit events as needed. The bundles are adapted and pinned at build time;
installed packages are adapted on the device as described under
[iOS](#installing-and-managing-firefox-extensions-on-ios). The host needs
iOS 18.4 or later; the bundled uBO Lite release requires iOS 18.6 or later.

The portable examples live in `tests/fixtures/extensions/portable-filters.json`.
Node tests execute the actual Android parser and bridge. Those checks and mobile
web tests do not establish native iOS behavior; WebKit compilation and the shared
add-on sandbox require separate Apple-device or simulator validation. The
[performance follow-up](benchmarks/mobile-extension-improvements.md) records the
physical iPhone content-rule checks and simulator bundled-extension behavior
checks completed for these changes; it does not validate the shared add-on sandbox.

## Author and maintenance references

- [Once add-on API and management](ADDONS.md)
- [Reliability implementation plan and evidence](plans/extension-reliability-plan.md)
- [Mozilla blocking request API](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/webRequest/onBeforeRequest)
- [Apple content-blocker documentation](https://developer.apple.com/documentation/safariservices/creating-a-content-blocker)

Bundled browser-extension updates must keep the bundle list explicit and rerun packaged
tests for extension pages, scripts, and settings adapters against the pinned
bundles. A hash-pinned archive and a passing parser unit test do not establish
runtime compatibility on their own.

## Installing and managing Firefox extensions on Electron

Settings → Browser Extensions lists installed extensions, including disabled entries.
Install extension accepts a Mozilla Firefox Add-ons page URL, one of its XPI
download links, or a local XPI/ZIP. A direct XPI link is verified against
Mozilla's listing for the id the package declares, and must be the file that
listing currently publishes.

The Add-ons site itself installs into Once when browsed in a tab. AMO chooses
its button from the browser named in its server-rendered state and from the
presence of `navigator.mozAddonManager`; the tab preload rewrites that state to
name Firefox before AMO's bundle boots and provides an add-on manager backed by
the extension manager (`extensions/amoBridge.ts`, `extensions/AmoHandlers.ts`),
so the site renders its own "Add to Firefox" button, relabelled "Add to Once",
and its own installed, enabled and Remove states. Clicking it downloads the
package, verifies it, and asks for confirmation in a native dialog that lists
the requested access before anything is installed; Remove asks the same way.
The request header is not changed. Clicking an XPI download link anywhere in a
tab goes through the same review instead of saving a file. If AMO changes its
state format the page falls back to its "Download Firefox" rendering, whose
"Download file" link still installs through the download fallback.
Review shows the extension identity, version, declared permissions, source, and
compatibility limitations before installation. Mozilla downloads are checked against
the listing's SHA-256 hash and GUID. Local packages are not cryptographically
signature-verified and are labelled accordingly. Archives have compressed/expanded
size limits, entry-count limits, and path validation before extraction.

The extensions button beside the address bar opens a panel listing every
installed extension with its action, options and enable controls. An action
can be pinned there, which places its button, badge and popup in the toolbar
itself; pins are kept per device in the shell window. A disabled extension
keeps its pin but its button is inert; a removed one disappears from the bar.

An extension's detail page offers enable/disable, its own options page (or popup
page when it has no options page), sync selection, and removal. Bundled extensions
can be disabled; updates to those bundles still arrive with Once. Installing a new
version preserves the enabled state and storage. Failed activation restores the
previous version. Installation, enabled state, and runtime status are local to the
device; syncing settings does not install or activate executable code elsewhere.
Reload existing pages after enabling or disabling: scripts already executing in a
document cannot be comprehensively undone. Removal keeps extension storage for a
later reinstall; obsolete extracted packages are pruned after catalog persistence.

### Selected settings sync

Choose settings to sync presents the keys in each extension's `storage.local` and
`storage.sync` areas. Both areas persist locally, independently. Neither area is
replicated by default. Only checked keys enter the `browser_extension_sync` settings
document, which uses Once's existing CouchDB replication. This is Once sync, not
Mozilla account sync. A key may contain multiple preferences, so the unit of
selection is a top-level storage key, not an inferred preference inside its value.

Changes made in extension pages are observed and selected values are saved back to
the document. Incoming changes raise both `storage.onChanged` and area-specific
`onChanged` events. A selected key absent from the incoming values is deleted;
unselected local keys are untouched. Deselecting a key removes its value from the
current sync document, but cannot erase historical CouchDB revisions or backups.
Local document patches are serialized; concurrent cross-device edits use the
existing CouchDB document conflict behavior. Cookies, IndexedDB, DOM localStorage,
extension files, and host permissions are outside this feature.

### Electron API coverage and limits

| Feature | Current behavior |
| --- | --- |
| Manifest formats | Firefox Manifest V2 and V3 with an explicit Gecko ID. V3 `action`, `host_permissions`, object-form `web_accessible_resources` (the `matches` restriction is not enforced) and `background.type: "module"` are read; `optional_host_permissions` and `content_security_policy` are ignored |
| Background scripts/pages | Hosted in separate persistent extension sessions; nonpersistent backgrounds remain resident. A V3 `background.service_worker` runs as an event-page script, as in Firefox, so worker-only globals such as `importScripts` are unavailable; `background.scripts` wins when both are declared |
| Content scripts | Manifest and dynamic `contentScripts.register`/`scripting.registerContentScripts`; match/exclude patterns, frames, run phases, and MAIN/ISOLATED worlds. `scripting.executeScript`/`insertCSS`/`removeCSS` with `files`, `func`+`args` or `css`; V3 registrations do not persist across sessions. Injected CSS is always author-origin because Electron cannot remove a user-origin sheet again, so `cssOrigin: "user"` is accepted but not honored |
| Messaging | Internal runtime/tab messaging and ports; external extension-to-extension import is not implemented |
| Storage | Separate persistent local/sync areas, changes and byte counts; Once sync is opt-in per key |
| Toolbar/options | Popups, options pages, click events, titles and badges through `browserAction` and its V3 alias `action`; dynamic icon updates remain limited |
| Browser requests | Existing blocking request runtime used by uBlock; not complete Firefox webRequest coverage |
| Declarative net request | `declarativeNetRequest` static rulesets (`declarative_net_request.rule_resources`, enable/disable persisted), dynamic rules persisted on disk and session rules in memory; `block`, `allow`, `allowAllRequests`, `upgradeScheme`, `redirect` (`url`, `extensionPath`, `transform`, `regexSubstitution`) and `modifyHeaders`, with `urlFilter`/`regexFilter`, resource types, methods, initiator/request domains, `domainType` and tab ids. `getMatchedRules` and `testMatchOutcome` reject as unsupported, `onRuleMatchedDebug` never fires; see the section below |
| Tabs/windows | Existing tab navigation and messaging; window APIs are approximations and capture is unavailable |
| Permissions | Manifest permissions only; optional permission requests return false |
| Other APIs | Existing alarms, cookie and i18n APIs; context menus, notifications, commands, browser chrome theme, native messaging, downloads and other Firefox-only features remain limited or unavailable |

### Manifest V3 request rules (`declarativeNetRequest`)

An extension with the `declarativeNetRequest` or `declarativeNetRequestWithHostAccess`
permission has its rules enforced in the browser session, ahead of any `webRequest`
listener: a rule that blocks ends the request before uBlock sees it, a declarative
redirect yields to a redirect from a blocking listener, and `modifyHeaders` rules apply
on top of whatever the listeners returned. Static rulesets listed under
`declarative_net_request.rule_resources` are read from the package when the extension
starts; a file that fails to parse is skipped with a log line. Dynamic rules and the
enabled ruleset set are kept in `dnr.json` beside the extension's storage; session rules
last until the extension is unloaded. Ties resolve as the specification says: highest
priority wins, then allow/allowAllRequests over block over upgradeScheme over redirect;
across extensions the first block wins, then the first redirect. `allowAllRequests`
is remembered per tab and frame URL for the extension that matched it.

Conditions: `urlFilter` (`||`, `|`, `^`, `*`; case-insensitive unless
`isUrlFilterCaseSensitive`), `regexFilter`, `resourceTypes`/`excludedResourceTypes`,
`requestMethods`/`excludedRequestMethods`, `initiatorDomains`/`excludedInitiatorDomains`
(and the older `domains` names), `requestDomains`/`excludedRequestDomains`,
`domainType`, `tabIds`/`excludedTabIds`. Redirects take `url`, `extensionPath`
(served only when the path is web-accessible), `transform` (scheme, host, port, path,
query or queryTransform, fragment, credentials) and `regexSubstitution`.

Not supported: `getMatchedRules` and `testMatchOutcome` reject with "not supported",
`onRuleMatchedDebug` never fires, `webtransport`/`webbundle` resource types never
match (Electron has no such requests), `responseHeaders` conditions and
`excludedResponseHeaders` are not evaluated, third-party detection uses the last two
host labels rather than the public suffix list, `requestHeaders` `append` joins values
onto one header regardless of the header, and rule-count limits are the Firefox
constants without the Chrome "safe" allowances.

The installer accepts packages independently of these feature limits. A successful
background-page load is not proof that every feature works. This custom runtime
is not a full implementation of Firefox's API or permission model. Install only
extensions whose source you trust. Android uses GeckoView's own installer and
permission model, described below. Arbitrary storage sync selection remains an
Electron feature; iOS installs through WebKit's own extension host, described below.

## Installing and managing Firefox extensions on Android

Settings → Browser Extensions lists enabled and disabled extensions. Install from
an Android-compatible Firefox Add-ons listing or choose a Mozilla-signed local
XPI. Gecko checks the package signature and compatibility, then Once presents
the verified identity and requested access in a native permission dialog.

Management includes enable/disable, options pages, action popups, manual update
checks, and removal with a data-removal confirmation. Bundled uBlock Origin and
Violentmonkey can be disabled; they update with Once and cannot be removed. The
internal Once bridge is protected. The reading address bar's three-dot browser
menu contains navigation/reload controls, an expandable Extensions entry and
the **Keep media playing in background** switch described in
[Android reading media](android-background-playback.md). Extension-created
tabs use separate Gecko sessions with close/reload controls.

Installed packages and their state remain on this device. This is not full
desktop Firefox compatibility: Once does not supply desktop-only APIs, Firefox
Account sync, a browser bookmarks/history database, a full tab strip, or a
general Android download manager. Page-action-only extensions and extension
pages requiring unimplemented browser UI delegates may need further host work.
See [Android architecture, limits, and validation](plans/android-gecko-extension-management.md).

## Installing and managing Firefox extensions on iOS

Settings → Browser Extensions lists the bundled extensions and every package the
user installed, including disabled entries. Install extension accepts a Firefox
Add-ons listing URL, one of its XPI download links, or a local XPI/ZIP chosen in
the Files picker. Tapping an XPI download link in a page opened in Once goes
through the same install instead of a download, and the Add-ons site itself
installs into Once when browsed in a tab: as on Electron and Once Lite, the
shared AMO shim (`packages/webext-runtime/src/amoShim.ts`) runs as a
document-start script in the page's own world (`apps/mobile/src/amoPageShim.ts`,
bundled as `amo-page-shim.js`), rewrites AMO's server state to name Firefox
and supplies `navigator.mozAddonManager` over a reply message handler that the
native side (`AmoInstallBridge.swift`) answers only for `addons.mozilla.org`'s
top frame. AMO then shows its own "Add to Once", installed, enabled and Remove
states; the install URL is the page's, as WebKit reports it, and the native
review sheet confirms before anything is kept. The native side
(`WebExtensionInstaller.swift`, `WebExtensionManagement.swift`,
`ExtensionArchive.swift`) does what the Electron package rules do: a listing is
resolved through Mozilla's API, the download must stay on Mozilla's hosts and
match the published SHA-256 hash and GUID, a direct XPI link must be the file
Mozilla currently lists for the id the package declares, local files are
labelled "signature not verified", and the archive is checked for size,
entry-count and path safety before extraction (200,000,000-byte archive, less
than 250 MiB expanded, at most 100 MiB per file, 10000 entries), matching
[Mozilla’s upload limit](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/)
and [archive size limits](https://github.com/mozilla/addons-server/blob/master/src/olympia/lib/settings_base.py). Downloads are staged to disk and archives are mapped
for extraction to avoid full-archive heap copies. A package without a Gecko id (`browser_specific_settings.gecko.id`)
is refused, as are the ids of the bundled extensions, which update with Once.

Before anything is kept, a native sheet shows the extension name, version,
description, source, requested permissions and host patterns, the adaptations
Once applied and the limitations it found; Cancel discards the unpacked
package. The package is adapted for WebKit by rewriting only `manifest.json`:
a Manifest V2 background page or script list becomes a non-persistent event
page (iOS has no persistent background pages, WebKit refuses them), and a
Manifest V3 `service_worker` runs as an event page script, as it would in
Firefox. Upstream code is untouched. Permissions WebKit does not know are
dropped by WebKit itself; Once lists them under "Compatibility notes" on the
extension's page, and names `webRequestBlocking` explicitly because without
blocking request listeners a filtering extension cannot filter (uBlock Origin
installs and shows its dashboard, but blocks nothing; uBO Lite's
`declarativeNetRequest` rules are what WebKit enforces). WebKit's own manifest
parse errors join the same notes.

Installed packages live under the app's Application Support directory with a
catalog file; each extension keeps a stable unique identifier and
`webkit-extension://` origin derived from its id, so storage survives updates.
Updates resolve Mozilla’s current release by the installed extension’s GUID,
including packages originally installed from a version-specific XPI URL. A
package installed from a file is updated by choosing the new file. Updates
keep the enabled state; a failed load or catalog write restores the previous
version and catalog. Removal asks first, then
unloads the context, deletes WebKit's data for the extension and its package.
Enabled state is kept per device; nothing about installed extensions syncs.
Optional permission requests are not prompted and resolve as denied.

Compatibility is whatever iOS WebKit's `WKWebExtension` implements: content
scripts, event-page backgrounds, storage, `declarativeNetRequest`, popups and
options pages, tabs/windows approximations through Once's single window. There
is no blocking `webRequest`, no `contextualIdentities`, `downloads`,
`nativeMessaging`, `bookmarks`, `history`, `sessions`, `identity`, `management`,
`privacy`, `proxy` or `theme`, and extensions that rely on a persistent
background lose in-memory state when the event page unloads. Installation
proves that the package parses and its background loads, not that every feature
works. `npm run test:mobile:e2e:ios:extension-compat -- <simulator UUID>`
downloads the add-ons in `tests/e2e/mobile/fixtures/ios-extension-compat.json`,
installs each through the real installer in a throwaway simulator app and
writes `artifacts/extension-support/ios-compat-report.md` with what loaded,
what WebKit dropped and which extension pages opened; see
[iOS compatibility results](#ios-compatibility-results) for the last recorded run.

### iOS compatibility results

Recorded on 2026-10-26 from `npm run test:mobile:e2e:ios:extension-compat` on an
iPhone 17 Pro simulator running iOS 26.5, with the then-current Add-ons
releases. Each package went through the real review → install → remove path;
"Background" is whether `loadBackgroundContent` resolved, "Content" whether
WebKit reports injected content for an `https://example.com` page, and
"Popup/Options" whether the action popup (or the options page) opened and had
text three seconds later. Limitations are what the review sheet shows,
shortened: "no blocking webRequest" is the `webRequestBlocking` note, "missing"
lists permissions WebKit does not implement. Background error counts come from
the extension's own pages (`error`, `unhandledrejection`, `console.error`).

| Extension | MV | Loads | Background | Content | Popup/Options | Limitations |
| --- | --- | --- | --- | --- | --- | --- |
| uBlock Origin 1.75.0 | 2 | yes | loaded (1 error) | yes | popup renders | no blocking webRequest; missing: dns, privacy |
| Privacy Badger 2026.9.15 | 2 | yes | loaded (2 errors) | yes | popup empty | no blocking webRequest; missing: privacy |
| Decentraleyes 3.0.2 | 3 | yes | loaded (3 errors) | no | popup renders | no blocking webRequest; missing: privacy |
| ClearURLs 1.27.3 | 2 | yes | loaded (2 errors) | no | popup renders | no blocking webRequest; missing: downloads |
| LocalCDN 2.6.86 | 2 | yes | loaded | no | popup renders | no blocking webRequest; missing: privacy |
| NoScript 13.6.36 | 2 | yes | loaded (5 errors) | yes | options render | no blocking webRequest; missing: dns, webRequestFilterResponse |
| Stylus 2.4.17 | 2 | yes | loaded (1 error) | yes | popup renders | no blocking webRequest |
| Tampermonkey 5.5.0 | 2 | yes | loaded (1 error) | no | popup empty | no blocking webRequest; missing: contextualIdentities, downloads, idle |
| Return YouTube Dislike 4.0.6 | 2 | yes | loaded | no | popup renders | missing: identity |
| I still don't care about cookies 1.1.9 | 2 | yes | loaded | no | popup renders | no blocking webRequest |
| Consent-O-Matic 1.1.5 | 3 | yes | loaded | yes | popup renders | none |
| Tranquility Reader 3.0.26 | 2 | yes | loaded | no | options render | none |
| Redirector 3.5.3 | 2 | yes | loaded (1 error) | no | popup renders | no blocking webRequest |
| Vimium 2.4.2 | 3 | yes | loaded (1 error) | yes | popup renders | missing: bookmarks, clipboardRead, history, search, sessions |
| Read Aloud 1.83.2 | 2 | yes | loaded | no | popup renders | missing: identity |
| Simple Translate 3.1.0 | 3 | yes | loaded | yes | popup renders | none |
| Old Reddit Redirect 3.0.3 | 3 | yes | loaded | no | no popup | static DNR ruleset rejected by WebKit (see below) |
| Firefox Multi-Account Containers 8.3.8 | 2 | yes | loaded (4 errors) | yes | popup empty | no blocking webRequest; missing: contextualIdentities, history, idle, management |
| Ghostery 10.6.9 | 2 | yes | loaded (4 errors) | yes | popup empty | no blocking webRequest |
| DuckDuckGo Privacy Essentials 2026.10.6 | 2 | yes | loaded (1 error) | yes | popup empty | no blocking webRequest |
| Bitwarden 2026.10.0 | 2 | yes | loaded (1 error) | yes | popup empty | no blocking webRequest; missing: clipboardRead, idle |
| Reddit Enhancement Suite 5.24.11 | 2 | yes | loaded | no | options empty | missing: history, identity |
| Cookie AutoDelete 3.8.2 | 2 | yes | loaded | no | popup renders | missing: browsingData, contextualIdentities |
| KeePassXC-Browser 1.10.4.1 | 2 | yes | loaded | yes | popup renders | no blocking webRequest |
| Unpaywall 3.98 | 2 | yes | loaded | yes | popup renders | id taken from Mozilla's listing (manifest names none) |
| Dark Reader, SponsorBlock, Violentmonkey | – | refused | – | – | – | bundled with Once; the bundle updates with the app |

What the run shows: every package Mozilla lists installs, parses and starts
its background in WebKit, and the review sheet names the permissions that are
gone. Working as intended is a smaller set: content-script and
storage-driven extensions (Consent-O-Matic, Simple Translate, Stylus, KeePassXC,
Cookie AutoDelete, the YouTube/Reddit helpers, Tranquility). Filtering and
redirecting extensions (uBlock Origin, Privacy Badger, Ghostery, DuckDuckGo,
ClearURLs, LocalCDN, Decentraleyes, NoScript, Redirector) install and show
their pages but cannot block or rewrite requests, because WebKit has no
blocking `webRequest`; uBO Lite's `declarativeNetRequest` rules are the
filtering iOS enforces. WebKit also accepts some permissions whose APIs are
then missing at runtime, which is what the background errors are:
`webNavigation.onHistoryStateUpdated`/`onCreatedNavigationTarget` (Stylus,
Vimium, NoScript), `notifications.onClicked` (Tampermonkey),
`management.onInstalled` (Multi-Account Containers),
`webRequest.OnHeadersReceivedOptions.EXTRA_HEADERS` (DuckDuckGo),
`declarativeNetRequest.ResourceType` (NoScript), a `ws://*/*` listener pattern
(Privacy Badger); Old Reddit Redirect's static ruleset (`modifyHeaders` and a
`queryTransform` redirect under `regexFilter`) fails in
`declarativeNetRequest.updateEnabledRulesets`, and ClearURLs cannot store its
downloaded rule set. An extension whose background initialisation throws
usually opens an empty popup ("No runtime.onConnect listeners"), which is the
"popup empty" column. The per-extension JSON, with every captured message, is
`artifacts/extension-support/ios-compat-results.json` after a run.

## Once Lite (WebView)

Once Lite runs the same `@once/webext-runtime` as Electron, in a hidden
broker WebView, with Chromium's DevTools protocol as the engine adapter
(`apps/mobile/src/lite`, `apps/mobile/android/app/src/lite/java/com/zmarn/once/lite`;
design in [plans/once-lite-plan.md](plans/once-lite-plan.md), host contract in
[plans/once-lite-broker-protocol.md](plans/once-lite-broker-protocol.md)).
The Electron table above is the baseline; this section records where Lite
matches it, falls short of it, or differs. Settings → Browser Extensions has
the Android management UI (list, enable/disable, options and action pages,
install from an AMO listing or a local XPI, removal with confirmation);
confirmations are native dialogs. Mozilla's download is checked against the
listing's SHA-256 hash and GUID, and Mozilla signatures are not
cryptographically verified, as on Electron; a local package is recorded as
"signature not verified" (`ExtensionPackage.ts`). Bundled uBlock Origin and
Violentmonkey are the plain upstream bundles, not the Gecko-adapted
Violentmonkey copy.

Lite retains a 32 MiB archive limit and a less-than-128 MiB expanded limit:
its Java/JavaScript bridge transfers whole archives as base64, so raising
the limit would multiply large allocations on mobile. Electron and iOS accept
Mozilla’s 200,000,000-byte upload limit; Android Gecko’s local file picker
uses that limit too and streams the file to disk.

**Full** (the Electron behaviour, or better):

| Feature | Lite behaviour |
| --- | --- |
| Blocking `webRequest` | Every request of every frame pauses at the `Fetch` request and response stage with resource type, request body and headers (`liteWebRequest.ts`); `onBeforeRequest` cancels (`BlockedByClient`) or redirects (a 307), `onBeforeSendHeaders` and `onHeadersReceived` edit headers, a document's `onResponseStarted` is awaited while its headers are held as on Electron; `onSendHeaders`, `onBeforeRedirect`, `onCompleted` and `onErrorOccurred` come from `Network.*` events |
| `declarativeNetRequest` | The shared rulesets and matcher, enforced ahead of the listeners, same conditions and limits as the Electron section |
| Content scripts | Isolated world `once-ext:<host>` in every frame at `document_start`, `document_end` and `document_idle`, from one `Page.addScriptToEvaluateOnNewDocument` registration per extension carrying every static and registered script; `match_about_blank`, dynamic `contentScripts.register`/`scripting.registerContentScripts`, `executeScript`/`insertCSS`/`removeCSS` (CSS is author-origin, as on Electron) |
| Main-world scriptlets | uBlock's `<script>` insertion works under a strict header CSP through the per-document nonce the broker adds to `script-src`; a `<meta>`-only policy is detected by a synchronous probe and the scriptlet runs through DevTools main-world evaluation instead (`worldBootstrap.ts`). Both paths are in the acceptance suite (phase d) |
| Extension pages | Background page, popups, options and other pages in their own WebViews at `https://<host>.moz-extension.localhost/`, with a Firefox desktop user agent; popups report their body size as Electron's do; `web_accessible_resources` from tabs (uBlock's element picker) |
| Storage, alarms | `storage.local`/`storage.sync` over Java-backed JSON stores with the Electron semantics; `alarms` and every long broker timer are driven by native timers (`timer.set`/`timer.fired`), so they survive the hidden WebView's throttling |
| Tabs, navigation | `tabs.*` and `webNavigation.*` events from the tab target's `Page.*` events; `tabs.create`/`update`/`remove`/`reload`; a `moz-extension://` tab URL opens the extension page |
| Cookies | `cookies.get`/`set`/`remove` over DevTools and `CookieManager`; `onChanged` by comparing the jar after writes and after a `set-cookie` response (`LiteCookies.java`) |
| Installation | AMO listing or XPI URL with the hash and GUID check, local XPI/ZIP through the document picker, unpacked by Java (`java.util.zip`, path-checked) and validated by the shared code; enable/disable/remove/update, options and action pages |

**Partial**:

| Feature | Lite behaviour |
| --- | --- |
| `filterResponseData` | The broker has the whole-body rewrite (`Fetch.getResponseBody`, then `fulfillRequest` with the new body); the page-side `StreamFilter` is not wired yet, so `browser.webRequest.filterResponseData` throws a clear error (`pageBootstrap.ts`). When it is, the body arrives in one `ondata`: streaming is not possible over this round trip. The HTML-filter assertion of the acceptance suite is opt-in (`ONCE_LITE_HTML_FILTERS=1`) for that reason |
| CORS preflights | Not interceptable; a `Preflight` that does reach the broker is reported as `other` |
| Workers | `Fetch` is enabled per page target, so requests a dedicated or service worker starts itself are not intercepted (`LiteTargets.java`) |
| `wrappedJSObject` | A proxy over a synchronous event channel to the main-world helper: JSON-representable values only; the page can observe the channel and, knowing its token, answer it, as it could change the globals read anyway (the token is not the broker's secret) |
| Paused requests | While the shared renderer main thread is blocked (a page's synchronous `XMLHttpRequest`, a JS dialog), the broker cannot answer; after about 4.5 s without a sign of life Java continues the waiting requests unfiltered (`FetchWatchdog.java`) instead of freezing every tab |
| Listener registration | `addListener` reaches the broker asynchronously (Electron's is synchronous); order within a context is preserved |
| URLs | Extension pages see the https form in `location` and the `moz-extension://` form from `runtime.getURL`; content worlds get the https form from `runtime.getURL` |
| Tabs and windows | One window (`windowId` 1); `tabs.move` answers without moving; `captureVisibleTab` is unavailable |
| Background page access | `extension.getBackgroundPage` returns `null` and `runtime.getBackgroundPage` resolves `null`, as Firefox answers where the page is out of reach: the background page is another WebView; use `runtime.sendMessage` |
| Userscripts | Handed to Violentmonkey through the `GeckoViolentmonkey` plugin contract (answered by the broker the Electron way, over a `VirtualContext`), not by the settings coordinator; filter lists reach uBlock through its dashboard port |

**Absent**: native messaging; `dns.resolve` (reserved in the protocol, not
exposed); `privacy.*` answers the Firefox defaults and changes nothing;
and everything the Electron table lists as unavailable.

**Security notes**: every extension's host is random per install
(`liteHostNames.ts`; one installed before keeps the host its data lives
under). The document nonce is derived per URL from a per-process secret no
page holds, so it is stable for a URL until the app restarts; a page learns
it only by reading a script element of its own document. A document's
synchronous answers are keyed by the secret and its URL and served once, to
its own origin. The broker runs at its own origin. Extension pages allow
mixed content (`MIXED_CONTENT_ALWAYS_ALLOW`), as Firefox lets extensions
fetch http filter lists. The DevTools socket stays open in release builds
while Tier 1 runs: shell (USB debugging, Shizuku) and root can attach to
every WebView of the app, the shell included (see
[ARCHITECTURE.md](ARCHITECTURE.md#mobile)); a release build in Tier 2 closes
it. Release builds log broker and extension-page messages with URLs cut to
their origin.

**Degraded mode (Tier 2)**: when the DevTools socket cannot be attached or
the `Fetch` domain is refused, no full extension loads. The broker still
starts and compiles what Java then enforces on its own, with no broker round
trip per request (`liteTier2.ts`, `LiteTier2.java`; protocol in
[plans/once-lite-broker-protocol.md](plans/once-lite-broker-protocol.md)):

| Feature | Tier 2 behaviour |
| --- | --- |
| Catalogue | uBlock Origin Lite (bundled, `uBOLite@raymondhill.net`) is the running extension, without options or popup; uBlock Origin, Violentmonkey and installed extensions are listed disabled with "Extensions limited: DevTools unavailable", and enabling, installing or opening their pages is refused with that reason |
| Network rules | `shouldInterceptRequest` consults a Java port of the DNR matcher (`DnrEvaluator.java`): `urlFilter` (`\|\|`, `\|`, `^`, `*`, matched in time linear in the URL's length), `regexFilter` (RE2/J linear-time matching over the complete URL; unsupported syntax such as lookaround and backreferences is skipped), request and initiator domains with exclusions, `domainType` (the last two labels stand in for the registrable domain, as in @once/core: `a.co.uk` and `b.co.uk` count as one site; an IP address is its own), resource types (no types means not the top-level document), methods, tab ids, priorities with Chrome's order at equal priority (allow, allowAllRequests, block, upgradeScheme, redirect; an upgrade of a secure URL or a redirect to the URL itself does not apply), and `allowAllRequests` for a tab's committed document. Every group decides on its own and a block from any wins: uBO Lite's default rulesets (uBlock filters, EasyList, EasyPrivacy, about 112k rules, read from the package and cached compiled per install) plus its session rules, and Once's synced lists in the portable subset the GeckoView bridge applies (block and `@@` rules without options) |
| Network actions | A block is an empty 403; a redirect to an `extensionPath` is served from uBO Lite's package (its neutered `web_accessible_resources` scripts and media); a redirect or `upgradeScheme` to an http(s) URL navigates a top-level document there and is fetched by Java for a subresource `GET`, since WebView refuses 3xx responses from the callback. That fetch is not the page's: only `Accept`, `Accept-Language`, `User-Agent` and `Referer` go along, cookies only when the target is the request's own origin and the page's site, redirects are followed by hand to http(s) targets off the device and its network, and the answer carries no credentialed CORS grant or `Set-Cookie`; a status WebView cannot take becomes a 502 |
| Resource types | Inferred: API 36 passes no `Sec-Fetch-Dest` (used when present), so the main-frame flag, `Accept` (`text/html` sub-frame, `image/*`, `text/css`), a `Range` header (media), `Ping-To` (ping), `X-Requested-With` (xmlhttprequest), the path's extension and an extensionless `/js` loader decide; anything else is `other`, so the few rules restricted to types other than `other` miss a `fetch()` or beacon with `Accept: */*` (about 3% of the default block rules), and a script stub redirect can become a plain block |
| Cosmetics | The synced lists' generic `##` selectors (refused when they could leave their rule or swallow the next: braces, `;`, `@`, escapes, comments, unclosed brackets or quotes) as one `<style>` at document start; uBO Lite's generic cosmetic filtering (its own `css-generic.js` over the default rulesets' selector maps, honouring their per-site exceptions) |
| Userscripts | The synced userscripts at their `@run-at`, matched by @once/core's `UserscriptMatcher` (`@match`, `@include`, `@exclude`, `@noframes`), each registered on its own so one that does not parse costs only itself (`tier2Page.ts`); GM shim as on iOS: `GM_addStyle`, `GM_getValue`/`GM_setValue`/`GM_deleteValue`/`GM_listValues` in the page origin's `localStorage` (under `once.userscript.<id>.`, so the page can read and change them), `GM_xmlhttpRequest` as a same-origin `fetch` (a `json` body that does not parse calls `onerror`), the `GM.*` promise forms, `GM_info`, `unsafeWindow` the `window` the script runs in. The shim keeps the `fetch`, `Storage` and `JSON` the document had at its start, and a script's GM API reaches it through its source's closure, so page code it calls cannot read it from `caller` (the script's source it can) |
| Injection | `addDocumentStartJavaScript` on every reading tab, in the page world (the GM functions are closure-scoped, not page globals); where the WebView reports `JS_INJECTION_IN_FRAME_AND_WORLD`, `addJavaScriptOnEvent` in an isolated world `once-tier2` instead (written, but WebView 133 on the API 36 emulator cannot exercise it) |
| Ready barrier | `applyExtensionSettings` answers once Java has the new rules and page scripts in force, which the first navigation waits for, as in Tier 1 |

Not in Tier 2: header edits (`modifyHeaders`, `webRequest`), request bodies,
redirect hops (`shouldInterceptRequest` sees none), scriptlets and
procedural or site-specific cosmetics (uBO Lite's per-site CSS and scriptlet
tables, the synced lists' domain-scoped rules), uBO Lite's optional rulesets
and its strict-block page, its dashboard and popup, extension pages (a
`moz-extension:` navigation fails with the reason), and the requests of
service workers. A subframe's requests are judged against the tab's
committed document (a navigation that never commits counts only for the
requests whose `Referer` shows they come from it), which is the initiator
Java knows. Unlike the GeckoView bridge, Tier 2 never blocks a top-level
document, and a list's non-ASCII `@@` exception is skipped without
withdrawing the list's blocks, so Tier 2 can block a little more than Gecko.
The tier is decided once per process: DevTools connecting late does not
start Tier 1 beside Tier 2. `adb shell setprop
debug.once.lite.devtools off` forces Tier 2 on a debuggable build
([DEVELOPMENT.md](DEVELOPMENT.md)); `LiteTier2Test` and
`npm run test:mobile:e2e:android:lite:tier2:local` exercise it.

`tests/e2e/mobile/mobile.lite-extensions.js`
([README](../tests/e2e/mobile/README-lite-extensions.md)) is the acceptance
suite: catalogue, synced lists and userscripts, network and cosmetic blocking,
scriptlets under header and `<meta>` CSPs, GM API timing and isolation,
popup and options pages, dashboard round trip, persistence across restarts,
disable/enable, and the opt-in live Dark Reader install.

### Requested extension builds

The Mozilla packages inspected on 2026-09-06 were SponsorBlock **6.1.7**
(`sponsorBlocker@ajay.app`) and Dark Reader **4.9.130** (`addon@darkreader.org`).
Their sources are [SponsorBlock on AMO](https://addons.mozilla.org/en-US/firefox/addon/sponsorblock/)
and [Dark Reader on AMO](https://addons.mozilla.org/en-US/firefox/addon/darkreader/).
`node scripts/check-requested-extensions.js` downloads, hash-checks, and reports
the current manifests and statically referenced APIs without executing the packages.

SponsorBlock required area-specific storage change events and the external-message
event registration surface in addition to persistent `storage.sync`. Dark Reader
required separate local/sync stores and manifest main-world content scripts. Its
popup doubles as its settings page. Optional Invidious host grants in SponsorBlock,
Dark Reader browser chrome theming and shortcuts, and other APIs in the table above
are not established by installation or storage tests.

`tests/e2e/electron/browser-extension-management.spec.js` exercises real AMO
installation through settings, extension initialization, a local SponsorBlock
video/segment fixture, Dark Reader-generated CSS, saved sync selection, disable,
enable and removal. The synthetic video is test evidence, not a live YouTube
playback or public SponsorBlock submission test. Existing extension-page tests
cover uBlock and Violentmonkey. See `artifacts/extension-support` for local logs;
those generated outputs are not source-controlled test fixtures.

The live AMO test is opt-in (`ONCE_TEST_AMO_EXTENSIONS=1`) so ordinary regression
runs do not depend on current marketplace releases or downloads. On 2026-09-06 it
passed against the versions above: SponsorBlock sought past the fixture segment,
and Dark Reader marked the page as dynamic and changed its white background to
`rgb(24, 26, 27)`. The settings selection and lifecycle controls passed in the same
run. Four existing Electron extension/add-on page regressions also passed. The
same live test and the extension-page specs passed again on 2026-09-11 on
Electron 44.3.0 with Violentmonkey 2.49.0 bundled, with the extensions'
console output kept through `ONCE_ELECTRON_E2E_ATTACH_LOGS=1`; the only
errors were SponsorBlock's expected "Receiving end does not exist" against
the fixture page.

A separate smoke of the distributable `Once-win32-x64/once.exe` verified the
packaged renderer reached `onceReady`, installed both AMO builds, rendered
SponsorBlock's options and Dark Reader's settings popup, and disabled/re-enabled
Dark Reader with the expected running state. This used an isolated profile and
renderer CDP on a private desktop; it did not require changing Electron's packaged
security fuses. The automated behavior fixtures above use the development build.

Once Lite Tier 2 evaluates regex rules with RE2/J, including when restoring
compiled rule caches. Accepted expressions run without Java regex backtracking,
and matching uses the complete URL rather than a truncated prefix. Cache format
version 3 invalidates previously compiled rules when switching regex engines.
