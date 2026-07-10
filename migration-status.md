# Monorepo Migration Status

## Current State

- Firefox is the only active, verified application composition.
- Its entrypoints are in `apps/firefox-extension/src/`; assets and manifest are
  in `apps/firefox-extension/public`; output is `apps/firefox-extension/dist`.
- The sidepanel uses `OnceApp`/`OnceClient` and `createWebExtPlatform`.
- `apps/chrome-extension`, `apps/electron`, `apps/website`, and `apps/mobile`
  are package placeholders, not working application builds.

## Complete

- Shared core, app, DOM UI, persistence, and platform packages exist.
- Firefox has working development and production webpack builds.
- The legacy root `src/` tree and its unused vendored Readability/PouchDB files
  have been removed.
- `packages/core` has no prohibited imports from webextension or UI packages;
  the checked boundary baseline is zero.
- Collector-generated UI styles now live in `ui-web`, and `Story` no longer
  uses `document` to build stored content.
- All active collectors, parsing helpers, and the registry now live in one
  `@once/collectors` package.
- The unused legacy `StoryLoader` compatibility API has been removed; source
  loading is owned by `OnceApp`.
- The unused legacy `OnceSettings` singleton API has been removed; settings
  access is owned by `OnceApp` and its platform ports.
- Every `@once/*` package builds JavaScript and declarations into its own
  `dist/` directory through TypeScript project references. Package manifests
  declare their real dependencies and compiled entrypoints.
- Firefox resolves workspace packages through their manifests; the root
  TypeScript paths and duplicated webpack aliases have been removed.
- `packages/core` is DOM-free. The boundary check rejects DOM, collector,
  platform, UI, and persistence dependencies in core.
- Dynamic collector loading and per-source packages are deferred.

## next steps

1. Clean up the remaining migration compatibility code now that package
   boundaries and build outputs are explicit.

## future steps

- Test suite
- Implement real Electron/mobile ports, then build Chrome and Electron apps.

## Commands

- `npm run build:packages`: incrementally build all workspace packages.
- `npm run clean:packages`: remove TypeScript package build outputs.
- `npm run check`: typecheck, boundary check, and Firefox development build.
- `npm run b2`: Firefox production build.

Legacy Chrome and Electron repositories remain under `legacy/` as reference
material for their later ports.
