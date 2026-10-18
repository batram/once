# Database performance investigation — 2026-10-18

## Result

The archive is not intrinsically too large: the server holds roughly 32,600 live
documents and 19 MB of logical content. The main measured costs were serialized
network round trips, repeated scans, unnecessary IndexedDB write transactions,
and a costly cold bookmark index. Password hashing and the local write lock did
not explain the observed delays. No production database was compacted, rewritten,
or migrated during this investigation.

There is also a separate Android storage reliability incident, described below.
Performance improvements do not make WebView IndexedDB durable.

## Controlled measurements

### HTTP copy and verification

The reproducible fixture contains 5,000 synthetic stories, uses real PouchDB 9
HTTP adapters and a local Couch-compatible server, and adds 25 ms of delay to
each HTTP request. Both versions perform strict content/revision verification.

| Operation | Before | After | Request count before → after |
| --- | ---: | ---: | ---: |
| Winning-revision copy | 25.108 s | 3.412 s | 802 → 72 |
| Strict verification | 16.447 s | 1.328 s | 1,004 → 42 |

This is a 7.4× copy improvement and a 12.4× verification improvement in this
fixture. These are measured test results, not claimed production cutover timings.
Real network round-trip latency was considerably higher than the fixture's 25 ms.

The old implementation specified `limit` but omitted PouchDB's `batch_size`.
PouchDB's HTTP changes adapter consequently split logical pages into serial
25-document requests. Copy batches defaulted to 50; verification also fetched
only 50 revisions at a time. Each census scanned the entire database twice.

The implementation now:

- Specifies both the logical and HTTP batch size, with a bounded default of 500.
- Reads the winner and all leaves in one census pass. It uses `doc._rev`, never
  assumes the first leaf is the winner, and rejects missing census data.
- Verifies 500 exact revisions per batch, still reading both databases and
  comparing canonical document contents and decoded attachment hashes.
- Reuses the canonical source content already validated during copy rather than
  hashing it a second time for read-back verification.
- Reconciles local epochs in bounded 500-document pages and reports copy,
  reconciliation and verification progress separately.

The operator's `open` command still performs its own strict verification and
source-sequence stability check. The final opening check has not been removed.
The runbook now recommends `copy` followed by `open` when opening is authorized;
standalone `verify` is for read-only rehearsal/review, avoiding two identical full
comparisons immediately before a cutover.

### IndexedDB compaction

These measurements use a private isolated copy of the actual pre-cutover Electron
IndexedDB snapshot: 32,809 documents, 58,995 retained revision bodies and obsolete
losing leaves. The stock compaction checkpoint was reset **only in the fixture**
so both implementations scan the same full dataset. Chromium ran headlessly on
a hidden Windows desktop; these are not phone timings.

| Metric | PouchDB stock compaction | Implemented compaction |
| --- | ---: | ---: |
| Wall time | 53.160 s | 4.616 s |
| IndexedDB transactions | 65,623 | 32,943 |
| Write transactions | 32,810 | 66 |
| Peak outstanding transactions | 63,636 | 17 |
| Document compactions with no removable bodies | 32,809 | 0 |
| Documents with actual reclaimable bodies | 0 | 0 |

An earlier full stock run took 64.995 s. Results vary with host load, but the
unnecessary work is deterministic: PouchDB 9's stock implementation queues a
compaction for every changed document. Its IndexedDB adapter opens a read/write
transaction and rewrites metadata even when the revision list to remove is empty.

Compaction cannot remove deleted losing leaves. In this dataset there were no
non-leaf bodies left to reclaim, so all those writes accomplished nothing.

`LocalCompaction` now pages through changes, checks revision-tree metadata with
at most eight workers, and calls public `compactDocument` only for documents with
available non-leaf bodies. It checkpoints completed batches for interruption
recovery, drains in-flight work on errors/cancellation, and never purges leaves.
The 66 remaining writes in the measurement are bounded progress checkpoints.

The eligibility check uses PouchDB's local `_getRevisionTree` adapter API. This is
an intentional, isolated dependency on PouchDB 9 and must be revalidated when
upgrading PouchDB. Adapters without it retain their public compaction fallback.
Regression tests check actual ancestor removal, preserved winning attachments,
preserved losing leaves, cancellation, and checkpoint reuse.

### Cold bookmark loading

The same real snapshot has 16 starred stories. PouchDB 9's local Mango index
creation does not put the requested partial selector into its mapper definition;
it builds the broad boolean index. The map/reduce engine also maintains per-document
index metadata. Increasing its batch size alone did not give a convincing gain.

| Operation | Existing Mango index | Incremental starred-ID projection |
| --- | ---: | ---: |
| Cold build/read | 9.861 s | 2.250 s |
| Warm read | 6.8 ms | 1.4 ms |
| Returned starred stories | 16 | 16 |

`StarredStoryIndex` scans the changes feed once, then retains only the starred IDs
and a local sequence checkpoint. Subsequent reads process changes since that
checkpoint and bulk-read the selected stories. It writes no new checkpoint when
unchanged. Per-instance reads are serialized, and separate contexts reconcile
checkpoint races with compare-and-swap retries. Deletions and unstars remove IDs.
Old Mango indexes are not automatically deleted.

This path also avoids Mango's implicit 25-result limit: a regression verifies 60
bookmarks are returned. Tests cover failed scans, concurrent readers, and a read
requested after an edit while an earlier snapshot remains in flight.

### Normal replication

The JavaScript replication filter only excluded three metadata IDs, but forced
`include_docs=true` on every remote changes page. That transferred document bodies
even when `_revs_diff` would subsequently determine every revision was already
present locally.

Replication now uses CouchDB's `_selector` filter on `_id` for full pulls and live
sync. Explicit ID lists are filtered separately because `_doc_ids` takes precedence
over `_selector`. Compatibility monitoring still intentionally reads its small
metadata document set. Tests exercise the real sync options over HTTP, exclude
all three control documents in both directions, and preserve deletion revisions.

In the synthetic unchanged-pull fixture, response bytes fell from 199,834 to
128,573, with no full-document changes feeds. The wall-time change at 25 ms latency
was small (517 ms to 502 ms); payload savings depend on document size and compression.
This is primarily avoided transfer/parsing work, not a claimed universal speedup.
On the actual public CouchDB endpoint, a 500-row sample fell from approximately
462 KB with 500 bodies to 137 KB with zero bodies (70% less decoded payload).
Warm request times were 337–354 ms versus 232–268 ms for those samples.

Changing the filter changes PouchDB's replication checkpoint identity. Existing
installations will perform one metadata scan on first use of the new selector.
The initial scan after epoch creation also remains: no synthetic replication
checkpoint is installed to bypass verification of remote revisions or local edits.

The test server needed a compatibility helper because express-pouchdb 4 omits
the POST `_changes` selector body. Production CouchDB supports this API; the helper
passes the selector to the real local PouchDB changes implementation. Other routes
and their body limits are unchanged.

## Server, network and local-storage findings

Read-only measurements against `goo` separated server work from transport:

| Request | Server loopback, warm median | SSH/IAP path | Public HTTPS path |
| --- | ---: | ---: | ---: |
| Database metadata | 2.3–2.5 ms | 139–172 ms, after first request | 149–190 ms |
| 25 changes with bodies | 11.2 ms | 154–156 ms | 178–223 ms |
| 500 changes with bodies | 132.9 ms | 270–402 ms | 298–385 ms |
| 500 exact revision bodies | 81.2 ms | 290–319 ms | 356–400 ms |

The 500-document payloads were about 462–478 KB. Server authentication was included
in these requests. Basic authentication was already fast; no password-hashing or
security settings were weakened. Local `get`/`allDocs` work is not inherently a
multi-minute operation at this dataset size.

A read-only sample in the actual Electron renderer took 10–11 ms to read/parse
500 document metadata records in one IndexedDB transaction, 25–27 ms with eight
bounded readers, and 53–56 ms with serial per-document transactions. The retired
and current epochs were similar for these reads.

The isolated write-lock experiment wrote 500 documents with 64 callers. Exclusive
locking took 738/694 ms; shared locking took 723/649 ms. That is not a compelling
improvement, so the existing exclusive migration/write barrier remains unchanged.

## Android reliability incident

The phone completed the cutover, reached up-to-date sync, and recorded its sync
acknowledgement. Later, at **21:29 Europe/Berlin**, its log recorded an IndexedDB
connection-closing failure. During this investigation both the active and retired
databases were absent, `navigator.storage.estimate()` reported zero usage, and
localStorage still held the epoch pointer and UI preferences. The user confirmed
that no storage cleanup or database deletion was requested.

Before disappearance, the phone reported about 2.0 GB free and 99% filesystem
usage; afterward it reported about 2.3 GB free. Storage was not persistent. These
observations are consistent with storage-pressure eviction, but no explicit
eviction event was found in the retained logcat, so that cause is not claimed as
conclusively proven. Only read-only phone diagnostics were performed. Guarded
existence probes aborted database creation when a database was missing; they can
create an empty origin-level container, but did not restore any database.

The installed Android System WebView is 155.0.8059.43. Chromium's WebView permission
implementation denies persistent-storage requests:
[AwPermissionManager](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/android_webview/browser/aw_permission_manager.cc).
Calling `navigator.storage.persist()` alone is therefore not a durable mobile fix.
[Chromium's persistence explanation](https://web.dev/articles/persistent-storage)
describes the distinction between best-effort and eviction-protected storage.

The server, Electron replica, off-device snapshots and physical backups remain
available. Remaining phone settings, error logs and quota metadata were preserved
privately. The user explicitly requested leaving the phone untouched until durable
storage is fixed; no restore, reset, restart or deployment was performed on it.

A regression now prevents a recreated, empty active epoch from migrating into
itself, marking itself retired and entering a restart loop when its epoch record
has disappeared. This is a safety guard, not restoration or eviction protection.

### Durable-storage implementation

The subsequent Android implementation and on-phone qualification are documented
in [mobile-native-storage.md](mobile-native-storage.md). Android now keeps the
primary database and epoch pointer outside WebView storage. The criteria below
remain the requirements for future adapter changes and other mobile platforms.

The Android primary database now uses app-owned native SQLite outside WebView
quota management, retaining PouchDB's revision, conflict, deletion, attachment and
replication engine. On-phone qualification and the completed recovery are recorded
in the linked implementation report. Other platforms and future adapter changes
still require their own durability qualification.

Before deploying that migration:

1. Prove that acknowledged offline writes survive process death, restart, low
   storage, WebView data eviction and interrupted transactions.
2. Verify revisions and decoded attachment bytes across native storage, IndexedDB
   exports and CouchDB, including conflicts and pending edits.
3. Use native filesystem capacity checks. Browser quota estimates are not physical
   free-space guarantees, and a retained IndexedDB copy shares the same eviction risk.
4. Rehearse restoration from the retained server/exports into a separate native
   database, preserving current device preferences and never uploading defaults
   over existing server settings.
5. Obtain the user's go-ahead before restoring the live phone. Data that existed
   only in the evicted stores cannot be assumed recoverable.

## Reproduction and evidence

Run the portable synthetic HTTP benchmark after building packages:

```text
npm run build:packages
node scripts/benchmark-database.js current 5000 25
```

Run the isolated IndexedDB benchmark with synthetic data:

```text
node scripts/run-hidden.js scripts/benchmark-local-database.js
```

An optional first argument accepts a raw IndexedDB export with store definitions,
keys, values and encoded blobs; the second argument chooses the report path. The
fixture is served only on loopback, all other browser network access is blocked,
and each strategy uses a fresh browser context. Source exports are never modified.

Private evidence is under `artifacts/performance/db-20261018/`, including
`server-loopback.json`, `network.json`, `production-local.json`, and
`electron-live-reads.json`. The synthetic HTTP reports are in the adjacent
`database-before-*` and `database-after-*` directories. Phone incident evidence is
in the restricted backup directory, not in committed reports.

Final validation passed: 1,286 unit tests passed and two were skipped; all seven
focused Electron end-to-end tests passed without retries. Type, structure,
boundary, line-ending, dead-code, scoped lint and diff-whitespace checks passed.
The dev Electron package built successfully; the live apps were not deployed.

Two existing tests intermittently encountered Windows `EPERM` while renaming
temporary files: the mobile Violentmonkey installer fixture and Electron origin
record. Both isolated tests and the unchanged full-suite rerun passed. The process
or filesystem condition responsible remains unidentified. No host configuration
or package installation was changed to mask it.
