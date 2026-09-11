# Engineering history

Completed implementation plans are removed once their durable behavior is
documented elsewhere. Git retains the detailed plans, reviews, and verification
evidence; this file is only a compact discovery index.

| Completed | Work | Landing commits | Durable documentation |
| --- | --- | --- | --- |
| 2026-09-11 | Android reading view keeps opted-in media playing in the background with notification and lock-screen controls | `a37e2a6e`..`fc389753` | [Android reading media](android-background-playback.md) |
| 2026-09-11 | Electron 44.3.0, adm-zip 0.6.1 and Violentmonkey 2.49.0; the 0.4.0 review fixes (popup listener leak, decrypt refusal fallback, reader tab restore, disabled-source marking, conversation pages ending with their addon) | `426699e8`..`c2c1484a` | [Releasing](RELEASING.md) |
| 2026-09-10 | Android GeckoView extension management: install from AMO or a signed XPI, native permission dialog, options and popup pages, extension-created tabs, header-framed extension pages | `7fbb586f`..`57438ee0` | [Extension compatibility](EXTENSION_COMPATIBILITY.md), [plan](plans/android-gecko-extension-management.md) |
| 2026-09-10 | An addon tray continues as a conversation page in the browser surface (Electron tab, extension page, mobile reading view); Tavily as a search fallback; linked-folder addons show where they run from | `85a49c35`..`4307eeab`, `bb1d8378` | [Add-ons](ADDONS.md), [Codemap](CODEMAP.md) |
| 2026-09-09 | Manual GitHub release check on installs without Squirrel updates, mouse back/forward through Settings, source enable toggle and ⋮ menu, read/star state on global search results | `04ed4815`, `ea3b7811`, `9236dba7` | [Development](DEVELOPMENT.md), [Codemap](CODEMAP.md) |
| 2026-09-07 | Electron extensions panel beside the address bar with pinnable actions; closed-tab history survives a restart | `b20dd771`, `a4d5538d`, `e73bcb50` | [Extension compatibility](EXTENSION_COMPATIBILITY.md), [Architecture](ARCHITECTURE.md) |
| 2026-09-06 | Once AI addon with story trays, local ZIP/folder imports, dedicated addon settings pages, encrypted sync of addon connections and Markdown in trays; Firefox extension management on Electron with selected settings sync; per-platform story buttons | `b939eafb`, `6830c87b`, `cf71fb30`, `e3a5abbb` | [Add-ons](ADDONS.md), [Addon sync vault](addon-sync-vault.md), [Extension compatibility](EXTENSION_COMPATIBILITY.md) |
| 2026-09-04 | Accessibility becomes opt-in on Electron: the forced full tree cost seconds of the main process per large page; Chromium's on-demand basic tree serves tab-strip tools, a "Screen reader support" setting enables the rest | see `git log -- apps/electron/src/AccessibilitySetting.ts` | [Architecture](ARCHITECTURE.md) |
| 2026-09-04 | Stored story content: feed text and saved page articles as story attachments, the offline reader path on every platform, the bookmark and per-source triggers | see `git log -- packages/core/src/story/storyContent.ts` | [Architecture](ARCHITECTURE.md), [Collectors](COLLECTORS.md), [Codemap](CODEMAP.md) |
| 2026-09-04 | Once add-ons: declarative contributions, the sandboxed script runtime on Electron and mobile, collector add-ons, install from URL with a per-device code cache, capabilities, storage, panel actions, and options | `308ac65`..`96d7e49` | [Add-ons](ADDONS.md), [Architecture](ARCHITECTURE.md), [Codemap](CODEMAP.md), [Collectors](COLLECTORS.md) |
| 2026-09-03 | Extension pages in iframes get their own context; port, webRequest filter, tab-move, and background-window fixes for uBlock Origin and Violentmonkey | `a730f75`, `4d5f83d` | [Architecture](ARCHITECTURE.md), [plan](plans/firefox-extensions-plan.md) |
| 2026-08-06 | Per-source cache timing, cache-first launch, and cache controls | `4819243`, `88f20f7` | [Architecture](ARCHITECTURE.md), [Codemap](CODEMAP.md) |
| 2026-08-05 | Typed story sources and verified v0.3.0 profile migration | `7223924`, `3d8ba09`, `0f47e4f` | [Architecture](ARCHITECTURE.md), [Collectors](COLLECTORS.md), [Codemap](CODEMAP.md) |
| 2026-08-05 | Configurable desktop keyboard navigation, story cursor, pane focus, and closed-tab history | `c074cd5`..`9d4c933` | [Architecture](ARCHITECTURE.md), [Codemap](CODEMAP.md), [Development](DEVELOPMENT.md) |
| 2026-07-12 | TypeScript 4.9 to 6.0 and ESLint 9 migration | `0b893cc`..`abd8829` | [Development](DEVELOPMENT.md) |

Active implementation plans live in [`plans/`](plans/).
