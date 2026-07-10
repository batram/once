# Once Monorepo Migration Plan

## Objective

Keep Firefox as the working reference application while making the shared
application and platform boundaries portable. Chrome, Electron, website, and
mobile are follow-on compositions, not active applications yet.

## Current Architecture

```text
apps/
  firefox-extension/  # active entrypoints, public assets, webpack build
  chrome-extension/   # package placeholder
  electron/           # package placeholder
  website/            # package placeholder
  mobile/             # package placeholder

packages/
  core/               # platform-neutral story, settings, and domain logic
  collectors/         # all source collectors, parsing, and collector registry
  app/                # OnceApp orchestration and typed client/event API
  ui-web/             # shared DOM UI
  persistence/        # PouchDB stores and sync service
  platform-webext/    # working Firefox/WebExtension ports
  platform-web/       # localStorage/browser prototype ports
  platform-electron/  # Electron port placeholder
  platform-mobile/    # mobile port placeholder
```

Firefox composition is in `apps/firefox-extension/src/` and uses `OnceApp`
with `createWebExtPlatform`. The old root `src/` tree has been removed.

## Boundary Goals

- `core` must be independent of browser, Electron, DOM, and filesystem APIs.
- `collectors` owns every source-specific collector, DOM/XML parsing, and the
  collector registry. It may depend on `core`, but `core` must not depend on it.
- `app` owns loading, settings, story state, and the typed client/event API.
- `ui-web` owns shared DOM presentation and depends on `app`, not platforms.
- `persistence` owns PouchDB-specific storage and sync.
- `platform-*` packages implement the ports required by `app`.
- `apps/*` contain entrypoints, packaging, manifests, and target build config.

## Completed

- Imported legacy Chrome and Electron repositories under `legacy/`.
- Created the workspace structure and extracted the shared packages.
- Restored and verified the Firefox development and production builds.
- Removed `core` imports of webextension/UI packages; the boundary baseline is zero.
- Moved all collectors, parser helpers, the registry, and the legacy
  `StoryLoader` into one `@once/collectors` package.
- Made `core` DOM-free and added a boundary check to keep it that way.
- Moved the Firefox entrypoints out of the old source tree.

## Collector Plan

Keep collectors simple for now: one local `@once/collectors` package, bundled
with each application. Dynamic loading, remote collector services, and
per-source packages are explicitly deferred until the application migrations
are complete and there is a demonstrated need.

## Remaining Sequence

1. Add fake-port tests for `OnceApp` reload, settings, story-change, and
   database-change behavior.
2. Remove or explicitly retain the legacy `StoryLoader` and `OnceSettings`
   compatibility APIs after their callers are accounted for.
3. Replace root TypeScript/webpack aliases with an explicit package build
   strategy.
4. Implement real Electron and mobile ports; their current factories only
   return caller-supplied ports.
5. Add Chrome composition/build, then Electron composition/build, using the
   legacy applications as references. Website and mobile come afterward.

## Validation

- `npm run check`: typecheck, boundary check, and Firefox development build.
- `npm run b2`: Firefox production build.

Keep both commands passing for each incremental migration change.

The boundary check prevents collector, platform, UI, persistence, and DOM
dependencies from entering `core`.
