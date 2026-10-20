# Once Lite: batching settings reads and avoiding recovery-only startup work

Measured 20 October 2026 on the Samsung SM-G780G, Android 13,
WebView 155.0.8059.43. Baseline commit: `1b61ee5c`, the committed
[native asset fulfillment change](once-lite-native-assets.md).
Individual samples are in [once-lite-startup-followup.json](once-lite-startup-followup.json).

## Changes

`ExtensionStorage` merges keyed reads that have not reached the store yet.
Requests arriving while another read is active can share the next native read,
with no timer or deliberate batching delay. Each caller still receives its
own requested keys/defaults. Full enumeration is an ordering barrier; a failed
batch rejects its callers without caching missing values, so subsequent calls
can retry. Existing local-change and failed-write recovery behavior is retained.

Native database preparation now accepts a lazy recovery URL. A verified existing
database returns without reading that URL; local migration also does not need
it. Remote recovery resolves it once, and lookup failures prevent activation.
The existing ready/epoch records are read concurrently. Pointer validation,
missing-metadata refusal, conflict checks and recovery verification are unchanged.

## Measurements

Five process-cold baseline launches, three launches with only extension-read
batching, then five launches with both changes. App foreground and unlocked,
debug production-identity APK, existing profile and caches retained. First
post-install launches are included. All runs successfully restore uBlock's
compiled snapshot.

Times below are medians in milliseconds. Configurations/stories/extensions use
the host launch request calibrated to the shell clock. Platform preparation
is the interval between the existing `platform` and `app-start` markers.
The settings group is the observed interval covering uBlock's concurrent list
selection, user preferences, request statistics and request-count reads.

| Measurement | Baseline | Batching only | Both changes |
| --- | ---: | ---: | ---: |
| uBlock native startup storage reads | 8 | 6 | 6 |
| Native sync-URL calls in observation window | 4 | 4 | 3 |
| Concurrent uBlock settings group | 90.9 ms | 44.3 ms | 31.5 ms |
| Platform preparation | 507.8 ms | 515.6 ms | 443.2 ms |
| Extensions ready | 3,326.4 ms | 3,599.3 ms | 3,356.5 ms |
| Configurations populated | 2,271.6 ms | 2,436.4 ms | 2,364.6 ms |
| First stories | 2,810.6 ms | 2,907.8 ms | 2,796.0 ms |
| All 110 stories | 2,888.8 ms | 2,973.0 ms | 2,860.9 ms |

The read counts improve consistently in every measured launch: eight to six
uBlock reads, and four to three sync-URL calls with lazy recovery lookup.
The native settings request containing 26 preference keys now also carries
the three statistics/count keys, instead of making two additional round trips.

**There is no demonstrated end-to-end startup improvement in this sample.**
Final extension readiness ranges from 3,243.5 to 4,668.2 ms, compared with
3,260.7 to 3,472.7 ms in the baseline. The final median is about 30 ms slower,
with one slow launch. The batching-only series is slower overall despite its
shorter settings phase. These sequential, small samples cannot attribute that
variation to one change, nor establish that platform preparation's lower median
is a reliable total-startup gain.

The concrete result is less native work and a shorter measured settings phase.
These changes remove avoidable requests; they do not resolve the remaining
module-loading, scheduling and snapshot-restoration costs identified in the
native asset report. A stronger total-startup claim needs a larger randomized
comparison, not selective exclusion of slow runs.

## Validation

- 370 mobile/runtime JavaScript tests passed, including concurrent disjoint
  reads, independent defaults, queued-read merging, failed-batch retry, full-read
  ordering and existing partial-cache write recovery.
- Recovery tests cover verified existing databases, migration without a remote
  URL read, lazy remote recovery, failed URL lookup without pointer activation,
  missing metadata, conflicting revisions and attachment preservation.
- Root/package/mobile type checks, lint, structural limits, boundaries and
  whitespace checks passed.
- Both Samsung regression checks passed: the bundled extension filtering/
  userscript/restart test and the native legacy/split/chunked keyed-storage test.

The existing native implementation is unchanged in this follow-up. The separate
dev package is used for instrumentation; the production-identity app is restored
afterward without profiling overrides. Raw traces remain under
`artifacts/lite-startup-detail/` and are ignored by Git.
