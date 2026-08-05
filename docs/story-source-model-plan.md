# Typed story sources, then per-source cache timing

Status: in progress. Phases 1 and 2 complete; phases 3–7 pending.

## Context

The ask was per-source cache timing: a slow blog's RSS feed does not need refetching as often as
Hacker News or Reddit. The obvious implementation — a side map from source to minutes — is
fragile, because a source has no identity. It is one opaque line of text, and that text is already
doing four jobs it should not: it keys `AppRuntime.sourceErrors` and `processingSources`, it keys
`SettingsPanel.sourceErrors` plus the textarea highlighter, and it is embedded in
`LoaderInsights.issueId`. Edit the line and every one of those breaks. A settings map would add a
fifth.

So the identity model is the real work, and paying for it once buys more than cache timing:

- **The `§§` hack exists because storage is lines.** `geny:§§<json>§§<url>` smuggles a config
  through a string, recovered by re-parsing the `og_url` argument (`genyMatch.ts:89-102`,
  `jsonSelect.ts:96-110`), with `resolve_url` to dig the real URL back out.
- **The cache read/write key mismatch dissolves.** `SourceLoader` reads under the raw line (`:18`)
  and writes under the resolved URL (`:55-58`), so `json:`/`geny:` sources never hit cache. Once
  `source.url` is the URL for every collector there is nothing to mismatch.
- **Three `*`-prefix line parsers disappear** (`core/settings/sourceGroups.ts:13`,
  `ui-web/settings/structured/sourceGroups.ts:13`, `StructuredSettingsEditors.ts:417`), plus the
  line-index↔(group,source) walk at `StructuredSettingsEditors.ts:410-441`.
- **The picker gets simpler.** Its IPC format is already the pair `(confJson, url)`
  (`apps/electron/src/browser/SourcePicker.ts:38-53`, `apps/mobile/src/mobileSourcePicker.ts:60-63`);
  only the last hop concatenates a line.

The risk is not the object model, it is doing the format cutover and a pile of network-behaviour
changes at once. So this is sequenced: the cache feature lands on the *existing* global default and
*existing* refresh semantics, and every behaviour change is a separate, separately-evidenced step.

## Contracts, decided up front

These are data-contract decisions, not implementation details, and everything below depends on them.

| Question | Decision |
|---|---|
| Mixed-version operation | **Unsupported.** A declared one-way cutover; all devices update together. A legacy-document change seen after cutover is a visible diagnostic, not a merge. |
| Is `story_sources` a rollback? | **No.** It is a pre-cutover copy. After the first edit it no longer holds current configuration, and the plan must not claim otherwise. |
| Groups | Preserved exactly, including **empty groups and duplicate names**, both of which round-trip today (`parseSourceGroups:13-19`). Modelled explicitly. |
| Duplicate URLs | Legal and representable; two sources may share a URL with different configs. |
| Source id | Opaque, minted once, **never re-derived**. Preserved across URL, group, collector, config and order changes. |
| Id grammar | `/^(src|grp)_[A-Za-z0-9]{8,58}$/`, plus the single reserved literal `group_default`. Prefixed and zero-padded so a 32-bit FNV-1a value is always exactly 8 characters and a legacy-derived id is indistinguishable in shape from a minted one. "Valid id" can never mean UUID-only. |
| Default group | **Implicit.** `groupId` absent means Default, so no Default object is stored in `groups`; the editor synthesizes the row using the reserved id `group_default`, which must never appear in `groups`. |
| Sync configured but offline | Migration stays **pending**; legacy sources keep serving from memory. An unreachable remote is never evidence that a remote `sources` document is absent. |
| Unknown schema version | Fails visibly. Never normalized into an empty or downgraded document; never overwritten. |
| Cache key | The normalized request URL only. Deliberate payload-cache policy: `select` is applied *after* the fetch, so two sources sharing a URL may safely share the body. |
| Expiry boundary | `ageMs < ttlMs` — an entry exactly N minutes old is expired. Integer milliseconds, injected clock, no float-minute comparison. |
| Refresh meanings | Unchanged through the cutover. `R`/click = cache-first, `Shift+R`/double-click = forced, pull = cache-first, startup = network-only, exactly as committed in `c5d7bc7`. Any change is a phase-7 item with its own request-count evidence. |
| Editable JSON | A supported long-term interface for sources, strictly parsed. |

## The model

New `packages/core/src/settings/storySource.ts`:

```ts
export const SOURCES_SCHEMA_VERSION = 2

export interface StorySourceDocument {
  version: number
  migratedFrom?: { document: "story_sources"; digest: string }
  groups: Array<{ id: string; name: string }>
  sources: StorySource[]
}

export interface StorySource {
  id: string              // opaque, minted once, never re-derived
  url: string             // fetched; pattern-matched when `collector` is absent
  groupId?: string        // absent = default group
  collector?: string      // explicit collector id; absent = auto-detect from url
  label?: string          // display name; absent = derived hostname, as today
  enabled?: boolean       // absent = true
  cacheMinutes?: number   // absent = inherit collector, then global
  select?: unknown        // collector config, replacing §§; typed at the collector boundary
}
```

**Groups are explicit**, not a string field on each source. A flat `group?: string` cannot represent
an empty group, two intentionally distinct groups with the same name, a group order independent of
source order, or later group metadata — and it makes a rename touch every member. Sources keep
array order; group order is the `groups` array. Group identity follows the same rules as source
identity, and for the same reason — independent migrations must converge on **both**:

- migrated group id = `grp_` + `hash(canonicalHeaderText + "\n" + groupOccurrence)`. The Default group
  is not migrated at all, because it is implicit — its members simply have no `groupId`;
- a group created later gets `grp_` + a value from the injected random generator;
- group ids survive rename and reorder — a rename changes `name` only;
- `groupId` references are validated on every normalize. A dangling reference is reassigned to the
  default group **and reported**, never silently dropped;
- deleting a non-empty group must either move its sources to the default group or be rejected. It may
  never leave dangling references.

**`enabled === false` means not loaded, and that has menu consequences.** A disabled source is skipped
by `reloadStories` entirely — no fetch, no cache read or write, no `processingSources` entry, no
source error. It also contributes **neither its collector type nor its group** to `menuChanged`, since
that menu exists to filter stories that can actually appear; a group whose every source is disabled
therefore drops out of the sidebar and the mobile chips. Both halves are tested explicitly rather than
left to fall out of the implementation.

**Identity is two separate concepts:**

- `id` — `src_` + a value from an injected generator (defaults to `crypto.randomUUID()` with the
  dashes stripped; injected so tests are deterministic). Minted once. Normalization **preserves any
  valid id** regardless of what else changed. Nothing re-derives it, so nothing shifts when a
  duplicate is inserted or rows are reordered.
- `legacyMigrationKey` — used *only* during legacy conversion, to derive each source's initial id so
  two devices converting the same line list converge:
  `src_` + `hash(canonicalLegacyLine + "\n" + occurrenceWithinLegacyDocument)`, zero-padded to 8
  characters so short hash values cannot fall under the grammar's minimum. A synchronous
  dependency-free hash (FNV-1a) is sufficient — convergence is the requirement, not collision
  resistance, and cryptographic hashing in core would force async `crypto.subtle` or a Node-only
  dependency. Collisions are resolved by appending a deterministic disambiguator until unique.

**Canonical legacy encoding**, shared by the migration keys and by `migratedFrom.digest`, so neither
depends on platform newline style or stray whitespace: normalize CRLF and CR to LF, **trim each line
at both ends** — matching what the live parsers already do (`core/settings/sourceGroups.ts` trims each
entry, `parseSourceGroups:11` does `raw.trim()`), so the digest agrees with how a line is actually
interpreted — drop blank lines, join with LF. The digest is FNV-1a over that string.
`migratedFrom.digest` is not decoration — it is what detects a post-cutover legacy edit: when
`story_sources` changes, re-canonicalize it and compare. A difference is the diagnostic.

**Import reconciliation** (text mode, and any pasted list) is an explicit algorithm, not a heuristic:
match a supplied valid `id`; else match on (url, collector, duplicate occurrence) and **preserve the
matched object's id and any omitted settings**; else mint a new id; report ambiguous matches rather
than silently picking one.

**Normalization keeps the envelope and has two modes.** `normalizeStorySourceDocument(value)` returns
a `StorySourceDocument`, not a bare array — discarding the version early makes every future migration
harder. One permissive normalizer serving storage corruption, imports and form saves risks data loss,
so:

- **strict** — user-authored JSON and form saves: reject invalid input and leave the stored document
  untouched;
- **tolerant** — legacy conversion only: skip blank lines, but *report* malformed configurable
  sources instead of dropping them silently.

**Collector config is typed at the collector boundary.** `select?: unknown` is acceptable in core
(which must stay collector-agnostic) but must not stay opaque downstream. Each collector owns
`normalizeConfig` / `serializeConfig`, and collector selection produces a resolved source once,
before loading:

```ts
interface ResolvedStorySource<TConfig = unknown> {
  source: StorySource
  collector: StoryParser<TConfig>
  config: TConfig
}
```

One validation path then covers picker output, imported JSON, migrated `§§` strings, the overlay
preview and runtime loading — instead of sanitizing at several call sites. This also gives
`jsonSelect` the sanitizer it does not have today, and closes geny's unsanitized read path
(`genyMatch.ts:94-99`).

## The text surface

Normal JSON, deterministically formatted: two-space envelope, **each source object on a single
line**. Plain `JSON.stringify(value, null, 2)` expands every object, so this needs a small custom
writer — ours to own, and worth it because the layout diffs like today's list and yields exact line
ranges per source id without a JSON source map.

```json
{
  "version": 2,
  "groups": [{"id":"grp_1f4a9c02","name":"news"}],
  "sources": [
    {"id":"src_7c1e0b3a","url":"https://news.ycombinator.com/","groupId":"grp_1f4a9c02","cacheMinutes":4},
    {"id":"src_b40a55d1","url":"https://old.reddit.com/r/netsec/.rss","label":"Netsec"}
  ]
}
```

- **Which parser runs is decided by an explicit discriminator, not by failure.** Text whose first
  non-whitespace character is `{` or `[` is JSON: it is strictly parsed and JSON errors are reported
  as JSON errors. It never falls through to the legacy parser — otherwise malformed JSON quietly
  becomes malformed sources.
- The legacy path accepts **only** blank lines, `*group` headers, valid http(s) URLs, and recognized
  legacy `geny:` / `json:` forms, then runs import reconciliation so a pasted URL list keeps existing
  ids and settings. Anything else **rejects the entire import and saves nothing**. No partial import
  unless the UI previews it and lists every skipped entry explicitly.
- Save: strict parse and validate; on failure the previous document is untouched and the error
  surfaces in the existing `.structured_validation` / status strip.
- **On a successful save, canonicalize immediately**: re-serialize, replace the textarea content, and
  rebuild the ranges. Users can reformat editable JSON, which would leave ranges recorded from the
  previous serialization stale; canonicalizing on save avoids needing a location-tracking parser and
  fits this UI.
- Navigation and highlighting resolve **by source id against those ranges**. Never substring-search
  for `"id":"…"` — whitespace, key order and escaping make that unreliable
  (`textareaHighlight.ts:35-60` compares whole trimmed lines today and must change).
- The textarea stops being the canonical intermediate. `SourceSettingsEditor.save():216-231`
  currently writes `join("\n")` into it and `StructuredSettingsEditors.getText()` reads it back; the
  document becomes the editor's state and the text is serialized only on entering text mode.

## Phases

Phases are independently **verifiable**. Most are also independently shippable; one pair is not:

- **Phases 1 and 2 stand alone.** This was expected to fail `check:dead-code`, on the grounds that
  knip with `includeEntryExports` rejects an export with no consumer. Measured: it passes, because
  knip resolves the root test suite's `packages/*/dist/…` requires back to the workspace, so a
  test-only consumer counts. A phase whose only consumer is its own tests can therefore ship.
  Neither phase changes persisted data.
- **Phases 3–4 together.** Phase 3 changes `getStorySources()` from `string[]` to a document while
  `AppRuntime`, the editor, the error surfaces and the picker still expect lines; the repository cannot
  operate between them without an object→legacy adapter, which would be write-only throwaway code
  pointing the wrong way. They keep separate internal verification boundaries — 3 is green on its own
  unit and integration suites before 4 starts — but land as one commit range.

Step 0 is this document: the frozen contracts live in the repo rather than only in a session plan.

### 1. Domain model and converters — complete

`core/settings/storySource.ts` (model, id minting, strict + tolerant normalizers, group helpers,
import reconciliation) and `core/settings/legacySourceLines.ts` (line→document converter, the right
home for the legacy `§§` separator once collectors drop it). Nothing reads or writes the new
document yet.

Tests: malformed `§§` configs, duplicate URLs, duplicate group names, **empty groups**, id
collisions, reorder, URL edits, repeated normalization (idempotence), and unknown future versions.

### 2. Collector contract — complete, legacy lines still decodable

- `StoryParser.options` gains a required unique `id` (`geny`, `hackernews`, `jsonselect`,
  `lobsters`, `redditjson`, `redditrss`, `nitter`, `rss`). `options.type` cannot serve — `redditJson`
  and `redditRss` are both `re`. These are **public persistence identifiers** — they end up in
  `source.collector` and in `cache_timing.collectors` — so renaming one requires an alias plus a
  document migration, and that must be documented next to the registry. The `as StoryParser[]` cast at
  `registry.ts:78` means a missing id would not type-error, so a test asserts presence, uniqueness and
  a frozen id list.
- `parse(input, context)` with `context = { url, config? }`, replacing `(input, url, og_url)`. Six of
  eight collectors ignore both current arguments, and this fixes a latent bug: `redditJson.parse(json,
  filter = true)` currently receives the URL as `filter` and works only because a non-empty string is
  truthy. `parse_response` loses `og_url` too.
- Collector-owned config codecs and registry lookup by id; `ResolvedStorySource` as the single
  pre-load validation point. A runtime adapter still converts legacy lines into resolved sources in
  memory, so nothing depends on the storage cutover yet.

### 3. Persistence cutover — the risky phase, isolated from behaviour changes

- New list-store document id `sources` holding `StorySourceDocument`. **Both** `sources` and
  `story_sources` go into `PouchSyncService.SETTINGS_DOCUMENT_IDS:49-56`.

**The gate needs an interface, because none exists today.** `syncFrom` is fire-and-forget
(`PouchSyncService.ts:130-179` returns `void` and runs `void this.runInitialSync(...)`), so nothing
can currently await the settings stage. Add one signal and one small state machine:

- `SyncServicePort` (`app/types.ts:171-176`) gains `onSettingsReplicated?(handler): () => void`.
  `PouchSyncService` fires it once per generation, immediately after the awaited
  `replicateStage("Syncing settings…", { doc_ids: … })` resolves, guarded by the same
  `this.generation !== generation` check the other callbacks use. It never fires on error or offline.
  **It is replayable within a generation**: the service records that the stage completed, and a handler
  registered afterwards is invoked immediately. `AppSettings` also subscribes before it ever calls
  `syncFrom` (it owns that call, in `startSync`). Both, deliberately — the subscription order is the
  intent, and the replay means a fast local replication cannot win the race and strand the migration
  in `"pending"` forever.
- `AppSettings` tracks `sourcesState: "pending" | "resolved"`:
  - **No sync URL configured** (`getSyncUrl()` empty, status `"disabled"`) — local-only, so resolve
    and migrate immediately.
  - **Sync configured, signal not yet received** — reads go through the phase-2 legacy runtime
    adapter in memory. **Nothing is persisted to `sources`.** This interim state is exactly what that
    adapter exists for.
  - **On the signal** — resolve the authoritative document: always prefer a valid `sources` document
    if one exists, local or remote; only if absence is established *afterwards*, convert
    `story_sources` and write the versioned document with `migratedFrom.digest`. If the effective
    configuration differs from what was serving, `publishChanged("sources")` and reload.
  - **Configured but offline or erroring** — stay `"pending"` indefinitely and keep serving legacy
    sources from memory. An unreachable remote is never evidence of an absent remote document.

  Without the gate a fresh client converts a default or stale local list, writes `sources`, then pulls
  a newer remote one — a conflict or a wrong-revision pick.
- If both documents exist at first resolve and their digest relationship is inconsistent (the legacy
  document does not canonicalize to the stored `migratedFrom.digest`), load `sources` as authoritative
  **and** emit the visible diagnostic.
- After cutover, a change to `story_sources` is likewise a diagnostic. That state is split-brain, not
  compatibility.
- `AppSettings.getStorySources()/saveStorySources()` move to the document;
  `handleObservedChange` gains `case "sources"`. `defaultSources` stays a line array run through the
  same converter, so fresh installs and migrations take one path.

Tests: local-only, remote-only, both present, delayed remote arrival, conflicting `sources`,
malformed new document, old-client legacy edit, and identical initial ids from two independent
migrations of the same input.

### 4. Object-native app, editor and picker

- Identity plumbing: `SourceError` (`app/types.ts:12-18`) gains `sourceId`; re-key
  `AppRuntime.processingSources:251` and `sourceErrors:301`, `SettingsPanel.setSourceErrors:623`,
  and `LoaderInsights.issueId:246`. `highlightSource` takes an id. `menuChanged`'s `{groups, types}`
  shape is unchanged, so `sidebarFilters.ts` and the mobile chips need no change.
- Editor: document is canonical state; rows, `contains`, `reveal`, drag and delete key on
  `source.id` (replacing the throwaway `source-${++rowSequence}` at `SourceGroupView.ts:228-237`).
  `sourceRows.ts` uses `label ?? derived hostname` (the `geny:` special case at `:19-29` goes away)
  and dims `enabled === false`.
- `structured/form.ts`: the field descriptor grows a `kind`
  (`text | multiline | number | select | checkbox`) with its own `choices`/`optional`, replacing the
  positional convention where `options.choices` applies only to the *last* field (`:124`) and
  `required = true` is forced on every input (`:142`). The source form needs two selects and a
  checkbox. Migrate the filter/redirect/group callers in the same phase.
  Source form: URL, Label, Collector, Cache minutes, Enabled, Group.
- Picker: `sourceLinePolicy.ts` becomes a conf codec; `build_source` returns a `StorySource`; the
  overlay preview stops round-tripping through a line (`sourcePicker.ts:383-386`). The
  `(confJson, url)` IPC contract is unchanged, so preload, `IpcHandlers`,
  `TabManager.startSourcePicker` and the mobile/webext injection paths are untouched.
- Settings search must be preserved deliberately: add source-id / object-range search tests,
  including navigation from the index-first Sources section.

### 5. Real-profile migration gate

Before legacy runtime support is deleted: back up **both** documents including their Pouch revision
metadata (`_rev`, not just the `list` payload — a restore without it cannot be written back cleanly);
convert a real profile; compare ordered sources, groups, collector selection and configurable
selectors; load every source or produce an explicit per-source failure inventory; relaunch and sync
from a second updated client; confirm no legacy document changed unexpectedly. Only then remove `§§`
handling from core and the picker, remove the legacy-format sections from
`docs/COLLECTORS.md`, and update `ARCHITECTURE.md` and `CODEMAP.md`. The current collector contract
is already documented; this gate removes only the transitional line-format guidance.

### 6. Per-source cache timing — no behaviour change beyond the override

Deliberately conservative: **keeps the existing 120-minute global default, the existing
network-only startup, and the existing refresh gestures.** Nothing here changes what any source does
until the user sets an override — which is why the shipped per-collector defaults are *not* in this
phase. Giving Hacker News 4 minutes out of the box changes request counts with no user action, so it
belongs in phase 7 with the other behaviour changes and its own evidence.

- `cacheMinutes` is already a field on the source. Per-collector overrides go in a small new
  document `cache_timing: { version: 1, collectors: Record<collectorId, number> }` — versioned from
  its first introduction even though it starts with one field, and no source map anywhere. It stays
  scoped to timing: the per-collector parsing knobs currently held as module-global mutable state
  (`options.settings`: `min_points`, `filter_ads`, `time_cut_off`) are parsing configuration, not
  cache policy, and belong in a separately versioned `collector_settings` document keyed by collector
  id if they are ever exposed. `cache_timing` joins `PouchSyncService.SETTINGS_DOCUMENT_IDS` and gets a
  `case "cache_timing"` in `AppSettings.handleObservedChange` that publishes `"cache"` and deliberately
  does **not** reload.
- The collector field `cache_minutes` is *declared* here so the precedence chain is complete and
  testable, but **no collector ships a value yet** — every collector inherits the global. It is a typed
  field on the collector rather than an entry in the untyped `options.settings` bag, and it is named
  `cache_minutes` to match that package's `global_search` / `min_points`, while core,
  app and ui-web use `cacheMinutes`. Deliberate, per-package consistency.
- Precedence: `source.cacheMinutes` → `collectors[id]` → collector shipped default → global.
  Vocabulary: absent/blank = inherit, `0` = always refetch, integer `0..525600` otherwise, anything
  else rejected. `0` needs an explicit skip-the-read branch — `minsOld > 0` is false for a
  sub-second-old entry, so `0` does not currently mean what it says.
- Replace the boolean `tryCache` with an explicit policy (`"cache-first" | "network-only"`). The
  boolean gets opaque once timing is configurable, and phase 7 wants a third value.
- Resolver `effectiveCacheMinutes` in `packages/app/src/cacheTiming.ts` (needs the registry, so not
  `core`; `check-boundaries.js` has no rule for `app`). Read the document **once per reload pass** —
  `reloadStories:248-265` fans out over every source concurrently.
- Acceptance: with no override set anywhere, **every** request count is byte-for-byte what it was before
  this phase. That is only true because no collector ships a default here.

### 7. Cache UX and behaviour changes — each on its own evidence

Independently observable, so none of these rides along with the format cutover: **shipped per-collector
defaults** (Hacker News 4, Reddit JSON 4, Reddit RSS 4, Lobsters 10; geny, jsonselect, RSS and Nitter
keep inheriting) — the field exists from phase 6, this is the step that populates it and accepts the
request-count change; global default 120 → 60; cache-first startup (today every shell passes `initialStoryLoad: "network"`, so the cache
is written every launch and read only by in-session reloads, which makes short windows nearly
inert); pull-to-refresh forcing a fetch rather than silently no-opping inside a 4-minute window;
**stale-on-error** (serve an expired entry with a warning when the network fails, instead of
discarding a useful body); fetch-timestamp display; `Clear cached feeds` and per-source
`Refetch now`; deleted-source eviction.

Notes for that phase:

- Per-source `Refetch now` **forces a request**; it must not delete a cache entry another source
  shares.
- Timestamp display: measure before adding a second IndexedDB store. The payload already carries the
  timestamp, and the only reason for a sidecar is avoiding a whole-feed read per row — on
  `platform-web` that is a synchronous main-thread `JSON.parse` of the entire feed. If it is worth a
  `DB_VERSION` bump, build a general cache **index** (key, timestamp, size) rather than a bare stamp
  store, write and delete it in the same transaction as the payload, define recovery for a
  half-written pair, and handle `onblocked` — the promise at `IndexedDbCacheStore.ts:10-25` hangs
  forever today if another tab holds the old version.
- Panel work lands in a new `packages/ui-web/src/settings/CacheTimingPanel.ts`, wired from
  `settingsControlBindings.ts` (83 logical lines) and `SettingsPersistence.ts` (71):
  `SettingsPanel.ts` is at 548/600 and `LoaderInsights.ts` at 576/600 against the structural limit.
  Everything stays inside the single existing `.settings_block` (`installSettingsNavigation` wraps
  the whole block), `#cache_time_input` keeps its id and `type="text"`
  (`settingsSectionDefinitions.js:12` resolves the section by it; `contracts.spec.js:284-296` asserts
  its background), collector rows are labelled by `description` not badge (two rows badged `re` read
  as a bug), placeholders show the inherited number so blank is never mistaken for zero, and the
  table must **not** carry `.structured_settings` (`settingsSearch.ts:60-66` strips that subtree).
  Buttons need `type="button"` and `class="button"`; CSS in `parts/settings.css` with `--sp-*` /
  `--fs-*` tokens only. Fix `settingsSummaries.ts:49`'s `"30"` fallback, and `:13-35` which counts
  sources by splitting the textarea on `*` prefixes.

## Acceptance criteria

- No migration write occurs before initial settings replication finishes when sync is enabled.
- Sync configured but offline leaves migration pending and keeps serving legacy sources; it never
  concludes the remote document is absent.
- Two devices migrating the same legacy document produce identical initial source **and group** ids.
- The canonical legacy encoding and digest are stable across CRLF/LF and trailing whitespace.
- Editing url, label, group, collector, config or cache policy preserves the source id.
- Reordering and inserting duplicates preserves every existing id.
- Empty groups and duplicate group names survive exactly, or are rejected before save.
- No `groupId` can dangle: a missing group reassigns to default with a report, and deleting a
  non-empty group either moves its sources or is rejected.
- Every generated and migrated id matches the declared grammar, including the shortest possible hash
  output; `group_default` never appears in `groups`.
- A handler subscribed to `onSettingsReplicated` after the stage completed is still invoked, so a fast
  replication cannot strand the migration in `"pending"`.
- A disabled source is never fetched and contributes neither its collector type nor its group to the
  menu; a group whose sources are all disabled drops out of the sidebar and the mobile chips.
- Malformed JSON in text mode reports a JSON error and never falls through to the legacy parser.
- A legacy import containing an unrecognized line saves nothing.
- Reformatted JSON still navigates to the right source after save, because save canonicalizes.
- An unsupported future schema version never overwrites stored data.
- Invalid JSON or a failed import leaves the previous document untouched.
- A legacy-document change after cutover produces a visible diagnostic.
- Search, error-log navigation, loader issues and row highlighting all resolve by source id.
- Two entries sharing a URL with different configs behave per the documented cache-sharing rule.
- Existing refresh request counts are unchanged through the format cutover.
- Every cache behaviour change lands with its own request-count evidence.

## Deliberately not done, and known edges

- **No scheduler.** The seams: `effectiveCacheMinutes` plus a timestamp read answer "which sources
  are due", and cache-first startup would make a future refresher `reloadStories` on a timer.
  Per-shell wake-up (Electron timer vs. `browser.alarms` vs. mobile background) and injecting new
  stories into a list being read stay out.
- **The same URL in two groups still fetches twice.** `reloadStories:248-265` has no in-flight
  dedupe, so both loads miss, both fetch, both write. Pre-existing, and it will make fetch-counting
  tests read oddly; worth an in-flight map later.
- **Two sources sharing a URL share one body**, each judging it against its own window, so the
  shorter one effectively wins. Documented rule, not a bug.
- **`Shift+R` re-stamps everything**, since a forced load still writes — one forced reload opts every
  source into a fresh window.
- **Nothing evicts the cache.** `WebCacheStore.set` has no `try`/`catch` around `setItem`, so a full
  quota surfaces only as a `console.log` from `parser.ts:148-152`.
- `story_sources` lingers as a pre-cutover copy and drifts from reality the moment sources are edited.
- The strict reader refuses a whole record on any fault, which is the point, but it means one bad
  hand-edit blocks the save rather than partially applying — the reports name every fault at once so
  that stays workable.
- `repairStorySources` drops an entry it cannot represent (no url, not an object) rather than
  inventing one. Reports name it, and the pre-cutover legacy copy still holds the original.

## Verification

- `npm run test:unit` — legacy converter against real old lines (groups, empty groups, duplicate
  names, `geny:§§`, `json:§§`, plain, blanks, duplicate URLs) asserting deterministic, idempotent
  ids; strict vs tolerant normalizer behaviour including unknown versions; import reconciliation
  including the ambiguous case; collector id presence/uniqueness/frozen list; `parse(input, context)`
  from a typed `select`; config codecs rejecting junk; `cacheTiming` precedence matrix with `0` at
  each layer, blank ≠ 0, out-of-range, unknown collector; `SourceLoader` with an injected clock,
  asserting `ageMs < ttlMs` at the exact boundary and that a geny source now hits cache; JSON
  text-mode round-trip plus the URL-list fallback preserving ids and settings.
  Rewrite `tests/unit/collectors/configurable.test.js`, `geny-builder.test.js`,
  `picker/source-line-policy.test.js`, `ui-web/structured-settings.test.js` (~15 `SourceGroup`
  literals), `settings-helpers.test.js`, `app-services.test.js:45`.
- `npm run test:electron` — the phase-3 migration matrix above, driven by a fake
  `onSettingsReplicated` so the pending/offline/resolved transitions are all exercised, plus the
  inconsistent-digest case; `json:`/`geny:` hitting cache on a second cache-first reload (the
  regression that fails today); per-collector beating global and per-source beating per-collector,
  driven through `fake.ports.listStore` with request counting; an observed `sources` change reloading
  while an observed `cache_timing` change only publishes.
- `npm run test:electron:e2e` — `source-picker.spec.js:78-233` is the most format-coupled suite in
  the repo (asserts the `geny:§§` prefix and splits on it) and moves to objects.
  `story-list.spec.js:384-393` relaunches with `keepUserData`, which is where a later cache-first
  startup would show. The stale comment at `keyboard-navigation.spec.js:103-107` documents the
  cache-key bug as a premise and `:142-143` says "two hours"; both need updating. Count requests with
  the fixture server's `onRequest` hook, as `keyboard-navigation.spec.js` does since `c5d7bc7`.
- `npm run test:extensions`, `npm run test:mobile:web` — `settings-source-groups.spec.js:19-291`
  asserts joined-line textarea values throughout and moves to JSON; `button-adoption.spec.js` covers
  new buttons automatically.
- Test helpers change first, and most specs follow: `tests/helpers/fake-platform.js:3`,
  `tests/e2e/shared/story-fixture.js:126`, `tests/e2e/shared/geny-fixture.js:7`,
  `tests/e2e/electron/electron-harness.js:323`, `tests/e2e/mobile/helpers/settings.js` and
  `helpers/stories.js`. Also `scripts/visual-compare.js:42-44,548-555`, `tests/live/source-cases.js`,
  `scripts/refresh-collector-fixture.js`.
- `npm run check` — especially `check:structure` (keep the two near-limit files out of it),
  `check:dead-code`, `check:boundaries`, `check:css-debt`, `check:cascade`,
  `check:semantic-controls`.
- Manual gate at phase 5, per the real-profile checklist above.
