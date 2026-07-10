# Monorepo Migration

## Goal and current state

Firefox is the working reference application. Its entrypoints, public files,
and build output live under `apps/firefox-extension/`, and it uses `OnceApp`
with `createWebExtPlatform`.

Chrome, Electron, website, and mobile are placeholders. Their future
implementations should reuse the shared packages and keep target-specific
entrypoints, packaging, and manifests inside `apps/*`. Legacy Chrome and
Electron repositories remain under `legacy/` as references.

## Package boundaries

- `core`: platform-neutral domain, story, and settings logic; no DOM, platform,
  collector, UI, or persistence dependencies.
- `collectors`: source collectors, parsing helpers, and the collector registry.
- `app`: application orchestration, settings, story state, and client events.
- `ui-web`: shared DOM presentation.
- `persistence`: PouchDB storage and synchronization.
- `platform-*`: target-specific implementations of the ports used by `app`.
- `apps/*`: application composition, entrypoints, assets, and build config.

## Completed

- Created the workspace packages and imported the legacy applications.
- Migrated Firefox to the monorepo and verified development and production
  builds.
- Removed the old root `src/` tree, vendored dependencies, obsolete APIs,
  compatibility shells, forwarding helpers, duplicate exports, and no-op
  backend stubs.
- Consolidated collectors into `@once/collectors` and made `core` DOM-free.
- Added a boundary check that prevents forbidden dependencies in `core`.
- Added package-owned TypeScript builds, declarations, dependencies, and clean
  output handling.
- Made Firefox consume compiled workspace packages through their manifests.
- Deferred dynamic collector loading and per-source collector packages until a
  concrete need appears.

## Next steps

1. Add fake-port tests for `OnceApp` reload, settings, story-change, and
   database-change behavior.
2. Implement real Electron and mobile ports.
3. Build the Chrome and Electron applications, followed by website and mobile.

## Validation

- `npm run build:packages`: build all workspace packages.
- `npm run clean:packages`: remove package build output.
- `npm run check`: typecheck, check boundaries, and build Firefox for
  development.
- `npm run b2`: build Firefox for production.
