# Repository Refactor Handoff

Updated: 2026-07-29

## Objective

Make the repository faster for humans and AI agents to discover, understand,
and change without altering public package APIs or runtime behavior.

The agreed direction is to:

- remove confirmed dead code and analysis noise;
- document composition roots, ownership, dynamic entrypoints, generated output,
  inactive roadmap surfaces, and common change locations;
- split large mixed-responsibility modules behind their existing public facades;
- normalize filenames and touched TypeScript symbols;
- enforce file/function size and dead-code guardrails;
- reindex the repository after each structural phase.

Native plugin methods, IPC bridge methods, compatibility paths, and other
dynamically invoked APIs must not be removed solely because a static graph shows
zero callers.

## Completed work

### Commit `874c8e2` — `refactor repo discovery and structural guardrails`

- Added `docs/CODEMAP.md` and linked it from the root README.
- Expanded `docs/ARCHITECTURE.md` with feature-level boundaries.
- Documented inactive roadmap surfaces, generated/native files, vendored
  assets, and dynamic entrypoints.
- Removed the unreachable legacy video presenter and vendored video assets.
- Removed confirmed dead presenter/menu hooks and Capacitor template tests.
- Renamed `presenters_frontend.ts` to `presenters/registry.ts`.
- Renamed affected collector files from snake_case to camelCase.
- Split Electron IPC registration by domain.
- Added structural limits and the `check:structure` command.
- Added Knip and an initial `check:dead-code` command.
- Preserved the `OnceApp` bounded working set and lazy persistence behavior.

### Commit `a1f57a6` — `fix dead-code analysis entry graph`

This fixed a review finding that the initial Knip gate did not model the
repository entry graph adequately.

- Added explicit Knip workspace and runtime entrypoints for Electron,
  extensions, mobile, tests, preload, content scripts, and background scripts.
- Disabled automatic Webpack config loading. The shared extension Webpack
  config requires `--env target=chrome|firefox`, so allowing Knip to load it
  automatically caused graph discovery to abort.
- Removed broad collector, presenter, website, and platform-web ignores.
- Changed the blocking gate to analyze unused files as well as exports/types:
  `knip --include files,exports,types --no-progress`.
- Replaced namespace-only collector registration with explicit capability
  objects so Knip can see which individual collector exports are live.
- Added type predicates for optional global/domain search capabilities.
- Replaced the outline presenter namespace cast with explicit registration.
- Removed confirmed-dead outline presenter URL-bar and legacy presentation code.

The repaired gate was tested with a temporary unused export inside an internal
collector module. It reported the export and exited with status 1. The canary
was then removed.

### Commit `ea987eb` — `Tighten package export surfaces`

- Enabled `includeEntryExports` for package entrypoints that define public
  surfaces.
- Removed exports that were proven internal and unused.
- Kept runtime entrypoints explicit so content scripts and background scripts
  remain part of the analysis graph.
- Did not remove the underlying implementations or change runtime behavior.

### Commit `ca47b07` — `Clean up dependency analysis ownership`

- Moved Playwright, Electron, and the mobile test server's
  Express/Express-PouchDB/PouchDB declarations to the root test harness that
  imports them.
- Removed the genuinely unused `copyfiles` declaration and duplicate root
  `pouchdb-browser` declarations. Platform packages retain their own
  `pouchdb-browser` dependencies.
- Kept Electron Forge, Webpack loader, Capacitor native plugin, WebdriverIO,
  Appium service, and Appium driver dependencies with their runtime owners.
- Replaced `knip.json` with commented `knip.jsonc` so every dynamic dependency
  exception has an adjacent rationale.
- Retained the entry-export analysis added in `ea987eb`; no barrel exports or
  package export surfaces were changed.
- Tested removing `types: ["*"]` from `tsconfig.base.json`. Full package
  type-checking proved it is still required for ambient PouchDB, Firefox
  `browser`, and NodeJS declarations, so it was restored and the single Knip
  unresolved finding is suppressed by file and issue type.

### Settings refactor checkpoint

- Kept `StructuredSettingsEditors` as the public facade while extracting
  source-group, filter, and redirect parsing/serialization; structured-list
  search/navigation; and shared form/action/list-card construction.
- Kept the existing parser helper exports available from
  `StructuredSettingsEditors`.
- Extracted theme, animation, cache, and sync restoration behavior from
  `SettingsPanel` into `settings/SettingsPersistence.ts`.
- Removed `LoaderInsights`' import-time dependency on the
  `SettingsPanel.instance` singleton. `mountOnceUi` now supplies its
  clear/highlight/show actions from the UI composition layer.
- Removed the `require.cache` SettingsPanel shim from
  `notifications.test.js` and added assertions for the injected actions.
- Updated `docs/CODEMAP.md` with the new Settings ownership directories.
- Fixed the mobile test server's `ERR_PACKAGE_PATH_NOT_EXPORTED` startup
  failure. The global UUID 11 security override remains, while the test-only
  legacy `express-pouchdb@4.2.0` dependency receives a scoped `uuid@3.4.0`
  override because it still imports `uuid/v4`.

## Verification completed

After the Settings checkpoint:

- `npm run check` passed.
- `npm run test:unit` passed: 134 tests.
- `npm run test:collectors` passed: 23 tests.
- Focused Settings and notification tests passed: 10 tests.
- `npm run check:dead-code` passed.
- Unfiltered `npx knip --no-progress` exited 0 with no dependency findings.
- `git diff --check` passed.
- A full codebase-memory MCP reindex succeeded:
  - project: `once`
  - nodes: 3,406
  - edges: 8,609
  - build/package output directories were excluded.

On this Windows host, package builds can fail inside the sandbox with `EPERM`
while updating committed/generated `dist` output. Retry the unchanged command
under the normal Windows identity; do not delete output or alter permissions
unless the escalated retry also fails.

CI already runs `npm run check`, unit tests, and collector tests in its quality
job. Extension and Electron suites run in separate jobs. No CI test wiring
change is currently needed.

## Known limitations and follow-up findings

Unfiltered Knip is clean apart from one non-error configuration hint claiming
that the explicitly listed mobile Webpack config is redundant. Keep that entry:
with automatic Webpack plugin loading disabled, omitting the explicit entry
makes `apps/mobile/webpack.config.js` appear unused.

The remaining narrow dependency-analysis exceptions are justified in
`knip.jsonc`:

- ambient `@types/firefox-webext-browser` and the `types: ["*"]` compiler
  wildcard;
- `ts-loader`, Electron Forge CLI/makers, and CSS loaders resolved from paths
  or string-valued configuration;
- Capacitor plugins linked into generated Android and iOS projects;
- WebdriverIO/Appium CLI, service, runner, framework, reporter, and platform
  drivers loaded dynamically by the native E2E harness.

Do not broaden these exceptions or remove dynamically invoked dependencies
solely because a static graph reports no import.

`npm ls` currently reports a separate Appium subtree inconsistency: installed
`uuid@14` copies do not satisfy their parents' `^11.1.1` declarations. This did
not cause the mobile test-server failure and was not changed in the Settings
checkpoint.

The scoped `express-pouchdb` UUID 3 dependency is confined to the local mobile
test server. `express-pouchdb@4.2.0` still uses the removed `uuid/v4` CommonJS
subpath. Replacing that legacy server would allow the compatibility dependency
to be removed.

The locally ignored `AGENTS.md` policy was intentionally left unchanged.
Locally ignored planning notes such as `docs/dreams_of_road.txt` and
`docs/once_todo.txt` were not part of the committed refactor.

## Recommended next commit

Finish the remaining Settings extraction behind the existing facades:

1. Move the stateful source/source-group renderer and editing behavior out of
   `StructuredSettingsEditors`.
2. Move filter and redirect rendering/editing, redirect testing, and
   drag/reorder behavior into focused modules.
3. Reduce `SettingsPanel` further by extracting summaries, textarea
   highlighting, and constructor control/event setup.
4. Preserve every selector, serialized setting, public facade method, and
   visible behavior; add focused DOM tests around each stateful extraction.
5. Remove the `SettingsPanel.ts` and `StructuredSettingsEditors.ts` structural
   exceptions only after both files fall below the enforced limits.

## Later structural phases

Land each phase as a separate behavior-preserving commit:

1. **Settings**
   - Split the structured editor into source, source-group, filter, redirect,
     form, drag/reorder, and search-navigation modules.
   - Reduce `SettingsPanel` to navigation/composition and extract persistence,
     summaries, highlighting, and control setup.
   - Remove `LoaderInsights`' dependency on the `SettingsPanel.instance`
     singleton. Supply its clear/highlight/show actions through an injected
     collaborator from the UI composition layer, then remove the
     `require.cache` SettingsPanel shim from `notifications.test.js`.
2. **Story list**
   - Separate story markup/actions from swipe state, geometry, animation, and
     transitions.
   - Keep `StoryListItem` as the public facade.
3. **Application orchestration**
   - Keep `OnceApp` as the facade.
   - Extract source loading/error reporting, working-set management,
     persistence/change reconciliation, and settings access.
   - Preserve bounded startup loading and lazy persistence.
4. **Platform composition**
   - Continue separating Electron tab/window lifecycle from navigation,
     Reader, and source-picker coordination.
   - Split iOS secure settings, browser surface, bridge controller, and
     application lifecycle into separate Swift files.
   - Split mobile reading rendering, browser-surface synchronization, and
     collapsed-card swipe behavior.
   - Split `SwipeSettingsLab` preview/gesture simulation from persistence.
5. **Tests**
   - Split large E2E suites by feature without weakening coverage.

For each phase:

- inspect current callers and dynamic entrypoints with codebase-memory MCP;
- preserve exports, selectors, serialized keys, IPC/plugin protocol shapes, and
  native callbacks;
- add focused regression tests around extracted behavior;
- run full lint, structure, dead-code, type, boundary, and build checks;
- run relevant unit/integration/E2E tests;
- reindex before trusting graph-based impact analysis.

## Useful starting commands

```powershell
git status --short
git log -2 --oneline
npm run check:dead-code
npx knip --no-progress
npm run check
npm run test:unit
npm run test:collectors
```

Before graph analysis, list MCP projects and reindex `C:\Users\mjb\develop\once`
if the index is absent, stale, or the branch has changed.
