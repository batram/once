# Repository Refactor Handoff

Updated: 2026-07-30 (second pass)

## Goal

Make the repository easier to discover and change, without altering public
package APIs or runtime behavior.

Line and file limits are a smoke detector, not the goal. `check:structure`
tells you where to look; it cannot tell you whether a change helped. Judge each
change on four things instead:

- **Reading span.** Can someone answer "where does X happen and what else does
  it touch?" without opening five files.
- **Explicit dependencies.** A module's collaborators should be visible in its
  imports and constructor, not delivered through a wide callback bag.
- **Testable seams.** Can the extracted behavior be driven directly, with a
  small stub, and does a test exist for the state it owns.
- **Truthful names.** The filename and symbol should say what the thing is.

A change that satisfies the limits while making any of these worse is a
regression, and should be rejected in review even though CI is green.

Maintained references, rather than repeating them here: `docs/CODEMAP.md`
(ownership, composition roots, generated files), `docs/ARCHITECTURE.md`
(package boundaries), `docs/DEVELOPMENT.md` (setup, builds, platform tests),
`knip.jsonc` and `scripts/structure-exceptions.json` (analysis exceptions, with
rationale inline).

## Current state

Guardrails are in place. `npm run check` covers lint, structure, types, dead
code, boundaries, and development builds. Knip models the Electron, extension,
mobile, test, preload, content-script, and background-script entry graphs and
blocks on unused files, exports, and types. Structural exceptions are down from
27 to 20 (8 files, 12 functions).

Settings is nearly finished. `SettingsPanel.ts` owns navigation and composition;
`StructuredSettingsEditors.ts` (1,825 → 629 physical lines, 534 logical) is a facade over
`settings/` and `structuredSettings/`. The 600-line `renderSources` was
genuinely decomposed — nothing in the new source modules exceeds 89 lines — and
the risky drag/reorder behavior has direct tests. Last checkpoint: `npm run
check`, 155 unit tests, 23 collector tests, `check:dead-code`, unfiltered
`knip`. Treat counts as information, not expectations.

`check-structure.js` no longer charges comments against a file's budget, and
exception keys now name one function each: a class member is keyed
`File.ts#Class.member`, an assigned function by its target
(`webpack.webext.config.js#module.exports`), a callback by its call
(`spec.js#test(name)`), and only a function nothing names falls back to
`#<anonymous@line>`. The rules are covered by `tests/unit/check-structure.test.js`
and the exception file was rekeyed in place, so the count is still 20 (8 files,
12 functions). `SourceGroupView.ts` now documents its drag/reorder state
machine, which cost 108 comment lines and no budget.

One known structural problem remains from optimizing for the limits:

**Two files remain too close to the cap.** `SettingsPanel.ts` is at 594
logical lines and `structuredSettings/SourceGroupView.ts` is at 599, against a
600 limit. Comments are free now, so both can be explained, but
`SourceGroupView.ts` cannot absorb a line of code and is not finished merely
because it passes.

## Next changes

The Settings dependency cleanup is complete:

- `createRowBody` and `createRowChevron` are direct imports at their use sites,
  rather than six adapter and test-stub members across the host chain.
- `FlatSettingsEditors.ts` and `SourceSettingsEditor.ts` reuse
  `StructuredFormField`; their domain types come from `redirects.ts` and
  `sourceGroups.ts`, rather than importing back from the parent facade.
- Entering an inline filter detail is one facade-owned operation, rather than
  separate callbacks for mutating detail state and refreshing the add button.
- `showForm` remains a host operation intentionally: it is not a pass-through.
  The facade adds section lifecycle, desktop action preservation, redirect
  tester wiring, editor dismissal, touch presentation, and header ownership.

The remaining host members cross real ownership boundaries: editor lifecycle,
section rendering, persistence, application error presentation, anchored-menu
placement, or access to facade-owned DOM. Do not split them solely to hit an
interface-width target.

### Next: `StoryListItem`

Split markup and action wiring from gesture state, geometry, and animation
completion. Keep `StoryListItem` as the facade and preserve its exports,
selectors, callback order, swipe thresholds, cancellation, and accessibility
labels. Add focused DOM tests per extracted stateful behavior. Retire its
structure exceptions only once the real limits are met — and do not leave the
result at 599 lines.

## Naming and structure

Unresolved and worth deciding before the next extraction, because every commit
adds to it. Filenames currently encode *when* a file was written, not what it
is: roughly 16 of 23 top-level PascalCase files in `packages/ui-web/src` export
no class, so "PascalCase means class" is not a real rule. `SourceRows.ts`
(functions) sits beside `SourceGroupView.ts` (class) and `sourceGroups.ts`
(parse/serialize) — three names, one apparent topic. Nine `Story*` files have
no directory while `reader/`, `picker/`, and `presenters/` do. `settings/` and
`structuredSettings/` are siblings split by owning class rather than feature,
which is why `FlatSettingsEditors` lives under `structuredSettings/`. Three
modules mean "search" and four mean "menu", including `menu.ts`, which is
actually panel navigation.

A candidate rule, mechanically checkable so it does not rely on `CODEMAP.md`
being read: a prefix shared by three or more files becomes a directory and is
dropped from the filenames; `PascalCase.ts` only when the primary export is a
same-named class. Nothing in the Settings cluster is exported from
`packages/ui-web/src/index.ts`, so renames there carry no public-API risk.

Do not rename the `presenters/` symbols (`handle_url`, `presenter_options`,
`story_elem_button`). They are the dynamically invoked presenter contract.

## Refactor invariants

- Do not remove native plugin methods, preload/IPC bridge methods,
  compatibility paths, or other dynamically invoked APIs solely because static
  analysis reports no caller. The same applies to the documented `knip.jsonc`
  dependency exceptions — do not broaden or delete them.
- Preserve public exports, selectors, serialized keys, protocol payloads, and
  native callback shapes.
- Keep `OnceApp` startup loading bounded and persistence lazy.
- Change generated assets at their source; do not edit `dist` or generated
  native web assets directly.
- Do not add a host method that only forwards an importable function.
- A file left at the limit is not finished; leave real headroom or say in the
  commit why the remainder is irreducible.
- Do not move a large function unchanged merely to relocate its exception.

## Later candidates

`scripts/structure-exceptions.json` is the real inventory; this is a suggested
order.

1. Extract loading, working-set, persistence reconciliation, and settings
   access behind the `OnceApp` facade.
2. Continue splitting Electron lifecycle/navigation coordination and mobile
   reading/native-surface coordination.
3. Split the 432-line iOS `AppDelegate.swift` into secure settings, browser
   surface, bridge controller, and application lifecycle. It is under the file
   limit, so no exception flags it.
4. Split `SwipeSettingsLab` gesture simulation from persistence.
5. Split large E2E suites by feature without reducing coverage.

## Workflow

Run from the repository root with Node.js 24 or newer; every relevant command is
an npm script that works on Windows, macOS, and Linux (`npm run check`,
`test:unit`, `test:collectors`, plus the narrower `check:structure` and
`check:dead-code`). Consult `docs/DEVELOPMENT.md` before platform-specific
Electron, extension, Android, or iOS validation, and record any platform suite
you could not run instead of assuming another operating system's paths,
executables, permissions, or sandbox behavior.
