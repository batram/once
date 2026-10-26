# iOS extension performance cleanup — 2026-10-26

Follow-up to the [performance investigation](ios-extension-impact-2026-10-26.md). This change removes avoidable extension initialization during supplemental-settings application, reuses converted filters across restarts, moves package deletion off the main actor, and reduces the AMO page script. It preserves the existing first-navigation preparation gate, enabled extensions, filtering rules, and installation/rollback semantics.

The [follow-up evidence](ios-extension-cleanup-2026-10-26.json) contains the physical-device runs, source hashes, matched-input cache timings, production bundle size and native behavior results. The original investigation evidence is preserved.

## Changes

**Start the extension host when needed.** Applying filter-list/userscript settings no longer starts an unawaited extension preparation task. Browsing (`open` and `navigate`) and extension commands already await the shared preparation task before creating a browsing surface or using extensions. The uBlock background-readiness wait remains in place. A session that applies settings but stays in the reader therefore avoids that eager host initialization. Opening extension management also still prepares the host, as expected.

This trades speculative warming for initialization at first actual use. It does not eliminate the cost when a user starts browsing, and a first navigation can have more preparation left to await than in a prewarmed session. The native regression executes the production settings method with a host getter that fails if accessed, and confirms supplemental filters and scripts are still applied. There is no new full-application startup timing claim.

**Cache the last converted filter list on disk.** The exporter keeps one binary plist in the app's disposable Caches directory. It stores the input hash, output hash and converted rules. Exact input content, rather than URL alone, controls reuse; changing downloaded filter contents invalidates it. An output checksum detects damaged cache payloads. The filename versions the exporter semantics. Writes are atomic, cache read/write failures fall back to conversion, and empty settings return `[]` without replacing the last useful entry.

The cache adds about 33 lines to the existing exporter. It has no database, background scheduler, LRU or extra synchronization. Conversion and cache I/O run in the existing detached preparation task. Cancellation and settings-generation checks remain in place, as does the compiled WebKit rule cache. Concurrent obsolete writes can at worst replace the performance cache with another input's valid entry; the content hash prevents that entry from being applied to different settings.

**Move package cleanup off the main actor.** Package removal and orphan pruning now perform filesystem work in detached utility tasks. Callers await completion, preserving the ordering required by rollback, updates and removal. Catalog mutations and WebKit operations remain on their existing actor. This changes where deletion executes, not the promise that files are gone when cleanup returns. It does not claim faster total deletion time.

**Import only the AMO bridge.** The runtime exposes `@once/webext-runtime/amo`, and the mobile AMO page entry uses it instead of the broad preload entry. Existing preload exports remain compatible. The production minified page script falls from **132,189 to 3,507 bytes**, a **97.3% reduction**, using the same shim implementation. Tests exercise the actual new package export, origin guards, native install/cancel messages, enabled-state updates, and the AMO server-state rewrite.

## Physical-device validation

Same physical iPhone 16 Pro Max / iOS 27.0.1, Release Swift `-O`, as the investigation. There are three process launches for cache tests and three for the native filter regression. Browsing uses three retained launches plus one conditioning launch for each of bare WebKit, AMO-only and all-bundle configurations: 12 browsing launches and 48 page loads. Thermal checks reported nominal state and low-power mode off.

The cache test compares identical input in the uncached exporter and cached path, verifies byte-for-byte output equality, then compiles that result with native WebKit. Three rule counts use separate benchmark cache files so the cases do not evict one another; production keeps only the latest entry. The first launch populates those files, and two subsequent fresh processes measure disk reuse.

| Domain rules | Uncached conversion median | First cache miss | Cache hit after process restart |
| --- | ---: | ---: | ---: |
| 1,000 | 11.8 ms | 12.6 ms | 2.34–2.51 ms |
| 10,000 | 77.4 ms | 85.7 ms | 1.02–1.18 ms |
| 50,000 | **366.4 ms** | **384.8 ms** | **4.36–4.69 ms** |

At 50,000 rules, persistent reuse removes about 362 ms of repeated conversion in this matched-input experiment. The first miss adds about 18 ms relative to the uncached median, for hashing/encoding/writing. These are two restart-hit observations per size; the small 1,000-rule case runs first and includes first-call setup. Input domains are shorter than the salted inputs in the original investigation, so its 670 ms export number is not a directly comparable baseline. The measured improvement is 366 ms versus approximately 4.5 ms on the same inputs here.

Browsing results remain in the prior session's range:

| Configuration | First-page component sum median | Later navigation median | Peak app physical footprint median |
| --- | ---: | ---: | ---: |
| Bare | 125.2 ms | 9.09 ms | 17.9 MiB |
| AMO only | 121.3 ms | 9.12 ms | 17.9 MiB |
| All bundles | 499.6 ms | 11.38 ms | 381.6 MiB |

The first-page metric retains the investigation's definition: preparation + surface construction + navigation completion, excluding process launch, Capacitor and catalog diagnostic probes. These are sequential sessions, not randomized before/after pairs. The AMO case being slightly faster than bare on first navigation is noise, not a claimed speedup. Its later-navigation result is close to bare after the bundle reduction.

The all-bundle native peak remains substantial when browsing actually initializes the extensions. This change avoids eager work in a settings-only/reader-only path; it does not shrink WebKit's declarative-rule initialization peak. No engine rewrite, default-filter reduction, or complex disabled-extension metadata cache was introduced. The latter remains deferred because preserving the complete catalog/options/icon/error behavior would require more invasive changes for a smaller measured gain.

## Checks

- All **53 selected unit/regression tests** pass, including the new native cache and lazy-settings tests and the AMO bridge tests.
- The cache test runs in two separate native processes and checks content invalidation, invalid plist recovery, valid-plist/checksum corruption, unavailable cache storage, cancellation, empty-list clearing and reuse without rewriting.
- The native iOS simulator host suite passes Dark Reader, SponsorBlock video skipping, Violentmonkey execution/storage/recovery, uBlock tools and navigation behavior.
- The native installer suite passes install/update rollback and identity checks, plus new assertions that pruning preserves installed packages and awaited removal finishes deleting the package before returning.
- The physical-device filter regression passes blocking, exceptions, cosmetic filtering/clearing, cache identity and preservation after compilation failure on all three launches.
- The full Once Dev iOS simulator app build and physical-device Release harness build pass. Mobile TypeScript checking, targeted lint, structural limits, package boundaries and `git diff --check` pass.

No product layout or styling changed. Older devices/iOS releases, complete process-group memory, real-site energy and full-app startup remain outside this follow-up's measurements. The test apps are removed after collection; the real Once application's data is unchanged.

## Reproduction

Build/install the isolated app as in the original investigation. The final builder includes the production changes and narrowed AMO entry. Use new output directories:

```sh
ONCE_BENCH_MODES=export-cache,filter-regression ONCE_BENCH_WARMUP=0 \
  ONCE_BENCH_OUTPUT=artifacts/ios-extension-cleanup-20261026/cache \
  node tests/e2e/mobile/run-extension-benchmark-ios.js DEVICE_ID 3
ONCE_BENCH_MODES=bare,amo,all \
  ONCE_BENCH_OUTPUT=artifacts/ios-extension-cleanup-20261026/browsing \
  node tests/e2e/mobile/run-extension-benchmark-ios.js DEVICE_ID 3
```

The first cache run requires a fresh isolated app container, or removed benchmark cache files, so it records the initial miss. Preserve the container for the subsequent restart-hit measurements. The real Once app is never used for this experiment.

After the native host suite, copy its `artifacts/extension-support/host-results.json` into the follow-up artifact directory. Regenerate evidence with:

```sh
node scripts/summarize-ios-extension-cleanup.js \
  artifacts/ios-extension-cleanup-20261026 /tmp/once-ios-extension-cleanup
```

The summarizer validates unique completed launches, expected cache-hit state, native output equality/compilation, filtering assertions, complete traffic and content-script state before writing the report JSON. It preserves individual runs rather than only the displayed medians.
