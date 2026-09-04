# Engineering history

Completed implementation plans are removed once their durable behavior is
documented elsewhere. Git retains the detailed plans, reviews, and verification
evidence; this file is only a compact discovery index.

| Completed | Work | Landing commits | Durable documentation |
| --- | --- | --- | --- |
| 2026-09-04 | Stored story content: feed text and saved page articles as story attachments, the offline reader path on every platform, the bookmark and per-source triggers | see `git log -- packages/core/src/story/storyContent.ts` | [Architecture](ARCHITECTURE.md), [Collectors](COLLECTORS.md), [Codemap](CODEMAP.md) |
| 2026-09-04 | Once add-ons: declarative contributions, the sandboxed script runtime on Electron and mobile, collector add-ons, install from URL with a per-device code cache, capabilities, storage, panel actions, and options | `308ac65`..`96d7e49` | [Add-ons](ADDONS.md), [Architecture](ARCHITECTURE.md), [Codemap](CODEMAP.md), [Collectors](COLLECTORS.md) |
| 2026-09-03 | Extension pages in iframes get their own context; port, webRequest filter, tab-move, and background-window fixes for uBlock Origin and Violentmonkey | `a730f75`, `4d5f83d` | [Architecture](ARCHITECTURE.md), [plan](plans/firefox-extensions-plan.md) |
| 2026-08-06 | Per-source cache timing, cache-first launch, and cache controls | `4819243`, `88f20f7` | [Architecture](ARCHITECTURE.md), [Codemap](CODEMAP.md) |
| 2026-08-05 | Typed story sources and verified v0.3.0 profile migration | `7223924`, `3d8ba09`, `0f47e4f` | [Architecture](ARCHITECTURE.md), [Collectors](COLLECTORS.md), [Codemap](CODEMAP.md) |
| 2026-08-05 | Configurable desktop keyboard navigation, story cursor, pane focus, and closed-tab history | `c074cd5`..`9d4c933` | [Architecture](ARCHITECTURE.md), [Codemap](CODEMAP.md), [Development](DEVELOPMENT.md) |
| 2026-07-12 | TypeScript 4.9 to 6.0 and ESLint 9 migration | `0b893cc`..`abd8829` | [Development](DEVELOPMENT.md) |

Active implementation plans live in [`plans/`](plans/).
