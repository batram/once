# Android native database storage

Android uses PouchDB 9's LevelDOWN adapter engine over an app-owned SQLite byte
store. The Capacitor bridge implements storage operations; PouchDB still owns
revision trees, conflict winners, replication checkpoints, attachments and Mango
indexes. iOS and the browser harness continue using IndexedDB.

The files live in `no_backup/once-databases/` inside the Android app sandbox,
outside WebView's quota-managed storage. Database names are hashed into filenames.
The native epoch pointer is committed in Android SharedPreferences, rather than
depending on localStorage surviving. These files survive WebView data eviction;
uninstalling Once or clearing the entire app's data still removes them. Sync and
off-device backups remain necessary.

## Commit and concurrency rules

- The bridge has one worker queue, keeping SQLite work off the UI thread.
- Each PouchDB byte batch is one SQLite transaction. Acknowledgement follows
  `COMMIT`, with WAL mode and `synchronous=FULL`.
- Failed batches roll back. A document revision, attachment bytes and associated
  metadata cannot be acknowledged as separate partial writes.
- Iterators use dedicated read-only transactions with bounded pages. They retain
  their original snapshot while later writes commit.
- Completed range pages release their native transaction immediately, including
  ranges fully materialized by `iteratorOpen`. A one-row lookahead distinguishes
  an exact 128-row final page from a range needing another page, without consuming
  that next page's first row. JavaScript retains the materialized rows and still
  batches their follow-up metadata/body reads. `iteratorEnd` remains idempotent
  after native completion; failed page reads also release their snapshot.
- Snapshot connections use a 256 KiB page cache; the writer keeps its default
  cache. The 64-retained-snapshot ceiling remains a resource guard. Aggregate
  resource diagnostics are available through the native bridge as described below.
- Exact-key iterators materialize their single row atomically without retaining a
  connection. PouchDB expands `allDocs(keys)` into concurrent point iterators;
  treating these as long-lived range snapshots exhausted the connection bound
  during real story loading. Tests cover 270 concurrent native point reads on the
  phone and 1,000 PouchDB keys in the SQLite transport fixture. Range snapshots
  remain bounded to 64.
- PouchDB's follow-up metadata/body reads are prefetched by page into a maximum
  512-entry cache. Writes invalidate it before submission and after completion;
  generation checks reject stale in-flight prefetch results. A 1,000-document
  changes scan is covered by a regression test requiring fewer than 20 bridge
  reads, rather than one per record.
- AndroidX's bundled SQLite driver supplies consistent transaction semantics on
  older Android versions. Android's framework read-only transaction API is only
  available from API 35; the qualification phone runs API 33.
- The driver returns large blobs directly, avoiding Android CursorWindow's row
  size limit. Bridge payloads are base64; iterator pages are bounded by count and
  approximately 1 MiB, except for an individual larger value.
- PouchDB's legacy LevelDOWN interface is pinned to the version required by
  PouchDB 9. Adapter upgrades require repeating the qualification tests.

## Import and recovery

Before creating the app runtime, Android prepares `once_mobile_native_v1`:

1. If a committed native pointer exists, require its database's readiness or
   completed epoch record. Missing metadata is an error, not permission to upload
   empty defaults.
2. If the active legacy IndexedDB database exists, import it without modifying or
   deleting it. Preserve its epoch version so adapter migration cannot bypass an
   outstanding epoch reconciliation.
3. If legacy storage is absent and sync is configured, follow the retained server
   epoch route and pull the canonical database. Replication checkpoints are
   target-only; recovery does not write to the source server.
4. Verify document winners, deletions and decoded attachment content. Unresolved
   conflicts block activation and retain all source data. A changing source may
   be pulled and verified again, with a bounded retry count.
5. Commit readiness, epoch metadata and then the native pointer. Only afterward
   create the normal runtime and enable two-way sync.

The browser network cache remains disposable IndexedDB storage. Current browser
preferences are preserved during recovery; the durable application settings and
stories reside in the native database. The sync credential remains in the
existing Keystore-backed settings store.

## Qualification

`tests/unit/mobile/native-storage.test.js` runs the common adapter conformance
suite over a real desktop SQLite transport. `native-recovery.test.js` checks
server recovery without source writes, conflict refusal, missing native metadata,
and preservation of old epoch versions. Epoch safety tests cover delayed and
failed native pointer commits.

For isolated Android qualification, build:

```text
npm run mobile -- package android --channel dev --e2e --native-storage-probe
node scripts/build-native-storage-probe.js
```

The package ID is `com.zmarn.once.nativeprobe`, separate from development and
production profiles. Inject the generated `artifacts/performance/native-storage/probe.js`
through the Android DevTools MCP. `onceNativeProbe.atomicity()` verifies rollback
and snapshot isolation; `run()` verifies conflicts, deletion, replication,
compaction, reopen, local checkpoints and a 3.6 MB attachment.

`seed()` acknowledges an offline document and attachment while leaving its handle
open. Force-stop only the probe package, remove only its `app_webview` directory,
restart it, reinject the probe and run `verify()`. Never apply the destructive
probe procedure to production. On 2026-10-18, the actual phone passed these tests;
the conformance suite took 8.7 seconds and the same revision, checkpoint and all
3.6 MB of attachment bytes survived process stop and complete WebView storage loss.
After bounded read-ahead, the same on-phone conformance test passed in 4.9 seconds.

## Attachment transport finding

The first production recovery was correctly blocked by the content fingerprint
check. One HTML attachment was 29,557 bytes at CouchDB but 29,710 bytes after
download: a `mailto:` link had become a `/cdn-cgi/l/email-protection` link. The
document revision was unchanged. This was a raw HTTP response transformation,
not a SQLite byte-encoding failure. The rejected, uncommitted native staging
database was backed up before removal; normal startup and two-way sync never
started from that copy.

Remote attachment reads now explicitly request CouchDB JSON with base64 content,
using the authenticated PouchDB HTTP transport. `get({attachments:true})` is not
sufficient: PouchDB's HTTP adapter internally follows it with raw attachment
requests. The protection is wired into mobile, Electron and extension source code.
The regression test deliberately rewrites a raw HTML endpoint and verifies that
protected replication retains the original bytes. Existing desktop/extension
installations need their next deployment to receive this protection.

The authenticated transport requires a `Headers` instance because PouchDB adds
authorization with `.set()`. An initial plain-object implementation failed on the
phone with `n.headers.set is not a function`; it was corrected and the transport
regression now includes authentication rather than testing only an open fixture.

`scripts/native-storage-audit.js` performs a read-only audit through the bridge
without opening or closing the running application's PouchDB handle. It reports
revision winners, deletions, leaves, missing bodies and attachment SHA-256 hashes.
Repeat an audit if its sequence changes during collection.

The first test update was refused for insufficient installation space. After the
user freed space (13 GiB available), qualification and production installation
could proceed. Android needs space for package staging as well as database files.

## Recovered phone — 2026-10-18

Release-channel build `261018-210258` was installed on the phone. Recovery passed
strict content verification and normal startup resumed. The app displayed 155
story rows and reported **Up to date**. A stable read-only comparison found:

- 32,608 live native documents matching all client documents on the server;
  CouchDB had 32,609 including its server-only compatibility marker.
- 217 winning deletions; no missing, extra or mismatched client winners.
- 57 matching attachment SHA-256 hashes, no missing bodies, and no unresolved
  conflicts or extra leaves.

The rejected staging database, remaining preferences and incident evidence were
preserved privately. After recovery, Once was force-stopped for a consistent
off-device native backup, then restarted for the final smoke check. The backup
includes SQLite files and the native epoch pointer; it is not an Android Keystore
export. The isolated probe installation was removed after qualification.

Validation: 1,295 unit tests passed, two were skipped; focused Electron platform
tests and type, structure, boundary, line-ending, dead-code, scoped lint and diff
checks passed. One full test run hit the previously observed Windows `EPERM`
renaming a temporary Violentmonkey fixture; an unchanged rerun passed.

Dependency qualification remains pinned to PouchDB 9's legacy LevelDOWN API. The
production dependency audit reports moderate advisories through transitive
`uuid` 8 dependencies; the reported bounds-check issue concerns v3/v5/v6 with a
caller-supplied buffer, while these PouchDB modules use v4. No broad dependency
upgrade or audit-force downgrade was applied as part of device recovery.

## Range snapshot exhaustion — 2026-10-26

Story loading now reads each story's immutable ingestion observations through a
prefix range. A bulk story load fans these reads out concurrently. Previously,
even an empty range retained a native snapshot until JavaScript ended its
iterator, and a populated short range needed another bridge call to discover
exhaustion. A burst could therefore fill the 64-snapshot bound before cleanup
arrived. This was reproduced on the Samsung phone in an isolated database:
96 concurrent empty ranges produced 64 successes and 32 failures with
`IllegalStateException (Too many open range snapshots)`.

Native ranges now release completed snapshots as described above. The connection
bound remains 64 for active multi-page reads; it is checked after determining
whether the initial page requires retaining a transaction. No database migration
or stored-document change is required.

The isolated on-phone `onceNativeProbe.rangeCapacity()` qualification passed 512
concurrent populated/empty ranges, exact 128-row completion, the active snapshot
bound, final-page capacity recovery before `iteratorEnd`, and snapshot isolation
across a concurrent write. `rangePages()`, `atomicity()` and the full storage
conformance probe also passed, including reverse reads, limits, keys-only reads,
rollback, revisions, replication, reopen and a 3.6 MB attachment. Desktop SQLite
regressions additionally exercise the real `PouchStoryStore` loading 270 stories
and their observation prefixes concurrently, plus bounded read-ahead for completed
range pages.

The fixed release-channel build was installed on the same phone after taking a
consistent native database/pointer backup. The deployed JavaScript bundle matched
the built asset. The original 96-empty-range reproduction then passed all 96
reads with no retained handles, and a live story reload completed without native
database failures. Hacker News stories rendered successfully. The separate Reddit
HTML-as-JSON response error remained reproducible and is outside this storage fix.

A DevTools reload of only the shell WebView also exposed the existing
`Database already open` guard, because the native plugin survives that page reload.
A full Android process restart recovered normal startup. Qualification of the
installed fix uses normal app starts and the Stories reload action; WebView-only
reload lifecycle handling remains separate work.

## Snapshot resource bound investigation — 2026-10-26

The 64-reader guard first appeared in commit `92aa8526`, together with the native
adapter. Neither that implementation nor its qualification report derives 64
from a SQLite limit or a measured memory budget. SQLite itself supports arbitrary
reader counts subject to available resources; see its [concurrency guidance](https://www.sqlite.org/whentouse.html#high_concurrency).

The guard bounds retained connections and their private native page caches.
It also limits simultaneous native handles/file descriptors. It does not bound
snapshot lifetime, WAL growth, bridge response allocations, or materialized rows
retained by JavaScript. All database work runs on one worker, so retaining more
snapshots does not add worker parallelism.

### On-phone measurements

The opt-in `NativeSnapshotResourcesTest` runs only in an isolated `.nativeprobe`
profile. It uses the same bundled driver, table layout, FULL synchronous WAL
writer, query-only deferred read transactions and eager snapshot pinning as the
production bridge. It creates/deletes only its own uniquely named synthetic file.
The regular Once profile is not used for the resource stress experiment.

The qualification phone is the Samsung SM-G780G, Android API 33. Its bundled
SQLite reports 3.50.1, 4096-byte pages, `mmap_size=0`, and `cache_size=-2000`.
The app process has an open-file limit of 32,768. The 256 MiB Android memory class
is a managed-heap setting, not a ceiling on SQLite's native allocations.

With the unchanged default cache, 512 simultaneous first-page readers succeeded:
there was no native failure boundary at 64. A fresh-process first-page sweep read
128 rows of 1 KiB values per reader. A separate, repeated paged-scan comparison
read all 10,000 rows in 128-row queries from a 44.7 MiB synthetic database. It used
two fresh instrumentation processes per cache configuration and retained each
reader's transaction after the scan. Native allocation deltas were:

| Retained readers | Default 2000 KiB cache | 256 KiB reader cache | Additional open FDs |
| --- | ---: | ---: | ---: |
| 16 | 38.8 MiB | 5.8 MiB | 32 |
| 32 | 77.3 MiB | 11.3 MiB | 64 |
| 64 | 154.7 MiB | 22.7 MiB | 128 |
| 128 | 309.4 MiB | 45.4 MiB | 256 |

The first-page-only workload was much smaller: approximately 10.7 MiB at 64
readers and 86.3 MiB at 512. SQLite fills caches on demand, rather than allocating
the configured maximum when the connection opens. Its [cache-size documentation](https://www.sqlite.org/pragma.html#pragma_cache_size)
and [memory allocator documentation](https://www.sqlite.org/malloc.html#page_cache_memory)
explain both that behavior and overhead beyond the configured page bytes.

At 64 retained readers, median per-reader full paged-scan times were 49.8–50.8 ms
with the default cache and 46.9–47.4 ms with 256 KiB. A 64 KiB cache used about
10.2 MiB total and scanned in 43.8–48.5 ms; 512 KiB used about 42.1 MiB and scanned
in 46.9–48.6 ms. These two-run phone timings do not establish a universal latency
optimum. Background scheduling and fsync tails were noisy: one 256 KiB case had
a 5.57 ms commit p95, compared with 0.65 ms in the other run. The robust finding
is the memory reduction without an observed median paged-scan penalty. This is
not a full application throughput benchmark or a qualification of every device.

A separate observed warm story refresh/bookmark read in the regular app issued
141 range opens. All 141 completed in their initial page, retaining no native
snapshots, and no native operation failed. This does not measure cold startup or
establish a maximum for every replication/indexing workload.

### WAL behavior

With automatic checkpointing enabled, 1200 same-row updates after a reader
pinned the first WAL frame produced 1201 frames. With either one reader or 64
readers, only one frame could be checkpointed. Closing the readers allowed all
1201 frames to checkpoint; an explicit truncate then reduced the WAL to zero.
With no reader, automatic checkpointing recycled the WAL at the default threshold.
The result repeated in all eight paged-scan runs.

Thus the snapshot count does not bound WAL retention: one old reader is enough.
This matches SQLite's [checkpoint starvation documentation](https://www.sqlite.org/wal.html#avoiding_excessively_large_wal_files).
`journal_size_limit` limits a reusable/reset WAL, rather than discarding frames
needed by an active reader. Count tuning cannot replace observing oldest-reader
age and WAL size, completing/cancelling whole operations, and releasing handles.
Silently expiring snapshots or reopening them at a newer version would break the
adapter's snapshot-at-creation contract.

### Recommended policy

Keep a bound on retained physical snapshots in the current connection-per-iterator
design. Removing the bound would exchange a controlled error for potentially
unbounded native memory/file-descriptor use. The experiment establishes no
performance cliff at 64 and no throughput reason to raise the ceiling.

There is no count optimum independent of cache configuration, workload and device
headroom. A useful sizing model is `count <= reader memory budget / measured
per-reader allocation`, with descriptor headroom checked separately. For example,
a deliberately chosen 32 MiB reader budget fits only about 13 fully scanned
readers with today's cache, versus about 90 with a 256 KiB cache. That budget is
an engineering choice, not an Android or SQLite requirement.

The recommended next implementation is a 256 KiB cache on snapshot connections
and a 64-snapshot emergency ceiling: about 23 MiB in this scan workload, with
headroom within that example budget. Keep the writer cache unchanged. 256 KiB
leaves more working-set margin than the smallest tested cache; it is a conservative
choice rather than a proven cache optimum. Add high-water/oldest-age/WAL telemetry
and apply producer backpressure if genuine multi-page concurrency approaches the
ceiling. A future implementation can share a physical transaction among iterators
created at the same database write generation, reducing duplicated caches.

Do not simply defer opening an iterator until another ends: a write could commit
in between and change its required snapshot. Blocking the single worker while
waiting for capacity would also prevent queued iterator-end calls from freeing
capacity. Any scheduling change must preserve creation ordering and progress.

The investigation initially changed no production limit or cache setting. Raw
measurements are retained under
`artifacts/performance/native-range-20261026/snapshot-*.json`.

### Implemented resource policy and qualification

The subsequent implementation keeps the 64-snapshot ceiling and sets
`PRAGMA cache_size=-256` only on snapshot connections. The writer cache remains
unchanged. Completed pages release connections immediately, including short
ranges opened while all 64 persistent slots are occupied.

`NativeDatabase.execute({ operation: "diagnostics", name })` reports the global
active/peak snapshot counts, oldest snapshot age in milliseconds, configured
limit/cache size, an active reader's actual SQLite cache setting (null when there
are no retained readers), the requested database's WAL byte size, and its writer's
actual cache setting. Counts/age/peak cover the plugin instance, while WAL size
and writer settings belong to `name`. Peak is retained for the plugin lifetime.
Diagnostics are read-only and requested explicitly; capacity failures also emit
that aggregate summary under the `OnceDatabase` Android log tag. No keys, document
bodies, database names or credentials are returned or logged by the summary.
Snapshots are not expired or reopened at a later version automatically.

The smaller-cache build passed the isolated phone qualification:
`rangeCapacity()` verified 512 concurrent short ranges, short-range success at
capacity, the 64-active limit, actual reader cache `-256`, an unchanged writer
cache, final-page release and consistent resource diagnostics. `rangePages()`,
`atomicity()` and the full adapter conformance probe passed, including snapshot
isolation, reverse/limited/keys-only reads, rollback, revisions, replication,
compaction, reopen and the complete 3.6 MB attachment. Evidence is retained in
`artifacts/performance/native-range-20261026/small-cache-qualification.json`.

The updated release-channel build was then installed on the Samsung. Its native
diagnostics confirmed the 64-snapshot ceiling, 256 KiB reader policy and unchanged
writer cache (`-2000`). A live story reload completed without native errors;
active snapshots returned to zero, oldest age was zero, and the app-launch peak
was one. The mobile suite passed 394 tests and 39 focused storage/recovery/ingestion
tests passed. The temporary probe app was removed after qualification.

### Reproduce

From `apps/mobile/android`, build isolated APKs:

```text
./gradlew :app:assembleLiteDevelopmentDebug :app:assembleLiteDevelopmentDebugAndroidTest -PonceNativeStorageProbe=true -PonceDeployAbis=arm64-v8a
```

Install the resulting Lite development app and AndroidTest APKs on the test
device. Run the named test with the explicit opt-in flag:

```text
adb -s DEVICE shell am instrument -w -e class com.zmarn.once.NativeSnapshotResourcesTest -e snapshotResources true -e snapshotScenario full -e readerCacheKiB 256 com.zmarn.once.lite.nativeprobe.test/androidx.test.runner.AndroidJUnitRunner
adb -s DEVICE exec-out run-as com.zmarn.once.lite.nativeprobe cat files/snapshot-resources.json
```

`readerCacheKiB=0` preserves SQLite's default. Omit `snapshotScenario` to measure
both first-page and full-scan retention. The test stops a sweep after a sampled
native-allocation delta exceeds 192 MiB or a PSS delta exceeds 256 MiB; it is not
an intentional OOM experiment. Counts are sampled in steps, so the last sample
can exceed that budget. PSS can include allocator-retained pages from an earlier
sweep; the comparison above uses fresh full-scan processes and native allocated
bytes. Without `snapshotResources=true`, this benchmark is skipped.
