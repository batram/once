# Mobile redesign — handoff

Branch: `mobile-redesign-swipe` (branched from `main` at `b353af0`, not pushed)

- `f64fdb5` — prototype + brief, checked into `docs/Mobile app redesign with swipe/`
- `9f23f6b` — stages 1–3 implemented

Read alongside:
- `docs/Mobile app redesign with swipe/MOBILE_REDESIGN_BRIEF.md` — what to build
- `docs/MOBILE_REDESIGN_PLAN.md` — the staged plan, stages 4–9 still pending

## Done and verified

**Stage 1 — four-slot story row** (§1). Mobile-only CSS in `apps/mobile/src/mobile.css`.
`story_html()` is untouched, so Electron and the extensions are unaffected by
construction.

**Stage 2 — kebab button + anchored menu** (§2). New shared
`packages/ui-web/src/StoryAnchoredMenu.ts`; `apps/mobile/src/actionSheet.ts` replaced by
`storyMenu.ts`; bottom sheet retired. Both the ⋮ tap and the long-press raise
`StoryMenuRequestEvent` and open the same menu at the same anchor.

**Stage 3 — detented swipe, configurable** (§3). `StoryListItem.swipeable()` rewritten;
settings model in `packages/app/src/swipeSettings.ts`; new "Swipe actions" settings block.

Test status at handoff: mobile web e2e 13/13, unit 82/82, Electron e2e 26 passed, Chrome
extension e2e 7/7, `npm run check` green, lint clean.

## Open items

1. **The reveal gradient is unverified visually.** The original row had a diagonal wash
   (`linear-gradient(45deg, colour, transparent 50%)`); I replaced it with a flat colour,
   the user asked for it back, and I reinstated it as a gradient whose *spread* carries
   the escalation — stage 1 fades out at 55%, stage 2 runs the full width
   (`--swipe-reveal-spread` in `stories.css`). The gradient strings resolve correctly and
   all tests pass, but **nobody has looked at it**. In particular the white bold label
   sits over a partly transparent gradient; contrast in light theme is unconfirmed. I was
   part-way through measuring it when work stopped. Look at it before trusting it.

2. **Stage-2 threshold was just raised 160 → 200px** at the user's request ("a bit
   stickier"). The plateau stays at 216, so you now drag almost all the way to the
   resting position before stage 2 engages. Tests and helper comments updated. If it is
   still not sticky enough, the next lever is hysteresis — require extra travel to enter a
   stage but less to fall back out — which is not implemented.

3. **Stages 4–9 not started.** Stage 4 (native in-app WebView Capacitor plugin) is the
   biggest piece, needs Java and Swift, and is the first thing in this project that
   **cannot be verified in the browser harness** — it needs a device or emulator. Stage 5
   depends on it.

## Traps worth knowing

**`npm run check` breaks the mobile e2e suite.** It runs `build:mobile:dev` *without*
`--e2e`, overwriting `apps/mobile/dist` with a bundle that live-loads sources at startup.
Running `npx playwright test` afterwards gives failures that look like gesture
regressions but are really rows being replaced mid-press by a background reload. Always
re-run `npm run test:mobile:web` (which rebuilds correctly) rather than Playwright alone.

**Leftover test server blocks the suite.** `tests/mobile-env/server.js` on port 3211 makes
Playwright's `globalSetup` hang rather than fail cleanly. Check the port before blaming
the tests.

**Do not read computed styles without letting transitions settle.** This cost three false
diagnoses during stage 3 — the swipe `transform` mid-snap (90ms), the reveal
`background-color` (which briefly looked like `light-dark()` was broken for the new
variables), and a row transform that read as identity in the browser pane while the same
assertion passed in Playwright. All three were harness bugs, not product bugs. Wait ~200ms
past any transition before sampling, and prefer the Playwright suite over ad-hoc probes in
the browser pane.

## Decisions already taken (do not relitigate without asking)

- In-app browser: a **custom native WebView plugin**, not an iframe (blocked by
  `X-Frame-Options` on most sources) and not `@capacitor/browser` (a full-screen system
  overlay that cannot be embedded).
- Settings restructure (§7) lands in **shared** `ui-web`, with Electron and the extensions
  rendering the same sections as list + detail.
- Only the Story sources subpage gets the designed treatment; the other rows host today's
  existing `.settings_block` markup behind a back arrow. **Nothing invented** — the brief
  says to ask before designing the rest.
- The detented swipe is **shared by every platform**, and user-configurable.
