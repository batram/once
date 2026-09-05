# Extension compatibility and recovery

Once add-ons extend the story UI and collectors. Browser extensions run in the
embedded browsing surface. Their configuration and runtime ownership are separate.

| Surface | Once add-ons | Browser filtering and userscripts |
| --- | --- | --- |
| Electron | Declarative contributions and sandboxed scripts | Allowlisted Firefox MV2 builds of uBlock Origin and Violentmonkey |
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

Browser-extension updates must keep the allowlist explicit and rerun packaged
tests for extension pages, scripts, and settings adapters against the pinned
bundles. A hash-pinned archive and a passing parser unit test do not establish
runtime compatibility on their own.
