# Repository Refactor Handoff

Updated: 2026-07-30

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
`StructuredSettingsEditors.ts` (1,825 → 634 lines) is a facade over
`settings/` and `structuredSettings/`. The 600-line `renderSources` was
genuinely decomposed — nothing in the new source modules exceeds 89 lines — and
the risky drag/reorder behavior has direct tests. Last checkpoint: `npm run
check`, 146 unit tests, 23 collector tests, `check:dead-code`, unfiltered
`knip`, `git diff --check`. Treat counts as information, not expectations.

Three known problems, all created by optimizing for the limits:

1. **Two files sit one line under the cap.** `SettingsPanel.ts` and
   `structuredSettings/SourceGroupView.ts` are both at 599 logical lines
   against a 600 limit. Neither is finished; both are unable to absorb a
   comment without failing CI.
2. **Comments are charged against the budget.** `logicalLines` in
   `scripts/check-structure.js` strips `//` but counts `/** */`. Every new
   Settings module landed with zero block comments while the facade kept all
   44 — including `SourceGroupView.ts`, which holds the hardest state machine
   in the package and explains none of it.
3. **Host callback bags replaced imports.** Extraction produced five host
   interfaces totalling ~47 members (`FlatSettingsHost` 15,
   `SourceSettingsHost` 13, `SourceRowHost` 9, `StructuredAddButtonHost` 7,
   `SourceGroupHost` 3). Some entries are pure pass-through —
   `rowBody: (...children) => createRowBody(...children)` appears in two
   adapters, delivering a `form.ts` function to modules that already import
   from `form.ts`.

## Next changes

Finish the quality debt before starting a new area. These are small and
independent of each other.

### 1. Make the limit measure code, not prose

In `scripts/check-structure.js`: exclude `/* */` and `/** */` lines from
`logicalLines`, and key anonymous-function exceptions by position or enclosing
member instead of collapsing them to `file#<anonymous>`. Today a single
`file#<anonymous>` entry exempts every unnamed function in that file, present
and future — five such entries exist. Do this first; it is what unblocks the
next item.

### 2. Explain the state machines that were just moved

`structuredSettings/SourceGroupView.ts` owns group expansion, drag/reorder,
drop targets, and collapse restoration, and documents none of it. Add the
"why" comments: what invariant each piece of mutable state protects, and why
the reorder commits where it does. Same for the touch reorder path. This is the
change most likely to save a future reader an hour, and it is currently
impossible without item 1.

### 3. Collapse the host bags back into imports

- Delete pass-through adapter entries and import `createRowBody`,
  `createRowChevron`, and `showStructuredForm` from `form.ts` at the point of
  use.
- Migrate `structuredSettings/FlatSettingsEditors.ts`, which was not updated
  when `form.ts` absorbed those primitives: it still routes them through its
  host, declares its own `FormFields` type duplicating `form.ts`'s
  `StructuredFormField`, and type-imports `RedirectRow` from the parent facade.
- Target: no host interface wider than about 8 members, and no host method that
  only forwards a free function.

Expect this to reduce total lines and shrink the test stubs; if it does not,
say so and stop.

### 4. Then `StoryListItem`

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
