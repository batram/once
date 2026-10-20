# Parallel Gecko session startup — Samsung, 2026-10-20

Baseline: `c7cb29b1`. The first blank session now opens immediately after extension preparation is queued, instead of waiting for the complete catalog. The requested URL still goes through the catalog, native filter-acknowledgement and Violentmonkey-settlement gates, with their existing bounded timeout behavior. This change starts the blank document earlier, but the measured first-page latency is not faster overall.

## Implementation and lifecycle safeguards

`InAppBrowserSurfacePlugin.ready()` starts the catalog future and calls `ensureReadingSession()` before attaching the catalog completion callback. It does not create a visible reading surface or load the requested URL at that point. Once the catalog arrives, the manager adopts the installed extensions, attaches delegates and ensures the bootstrap session is still open. The existing settings/userscript barrier then releases navigation.

The waiting-call map, surface generation and navigation sequence continue to reject or suppress obsolete work. Closing a pending surface prevents a late catalog result from recreating it. A superseding open replaces the old request. Catalog failure rejects the request; a retry can reuse the blank session.

A longer diagnostic run exposed an important lifecycle regression in the initial implementation: Android sent a memory-pressure callback while the new blank session was still hidden. The host reclaimed that session before it could start extension ports, and the open hit its 30-second deadline. The final implementation therefore:

- Exempts sessions with pending startup calls from hidden-session eviction, including both Android trim callbacks and tab eviction.
- Reopens a bootstrap session that has closed before catalog delivery, with the old session/delegates released correctly.
- Clears the old hidden-process-death flag when creating its replacement, preventing an unnecessary later recovery reload.
- Makes completed hidden pages reclaimable again. It does not permanently pin the session or change the existing readiness timeouts.

A production-app fault check injected `RUNNING_CRITICAL` about 200 ms into a cold browser open. The fixed build accepted navigation in 2,307 ms and received the local page's report in 3,047 ms, without a timeout. This was also a post-install warmup and is excluded from the ordinary timing comparison.

## Benchmark method

Samsung Galaxy S20 FE SM-G780G, Android 13, GeckoView `155.0.20260903215306`. The retained production profile has 31 configurations, five userscripts and the Once bridge, uBlock, Violentmonkey, Dark Reader and SponsorBlock. No profile data, extension permissions or enabled states were cleared or changed.

Three fresh baseline runs were collected before installation, followed by five runs of the final implementation. Each force-stops the process, observes the Capacitor shell for 15 seconds, then opens a tiny local HTTP fixture through ADB reverse. The phone was unlocked and foreground. Both builds use the production-channel debug variant and the same package verification mode. The post-install warmup, deliberate memory-pressure check, native instrumentation and the failed pre-fix diagnostic are excluded.

This is a sequential before/after experiment, not randomized A/B. Live feeds and sync remain enabled. Host launch timings, native log deltas and WebView timings are distinct clock measurements; the phase table uses only within-log differences. The local page report includes report transport and is not a first-paint measurement.

| Milestone | Baseline, median of 3 | Final, median of 5 |
|---|---:|---:|
| First saved stories from launch request | 1,994 ms | 1,907 ms |
| Source configurations visible | 2,046 ms | 1,952 ms |
| First native browser open resolves | 1,467 ms | 1,525 ms |
| First native open range | 1,397–1,583 ms | 1,519–1,594 ms |
| First local page reports loaded | 2,145 ms | 2,188 ms |

There is **no demonstrated end-to-end browser startup gain**: median open acceptance is 58 ms higher, with overlapping ranges. The story-list difference should not be credited to this change: that path does not start Gecko, and its initialization code is unchanged.

## Where the remaining time goes

Median native milestones, relative to Gecko's `LAUNCHED` log event:

| Milestone | Baseline | Final |
|---|---:|---:|
| Native libraries ready | 40 ms | 38 ms |
| Gecko running | 214 ms | 301 ms |
| Bootstrap blank document starts | 726 ms | 677 ms |
| Bridge's session delegate attached | 340 ms | 1,205 ms |
| First background native-port event | 955 ms | 1,053 ms |
| Requested page starts | 1,471 ms | 1,537 ms |
| Once signals page ready | 2,091 ms | 2,131 ms |

The blank document starts about **49 ms earlier**, but catalog-dependent delegate attachment happens much later. This is more than a scheduling guess: the shipped Gecko implementation explains the dependency.

Inspection of `modules/GeckoViewWebExtension.sys.mjs` in the pinned GeckoView AAR's `assets/omni.ja` shows:

- `ensureBuiltIn()` waits for `AddonManager.readyPromise`, reads the bundled version and calls `exportExtension()` for an unchanged installed extension.
- `exportExtension()` checks `WebExtensionPolicy.getByID()` and awaits its `readyPromise` when present.
- The `GeckoView:WebExtension:List` handler also exports every extension through that same readiness-aware function.

Starting the session earlier initiates activation sooner, but also makes those policy-readiness dependencies visible to the preparation/catalog path. The observed later delegate attachment is consistent with that mechanism. This implementation overlaps the host's calls; it does not make Gecko's policy initialization independent of its catalog APIs.

In the final five runs, `OnceReadSnapshot` begins around 1.23–1.27 seconds after the open request and takes **225–296 ms**. Settlement then adds about 20–32 ms, plus small intervening operations. Those snapshot durations include extension startup work, storage/export and cross-engine scheduling; they are not isolated disk-read costs. The earlier hand-off batching and unchanged-snapshot fast path remain in place.

An earlier native-acceptance experiment would be to attach Violentmonkey's relay as soon as its own `ensureBuiltIn()` completes, allowing its snapshot/reconciliation work to overlap the remaining catalog preparation. The final full-catalog, filter and userscript barriers would still have to gate the requested URL. That follow-up is not implemented here, and no saving is assumed. Engine-level process preallocation is a separate option with memory/lifetime tradeoffs; this change does not enable a spare process or eagerly start Gecko for the story list.

Gecko's extension startup cache was also inspected: its `StartupCache.save()` uses a 5-second deferred write. Cache files were present after an idle interval. The subsequent pre-fix trial timed out because the host reclaimed the hidden bootstrap, so it cannot establish a cache-warming performance effect.

## First-request delay: uBlock filter restoration

Three additional diagnostic launches read uBlock's existing `supportStats` after the page had loaded. They used the final build rebased onto `26e785dd`; the native startup implementation is unchanged by that rebase. These later launches are kept separate from the before/after comparison: installation state, caches, scheduling and unrelated upstream shell changes prevent attributing their faster results to this change.

| Diagnostic | uBlock ready after its T0 | Longest asset-cache wait | uBlock ready after page navigation origin | HTTP request after uBlock ready |
|---|---:|---:|---:|---:|
| Rebased post-install smoke | 867 ms | 264 ms | 409 ms | 9 ms |
| Later launch 1 | 755 ms | 242 ms | 356 ms | 10 ms |
| Later launch 2 | 716 ms | 274 ms | 400 ms | 12 ms |

All three reported a valid cached filter-engine snapshot (uBlock's “selfie”) and the IndexedDB cache backend. From the background document's time origin to uBlock readiness, the totals were 1,070, 942 and 929 ms. The page's first HTTP request began only 9–12 ms after uBlock reported readiness, accounting for roughly 356–409 ms of the otherwise unexplained delay after page navigation began.

This correlation has a matching mechanism in the bundled source: `traffic.js` initially suspends network handling, then `webRequest.start()` installs the filtering listeners and unsuspends requests. `start.js` calls that function after filter initialization, immediately before recording `allReadyAfter`. `vapi-common.js` records `vAPI.T0` using `Date.now()`, allowing the readiness timestamp to be compared with the page's `performance.timeOrigin + requestStart`. This uses timestamps on the same device, not host elapsed time.

The next target for visible first-page latency is therefore uBlock's cached filter restoration. Its longest asset-cache waits of 242–274 ms include both registry/cache operations and scheduling, not just disk access, and must not be added together or subtracted from total startup as independent phases. A follow-up should separate IndexedDB retrieval, snapshot deserialization, filter-engine initialization and scheduling contention while retaining the request-suspension barrier. Earlier Violentmonkey settlement alone may improve native acceptance without advancing the first network request.

The rebased build was rebuilt, installed and smoke-tested; its installed APK checksum was matched to the local artifact. The JSON preserves the original benchmark APK checksum separately from the final installed APK checksum. Diagnostics used read-only inspection plus transient in-memory result globals; restarting the app removes those globals.

## Validation

Seven native test methods passed on the Samsung in separate instrumentation processes, using a temporary fresh Gecko profile in the development app:

1. Blank session before catalog delivery; no visible surface or requested-page network request before the filter barrier; userscripts settled before acceptance; pending trim/eviction protection; completed hidden-page reclamation.
2. Closed/killed bootstrap replacement before navigation, with the stale death flag cleared.
3. Close and supersede while catalog delivery is held, without obsolete page requests or session resurrection.
4. Catalog failure followed by a successful retry.
5. First page and warm switches, including settings acknowledgement, bridge connection and paint/readiness.
6. Paint-reset invalidation.
7. Retained tabs, independent document/history state and rejection of closed tab generations.

The test harness now waits for both shell UI readiness and the shell's initial extension-settings publication. Controlled Gecko results use a main-thread handler. Startup tests explicitly select the root session rather than inspecting it while another tab is selected. A combined instrumentation run encountered an activity-focus setup failure; the final methods were run separately to keep process/foreground state independent. Earlier fixture setup failures and the superseded pre-fix implementation are not counted as successful validation.

The 330 mobile unit tests passed. Android production/development debug builds and instrumentation packaging passed. Structural, lint and whitespace checks passed; the repository's pre-push checks also run on the committed change.

The development test profile and temporary Gecko YAML are removed. The regular app is left running normally, with its existing profile retained and temporary inspector forwarding removed. Raw logs remain in ignored `artifacts/gecko-startup-detail/`; the accompanying JSON contains sanitized timing summaries.
