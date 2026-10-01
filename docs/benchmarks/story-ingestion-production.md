# Production ingestion limit validation

Validated 2026-10-01 after implementing one shared limit of 64 story ingestion operations per AppRuntime.

## Implementation

StoryIngestionQueue shares FIFO capacity across source batches. AppRuntime registers each ingestion operation with StoryWriteQueue before acquiring a shared slot. This preserves ordering against later edits to the same URL; same-URL predecessors do not consume ingestion slots while waiting. Unrelated user edits and sync reconciliation retain their existing write path outside the ingestion gate. Slots release on success, asynchronous rejection, and synchronous exceptions. Promise.all retains source result order.

The bulk URL lookup remains outside the gate. The production benchmark therefore observes up to 69 outstanding database promises: 64 story operations plus overlapping source lookups. This limit bounds active ingestion, not all application database traffic or the memory used to hold source input and queued promises.

## Related improvements

- Bulk PouchDB URL lookups deduplicate URLs before requesting documents; ingestion still processes every incoming story so shared-URL source metadata is preserved.
- Empty batches skip the storage lookup.
- Tag merging uses a Set of existing tag texts instead of rebuilding an array for every incoming tag. It saves and emits changes only when new tags are added. Reordering, subsets, and duplicate incoming tags do not produce redundant saves.
- Failed new-story insertion removes the unpersisted working-set entry if it still owns that URL. Failed tag saves restore the previous tags. Both changes allow a later source retry to persist the data rather than mistake failed mutations for completed ingestion. A queued user edit can still restore the story after a failed insertion.
- Benchmark scripts follow repository lint conventions. Historical benchmark modes explicitly bypass the native limiter; --production exercises it and observes actual story execution after per-URL ordering.

## IndexedDB verification

The production implementation, with no experimental gate substituted, completed 27 samples: six simultaneous source batches, three repetitions each at 100, 300, and 1,000 stories per source, with cold, unchanged-warm, and tag-update phases. Each disposable database held 10,000 historical stories. The browser used the application's LOCAL_POUCH_OPTIONS in headless Chromium on a hidden desktop.

| Stories/source | Total | Median cold ms | Median unchanged warm ms | Median warm updates ms | Peak active story operations | Peak saves |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 600 | 1002.0 | 69.8 | 652.8 | 64 | 64 |
| 300 | 1800 | 2580.5 | 171.2 | 2121.7 | 64 | 64 |
| 1000 | 6000 | 6848.3 | 410.3 | 6979.8 | 64 | 64 |

Median per-trial maximum timer lag was 7.6/14.1 ms cold/updated at 600 stories, 32.2/50.5 ms at 1,800, and 145.4/179.8 ms at 6,000. Timer lag is excess delay of a 10 ms interval, not a measured Electron UI frame time. These are implementation verification measurements, not a fresh controlled comparison against unbounded ingestion. See story-ingestion-concurrency.md for the earlier four-strategy comparison.

Every browser sample checks get/put/allDocs counts, final document count, persisted updated tags, the concurrency cap, and complete queue drainage. Raw data is in story-ingestion-production.json.

## Regression checks

The package build and lint checks on all changed application, persistence, test, and benchmark files passed. 85 application/persistence/service tests passed, including shared capacity across six batches, ordered results, same-URL ordering, unrelated write independence, slot recovery after failures, shared-URL metadata merging, retry rollback, a user edit queued behind failed ingestion, content attachments, and synchronized state reconciliation.

The first lint pass exposed quote-style violations in the existing benchmark scripts and a throw in a finally block; both were corrected. The broader persistence tests still emit a dependency punycode deprecation warning, without failures.

## Further optimization candidates

Individual save reads reconcile synchronized state, current revisions, and attachment stubs, so eliminating them requires a separate correctness design. Combining metadata and feed-content updates could reduce multiple saves within a single story operation, but should be measured with realistic content and conflict workloads before changing that behavior.

Warm unchanged refreshes still pay for bulk lookup and deserialization. The limiter does not bound that work or guarantee yielding between CPU-only promise continuations. A separate measured experiment could examine lookup/deserialization chunking if live Electron profiling shows that cost affects interaction latency. Skipping resident-story lookups would need to preserve reconciliation with database changes.

The failed-insertion and failed-tag rollback improvements cover those mutations specifically; they are not a general transaction rollback for comment or content updates.

## Reproduce

```powershell
npm run build:packages
node --test "tests/integration/app/*.test.js" "tests/unit/persistence/*.test.js" tests/unit/app-services.test.js
node scripts/benchmark-story-ingestion-browser.js --production
```

Use the hidden-desktop workflow for unattended browser runs on Windows. User databases are never opened by the benchmark.
