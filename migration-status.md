# Monorepo Migration Status

## Current State

- Firefox is the active, verified composition target.
- Firefox entrypoints live in `apps/firefox-extension/src/`; the legacy root `src/` tree is gone.
- Firefox assets and manifest live in `apps/firefox-extension/public`; builds output to `apps/firefox-extension/dist`.
- The sidepanel uses `OnceApp`/`OnceClient` with `createWebExtPlatform` rather than legacy webextension messaging.
- The shared packages are `core`, `app`, `ui-web`, `persistence`, and platform adapters.
- Validation commands:
  - `npm run check`: types, package boundaries, and development Firefox build
  - `npm run b2`: production Firefox build
- Last verified commit: `0e29b2f` (`Move Firefox entrypoints out of legacy src`).

## Complete

- Extracted shared story, settings, parser, collector, persistence, UI, app, and platform code into packages.
- Removed known `@once/platform-webext` imports from `packages/core`; the boundary baseline is zero.
- Added webextension, web, Electron, and mobile platform factory entrypoints.
- Removed obsolete vendored `Readability` and PouchDB files from the old source tree; PouchDB is now supplied as a package dependency.

## Remaining Work

1. Make `packages/core` platform-neutral by moving or isolating remaining DOM-only helpers.
2. Add focused `OnceApp` tests using fake platform ports, covering reloads, settings, story updates, and database changes.
3. Decide whether the legacy `StoryLoader` and `OnceSettings` compatibility exports can be removed.
4. Replace root TypeScript/webpack aliases with package-local builds or another explicit package build strategy.
5. Implement native Electron and mobile ports, then add Chrome and Electron composition/builds.

## Scope

- Legacy Chrome and Electron imports remain under `legacy/` for reference only.
- Keep `npm run check` green for each incremental migration change.
