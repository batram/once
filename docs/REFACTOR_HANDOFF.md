# Repository Refactor Handoff

Updated: 2026-07-30 (work-package plan)

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

The function limit reads differently in `tests/`. A `test()` body has no
callers and no collaborators, so "extract something" is not available to it —
the only moves are pushing assertions into a helper, which costs reading span,
or splitting into more tests, which is a coverage decision. Ask whether a
flagged test has one subject rather than how long it is. Three subjects sharing
a fixture should be three tests; one continuous scenario that happens to be
long should keep an exception saying why. The file limit is the useful test
signal: it surfaced the former 2189-line mobile suite.

Maintained references, rather than repeating them here: `docs/CODEMAP.md`
(ownership, composition roots, generated files), `docs/ARCHITECTURE.md`
(package boundaries), `docs/DEVELOPMENT.md` (setup, builds, platform tests),
`knip.jsonc` and `scripts/structure-exceptions.json` (analysis exceptions, with
rationale inline).

## Current state

Guardrails are in place. `npm run check` covers lint, structure, types, dead
code, boundaries, and development builds. Knip models the Electron, extension,
mobile, test, preload, content-script, and background-script entry graphs and
blocks on unused files, exports, and types.

The live inventory is `scripts/structure-exceptions.json`: 4 function
exceptions. One is opportunistic cleanup and three are accepted
exceptions that are not refactor work: the cohesive pull-to-refresh gesture,
declarative Webpack configuration, and the intentionally linear Electron
diagnostic scenario.

The large E2E suites are already split and no test file carries a file
exception. `mobile-web.spec.js` became ten feature specs over
`tests/e2e/mobile/helpers/`, and `core-browser.spec.js` became seven.

## Work-package rule

Complete exactly one package at a time, in the order below. A package is not an
invitation to make the first extraction and leave the repository between
designs.

For every package:

1. Read the affected implementation, its direct tests, and the relevant
   architecture/codemap sections before editing.
2. Make all extractions needed for the stated boundary in one working session.
   Preserve the public facade and behavior; do not leave temporary adapters,
   duplicate implementations, TODO migrations, or an exception relocated to a
   new file.
3. Add direct tests for each new state owner or pure policy. Keep existing
   integration coverage.
4. Remove the package's entries from `scripts/structure-exceptions.json`.
   Run `npm run check` and the relevant unit/integration suites. Perform the
   platform validation described in `docs/DEVELOPMENT.md` when available, and
   record any platform suite that could not be run.
5. Review the diff for reading span, explicit dependencies, testable seams,
   and truthful names. The package is unfinished if it merely passes a line
   limit.
6. Commit the complete package as one focused commit before starting the next
   package. Do not begin a later package while the current one is uncommitted.

If a package cannot be completed without changing a public API or an invariant
below, stop and update this handoff with the concrete blocker. Do not commit a
half-extracted architecture.

## Opportunistic cleanup, not a scheduled package

`BrowserShell.render` is 122 lines against a 120-line limit. The two-line
overage is not by itself a design problem. During related Electron shell work,
it may be split into tab-strip rendering and active-navigation-control
rendering if that produces useful named seams and direct tests. Until then its
documented exception is preferable to helpers created only to satisfy the
counter. Do not interrupt the ordered packages solely to retire it.

## Accepted structural exceptions

These are reviewed decisions, not pending refactors:

- `attachPullToRefresh` is one gesture state machine whose handlers
  intentionally share closure state. Splitting it would spread one event
  sequence across files or replace closure state with fields without producing
  a new owner.
- `scripts/webpack.webext.config.js#module.exports` is a declarative build
  entrypoint. Extracting fragments of one configuration object would increase
  reading span.
- The Electron `story-list.debug.js` callback is one numbered diagnostic
  journey with shared process, fixture, checkpoint, logging, failure capture,
  and cleanup lifetime. Moving its steps behind helpers or separate tests
  would weaken the diagnostic narrative.

Revisit an accepted exception only when its responsibility changes, not when a
limit changes or nearby lines are added. Its rationale in
`scripts/structure-exceptions.json` must continue to describe why the code is
cohesive rather than merely saying that an exception exists.

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
- A file left at the limit is not finished; leave real headroom or explain why
  the remainder is irreducible.
- Do not move a large function unchanged merely to relocate its exception.

## Validation

Run from the repository root with Node.js 24 or newer. Every relevant command
is an npm script that works on Windows, macOS, and Linux: `npm run check`,
`test:unit`, `test:collectors`, plus narrower checks such as
`check:structure` and `check:dead-code`.

Consult `docs/DEVELOPMENT.md` before Electron, extension, Android, or iOS
validation. Record platform suites that could not be run instead of assuming
another operating system's paths, executables, permissions, or sandbox
behavior.
