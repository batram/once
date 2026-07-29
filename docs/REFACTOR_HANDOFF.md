# Repository Refactor Handoff

Updated: 2026-07-30

## Goal

Make the repository easier to discover and change without altering public
package APIs or runtime behavior. Prefer small, behavior-preserving extractions
behind existing facades.

Use these maintained references instead of repeating architecture details here:

- `docs/CODEMAP.md` for ownership, composition roots, generated files, and
  common change locations;
- `docs/ARCHITECTURE.md` for package boundaries and runtime structure;
- `docs/DEVELOPMENT.md` for platform-specific setup, builds, and tests;
- `knip.jsonc` and `scripts/structure-exceptions.json` for documented analysis
  exceptions.

## Current state

The discovery and guardrail work is in place:

- `npm run check` covers lint, structure, types, dead code, boundaries, and
  development builds.
- Knip models the Electron, extension, mobile, test, preload, content-script,
  and background-script entry graphs. Its blocking check includes unused files,
  exports, and types.
- Dynamic dependency exceptions are narrow and documented in `knip.jsonc`.
- Electron IPC registration and several large Settings responsibilities have
  been split into focused modules.

For Settings, `SettingsPanel.ts` now mainly owns navigation and composition.
Persistence, summaries, subscriptions, highlighting, control binding, flat
filter/redirect editing, redirect testing, shared forms and add controls,
source state/editing, source rows, source groups, and source/group reorder
behavior have been extracted. `StructuredSettingsEditors.ts` remains the
public facade.

The last verified checkpoint passed:

- `npm run check`
- `npm run test:unit` (143 tests)
- `npm run test:collectors` (23 tests)
- `npm run check:dead-code`
- `npm exec knip -- --no-progress`
- focused mobile source-group Playwright tests (2 tests)
- `git diff --check`

Treat test counts as checkpoint information, not fixed expectations.

## Next change

Split `StoryListItem` markup/actions from swipe geometry and animation.

1. Keep `StoryListItem` as the public facade and preserve its existing exports.
2. Separate markup and action wiring from gesture state, geometry, and
   animation completion.
3. Preserve selectors, callback order, swipe thresholds, cancellation, and
   accessibility labels.
4. Add focused DOM tests for each extracted stateful behavior.
5. Remove the related `StoryListItem.ts` structure exceptions only after the
   facade and extracted functions meet the enforced limits.

## Refactor invariants

- Do not remove native plugin methods, preload/IPC bridge methods,
  compatibility paths, or other dynamically invoked APIs solely because static
  analysis reports no caller.
- Preserve public exports, selectors, serialized keys, protocol payloads, and
  native callback shapes.
- Keep `OnceApp` startup loading bounded and persistence lazy.
- Change generated assets at their source; do not edit `dist` or generated
  native web assets directly.
- Review current callers and runtime entrypoints before moving code.
- Add focused regression tests, then run the broad checks appropriate to the
  affected packages.

## Later candidates

After Settings, take one behavior-preserving area at a time:

1. Extract loading, working-set, persistence reconciliation, and settings
   access behind the `OnceApp` facade.
2. Continue splitting Electron lifecycle/navigation coordination and mobile
   reading/native-surface coordination.
3. Split `SwipeSettingsLab` gesture simulation from persistence.
4. Split large E2E suites by feature without reducing coverage.

Re-check `scripts/structure-exceptions.json` before selecting work; it is the
current inventory, while this list is only a suggested order.

## Portable workflow

Run commands from the repository root with Node.js 24 or newer. These commands
work through npm on Windows, macOS, and Linux:

```text
git status --short
git log -2 --oneline
npm ci
npm run check:structure
npm run check:dead-code
npm run check
npm run test:unit
npm run test:collectors
git diff --check
```

Run only the installation step when dependencies need to be restored. Consult
`docs/DEVELOPMENT.md` for platform-specific Electron, extension, Android, and
iOS validation. Record any platform suite that could not be run rather than
assuming another operating system's paths, executables, permissions, or
sandbox behavior.
