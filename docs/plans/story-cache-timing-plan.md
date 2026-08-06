# Per-source cache timing and cache behavior

Status: both phases landed; pending a close-out into HISTORY.md. Depends on the completed typed-source persistence and
object-native UI work recorded in [HISTORY.md](../HISTORY.md).

## Context and boundary

A slow blog feed need not refetch as often as Hacker News or Reddit. The typed source model reserves
`StorySource.cacheMinutes` and gives every source stable identity; this plan owns everything that
turns that field into cache policy or UI.

The split is deliberate:

- the source-model plan owns source identity, migration, persistence, grouping, collector selection,
  configuration, and the object-native editor;
- this plan owns cache timing documents, precedence, loader policy, request behavior, cache UX,
  timestamps, eviction, and cache-specific diagnostics.

The phase-2 collector work already fixed the legacy configurable-source cache-key mismatch by
resolving a line before reading cache. That completed compatibility fix is not part of this roadmap.

## Contracts

| Question | Decision |
|---|---|
| Cache key | The normalized request URL only. `select` is applied after fetching, so sources sharing a URL safely share the response body. |
| Expiry boundary | `ageMs < ttlMs`; an entry exactly N minutes old is expired. Use integer milliseconds and an injected clock. |
| Timing precedence | Source override → user collector override → shipped collector default → global default. |
| Value vocabulary | Absent or blank means inherit; `0` means always refetch; otherwise an integer `0..525600`; reject everything else. |
| Existing refresh behavior | Before behavior changes: `R`/click and pull are cache-first, `Shift+R`/double-click are forced, and startup is network-only, as committed in `c5d7bc7`. |
| Shared body policy | Each source judges the shared timestamp against its own window. The shortest active window therefore determines how often the shared body is refreshed. |

## Phase 1: timing overrides without unrelated behavior changes — landed

Keep the existing 120-minute global default, network-only startup, and refresh gestures. Nothing
changes until a user sets an override; no collector ships a default in this phase.

- `cacheMinutes` already exists on `StorySource`. Add a versioned timing document:
  `cache_timing: { version: 1, collectors: Record<collectorId, number> }`. There is no source map.
- Keep parsing settings such as `min_points`, `filter_ads`, and `time_cut_off` out of this document.
  They belong in a separately versioned `collector_settings` document if exposed later.
- Add `cache_timing` to `PouchSyncService.SETTINGS_DOCUMENT_IDS`.
  `AppSettings.handleObservedChange` publishes `"cache"` without reloading stories.
- Add typed collector `cache_minutes`, but ship no values yet. Collector uses snake case consistently
  with `global_search` and `min_points`; core, app, and UI use `cacheMinutes`.
- Replace boolean `tryCache` with explicit `"cache-first" | "network-only"` policy.
- Add `effectiveCacheMinutes` in `packages/app/src/cacheTiming.ts`. It needs the collector registry,
  so it does not belong in core. Read the timing document once per reload pass before the concurrent
  source fan-out.
- Implement `0` with an explicit skip-read path; the old `minsOld > 0` comparison mishandles a
  sub-second-old entry.
- Add Cache minutes to the source form introduced by the source-model plan.

Acceptance: with no override anywhere, request counts are identical to the pre-phase baseline.

As landed, `effectiveCacheMinutes` is reached through `AppSettings.cacheWindows()`, which reads the
timing document and the global default once and returns the resolver a reload pass uses for every
source. `OnceClient` gained `getCacheTiming`/`setCacheTiming`; no panel writes them yet. The source
form's Cache minutes field refuses anything that is not blank or a whole number rather than coercing
it (`readCacheMinutesInput` in core).

## Phase 2: cache UX and behavior changes — landed

Land each independently observable behavior with its own request-count evidence:

- shipped defaults: Hacker News 4, Reddit JSON 4, Reddit RSS 4, Lobsters 10; Geny, JSON Select, RSS,
  and Nitter inherit;
- global default 120 → 60;
- cache-first startup;
- pull-to-refresh forces a fetch;
- stale-on-error serves an expired body with a warning when the network fails;
- fetch-timestamp display;
- `Clear cached feeds` and per-source `Refetch now`;
- deleted-source eviction.

Per-source `Refetch now` forces a request but must not delete an entry shared by another source.

As landed, timestamps are read from the cached payload and no `DB_VERSION` bump was needed, so
`IndexedDbCacheStore`'s `onblocked` gap remains open and is now the only item below still pending.
`CacheStorePort` gained `delete` and `clear`; the panel lives in `settings/CacheTimingPanel.ts`,
mounted into `#cache_timing_panel` inside the existing cache block.

Measure timestamp display before adding another IndexedDB store. The payload already carries the
timestamp; a sidecar is useful only to avoid parsing an entire feed per settings row. If a
`DB_VERSION` bump is justified, build a general cache index `(key, timestamp, size)`, write and
delete it transactionally with the payload, define half-written-pair recovery, and handle
`onblocked`. `IndexedDbCacheStore.ts:10-25` currently hangs when another tab retains the old version.

Put panel work in `packages/ui-web/src/settings/CacheTimingPanel.ts`, wired from
`settingsControlBindings.ts` (83 logical lines) and `SettingsPersistence.ts` (71); keep it out of
`SettingsPanel.ts` (548/600) and `LoaderInsights.ts` (576/600). Keep everything inside the existing
`.settings_block`, which `installSettingsNavigation` wraps as one unit. Preserve
`#cache_time_input` and its `type="text"` contract: `settingsSectionDefinitions.js:12` resolves its
section and `contracts.spec.js:284-296` asserts its background. Label collector rows by description
rather than badge because both Reddit collectors use `re`. Show inherited values as placeholders,
and do not apply `.structured_settings` because `settingsSearch.ts:60-66` strips that subtree.
Buttons use `type="button"` and `class="button"`; CSS belongs in `parts/settings.css` and uses
`--sp-*` / `--fs-*` tokens only. Fix `settingsSummaries.ts:49`'s stale `"30"` fallback and its
line-based source count at `:13-35` while touching this surface.

## Acceptance criteria

- Precedence works at every layer, including `0`, blank, invalid, and unknown-collector cases.
- Exact-boundary expiry uses `ageMs < ttlMs` with an injected clock.
- Phase 1 changes no request count unless the user sets an override.
- Every phase-2 behavior change has independent request-count evidence.
- A timing-document change publishes cache settings without triggering a story reload.
- Editing cache policy preserves the source id.
- Sources sharing a URL but using different selectors share one response body safely.
- Per-source refetch does not invalidate another source's shared body.
- Cache controls remain searchable, keyboard accessible, and visually consistent on every shell.

## Deliberately not done, and known edges

- **No scheduler.** `effectiveCacheMinutes` plus timestamp reads answer which sources are due, but
  per-shell wake-up and injecting stories into an active reading list remain separate work.
- **The same URL can fetch twice concurrently.** There is no in-flight deduplication, so two sources
  can miss, fetch, and write together.
- **Two sources sharing a URL share one body.** Each judges the timestamp against its own window, so
  the shorter window effectively wins. This follows directly from the documented URL-key policy.
- **Forced reload re-stamps everything.** A forced request still writes a fresh timestamp.
- **Eviction is absent before phase 2.** A full `WebCacheStore` quota currently surfaces only through
  the cache-write log path.

## Verification

- `npm run test:unit`: timing precedence matrix; `0` at every layer; blank versus zero; range and
  unknown-collector validation; `SourceLoader` with injected clock at the exact boundary.
- `npm run test:electron`: per-collector beats global, per-source beats per-collector, timing document
  changes publish without reloading, and configurable sources hit cache on cache-first reload.
- `npm run test:electron:e2e`: request counts via the fixture server; cache-first relaunch through
  `story-list.spec.js:384-393`; refresh gestures and stale-on-error; settings controls and
  timestamps. Update `keyboard-navigation.spec.js:103-107`, whose comment still describes the fixed
  configurable-source cache-key bug, and `:142-143`, which still says "two hours". Use the fixture
  server's `onRequest` hook as that suite has since `c5d7bc7`.
- `npm run test:extensions` and `npm run test:mobile:web`: timing settings and cache controls across
  shells.
- `npm run check`: structure, dead code, boundaries, CSS debt, cascade, and semantic controls.
