# Once Monorepo Migration Plan

## Direction

Use `sidepanel_once_firefox` as the canonical starting repo because it has the
most current code. Keep Firefox working first, then add Chrome, then port the
Electron shell.

Long term GitHub target:

- Rename `batram/once` to `batram/once-electron-legacy`.
- Rename `batram/sidepanel_once` to `batram/sidepanel_once-legacy`.
- Rename `batram/sidepanel_once_firefox` to `batram/once`.

## Target Structure

```text
apps/
  firefox-extension/
  chrome-extension/
  electron/
  website/
  mobile/

packages/
  core/
  ui-web/
  platform-webext/
  platform-electron/
  platform-web/
  platform-mobile/
  persistence/

legacy/
  sidepanel_once/
  once-electron/
```

## Boundaries

- `packages/core`: stories, sources, parsers, collectors, filters, redirects,
  settings model, sync rules, repository interfaces.
- `packages/ui-web`: DOM UI shared by extension, website, and maybe Electron.
- `packages/platform-webext`: Firefox/Chrome APIs, manifests, background,
  side panel/sidebar glue.
- `packages/platform-electron`: Electron main process, preload, IPC, windows,
  tabs, filesystem glue.
- `apps/*`: packaging, build entrypoints, target-specific config.

Core must not import `browser`, `chrome`, `electron`, `document`, `window`, or
filesystem APIs.

## Preserve Git History

Import old repos as subtrees under `legacy/`:

```bash
git remote add legacy-chrome https://github.com/batram/sidepanel_once.git
git remote add legacy-electron https://github.com/batram/once.git
git fetch legacy-chrome
git fetch legacy-electron

git subtree add --prefix=legacy/sidepanel_once legacy-chrome master
git subtree add --prefix=legacy/once-electron legacy-electron master
```

This keeps old commit history available without making the first migration too
fragile.

## Migration Steps

1. Create a migration branch: `codex/monorepo-structure`.
2. Tag current repo tips before moving code:
   - `pre-monorepo-firefox`
   - `pre-monorepo-chrome`
   - `pre-monorepo-electron`
3. Import Chrome and Electron legacy repos under `legacy/` with `git subtree`.
4. Add the workspace skeleton: `apps/` and `packages/`.
5. Move Firefox app packaging into `apps/firefox-extension/`.
6. Extract platform-neutral modules into `packages/core/`.
7. Split `OnceSettings` into core services plus platform adapters.
8. Split `StoryLoader` so core handles loading/parsing and UI handles status.
9. Move shared DOM UI into `packages/ui-web/`.
10. Add `packages/platform-webext/` adapters and restore the Firefox build.
11. Add Chrome manifest/build using the old Chrome repo as reference.
12. Add Electron shell using the old Electron repo as reference.
13. Add website/mobile only after the core and web UI boundaries are stable.

## Commit Plan

```text
1. Import legacy Chrome and Electron repos under legacy/
2. Add workspace and package skeleton
3. Move Firefox app files under apps/firefox-extension
4. Extract core story/parser/collector modules
5. Extract shared web UI package
6. Add webextension platform adapters
7. Restore Firefox build
8. Add Chrome manifest and build
9. Add Electron shell
```
