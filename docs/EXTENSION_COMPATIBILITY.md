# Extension compatibility and recovery

Once add-ons extend the story UI and collectors. Browser extensions run in the
embedded browsing surface. Their configuration and runtime ownership are separate.

| Surface | Once add-ons | Browser filtering and userscripts |
| --- | --- | --- |
| Electron | Declarative contributions and sandboxed scripts | Bundled extensions plus user-installed Firefox MV2 XPIs; see the management and API limits below |
| Android | Declarative contributions and sandboxed scripts in the app shell | GeckoView built-ins; synced additions handled by Once's bridge |
| iOS | Shared add-on implementation; device validation remains required | WebKit content rules and the documented small GM shim |
| Chrome side panel | Declarative contributions and sandboxed scripts | Browser-native extensions remain the user's browser configuration |
| Firefox side panel | Declarative contributions; scripts require a configured hosted sandbox | Browser-native extensions remain the user's browser configuration |

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

The portable examples live in `tests/fixtures/extensions/portable-filters.json`.
Node tests execute the actual Android parser and bridge. Those checks and mobile
web tests do not establish native iOS behavior; WebKit compilation and the shared
add-on sandbox must still be validated on an Apple device or simulator.

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
Install extension accepts a Mozilla Firefox Add-ons page URL or a local XPI/ZIP.
Review shows the extension identity, version, declared permissions, source, and
compatibility limitations before installation. Mozilla downloads are checked against
the listing's SHA-256 hash and GUID. Local packages are not cryptographically
signature-verified and are labelled accordingly. Archives have compressed/expanded
size limits, entry-count limits, and path validation before extraction.

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
| Manifest formats | Firefox Manifest V2 with an explicit Gecko ID; MV3/service workers are rejected |
| Background scripts/pages | Hosted in separate persistent extension sessions; nonpersistent backgrounds remain resident |
| Content scripts | Manifest and dynamic `contentScripts.register`; match/exclude patterns, frames, run phases, and MAIN/ISOLATED manifest worlds |
| Messaging | Internal runtime/tab messaging and ports; external extension-to-extension import is not implemented |
| Storage | Separate persistent local/sync areas, changes and byte counts; Once sync is opt-in per key |
| Toolbar/options | Popups, options pages, click events, titles and badges; dynamic icon updates remain limited |
| Browser requests | Existing blocking request runtime used by uBlock; not complete Firefox webRequest coverage |
| Tabs/windows | Existing tab navigation and messaging; window APIs are approximations and capture is unavailable |
| Permissions | Manifest permissions only; optional permission requests return false |
| Other APIs | Existing alarms, cookie and i18n APIs; context menus, notifications, commands, browser chrome theme, native messaging, downloads and other Firefox-only features remain limited or unavailable |

The installer accepts packages independently of these feature limits. A successful
background-page load is not proof that every feature works. This custom runtime
is not a full implementation of Firefox's API or permission model. Install only
extensions whose source you trust. Android remains on its existing GeckoView
built-in installation path; iOS cannot execute Firefox WebExtensions. The new
installer and arbitrary storage sync integration are Electron features.

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
run. Four existing Electron extension/add-on page regressions also passed.

A separate smoke of the distributable `Once-win32-x64/once.exe` verified the
packaged renderer reached `onceReady`, installed both AMO builds, rendered
SponsorBlock's options and Dark Reader's settings popup, and disabled/re-enabled
Dark Reader with the expected running state. This used an isolated profile and
renderer CDP on a private desktop; it did not require changing Electron's packaged
security fuses. The automated behavior fixtures above use the development build.
