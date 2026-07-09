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
  - `63aaeb6 Mass move files`

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
- Webextension platform package:
  - IndexedDB cache store
  - browser sync storage for sync URL and cache time
  - document theme handling
  - background/runtime messaging adapter
- Persistence package:
  - PouchDB list store
  - PouchDB story store
  - PouchDB sync service

## Recent Commits

```text
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
  - 3 known `@once/platform-webext` import violations remain, tracked by `scripts/core-boundary-baseline.json`
  - still contains some DOM assumptions in parser/collector/story helpers
- `OnceSettings` still owns too much orchestration:
  - creating the PouchDB instance
  - registering `BackComms` handlers
  - reacting to DB changes
  - forwarding UI refresh messages
  - exposing compatibility methods
- `StoryLoader` now lives in core, but still mixes source loading with:
  - cache access
  - menu group/type buttons
  - loader processing status
  - settings-panel source errors
- `StoryMap` still mixes domain map behavior with:
  - messaging/invocation
  - persistence calls
  - UI refresh events
- `packages/ui-web` is shared DOM UI, but currently imports webextension messaging directly.
- `src/js/view/sidepanel.ts` remains the Firefox-specific bootstrap that wires core and UI together.
- Build tooling still relies on root TypeScript path aliases and webpack aliases rather than package-local builds.
- Guardrails now exist:
  - `npm run check:types`
  - `npm run check:boundaries`
  - `npm run check`
- Compatibility re-exports for old import paths have not been added; callers should use package aliases for now.

## Next Steps

1. Keep reducing the `packages/core` boundary baseline:
   - remove `BackComms`/`CacheStore` from `StoryLoader`
   - remove `BackComms` from `StoryMap`
   - move `OnceSettings` platform orchestration behind app/platform composition
2. Make `packages/core` genuinely platform-neutral:
   - keep `npm run check` green after every step
   - move DOM-only helpers such as CSS injection into `packages/ui-web`
   - replace UI notifications with callback/event interfaces owned by the caller
3. Split `StoryLoader` first, before `StoryMap`:
   - core: source selection, fetching/parsing/filtering, story tagging
   - platform adapter: cache get/set and network policy
   - UI adapter: menu type/group updates, loader insights, settings errors
4. Then split `StoryMap`:
   - core story collection and merge/update rules
   - persistence adapter backed by `packages/persistence`
   - webextension messaging wrapper in `packages/platform-webext`
5. Extract `OnceSettings` orchestration last among the current knots:
   - keep the working Firefox bootstrap stable while lower-level seams are introduced
   - move PouchDB setup toward persistence/platform composition
   - leave compatibility methods until callers are migrated
6. Introduce app-level composition modules:
   - Firefox sidepanel wires core, ui-web, persistence, and platform-webext
   - Chrome can reuse the same composition after manifest/build setup
   - Electron should wait until core no longer depends on webextension APIs
7. Decide on old-path compatibility re-exports only if external or legacy callers need them.
8. Add Chrome manifest/build after the Firefox composition path is explicit and repeatable.
9. Port Electron after the core/platform split is real, not just directory-based.

## Notes

- Keep changes incremental and commit after each passing build.
- Add old-path compatibility re-exports only if a follow-up migration needs them.
- Do not move Electron code until Firefox remains stable from the monorepo structure.
