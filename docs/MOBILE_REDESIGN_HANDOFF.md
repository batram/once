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

**Web e2e bundle can no longer be silently clobbered.** `mobile web` now writes
`apps/mobile/dist/.once-web-build.json` (channel + `e2e` + `builtAt`), and the mobile
Playwright `globalSetup` rebuilds with `--e2e` when that stamp is missing, non-e2e, wrong
channel, or older than `apps/mobile/src`, `webpack.config.js` or any `packages/*/src`.
`npx playwright test` straight after `npm run check` therefore rebuilds instead of failing
in ways that look like gesture regressions. The freshness helpers are shared with the
Android runner in `tests/e2e/mobile/build-freshness.js`.

**Swipe settings sample row.** `packages/ui-web/src/SwipePreviewRow.ts` puts a real
`StoryListItem` in the "Swipe actions" block. `SwipeConfig` was split into
`createSwipeGeometry(read)` plus the live instance, so the sample is driven by the values
currently *in the form* — an edit can be tried before it is saved — and
`StoryListItem.swipePreview` diverts the release: it reports the action it would have run
in a status line and touches no stored state. Links and buttons on that row are
neutralised at the capture phase, the mobile long-press skips
`[data-swipe-preview]` rows, and the row keeps its own touch axis lock (there is no
`attachPullToRefresh` in settings to drive one). Type `EX`, coloured from two new
`--sample-badge-*` variables since no collector emits that type.

**Reveal alignment fix.** `.bb_slide`'s two sides were flex children at `width: 100%`, so
each shrank to half the row: a stage-2 drag uncovers more than half, leaving a gap between
the row's trailing edge and the colour. They are now stacked at `inset: 0` — only one side
is ever coloured, so the overlap is invisible. Confirmed on device.

Test status: mobile web e2e 14/14, unit 82/82, `npm run check:types`, lint and boundaries
clean. **Electron and extension e2e were not re-run** after the shared `stories.css`
change — packaging hit `EBUSY` on `apps/electron/out` and re-running was deferred. Run
`npm run test:electron:e2e` and `npm run test:extensions` before trusting the desktop
surfaces.

**Mobile E2E harness hardened and verified.** Web and native runners now let the
server atomically bind an OS-assigned port, identify it with a per-run ownership
token, and keep PouchDB state in private temporary directories outside
Playwright's artifact tree. Database reset clears documents in place instead of
destroying and immediately recreating LevelDB directories. Cleanup requests a
cooperative shutdown, force-terminates after a bounded wait, and removes only
the owning run's temporary data. Regression tests cover dynamic and occupied
ports, parallel database isolation, ownership, repeated seeded resets, shutdown,
and temporary-directory removal. Verification passes `npm run test:mobile`
(18/18) and `npm run test:mobile:web` (14/14), including authenticated sync.

## Open items

Stages 4–9 now have their core technical implementation:

- typed Android/iOS secondary WebView surface with browser fallback and explicit
  URL, popup, download, TLS, bounds and lifecycle handling;
- shared Reading session and rendered-order traversal, plus the mobile Reading tab;
- reader/browser/comments modes and Android back priority;
- versioned, session-scoped TTS bridge with host controls;
- mobile filter chips and issue presentation;
- searchable list/detail settings navigation shared by all products;
- safe-area, focus-visible and reduced-motion polish.

Verification completed before the harness hardening: `npm run check`, 88/88 unit
tests, Android `compileDevelopmentDebugJavaWithJavac`, and mobile/extension E2E
syntax checks. After hardening, the complete mobile unit suite passes 18/18 and
the complete mobile Playwright suite passes 14/14, including the corrected
authenticated-sync scenario.

Still required:

1. Run Electron and extension Playwright after the shared `stories.css` change.
   The production extension builds, artifact checks and Firefox lint passed in
   the earlier attempt, but the E2E results still need a clean completed run.
2. Diagnose the shared native smoke-test failure at the story-title interaction:
   Android reports that the external browser package did not open and iOS reports
   that `SFSafariViewController` did not appear. Determine whether the redesign
   changed the intended routing contract or introduced an application regression
   before changing either the application or the assertion.
3. Run the Android native acceptance matrix on a device/emulator: embedded HN,
   redirects/history, rotation, keyboard, background/resume, process recreation,
   offline/TLS failure, external schemes, downloads, tab switching and back order.
4. Build and run the iOS counterpart with Xcode on macOS; Windows compilation does
   not establish Swift/WKWebView parity.
5. Ask the user for the planned visual pass in light and dark themes after the
   executable gates are green.

## Traps worth knowing

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
- Visual confirmation is **the user's call**: stop and ask them to look rather than driving
  the browser pane or a device to judge appearance.
