# Monorepo Migration Status

## Current State

- Active branch: `monorepo-structure`
- Canonical working repo: `sidepanel_once_firefox`
- Firefox extension build is currently usable after the mass package move.
- Firefox build output:
  - `apps/firefox-extension/dist`
- Firefox source assets and manifest:
  - `apps/firefox-extension/public`
- Rebuild command:
  - `npm run build-dev`
- Last verified checks:
  - `npm run check`
- Last verified commit:
  - current `HEAD` (`Introduce OnceApp client architecture`)

## History And Layout

- Legacy Chrome repo imported under:
  - `legacy/sidepanel_once`
- Legacy Electron repo imported under:
  - `legacy/once-electron`
- App/package skeleton added:
  - `apps/firefox-extension`
  - `apps/chrome-extension`
  - `apps/electron`
  - `apps/website`
  - `apps/mobile`
  - `packages/core`
  - `packages/ui-web`
  - `packages/platform-webext`
  - `packages/platform-electron`
  - `packages/platform-web`
  - `packages/platform-mobile`
  - `packages/persistence`
  - `packages/app`

## Extracted So Far

- Core package:
  - `OnceSettings`
  - shared story model
  - story map and story loading modules
  - default sources, filters, and redirects
  - story filtering
  - URL redirect replacement logic
  - source grouping
  - story comparison
  - parser modules and pattern matching
  - parser response caching is now injected by the caller
  - core no longer imports webextension platform code
  - reusable collectors:
    - generic matcher
    - Hacker News HTML
    - JSON selector
    - Lobsters HTML
    - Reddit JSON/RSS
    - Twitter/Nitter HTML
    - vanilla RSS/Atom
  - relative time helpers
- UI web package:
  - sidepanel DOM views:
    - loader insights
    - navigation handler
    - settings panel
    - story filter view
    - story history
    - story list and list item
    - menu and context menu
  - search UI
  - outline and video presenters
  - presenter frontend/backend adapters
  - shared DOM UI now depends on typed `OnceClient` APIs instead of webextension messaging
- App package:
  - typed `OnceApp`/`OnceClient` command and query API
  - typed event bus for loader, source errors, stories, story changes, settings, redirects, menu state, and selected URL
  - source loading orchestration, settings persistence orchestration, story merge/update orchestration
  - platform port interfaces for stores, cache, sync settings, theme, active tab, fetch, DB changes, and transport
- Platform packages:
  - `packages/platform-webext` exposes `createWebExtPlatform`
  - `packages/platform-web` exposes a localStorage-backed `createWebPlatform`
  - `packages/platform-electron` exposes `createElectronPlatform` for Electron-provided ports
  - `packages/platform-mobile` exposes `createMobilePlatform` for WebView/native-provided ports
- Webextension platform package:
  - IndexedDB cache store
  - browser sync storage for sync URL and cache time
  - document theme handling
  - Firefox/webextension platform factory for PouchDB, cache, sync storage, theme, active-tab integration, and DB change subscriptions
- Persistence package:
  - PouchDB list store
  - PouchDB story store
  - PouchDB sync service

## Recent Commits

```text
aa98bc9 Extract StoryLoader platform adapters
63aaeb6 Mass move files
467c077 Fix optional sync handler typing
d1629a3 Fix refactor lint and type issues
5d43531 Extract PouchDB sync service
ec86e74 Extract PouchDB story store
bbe7ebe Extract PouchDB list store
22f6a38 Move theme handling to webext platform
8ec4834 Move sync storage to webext platform
c98904a Move IndexedDB cache to webext platform
```

## Remaining Big Knots

- `packages/core` is not platform-neutral yet despite the package move:
  - 0 known `@once/platform-webext` import violations remain, tracked by `scripts/core-boundary-baseline.json`
  - still contains some DOM assumptions in parser/collector/story helpers
- `OnceSettings` is now a platform-neutral compatibility/defaults shell; app orchestration lives in `packages/app`.
- `StoryLoader` remains as legacy helper code, but Firefox sidepanel now uses `OnceApp.reloadStories`.
- `StoryMap` no longer registers transport handlers; Firefox sidepanel story state is owned by `OnceApp`.
- `packages/ui-web` is shared DOM UI and no longer imports webextension platform packages.
- `apps/firefox-extension/src/sidepanel.ts` is the Firefox-specific bootstrap that wires core and UI together.
- `apps/firefox-extension/src/background.ts` is the Firefox background entrypoint; the legacy root `src/` tree has been removed.
- Build tooling still relies on root TypeScript path aliases and webpack aliases rather than package-local builds.
  - `packages/app` and all platform packages are now included in root typechecking
- Guardrails now exist:
  - `npm run check:types`
  - `npm run check:boundaries`
  - `npm run check`
- Compatibility re-exports for old import paths have not been added; callers should use package aliases for now.

## Next Steps

1. Keep reducing the `packages/core` boundary baseline:
   - done: known core platform import violations are now zero
   - next: move remaining DOM-only helpers such as CSS injection into `packages/ui-web`
2. Make `packages/core` genuinely platform-neutral:
   - keep `npm run check` green after every step
   - replace or isolate parser DOM assumptions where they block non-browser runtimes
3. Harden the new `packages/app` layer:
   - add focused fake-port tests for reload events, settings events, story changes, and DB changes
   - decide whether legacy `StoryLoader`/`OnceSettings` exports should remain or be removed after callers are fully migrated
4. Introduce runtime platform factories:
   - done: `createWebExtPlatform`, `createWebPlatform`, `createElectronPlatform`, and `createMobilePlatform` entrypoints exist
   - next: fill Electron/mobile native ports with real IPC/WebView bridge implementations
5. Add Chrome manifest/build after the Firefox composition path is explicit and repeatable.
6. Port Electron after the app/platform split is real, not just directory-based.

## Notes

- Keep changes incremental and commit after each passing build.
- Add old-path compatibility re-exports only if a follow-up migration needs them.
- Do not move Electron code until Firefox remains stable from the monorepo structure.
