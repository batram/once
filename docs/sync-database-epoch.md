# Sync database epoch

A sync database collects losing conflict branches that can never be removed in place. A
database epoch moves every replica to a fresh database that holds only the winning
revisions. This document records why, how a move works, and how to run one.

## Why tombstones cannot be cleaned in place

When conflict maintenance resolves a story, it deletes the losing revisions
(`PouchMaintenanceService.resolveStoryConflicts`). A deleted revision is still a leaf of the
revision tree. It replicates everywhere, and compaction keeps it, because compaction only
drops the bodies of non-leaf revisions.

Measured on a phone on 2026-10-18:

- `by-sequence`: 58,898 rows for 32,770 documents.
- 26,326 of those rows were deleted losing leaves. 21,269 of them sat at position 2: one
  feed item created independently on two devices, then the loser deleted.
- The one-time `compact()` took over 7 minutes and removed almost nothing.
- `dev_` device documents had up to 160 separate roots: `revs_limit: 20` plus frequent
  writes left replicas with no common ancestor.

None of this can be removed locally. Pull replication reads the changes feed with
`style=all_docs`, which lists every leaf. `revs_diff` reports the dropped leaves as missing,
and they come straight back from the server. The same happens on push from any device that
still holds them. `_purge` does not replicate either, and the IndexedDB `idb` adapter has no
purge at all. A cleanup therefore has to move the server and every device together.

New conflicts of the position-2 kind are now avoided at the source. Story documents are
written deterministically (no `ingested_at`, exact HN times, a deterministic feed-content
`saved_at`, sorted keys, and a content fingerprint). Devices that ingest the same item
therefore mint the same revision id, and replication sees one revision.

## The data step

`packages/persistence/src/PouchEpochCopy.ts`:

- `copyWinningRevisions(source, target, sourceId)` copies every winner with its
  `_revisions` ancestry and inline attachments, using `bulkDocs` with `new_edits: false`.
  Deleted documents move as tombstones, so a replica's stale live copy stays deleted. The
  copy is resumable through `_local/once-epoch-copy` in the target.
- `censusRevisions(db)` (read-only) reports, per document, its winner and how many leaves
  it carries.
- `verifyWinningRevisions(source, target)` (read-only) checks that the target holds every
  source winner as its only leaf.

Each revision keeps its id and history. A replica whose winner descends from a copied one,
such as a device with offline edits, therefore fast-forwards onto the copy instead of
conflicting. `tests/unit/persistence/epoch-copy.test.js` covers this, along with deleted
documents and resumed copies. The server and every device move with this same function.

## How the move works

The configured sync URL never changes. It names the database a profile is bound to
(`SyncDestinationBinding`), and on webext the browser syncs it to other installations, so
repointing it would make every other install refuse it as a different database. Instead,
the old database carries a marker that clients follow:

```json
{ "_id": "once_sync_epoch", "schema": 1, "state": "preparing", "next": "once_e2" }
```

`state` is `preparing` or `ready`. `next` is a database name, never a URL. It is validated
against CouchDB's naming rule without `/`, so a marker can only lead to a sibling database
on the same server, reached with the same credentials (`epochSiblingUrl` in `@once/core`).
Chains (`once` → `once_e2` → `once_e3`) are followed for up to five hops. A marker that
points at itself, or a loop, is reported as damaged metadata.

**Sync protocol 3.** A client that cannot follow an epoch would push its losing branches
into the new database. `freeze` therefore raises `once_sync_compat` to protocol 3, and
older versions stop at "update required".

**In the client** (`resolveSyncEpoch` in `SyncEpoch.ts`, run in `PouchSyncService.preflight`
after the compatibility check and before any replication):

- `preparing`: sync pauses ("Sync paused while the sync database is cleaned up") and
  retries with the usual backoff, at most every minute. Live sync watches the marker
  beside `once_sync_compat`, so a running session stops as soon as the move starts.
- `ready`: `LocalDatabaseEpoch.rebuild` copies the local database's winners into
  `<base>@once_e2`, repeating copy and verify until the copy matches. It then writes the
  markers that stop the conflict scan and compaction from running again, and switches the
  local database pointer. After that the app restarts on the new database.
- The pointer (`localStorage` key `once:local-database:<base>`) is read synchronously by
  `openLocalDatabase` on every platform. It is the commit point:
  - A crash before the pointer is written leaves the old database in use, and the copy
    resumes from its checkpoint.
  - A crash after it opens the new one.
  - The old database is marked `_local/once-sync-epoch: { retired }` first. If the pointer
    is ever lost, the old database opens, refuses to sync, restores the pointer, and
    restarts.
- Each rebuilt database records the destination it was built for, and syncs only with
  that destination. If the old database's marker disappears afterwards, sync stops with
  "metadata needs attention" rather than falling back. If the old database itself is
  deleted, the remembered destination is used.
- After the first successful sync on the new epoch, the replaced local database is
  destroyed.
- Other windows of the same app restart when the pointer changes (`storage` event), and
  the rebuild holds a Web Lock, so only one window moves the data.
- The webext background, which publishes tab documents over plain HTTP, follows the same
  markers and re-resolves them on every heartbeat.
- The marker never replicates (`isSyncMetadataId`), and `copy` excludes it, so a new
  epoch cannot point at itself.

`tests/unit/persistence/sync-epoch.test.js` covers these cases against real PouchDB
databases:

- A full move, where an offline edit arrives on the new database with no conflicts and no
  losing leaves.
- A move being prepared, which pauses sync and keeps local edits.
- A lost pointer.
- A marker removed after the move.
- A client without an epoch mover.
- Marker validation.

## Running a move

`scripts/couch-epoch.js` runs every step. It never creates or deletes a database, and on the
source it writes only `once_sync_compat` and `once_sync_epoch`. Credentials come from
`ONCE_COUCHDB_URL` (the old database) and `ONCE_COUCHDB_TARGET_URL` (the new one), and are
redacted from all output.

The sync account on goo-couch (`moep`) is not a server admin; only `admin` is. Creating the
new database is therefore a manual administrator step.

1. **Before you start.** Update every device to a version with sync protocol 3. Older ones
   will show "update required" from step 3 on and stay paused until they update.
2. **Prepare (admin).** Create `once_e2` and copy `once/_security` to it. Optionally run
   `analyze` for the numbers, and a dry-run `copy` to see how long it takes.
3. **Freeze.** Run `freeze`. This raises the protocol and writes `preparing`, and clients
   pause within a minute. To undo it, run `abort`, which works only until step 5.
4. **Copy.** Run `copy` until a run copies 0 documents, then run `verify`.
5. **Open.** Run `open`. It re-verifies, then writes `ready`. From here on, each client
   moves the next time it connects.
6. **Retire (admin, by hand).** Once every device has synced with `once_e2`, `once` can be
   deleted. Devices that have already moved remember where to go. Keep the old database
   for a while anyway, as the rollback and for devices that were offline.

There is no rollback after `open`, because devices that already moved have written to
`once_e2`. Fix forward instead: a further epoch (`once_e2` → `once_e3`) is the same
procedure.

One known gap remains. A local edit made in another window in the last milliseconds before
the pointer switch stays behind in the old local database, and is lost when that database is
removed after the first successful sync. The other windows restart as soon as the pointer
changes, so the gap is that short.
