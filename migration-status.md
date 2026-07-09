# Monorepo Migration Status

## Current State

- Active branch: `monorepo-structure`
- Canonical working repo: `sidepanel_once_firefox`
- Firefox extension build is currently usable.
- Firefox build output:
  - `apps/firefox-extension/dist`
- Firefox source assets and manifest:
  - `apps/firefox-extension/public`
- Rebuild command:
  - `npm run build-dev`
- Last verified checks:
  - `npm run build-dev`
  - `npx eslint packages\persistence\src\PouchSyncService.ts`

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

## Extracted So Far

- Core package:
  - default sources, filters, and redirects
  - story filtering
  - URL redirect replacement logic
  - source grouping
  - story comparison
  - shared story model base
  - parser pattern matching
  - relative time helpers
- Webextension platform package:
  - IndexedDB cache store
  - browser sync storage for sync URL and cache time
  - document theme handling
- Persistence package:
  - PouchDB list store
  - PouchDB story store
  - PouchDB sync service

## Recent Commits

```text
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

- `OnceSettings` still owns orchestration:
  - creating the PouchDB instance
  - registering `BackComms` handlers
  - reacting to DB changes
  - forwarding UI refresh messages
  - exposing compatibility methods
- `BackComms` is still in `src/js/data` and should move to `packages/platform-webext`.
- `StoryMap` still mixes domain map behavior with messaging and persistence calls.
- `StoryLoader` still mixes loading/parsing with UI status and settings panel errors.
- Collectors and parser modules still live under `src/js/data`; many are reusable but some import the extension `Story` wrapper.
- `ui-web` is still mostly empty; DOM view modules have not been moved yet.

## Next Steps

1. Move `BackComms` into `packages/platform-webext`, leaving `src/js/data/BackComms.ts` as a compatibility re-export.
2. Split `StoryMap` into:
   - core story map/domain behavior
   - platform messaging wrapper
   - persistence calls through injected store/service
3. Split `StoryLoader` into:
   - core source loading/parsing workflow
   - web UI progress/error reporting
4. Move reusable collectors/parser contracts toward `packages/core`.
5. Move shared DOM views into `packages/ui-web`.
6. Restore and verify Firefox after each step with `npm run build-dev`.
7. Add Chrome manifest/build using `legacy/sidepanel_once` as reference.
8. Port Electron shell from `legacy/once-electron` after the shared core and web UI boundaries stabilize.

## Notes

- Keep changes incremental and commit after each passing build.
- Keep old import paths as compatibility re-exports during migration.
- Do not move Electron code until Firefox remains stable from the monorepo structure.
