# Sync database epoch

An epoch removes obsolete revision branches by moving the canonical database and
its replicas to fresh databases. It does not replace conflict resolution, integrity
checks, backups, or a retention policy. **Do not run a cutover until the preflight
requirements below are satisfied.** Implementing these safeguards does not repair
existing live data or authorize a production cutover.

## Evidence and production prerequisites

A read-only audit on 2026-10-18 found the same winning revisions and leaf sets on
the phone and Electron: 32,787 documents, 58,915 revision bodies, 26,128 extra
leaves, and no retained non-leaf bodies. Stories accounted for 25,434 extra
leaves. Electron held 1,217 replication checkpoints; the phone held seven.
Another compaction cannot remove these leaves.

Revision identity was not sufficient to establish integrity. An RSS article had
different attachment bytes under the same revision on the two replicas. A
thumbnail did too, and only the phone's thumbnail matched its stored content hash.
Neither replica had missing or orphaned attachment blobs. Seven documents had
unresolved live conflicts: `animation`, `filter_list`, `redirect_list`, `sources`,
`story_sources`, `swipe`, and `theme`. Losing branches include unique values, which
may be pending edits or intentionally removed history; do not blindly union them
or silently discard them.

The initially inspected builds were phone `261013-125437` and Electron
`261014-222321`, both before epoch support, with `revs_limit: 20`. The subsequent
server audit and remediation are recorded below. Before migration:

1. Back up every replica, including revision trees, attachments, live losing
   branches, local routing metadata, and configured destination. Preserve divergent
   attachment variants separately with provenance and hashes.
2. Resolve live conflicts by document type. Vault branches need explicit
   application-level resolution; an arbitrary CouchDB winner is not consent to
   discard encrypted settings. The copy refuses unresolved live conflicts.
3. Repair divergent content through **new revisions**, with consistent metadata
   and attachment bytes. Do not overwrite a revision using `new_edits: false` as a
   repair. Compare both article variants before choosing: larger is not necessarily
   correct. This is a separate, explicitly authorized operation.
4. Re-audit content across replicas. Equal revision IDs do not prove that
   historical divergent bytes converged. A same-revision content mismatch during
   local reconciliation stops migration and retains local data.
5. Deploy protocol **4** clients to every writer, including browser backgrounds.
   Close/restart older windows and processes: old code cannot participate in the
   new local write lock. Verify installed build identifiers, not just repository HEAD.
6. Check free space for staging, retained local backups, attachments, and rebuilt
   indexes. Disk-full errors stop the operation; do not delete backups to force it
   through. Inventory offline clients and verify the server's `_revs_limit`, roles,
   `_security`, backups, and restore procedure.

## Why an epoch

Compaction removes non-leaf bodies. Deleting a losing revision creates a tombstone
leaf that still replicates. Purging one peer is not coordinated deletion across
PouchDB/CouchDB peers; the current `idb` adapter does not expose PouchDB's purge
implementation. A fresh database creates an explicit boundary and retains the
original for recovery and ancestry checks.

Winning deletion revisions remain, so stale live ancestors do not resurrect deleted
documents. Normal user edits can still create legitimate conflicts; the objective
is to remove obsolete branches without throwing away pending work.

## Atomic content and strict verification

`PouchStoryStore` writes article bytes and metadata in **one revision**, using
portable UTF-8/base64 data and a SHA-256 fingerprint. Failed writes cannot leave
new metadata labelling old bytes. Repeated feed saves check actual stored content
before treating it as a no-op; plain edits retain attachment stubs.
Stale read-state/bookmark snapshots also retain the metadata belonging to the
currently stored attachment, rather than relabelling its bytes with old metadata.

`copyWinningRevisions` preserves ancestry with `new_edits: false`. It rejects live
conflicts and branch divergence. Each batch is read back at the exact written
revisions and checked for canonical document/attachment equality. Incomplete reads
are errors. Thumbnail content hashes and known article fingerprints are validated
against bytes. Legacy content without fingerprints still requires cross-replica
comparison before selecting an authoritative version.

`verifyWinningRevisions` checks winner/deletion identity, target leaf count,
canonical content, attachment bytes, unresolved source branches, and unexpected
target documents. **Extra target documents fail verification.** Only explicitly
excluded control documents are ignored. Operator copies exclude the epoch marker
and freeze design document, but retain the protocol marker.

Copies are resumable. A source winner changing branches produces
`EpochCopyDivergedError` and requires an empty staging target. Use a separate scratch
database for dry runs. Content corruption or ambiguous pending changes do not
authorize automatic deletion of data.

## Local migration and returning replicas

The configured URL remains bound to the profile. Its marker names a sibling on
the same server, reached with the current configured credentials:

```json
{ "_id": "once_sync_epoch", "schema": 1, "state": "preparing", "next": "once_e2" }
```

`preparing` pauses connections; `ready` allows rebuilding. Moved clients start from
their remembered destination. New installations discover it through the original
URL. Pouch replication and background HTTP clients enforce the marker; background
reconnects re-arm one-minute retries for as long as preparation lasts.

The rebuild seeds a private target from the **canonical new remote**, then
reconciles local winners:

- Same revision: content must also match, otherwise stop for repair.
- Canonical descendant: keep the newer canonical revision.
- Local descendant: preserve the pending local edit and its ancestry.
- Unrelated branch: discard it only when the frozen old remote proves that the
  exact local revision is an ancestor of a deleted branch. This prevents a stale
  replica from recreating a known losing branch.
- Unprovable ancestry, unrelated pending edits, or live local conflicts: stop
  and retain all local data. Export/reconcile explicitly; do not reset the profile.

The canonical remote can advance during a client's copy. Every exact copied
revision is verified, and subsequent replication brings newer descendants. The
staging target must remain free of extra branches. Reconciliation uses bounded batches.

All ordinary local writes, including replication, deletes and attachments, enter
the same lock as migration through local Pouch `bulkDocs`. Web Locks coordinate
windows/workers. Browser migration refuses to proceed without Web Locks; the
single-context fallback is for Node fixtures. Queued writes to a retired source
fail explicitly instead of being acknowledged and lost. Restart all old contexts
before relying on this barrier.

The localStorage pointer is a synchronous routing cache, not the only durable
record. Before switching it, the source is marked retired. Losing the pointer
reopens that retained source and restores the route. A target with committed epoch
state is **never destroyed as a staging copy**. An inconsistent externally recreated
base stops for recovery.

Committed local epochs carry a migration version. Upgrading an epoch created by
the earlier implementation reconciles it again into a separate versioned local
database; it cannot bypass the hardened checks just because its destination is
already recorded. The older committed database is retained, never overwritten.

Synchronization acknowledgement is recorded only after live replication pauses
without an error. **Old local databases are not automatically deleted**, even then:
they preserve backups and durable routing. Later reclamation needs a separately
reviewed procedure preserving those records and verified backups. Do not clear
localStorage or delete databases as a recovery shortcut.

## Operator procedure

### Bringing an additional client onto the completed epoch

No second server cutover is needed. Install a build containing the current epoch
and attachment-transport fixes, keeping the same application channel, browser
profile and extension/application identifier when preserving local data.

1. Close old Once windows and panels. Fully quit Electron before replacing it;
   force-quit iOS before installing its update. Reload an existing unpacked or
   temporary extension after rebuilding it, so its background code updates too.
2. Keep the existing configured sync URL, including its original `/once` database
   name. Its retained ready marker leads to `/once_e2`. Do not manually repoint an
   old populated profile to `/once_e2`, which can bypass old-profile reconciliation.
3. Open the updated client, allow its local rebuild/reconciliation and automatic
   restart, then wait for **Up to date**. Check settings, bookmarks and a saved
   article. Keep free space for the retained old copy and the new database.
4. For a conflicting ordinary setting, open **Settings → Sync → Review versions**.
   Compare the synced version and this device's current version. Select one and
   confirm **Use selected version and resume sync**. To settle the remaining
   settings conflicts together, use **Use synced for all** or **Use current local
   for all**, then confirm. This applies only to this migration, does not change
   nonconflicting settings, and does not establish a rule for future syncs.
   Older local branches remain in backups rather than appearing as choices.
   Each setting is checked again before writing. If the session changes or a
   version is unavailable, the batch stops; completed choices and backups remain.
   Every original local branch and the reviewed server version are backed up in
   a local-only record before resolution. The resolver checks that the reviewed
   revisions are still current, never writes directly to the server, and resumes
   normal migration afterward. Choosing a local version can update other devices
   once sync resumes. Choosing the synced version reuses its revision when possible.
   Identical values are grouped into one choice. If every live local value agrees
   with the canonical value, migration retains the canonical revision without a
   prompt or a new revision; the original branches remain in the retained old
   database. Settings are checked before copying or scanning the archive, so
   reviewing additional settings does not repeat the full local scan.
   Device publication records use tab sync's existing ordering (epoch, sequence,
   then revision tie-break). A newer local publication is rebased onto the staged
   canonical branch, with all payload fields preserved and read-back verified.
   This does not modify the source or server during migration. Malformed records
   and same-revision content mismatches still stop the move.
5. Divergent story histories use the same merge rules as normal story conflicts:
   preserve read/bookmark/filter edits and new discussions/source associations,
   while keeping canonical parsed metadata. Parsed-only differences reuse the
   canonical revision. Unique local saved content is copied with its metadata.
   If both sides have different saved content, canonical content stays active
   and the alternate is verified into a local-only `_local/once-epoch-story-*`
   recovery record in the new database; originals also remain in the old database.
   These recovery records do not sync and currently require technical tooling to
   extract. A failed backup or integrity check stops the move.
6. Vaults and content-integrity failures are not resolved by this ordinary
   settings chooser. Retain that profile for their dedicated recovery flow. Do
   not edit markers or force a direct sync. Conflicts already on the canonical
   server also require separate resolution; this chooser resolves the returning
   client's settings.

For an expendable test installation whose unsynced data is not needed, starting
with a genuinely fresh profile is also valid. Install the updated client and pair
it or configure the original URL; it discovers the canonical epoch automatically.
Server-synced settings return. Device-only preferences, local caches, secrets not
present in the synced vault, and unsynced edits may not. An in-place update is the
first choice when retaining those matters.

The native SQLite durability change is **Android-only**. Updated iOS, browser
extensions and Electron clients can use the new sync epoch, but still use their
existing IndexedDB storage. Updating iOS does not confer the Android eviction
protection. A Git push alone does not update installed clients or publish a release.

### Server operations

`scripts/couch-epoch.js` reads `ONCE_COUCHDB_URL` and `ONCE_COUCHDB_TARGET_URL`;
never put credentials in command arguments or reports. Build packages first.
`analyze` and `verify` are read-only. No command creates or deletes a database.
`copy` writes only the named target. `freeze`, `open`, and `abort` alter source
control documents and require authorization. This runbook is not authorization.

1. **Prepare.** Complete the prerequisites. An administrator creates a fresh sibling
   target and applies the intended `_security` and an explicit `_revs_limit` of
   **1000**. Verify both through the server API; changing PouchDB options does not
   change an existing CouchDB database's retention. It must have no epoch/freeze control
   documents. Optional dry-run copies use a separate scratch target.
2. **Freeze.** With server-admin operator credentials, run `freeze`. It raises
   `once_sync_compat` to protocol 4, publishes `preparing`, then installs
   `_design/once-epoch-freeze`. The validation function rejects ordinary writes
   **including administrator writes**. Only admins may update/remove the three
   control documents. Never use server-admin credentials in clients. A partial
   failure leaves clients paused: complete freeze or explicitly abort.
3. **Check the barrier.** Verify its exact design document. In a disposable server
   fixture, confirm rejection of ordinary writes, deletes, and replication writes.
   The script requires the exact fence when copying a preparing database or opening
   it. Do not rely on every client observing the marker within a minute.
4. **Copy.** Run `copy`, then rerun until nothing remains. Keep the source fenced.
   Neither the fence nor the epoch marker may reach the target.
5. **Verify and open.** Once opening is authorized, run `open`: it requires the
   fence, rejects target control documents, performs strict verification, and
   checks that the source update sequence did not change during verification
   before writing `ready`. Investigate every mismatch, live conflict, unexpected
   document or divergence. It leaves the source barrier in place. Use standalone
   `verify` for a read-only rehearsal or review; running it immediately before
   `open` on the same frozen data needlessly repeats the complete comparison.
6. **Observe.** Confirm each device's installed build/protocol, local pointer,
   retained backup, content integrity, pending-edit upload and post-sync leaf count.
   Include an offline/stale device and a fresh installation. Stop and inspect
   unprovable local ancestry; never discard the device's database to make it pass.
7. **Retain discovery.** Keep the original URL permanently available with its
   protocol marker, ready route, security and barrier. Do not delete it merely
   because all current devices moved: future/reset installations have no remembered
   destination. Initially retain the entire frozen source. A separately reviewed
   admin procedure may later archive its data and replace it with a verified
   metadata-only discovery database at the same URL, with backup/restore checks.
   Reclaiming old bodies also removes online ancestry proof: remaining stale
   clients may require explicit reconciliation against the verified archive.

Before `open`, `abort` removes the barrier and announcement; the raised protocol
requirement stays. Incomplete freezes can also be aborted. After `open`, abort is
refused because clients may have written to the new epoch. Fix forward or use an
explicit disaster-recovery procedure; never silently route clients back.

## Preventing recurrence and acceptance tests

### Low-churn story ingestion

Existing stored stories own their parsed metadata. Normal refreshes keep their
title, publication time, primary source and existing parser fields. User-state
writes also preserve that metadata, even when their in-memory snapshot is stale.
New discussion links and source associations are merged by discussion identity
and tag class plus link (or text when there is no link). Reordering, subsets,
renamed source labels and changed discussion timestamps do not cause refresh writes.
Conflict maintenance retains the winning parsed metadata and unions associations
from other branches before retiring them. Unique saved attachment content is not
automatically deleted to settle a metadata conflict.

New publication times are normalized to numeric UTC timestamps. Missing source
dates use zero, including collector fallbacks that previously used `Date.now()` or
relative-age estimates. Rendering/sorting can use a session-local observation time;
that fallback is not serialized or represented as a known publication date.
Existing records are not bulk-rewritten to normalize their legacy representation.

Repeated user actions with the same value do not stamp clocks or save. Genuine
transitions retain clocks, including a toggle away and back; failed optimistic
actions roll back so they can be retried. Automatic re-filtering persists actual
filter-value changes without creating a device-clock update.
An explicit zero filter clock marks derived state, preventing an older window's
historical wall-clock value from overwriting a re-evaluated filter. Identical article
bytes and meaningful metadata retain the previous `saved_at`; changed bytes,
including same-length edits, remain real updates. Concurrent independent discovery
can still create branches, which maintenance reconciles rather than promising
conflict-free offline creation.

Deployment verification also found feed copies differing only in hidden WordPress
`_wpnonce` inputs. Feed ingestion removes that request-only field before hashing;
page captures and other form fields remain unchanged. Maintenance may settle old
feed branches when their bytes match after this same narrow normalization. Other
attachment differences still require explicit resolution.

Deterministic creation removes a common source of duplicate roots: no ingestion
clock, canonical keys, exact HN time where available, stable feed metadata and atomic
fingerprinted content. Different titles, sources, tags, missing-time fallbacks and
user edits remain real differences needing document-specific policies.

Variable tab/loaded-story/newest-story ID lists no longer create checkpoints.
Unchanged sampled state retains capture metadata, preventing sampling alone from
changing the publication fingerprint. Local revision retention returns to PouchDB's
default **1000**, rather than 20 or 100. This is a finite buffer, not a guarantee:
the audit observed 67 Chrome revisions in about 8.8 minutes. Measure write rates and
server retention against the required catch-up window. A separate store/transport
for ephemeral device snapshots remains a longer-term option.

Regressions cover byte mismatches under equal revisions, invalid thumbnail hashes,
extra documents, incomplete reads, live settings conflicts, stale losing branches,
pending descendants, ambiguous edits, concurrent writers, lost pointers, committed
target protection, retained backups, atomic write retries, more than 100 unpublished
updates, fresh-client discovery, repeated background retries and unchanged sampling.
Fence validation uses synthetic users/documents. No test accesses live databases.

Before deployment, also exercise installed builds with disposable profiles and a
disposable CouchDB server: actual server validation/replication, multiple windows,
crash points, offline reconnect, permissions and disk-space failure. Record leaf
counts, payload/attachment hashes and acknowledged pending edits. Passing Node
fixtures is not a completed deployment or production cutover.

## Server backup and preparation evidence — 2026-10-18

An online physical backup was captured from `goo` (`couchdb-free-1`) between
17:05:04 and 17:05:07 UTC. CouchDB package version is `3.5.2.1~bookworm`
(HTTP version `3.5.2`), with two shards and one replica. The backup copies
secondary indexes before database files, and includes system databases and the
complete CouchDB configuration. This follows the append-only file backup procedure
in [CouchDB's backup documentation](https://docs.couchdb.org/en/stable/maintenance/backups.html).
It is a per-file consistent online backup, not a globally atomic snapshot across
shards. Capture a final backup after freezing at the eventual cutover.

The private, ignored local backup directory is
`artifacts/backups/goo/20261018T170504Z/`; the remote archive is
`/home/mjb/once-backups/20261018T170504Z.tar.gz`. The local archive is named
`backup.tar.gz` (42,288,563 bytes), with SHA-256
`685eebc94a5144cd99e721930df25d21d6467e5fc2080c816e4ebe83b00f5926`.
The directory has restricted Windows ACLs; remote backup files are mode 0600.
Treat the archive as secret-bearing because it includes server configuration.

A separate network namespace restored the archive using the installed CouchDB
binary. It could not reach production or external replication endpoints. All 26
manifest file hashes matched. Restored `once` had 32,583 live documents, 217
deleted documents, 58,928 leaf revisions, seven conflicted documents, and 62
readable winning attachments. This checks physical restoration and winning
attachment reads; it is not a complete semantic audit of every losing body.

At backup time the server had `_revs_limit: 20` and `minSyncProtocol: 2`, without an epoch
marker or freeze design document. The seven conflicted IDs remain `animation`,
`filter_list`, `redirect_list`, `sources`, `story_sources`, `swipe`, and `theme`.
The previously identified article's server attachment matches Electron's variant
(29,557 bytes); the thumbnail matches the phone's variant (9,992 bytes). Preserve
the other device variants before selecting canonical content and writing repairs.
The server backup alone cannot preserve bytes that exist only on a device.

The isolated rehearsal also exercised the actual fence on a disposable database:
administrator create/delete returned 403, a replication-style `new_edits:false`
write returned `forbidden`, and an admin control-document write succeeded. An
earlier cold JavaScript query-server start timed out with HTTP 500; the repeated
rehearsal passed. Validate server readiness and inspect errors at the real freeze;
do not treat an arbitrary HTTP failure as proof of the intended barrier.

After the user explicitly authorized recovery of the forgotten admin password,
the `admin` password was reset and CouchDB restarted. Its graceful stop took about
39 seconds. The initial startup authentication check failed; the later check
verified `_admin` access. The effective password hash and removal of the temporary
plaintext configuration value were verified. The client account was not reset.
Restricted local `admin-credentials.json` holds the new credentials, and
`configuration-after-reset.tar.gz` preserves the updated configuration. The main
physical backup predates this reset: restoring its configuration alone restores
the old admin credential. Preserve the updated configuration alongside it.

Production `once_e2` was then created and verified at 17:16:26 UTC: zero live or
deleted documents, source-matching security, two shards, one replica, and retention
1000. The source remains at protocol 2 and retention 20, with neither a move marker
nor a freeze design document. `preparation-report.json` records these API checks.
The private `prepare-target.py` beside the local backup checks admin access, refuses
an existing target or active source epoch, creates the empty sibling, copies source
security, and explicitly sets/verifies retention 1000. It does not change source
documents, freeze the source, or route clients. Retain an incomplete target for
inspection if preparation fails; do not automatically delete or overwrite it.

At the end of initial preparation, cutover remained blocked on reviewed conflict/content repair, preservation of all
device-only variants and pending edits, deployment/verification of protocol 4 on
every participating client, and the remaining installed-client migration tests.
No source documents, source retention settings or epoch controls were modified by
these operations. The production changes were the explicitly authorized admin
credential recovery/restart and creation/configuration of the empty target.

## Remediation and retained clients — 2026-10-18

The user authorized fixing the blockers and explicitly selected the settings
currently shown on both devices. Raw IndexedDB snapshots (all object stores and
attachment blobs) and localStorage were saved for Android and Electron in the
restricted backup directory before repair. Do not publish these secret-bearing
snapshots. The other Chrome, Firefox, iOS and Electron records were identified by
the user as mostly disposable test installations; preserving all their data is
not a cutover prerequisite. Their profiles have not been reset or deleted. Update
them before reuse; an ambiguous returning replica must still stop rather than
silently discard local work.

`scripts/couch-repair.js` performs guarded, ordinary revision writes. It requires
the reviewed winner and exact live branch set, durably archives every branch
through its caller before writing, rechecks after archival, and refuses concurrent
changes. It creates a new winning revision before tombstoning reviewed losers.
It does not purge, force revision identities, or run a cutover. Tests cover failed
archival, stale plans, concurrent edits, attachment mismatch and atomic fingerprint
updates. Operator plans and per-step journals remain in the private backup folder.

The seven settings conflicts were settled without changing the selected values:
17 older live branches were archived and tombstoned. The article received an atomic
fingerprint revision and the thumbnail received a new revision containing the
phone/server bytes that match its SHA-1 metadata. A subsequent story conflict had
identical values and differed only in a field timestamp; both branches were
archived and the newer timestamp retained. Source `_revs_limit` is now 1000.

Checks while the old clients were still running briefly found stale article bytes
and the extra story conflict. After both client updates, all 66 common winning
attachments matched, both databases had zero live conflicts, and no tested
attachment failed its fingerprint/contentHash check. The original 29,710-byte
phone article variant from the first audit was no longer present in the captured
snapshots; its bytes cannot be claimed as preserved. The selected current article
is 29,557 bytes and is preserved with provenance in the snapshots and journals.

Decoded bytes are authoritative for cross-adapter verification: CouchDB may report
a digest of compressed attachment storage while local PouchDB hashes decoded
bytes. `epochContent` compares content type and decoded SHA-256, not equality of
transport digests. A regression accepts different transport digests for identical
bytes and still rejects differing bytes.

The final loaded release builds are Electron `261018-173614` and Android
`261018-173623`; the Android loaded bundle explicitly reports sync protocol 4.
Chrome and Firefox release bundles were rebuilt but were not installed into the
disposable test profiles. Both retained clients passed a fresh read-only integrity
audit after deployment. The packaged Electron epoch regression preserves a
device-local preference, retains the old IndexedDB database, and restores routing
after deliberate pointer loss in a disposable profile. The test uses a disposable
HTTP PouchDB fixture; actual CouchDB fence validation was tested separately above.

A post-repair physical backup is preserved as `post-repair-backup.tar.gz` in the
same local backup folder and `/home/mjb/once-backups/20261018T173658Z.tar.gz` on goo.
It was captured between 17:36:58 and 17:37:09 UTC, is 26,750,651 bytes, and has
SHA-256 `07135db06ac3147ad478d2f7a28ab2b20f342e9d007244503b40e6f7cb586f0c`.
The downloaded checksum matches. The original pre-repair archive is retained.

The repaired production dataset also passed a disposable local epoch rehearsal.
Replication captured 58,940 revision bodies with zero write failures. The snapshot
contained 32,805 documents including 217 deleted documents and 26,135 extra leaves,
with zero live conflicts. Winner-only copy retained all 32,805 documents and 217
deletions while reducing extra leaves to zero. Strict verification reported no
revision/content mismatches, unexpected documents or unresolved branches. Detailed
counts are in `epoch-dryrun-report.json`; both disposable databases are retained.
This closes the data-copy rehearsal blocker without writing to production `once_e2`.

Validation: 1,263 unit tests passed, two skipped; the final packaged Electron epoch
test passed without retry. Type checks, focused lint, structural and line-ending
checks passed. Initial test harness failures (network disabled in the new Electron
fixture, catalog cleanup on Windows, and PowerShell treating installer stderr as
fatal) were corrected; they were not silently counted as passing validation.

At the end of that remediation stage, the source remained writable, without a
preparing/ready marker or freeze design document, and the target remained empty.
At an authorized cutover, stop
interacting with the retained clients, freeze the source, capture a final backup,
and repeat strict source/target verification. A clean audit while writes continue
does not replace that final barrier and verification.

## Cutover and subsequent findings — 2026-10-18

After all ten CI jobs passed for `cb1e27af`, the authorized cutover completed.
`once` remains the frozen discovery endpoint with protocol 4 and a ready route to
`once_e2`. Strict verification passed before opening. Both retained clients moved,
preserved their selected settings, and recorded successful synchronization.
The final audit had 32,600 live server documents (one server-only compatibility
marker), 217 winning deletions, 60 matching attachments, and zero extra leaves or
live conflicts. Both server databases retain revision limits of 1000 and matching
security. The source was not deleted or unfrozen.

The final frozen physical backup is
`/home/mjb/once-backups/20261018T183341Z.tar.gz` on goo and
`cutover-cb1e27af/frozen-backup.tar.gz` beneath the private backup directory.
It is 28,424,362 bytes with matching downloaded SHA-256
`ac5e07263ac4ad278ac7d331a84938de9bdbb7cd6bd0d51bda3782d815ff473f`.

Subsequent profiling found avoidable HTTP pagination, duplicate census scans,
empty compaction writes and cold bookmark-index work. See
[database-performance.md](database-performance.md) for measured results,
implemented improvements, reproducible benchmarks and limitations.

The phone's IndexedDB databases subsequently disappeared after successful sync.
At 21:29 Europe/Berlin its log recorded a closing database connection. The user
confirmed no cleanup was requested. Storage usage later read zero, while its
localStorage pointer/preferences remained. Storage-pressure eviction is consistent
with the nearly full filesystem and non-persistent WebView storage, but was not
explicitly logged. The server and off-device backups remain available; the user
requested leaving the phone untouched until durable storage is fixed.

**Additional prerequisite for future mobile migrations:** browser quota estimates
and two local IndexedDB copies do not provide durable protection from eviction.
Check physical free space and retain an off-device export. Android WebView does
not grant persistent-storage permission. Android now uses the native SQLite backing
store described in [mobile-native-storage.md](mobile-native-storage.md), qualified
against process stop and complete WebView storage loss on the phone. A missing active epoch record
now fails explicitly rather than attempting a migration into the same database
and retiring itself. This guard does not recover evicted data.

The subsequently authorized Android recovery completed on native SQLite in build
`261018-210258`. Its 32,608 client documents, 217 deletions and 57 attachments
matched the canonical server in a stable audit, with no unresolved conflicts or
missing bodies. The server-only compatibility marker accounts for its additional
live document. Current settings were retained and the app reported Up to date.
The native recovery report records the durability tests and the attachment
transport fixes discovered during recovery; the frozen original database remains
unchanged.
