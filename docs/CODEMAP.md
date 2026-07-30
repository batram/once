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
| Loading, settings, story state | `packages/app/src/OnceApp.ts`, `packages/app/src/AppRuntime.ts` | Public facade and application service composition |
| PouchDB storage and sync | `packages/persistence/src` | Storage implementations |
| Story list and actions | `packages/ui-web/src/story` | Shared DOM UI |
| Story and settings popup menus | `packages/ui-web/src/menu` | Action model plus anchored renderer |
| Panel navigation and status surfaces | `packages/ui-web/src/shell` | Sidebar, panels, overlays |
| Touch and drag gestures | `packages/ui-web/src/gesture` | Shared gesture plumbing |
| Settings UI | `packages/ui-web/src/settings` | Panel, persistence, structured editors, search, and form helpers |
| Reader extraction and display | `packages/ui-web/src/reader` | Shared reader runtime |
| Source picker | `packages/ui-web/src/picker` | Shared picker plus platform injection |
| Electron tabs and windows | `apps/electron/src/TabManager.ts` | Main-process ownership |
| Mobile reading view | `apps/mobile/src/readingController.ts` | Current-story DOM interaction |
| Mobile reading surface | `apps/mobile/src/readingSurfaceCoordinator.ts` | Native session and surface lifecycle |
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

## Settings ownership

All paths below are under `packages/ui-web/src`.

- `settings/SettingsPanel.ts` owns settings navigation and composes
  collaborators.
- `settings/SettingsPersistence.ts` owns persisted theme, animation, cache, and
  sync restoration.
- `settings/settingsControlBindings.ts`, `settingsSubscriptions.ts`,
  `settingsSummaries.ts`, `syncSettingsControls.ts`, and
  `textareaHighlight.ts` own DOM control wiring and derived presentation.
- `settings/StructuredSettingsEditors.ts` remains the structured-settings
  facade over `settings/structured/`.
- `settings/structured/FlatSettingsEditors.ts` owns filter and redirect list
  state, rendering, editing, and saving.
- `settings/structured/SourceSettingsEditor.ts` owns the sources section, with
  `SourceGroupView.ts` for group rendering and reordering and `sourceRows.ts`
  for one source row.
- `gesture/dragReorder.ts` owns reusable row reordering and drag-edge
  scrolling, shared with the story list rather than owned by settings.

## Story row ownership

All paths below are under `packages/ui-web/src/story`.

- `StoryListItem.ts` is the `story-item` custom element and the row's public
  API: its lifecycle, the state it reflects (read, bookmark, filter), and the
  actions the context menu calls (`openStory`, `toggleReadState`,
  `confirmPurge`, the `*ActionLabel` getters). It composes the modules below
  rather than containing them.
- `storyRowMarkup.ts` builds the title line and the filter and purge buttons,
  and exports `createIconButton`, the row's shared button shape — presenters
  use it so a collector-specific action looks like the built-in ones.
- `storyRowSubstories.ts` builds the per-source lines under the title.
- `storyLinks.ts` owns anchor behaviour on a row: claiming clicks and
  middle-clicks from the browser, and marking a story read when its URL opens.
- `storyExitTransition.ts` owns completing a row's slide-out even when the
  transition is cancelled.

`story/swipe/` is the two-stage swipe, split by what each part owns:

- `geometry.ts` is the model alone — travel to stage, resting position, and
  action. No DOM, so it is driven directly from tests.
- `track.ts` owns one drag: its origin, travel, the stage a release would
  commit, and moving the row.
- `revealLayer.ts` owns the `.bb_slide` panel revealed behind the row.
- `stageLock.ts` owns fast-swipe protection for stage two.
- `gesture.ts` owns the input half only — which events drive a drag and when
  the document listeners go up and come down — and is what `StoryListItem`
  calls as `attachStorySwipe`.
- `commit.ts` runs what a released swipe selected, routing through
  `menu/storyContextMenu` so the reader and filter paths stay in one place.

## Naming

`packages/ui-web/src` follows the convention the rest of the repo already uses:

- A directory groups a feature; filenames keep their full descriptive name
  rather than dropping the prefix the directory implies.
- `PascalCase.ts` only when the primary export is a same-named class
  (`story/StoryListItem.ts`, `settings/structured/SourceGroupView.ts`).
  Everything else is a camelCase module (`story/storyList.ts`,
  `settings/settingsSummaries.ts`).
- A filename says what the module is, not what it was written beside:
  `shell/panelNavigation.ts` is panel navigation, and
  `settings/structured/structuredSearch.ts` filters rows within one structured
  list — neither is the story search in `story/storySearch.ts`.

- A namespace export in `index.ts` carries its module's name, so the import
  site names the file it came from: `StoryList`, `StorySearch`, and
  `PanelNavigation`.

`presenters/` keeps its `handle_url`, `presenter_options`, and
`story_elem_button` symbols; they are the presenter contract. The remaining
snake_case exports (`open_panel`, `show_filter_dialog`) are unconverted, not
deliberate.

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
