# uBlock cached restoration — Samsung, 2026-10-20

Baseline: `e7287626`. Android now prefetches static snapshots during settings initialization, overlaps independent restore work and batches repeated administrator-settings reads. The change preserves uBlock's requested-URL suspension and filter-readiness sequence. Measurements showed substantial within-session drift, including when reinstalling the original APK; the results do not support a precise, portable startup saving.

## Changes

The Android built-in copy differs from the pinned uBlock Origin 1.74.0 bundle in two source files:

- `storage.js`: the three static snapshots are prefetched after cache-backend selection, overlapping the general settings reads. Prefetch never applies filters. Creation/invalidation advances a generation and drops pending entries; consumption and final restoration reject stale data. Speculative read failures become cache misses without unhandled rejections, and entries are consumed once. Public-suffix data loads without waiting for optional WebAssembly. The existing JavaScript implementation remains usable, and upstream's WASM activation copies already-loaded data when it becomes available. Rejected WASM activation remains handled. Redirect/scriptlet resources restore concurrently with the three static filter snapshots. All tasks must settle before successful completion or fallback, so failed restoration cannot race a still-running resource load.
- `start.js`: after backend selection it starts the prefetch, retaining all subsequent format, validity and readiness checks. The four administrator-settings reads share one cached settings snapshot and one upstream managed-settings refresh, instead of repeating that read/refresh/write cycle for every subset. Results are cloned per caller, selection/default semantics are retained, and a `finally` restores the original API after initialization. Later reads retain upstream behavior. This respects upstream's documented persisted-policy snapshot model, under which policy changes can require another restart.

The entire startup suffix beginning with filter-engine priming, including snapshot/list fallback, `readyToFilter`, tab initialization and `webRequest.start()`, is unchanged. `traffic.js`, its suspend/unsuspend implementation, cache formats, selected lists and permissions are unchanged. Once's catalog, filter acknowledgement and userscript gates also remain unchanged.

`scripts/adapt-gecko-ublock.js` generates the Android copy under `vendor/extensions/android`. The original hash-verified, Mozilla-signed bundle remains untouched for other consumers. The modified built-in omits the now-inapplicable upstream signature files and uses GeckoView's existing built-in installation mechanism; signature-verification preferences are not weakened. Its ID remains the same, retaining the user's profile. A content-derived manifest revision causes Gecko to update the built-in; `version_name` retains the upstream version so uBlock does not accidentally enable development-build defaults or apply spurious version migrations.

## Benchmark method and results

Samsung Galaxy S20 FE SM-G780G, Android 13, GeckoView `155.0.20260903215306`; production-channel debug APK, unlocked foreground, retained production profile with 31 source configurations and five userscripts. uBlock, Violentmonkey, Dark Reader and SponsorBlock stayed enabled, alongside the Once bridge. uBlock retained 276,265 network filters and a valid cached engine snapshot.

Each run force-stops the app, observes its shell for 15 seconds, then opens a tiny local HTTP page over ADB reverse. Native-open acceptance and the page's load report are measured separately; the latter includes transport overhead and is not a first-paint measurement. All measured runs reported a valid cached snapshot. There are three measured runs per earlier batch and five in the final prefetch batch. Post-install warmups, diagnostic builds, profiling and fault/instrumentation tests are excluded.

| Build/batch | Runs | Native open, median | Page report, median | uBlock ready after T0, median |
|---|---:|---:|---:|---:|
| Original initial baseline | 3 | 1,199 ms | 1,710 ms | 596 ms |
| Intermediate, no prefetch | 3 | 1,506 ms | 2,276 ms | 859 ms |
| Original reinstalled | 3 | 2,104 ms | 2,798 ms | 894 ms |
| Intermediate repeated, no prefetch | 3 | 2,045 ms | 2,752 ms | 798 ms |
| Final implementation with prefetch | 5 | 1,518 ms | 2,094 ms | 689 ms |

The final five-run page-report range is 1,999–2,208 ms and native-open range 1,491–1,645 ms. The repeat original-build ranges were 2,687–2,935 ms and 1,991–2,196 ms. Final uBlock readiness ranges from 591 to 733 ms. First network requests followed readiness by 13–31 ms. The final maximum cache-wait median is still 423 ms: prefetch overlaps that work rather than making the records cheaper to read.

The original APK was reinstalled between updated-build batches to expose drift instead of attributing every difference to the code. This is still a sequential experiment, not randomized A/B. Android reported thermal status 0 during the slower batch, with AP temperature 39.4°C and battery temperature 33.7°C; that excludes reported thermal throttling at that observation, not all scheduling, storage or power-state effects. The initial and repeat original-build results differ enough that a single before/after percentage would be misleading.

## What the investigation established

The original startup path reads the same `cachedManagedStorage` value four times. Each read also starts a managed-storage refresh and a write back to local storage. The new startup wrapper reduces that to one read/refresh cycle while keeping all consumers behind its completion. Settings reads and cache access are asynchronous; their elapsed waits include scheduling and must not be described as pure disk costs.

An early instrumented adaptation showed this sequence relative to uBlock's own startup timestamp: initialization begins at 51 ms; administrator settings at 206 ms; hidden settings at 257 ms; first general settings fetch at 331 ms; public-suffix/cache metadata at 473 ms; user settings at 550 ms; static and redirect snapshot reads begin at 556 ms; filter restoration completes at 999 ms; all-ready at 1,011 ms. This diagnostic build preceded administrator-read batching and the runtime-version correction, so these numbers identify dependency ordering and are excluded from the final benchmark. Instrumentation is not shipped.

A 5 ms JavaScript sampling profile of the original build found relatively few uBlock JavaScript samples compared with the elapsed startup interval, including module initialization and trie restoration/checksums. Sampling does not measure storage wait time or isolate all native copying cost. Together with the cache-wait telemetry, it supports investigating storage delivery and scheduling rather than assuming the full startup interval is spent executing filter deserialization.

A separate, post-startup read-only check quantified the raw IndexedDB records:

| Snapshot | Read elapsed | Approximate payload bytes | Traversed values |
|---|---:|---:|---:|
| Main metadata | 1 ms | 45,932 | 1,349 |
| Cosmetic/extended filtering | 335 ms | 15,030,282 | 939,306 |
| Network filtering | 175 ms | 19,955,944 | 57,707 |
| Redirect resources | 4 ms | 632,372 | 2,407 |

These were sequential reads after startup, not additive cold-start phases. Payload sizes count strings and binary views, not complete JavaScript heap usage. The especially large cosmetic object graph helps explain why raw cache delivery is expensive.

The existing serialized backup was tested without modifying storage. Cosmetic data took 158 ms to read plus 380 ms to deserialize; network data took 313 ms plus 449 ms. That alternative was slower than raw IndexedDB delivery and was rejected. The final optimization instead overlaps the existing raw reads with settings initialization, while keeping snapshot checks and the request barrier in place.

In the final five runs, median device-clock milestones relative to Gecko's LAUNCHED event were: libraries ready 37 ms; Gecko running 283 ms; blank document start 666 ms; uBlock background document origin 915 ms; uBlock's T0 1148 ms; requested page navigation 1554 ms; uBlock filtering ready 1846 ms; Once page-ready 2032 ms. These are milestones, not independent costs to add. The background-document-to-T0 gap includes script/module loading and scheduling, and the requested page can begin navigating while its network request remains suspended.

The first network request continues to follow uBlock readiness closely. Readiness is calculated using `vAPI.T0 + supportStats.allReadyAfter` and compared with the page's `performance.timeOrigin + requestStart`, using device clocks. Upstream suspends requests while the filter engine initializes and releases them in `webRequest.start()`; this remains intact. Cached engine readiness is still a real critical path, even when native open acceptance happens sooner.

The next targeted investigation is to separate IndexedDB record delivery/structured cloning, object deserialization and trie restoration under a controlled device state. `maxAssetCacheWait` includes the registry/cache promises and scheduling, and concurrent waits cannot be summed into a startup total. Changing cache backends or bypassing the request barrier is not part of this change.

## Integration

The comparison was measured on the `e7287626` application base. Upstream keyboard-inset and Git-hook changes landed during testing and are integrated separately; the uBlock adapter and generated JavaScript are unchanged by that integration. The final combined application is rebuilt and smoke-tested. The JSON distinguishes the measured APK from the final installed APK.

## Validation and cleanup

- Fifteen focused tests cover concurrent static/redirect completion, invalid and rejected snapshots, resource rejection, invalid-cache fallback, optional/disabled/failed WASM, managed-settings subsets/defaults/isolation/restoration, prefetch reuse/invalidation/failure, and adaptation invariants. The source after the filter-engine priming point and the network suspension implementation are checked against upstream.
- All 344 mobile unit tests and mobile typechecking passed.
- Three native instrumentation methods passed on the Samsung using an initially empty, temporary development Gecko profile: first page and warm switches; held catalog/filter and userscript readiness including pending memory-pressure protection; paint-readiness invalidation.
- The existing production profile successfully upgraded to the adapted built-in, returned to the original built-in for comparison, then upgraded again. No profile clearing or extension disabling was used for timings.
- The temporary development profile, Gecko configuration and inspector forwarding are removed. A temporarily enabled uBlock console setting was restored to its original absence. The phone is left on the final normal build. The installed APK is checked against the local artifact.

The repository pre-push static checks and complete unit suite run on the committed change. Sanitized measurements are in the accompanying JSON; raw diagnostics remain in ignored `artifacts/gecko-startup-detail/`.
