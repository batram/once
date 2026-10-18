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
