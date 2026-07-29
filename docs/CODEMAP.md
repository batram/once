# Code map

Use this page as the starting point for source discovery. `ARCHITECTURE.md`
defines the dependency rules; this page identifies the concrete entrypoints
and ownership boundaries.

## Composition roots

| Target | Composition root | Platform-specific code |
| --- | --- | --- |
| Firefox | `packages/webext-shell/src/sidepanel.ts` | `apps/firefox-extension` |
| Chrome | `packages/webext-shell/src/sidepanel.ts` | `apps/chrome-extension` |
| Electron | `apps/electron/src/main.ts`, `renderer.ts`, `preload.ts` | `apps/electron/src/browser` |
| Android/iOS | `apps/mobile/src/main.ts` | `apps/mobile/android`, `apps/mobile/ios` |
| Website | Not active | `apps/website`, `packages/platform-web` |

Applications are composition roots. Reusable behavior belongs in a package;
target lifecycle, permissions, native bridges, and packaging belong in an app.

## Feature lookup

| Change | Start here | Related boundary |
| --- | --- | --- |
| Story model, comparison, filtering | `packages/core/src/story` | Platform-neutral and DOM-free |
| Source parsing and collectors | `packages/collectors/src` | May depend only on core |
| Loading, settings, story state | `packages/app/src/OnceApp.ts` | Application orchestration |
| PouchDB storage and sync | `packages/persistence/src` | Storage implementations |
| Story list and actions | `packages/ui-web/src/StoryListItem.ts` | Shared DOM UI |
| Settings UI | `packages/ui-web/src/SettingsPanel.ts`, `packages/ui-web/src/settings`, `packages/ui-web/src/structuredSettings` | Facade, persistence, structured editors, search, and form helpers |
| Reader extraction and display | `packages/ui-web/src/reader` | Shared reader runtime |
| Source picker | `packages/ui-web/src/picker` | Shared picker plus platform injection |
| Electron tabs and windows | `apps/electron/src/TabManager.ts` | Main-process ownership |
| Mobile reading surface | `apps/mobile/src/readingController.ts` | Web/native coordination |
| Native browser bridge | `packages/platform-mobile/src/InAppBrowserSurface.ts` | Capacitor-facing adapter |

## Source classifications

- **Authored source:** `apps/*/src`, `packages/*/src`, `scripts`, and `tests`.
- **Generated output:** `**/dist`, Electron `.webpack`/`out`, mobile build
  directories, generated mobile web assets, reports, and test results. Never
  edit these by hand or include them in source analysis.
- **Generated native scaffolding:** Gradle/Xcode project metadata, launcher and
  splash variants, wrapper files, and Capacitor package scaffolding under
  `apps/mobile/android` and `apps/mobile/ios`. Keep these committed when the
  native toolchain requires them, but start analysis in the authored Java and
  Swift bridge files.
- **Dynamic entrypoints:** Electron preload/IPC handlers, WebExtension
  background listeners, Capacitor plugin methods, native lifecycle callbacks,
  and HTML-loaded scripts. A missing static caller is not proof that these are
  dead.
- **Inactive roadmap surfaces:** `apps/website` and `packages/platform-web`.
  They remain buildable placeholders but are not part of current product
  composition.
- **Vendored assets:** opaque third-party or minified files are not authored
  source and must live outside `src` or be excluded explicitly.

## Dependency direction

```text
apps -> shells / UI / platform adapters -> app -> collectors -> core
                                  |                    |
                                  +-> persistence ----+
```

Run `npm run check:boundaries` after moving imports across packages. Do not add
new exceptions to the boundary baseline without an architectural decision.

## Common changes

- Add a collector in `packages/collectors/src/collectors`, register it in
  `registry.ts`, then add contract fixtures and unit coverage.
- Add shared behavior through an application port rather than importing a
  platform adapter from `ui-web`.
- Add Electron browser behavior in the main-process browser modules and expose
  only the minimum typed preload/IPC surface.
- Add native mobile behavior as a Capacitor bridge plus a TypeScript adapter;
  keep Android and iOS event/payload shapes aligned.
- Change generated assets at their canonical source and run the owning build;
  do not patch `dist` or native generated web assets.
