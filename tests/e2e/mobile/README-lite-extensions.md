# Once Lite extension acceptance suite

`tests/e2e/mobile/mobile.lite-extensions.js` is the M3 acceptance suite for the
Lite extension runtime (`docs/plans/once-lite-plan.md`). It drives the
WebView-based Android app through Appium, like the smoke suite, and is selected
by `ONCE_MOBILE_LITE_EXTENSIONS=1` in `wdio.shared.conf.js`.

It covers Tier 1 (DevTools available) only: its phases drive uBlock Origin's
and Violentmonkey's own pages, popups and dashboards, which Tier 2 does not
load. Tier 2 is covered by `LiteTier2Test` (instrumentation) and the smoke
suite run with DevTools switched off,
`npm run test:mobile:e2e:android:lite:tier2:local` (see
`docs/DEVELOPMENT.md`).

## Running it

Against the running emulator (`emulator-5554`; the runner packages the Lite dev
APK, starts the fixture server and the Appium session):

```
npm run test:mobile:e2e:android:lite:extensions:local
```

The CI form (device already prepared) is `npm run test:mobile:e2e:android:lite:extensions`.
Both set the env and pass `--engine lite`; the suite refuses any other engine.

Optional:

- `ONCE_TEST_AMO_EXTENSIONS=1` enables phase k (live install of Dark Reader
  from addons.mozilla.org).
- `ONCE_LITE_HTML_FILTERS=1` asserts the HTML filter rule (`##^#lite-html-filtered`,
  needs response-body filtering); otherwise its outcome is only logged.
- `ONCE_LITE_EXTENSIONS_PENDING=1` is for the *smoke* suite only: it keeps the
  Lite skip of its extension assertions until M2 lands. Delete the gate in
  `mobile.smoke.js` with the env once Lite applies filter lists and userscripts.

Fixtures live in `tests/mobile-env/server.js` (`/fixtures/lite-filter-list.txt`,
`/fixtures/ublock/*`, `/fixtures/violentmonkey/*`, `/fixtures/popup-probe.html`);
the filter list is generated per request with the host the device reached the
server through, so hostname-scoped rules match on the emulator (`10.0.2.2`).

## Phases

The phases share one session and `bail` stops at the first failure; each
assertion names the capability it proves.

| Phase | Proves |
| --- | --- |
| a | Startup on Lite; Settings → Browser Extensions lists exactly uBlock Origin and Violentmonkey, enabled, "Included with Once", with options and action controls and no removal |
| b | Synced filter list and three userscripts saved from Once's settings; `applyExtensionSettings` acknowledged |
| c | On `/fixtures/ublock/page.html`: `ad.js` blocked (network), `.lite-ad-slot` hidden (cosmetic), `set-constant` scriptlet ran before the page's first inline script |
| d | The same under a strict `Content-Security-Policy` header (per-document nonce path) and under a `<meta>` CSP (main-world evaluation path) |
| e | Userscripts: `@run-at document-start` timing, `GM_setValue/GM_getValue`, `GM_addStyle`, `GM_xmlhttpRequest`, `@inject-into content` isolation (page globals only via `unsafeWindow`), `@inject-into page` with `@grant none` sharing the page world (its write to a page variable lands there; with a grant Violentmonkey's window wrapper hides page globals in every browser) |
| f | Native browser menu → Extensions → uBlock Origin opens the popup in the extension page frame (`popup: true`); the popup WebView shows the fixture host and a non-zero blocked count; the frame's Close closes it |
| g | Settings → uBlock Origin → "Open extension settings" opens the dashboard in the frame (`popup: false`, titled), with `vAPI` and its pane iframe loaded |
| h | Disabling a script in Violentmonkey's dashboard reaches the synced userscripts document (`dashboardChanged` → reconciliation); re-enabling from Once applies again |
| i | After terminate/activate the catalog and the filtering still hold (storage persistence) |
| j | Disabling uBlock Origin lets `ad.js` load and the slots show; re-enabling blocks again |
| k | (opt-in) Dark Reader installs from its AMO listing after the native "Install" prompt, darkens `/fixtures/article.html`, and is removed again |

## Selectors the suite relies on

Shell (keep stable): `[data-settings-target='extensions']`, `#extension_settings .mobile_extension_row[aria-label='Manage <name>']`,
`.mobile_extension_title strong`, `.mobile_extension_meta` ("… · Enabled · Included with Once"), detail buttons by text
("Disable extension", "Enable extension", "Open extension settings", "Open extension action", "Remove extension…",
"Remove extension and data", "Install extension", "Review and install"), `#mobile-extension-source`,
`[data-testid='extension-supplemental']`, `[data-testid='filter-lists']`, `[data-testid='save-filter-lists']`,
`[data-testid='add-userscript']`, `[data-testid='userscript-source']`, `[data-testid='save-userscript']`,
`[data-testid='userscripts-settings'][data-page='script'|'list']`, `#userscripts_settings[data-enabled-count]`,
`.userscript_row[data-enabled]`, `[data-testid='userscript-enabled']`, `#reading_menu_btn`, `#reading_url`,
`#reading_url_form`, `#reading_content[data-mode][data-load-state]`, `#reading_browser_menu`,
`#extension_page_frame` (`hidden`, `.extension_page_frame--popup`, `.extension_page_title`, `.extension_page_close`).

Native (UiAutomator): the browser menu's expander `descriptionStartsWith("Extensions (")`
(content description ends in ", collapsed"/", expanded"; the iOS sheet's expander carries the same
accessibility label), extension rows by `text("<name>")`,
the install prompt by `textContains("Install")` with its "Allow" button, an optional "Remove" confirmation.

Extension pages (Appium WebView contexts whose URL is `https://<host>.moz-extension.localhost/...`):
uBlock `popup-fenix.html` (`#hostname`, `#basicStats` span after `[data-i18n=popupBlockedOnThisPage_v2]`, `#switch`),
uBlock `dashboard.html` (`vAPI`, `iframe#iframe`), Violentmonkey `options/index.html` (`.script` rows, their "Disable" control).
