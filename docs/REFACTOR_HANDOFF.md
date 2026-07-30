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

The function limit reads differently in `tests/`. A `test()` body has no
callers and no collaborators, so "extract something" is not available to it —
the only moves are pushing assertions into a helper, which costs reading span,
or splitting into more tests, which is a coverage decision. So when the limit
flags a test, ask whether the test has one subject rather than how long it is.
Three subjects sharing a fixture should be three tests; one continuous
scenario that happens to be long should keep an exception saying why. Measured
across 308 test callbacks, the limit flags two, so it is cheap either way.
The file limit is the one that earns its keep in `tests/`: it is what surfaced
the 2189-line mobile suite.

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
27 to 17 (7 files, 10 functions).

### Next: `OnceApp`

Extract loading, working-set, persistence reconciliation, and settings access
behind the `OnceApp` facade, preserving its public API. Keep startup loading
bounded and persistence lazy. Add tests per extracted service, and retire its
structure exception only once the real limits are met.

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

1. Continue splitting Electron lifecycle/navigation coordination and mobile
   reading/native-surface coordination.
2. Split `SwipeSettingsLab` gesture simulation from persistence. Its preview
   row now drives `story/swipe/` directly, so the seam is on the lab side.

The large E2E suites are split and no test file carries an exception any more.
`mobile-web.spec.js` became ten feature specs over `tests/e2e/mobile/helpers/`,
and `core-browser.spec.js` became seven. Both retired their exceptions.

## Workflow

Run from the repository root with Node.js 24 or newer; every relevant command is
an npm script that works on Windows, macOS, and Linux (`npm run check`,
`test:unit`, `test:collectors`, plus the narrower `check:structure` and
`check:dead-code`). Consult `docs/DEVELOPMENT.md` before platform-specific
Electron, extension, Android, or iOS validation, and record any platform suite
you could not run instead of assuming another operating system's paths,
executables, permissions, or sandbox behavior.
