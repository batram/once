#!/usr/bin/env node

// Operator tooling for a sync database epoch: analyse a database's revision
// bloat, announce a move, copy the winning revisions into a fresh database,
// verify the copy, and open it to clients. No database is deleted: the copy goes
// into a target that must already exist (an administrator creates it, with
// the source's _security). The original URL remains a frozen discovery
// endpoint. freeze/abort also install/remove a server write barrier.
// See docs/sync-database-epoch.md.

const PouchDB = require("pouchdb")
const { FENCE_ID, installFence, assertFence, removeFence } = require("./couch-epoch-fence")
const { epochSiblingUrl, readSyncEpoch, SYNC_COMPAT_ID, SYNC_EPOCH_ID, syncDatabaseName, syncDestination } = require("../packages/core/dist")
const {
  censusRevisions,
  copyWinningRevisions,
  verifyWinningRevisions
} = require("../packages/persistence/dist")

/** The first protocol with hardened epoch reconciliation; freeze raises the source to it. */
const EPOCH_PROTOCOL = 4
const notMarker = id => id === SYNC_EPOCH_ID || id === FENCE_ID

function usage() {
  console.log(`Usage:
  set ONCE_COUCHDB_URL=https://user:password@example.org/once
  node scripts/couch-epoch.js analyze
      Read-only: documents, deleted documents, and leaves beyond each winner.

  set ONCE_COUCHDB_TARGET_URL=https://user:password@example.org/once_e2
  node scripts/couch-epoch.js freeze
      Announces the move: clients stop syncing ("preparing"), and app
      versions that cannot follow an epoch must update (sync protocol ${EPOCH_PROTOCOL}).
      Installs a server write barrier; requires server-admin operator credentials.
      The target must be a database beside the source on the same server.

  node scripts/couch-epoch.js copy
      Copies every winning revision with its ancestry into the target, which
      must exist and be empty or hold an earlier copy of this source. Rerun
      it to copy what changed since; it resumes from its checkpoint.

  node scripts/couch-epoch.js verify
      Read-only: whether the target holds exactly the source's winners, each
      as its only leaf.

  node scripts/couch-epoch.js open
      Verifies, then marks the move "ready": each client rebuilds its local
      database and continues on the target.
      The original database remains the frozen discovery endpoint.

  node scripts/couch-epoch.js abort
      Before open only: removes the announcement, and clients resume on the
      source. The raised sync protocol stays.`)
}

/** The URL without credentials, query or fragment, for output and the copy checkpoint. */
function redacted(raw) {
  const url = new URL(raw)
  url.username = ""
  url.password = ""
  url.search = ""
  url.hash = ""
  return url.href.replace(/\/$/, "")
}

function database(variable) {
  const raw = process.env[variable]
  if (!raw) throw new Error(`${variable} is not set`)
  if (!/^https?:\/\//.test(raw)) throw new Error(`${variable} must be an http(s) URL`)
  // skip_setup: never create a database by accident.
  return { db: new PouchDB(raw, { skip_setup: true }), name: redacted(raw), url: raw }
}

/** Source and target, where the target is the sibling a client would derive from the marker. */
function move() {
  const source = database("ONCE_COUCHDB_URL")
  const target = database("ONCE_COUCHDB_TARGET_URL")
  const next = syncDatabaseName(target.url)
  if (syncDestination(epochSiblingUrl(source.url, next)) !== syncDestination(target.url) || source.name === target.name) {
    throw new Error("The target must be another database beside the source, on the same server")
  }
  return { source, target, next }
}

async function readOrNull(db, id) {
  return db.get(id).catch(error => { if (error.status === 404) return null; throw error })
}

async function assertExists({ db, name }) {
  const info = await db.info().catch(error => error)
  if (info && info.db_name) return info
  throw new Error(`${name} is not reachable or does not exist: ${info?.status ?? ""} ${info?.reason ?? info?.message ?? info}`)
}

function prefixOf(id) {
  const match = /^(_design\/|[a-z]+_)/.exec(id)
  return match ? match[1] : "(other)"
}

async function analyze() {
  const source = database("ONCE_COUCHDB_URL")
  const info = await assertExists(source)
  console.log(`Analysing ${source.name} (${info.doc_count} documents, ${info.doc_del_count ?? "?"} deleted, update_seq ${String(info.update_seq).split("-")[0]})…`)
  const census = await censusRevisions(source.db)
  const byPrefix = new Map()
  for (const [id, winner] of census.winners) {
    const row = byPrefix.get(prefixOf(id)) ?? { documents: 0, deleted: 0, conflicted: 0, extraLeaves: 0, worst: 0 }
    row.documents++
    if (winner.deleted) row.deleted++
    if (winner.leaves > 1) {
      row.conflicted++
      row.extraLeaves += winner.leaves - 1
      row.worst = Math.max(row.worst, winner.leaves)
    }
    byPrefix.set(prefixOf(id), row)
  }
  console.table(Object.fromEntries([...byPrefix].sort((a, b) => b[1].extraLeaves - a[1].extraLeaves)))
  const leaves = census.documents + census.extraLeaves
  console.log(`${census.liveConflicts.length} documents have unresolved live branches; resolve these before copying.`)
  if (census.liveConflicts.length) console.log(census.liveConflicts.slice(0, 20).join("\n"))
  console.log(`${census.extraLeaves} of ${leaves} leaves (${(100 * census.extraLeaves / Math.max(leaves, 1)).toFixed(1)}%) are losing branches a winners-only copy would leave behind.`)
}

async function copy() {
  const source = database("ONCE_COUCHDB_URL")
  const target = database("ONCE_COUCHDB_TARGET_URL")
  if (source.name === target.name) throw new Error("Source and target are the same database")
  await assertExists(source)
  const targetInfo = await assertExists(target)
  const checkpoint = await target.db.get("_local/once-epoch-copy").catch(() => null)
  // PouchDB servers omit doc_del_count; a missing count must not read as empty.
  const held = (targetInfo.doc_count ?? 1) + (targetInfo.doc_del_count ?? 0)
  if (held > 0 && checkpoint?.source !== source.name) {
    throw new Error(`${target.name} already holds documents that are not a copy of ${source.name}; use an empty database`)
  }
  console.log(checkpoint ? `Resuming the copy of ${source.name} into ${target.name}…` : `Copying ${source.name} into ${target.name}…`)
  if (!readSyncEpoch(await readOrNull(source.db, SYNC_EPOCH_ID))) {
    console.log("  The source is not frozen, so clients keep writing: this is a dry run. Run copy again after freeze.")
  } else await assertFence(source.db)
  let lastReport = 0
  const result = await copyWinningRevisions(source.db, target.db, source.name, {
    exclude: notMarker,
    onProgress: ({ copied, skipped }) => {
      if (Date.now() - lastReport < 2000) return
      lastReport = Date.now()
      console.log(`  ${copied} copied${skipped ? `, ${skipped} skipped` : ""}…`)
    }
  })
  console.log(`Copied ${result.copied} winning revisions. Run verify next.`)
}

async function verify() {
  const source = database("ONCE_COUCHDB_URL")
  const target = database("ONCE_COUCHDB_TARGET_URL")
  await assertExists(source)
  await assertExists(target)
  console.log(`Comparing ${source.name} with ${target.name}…`)
  const result = await verifyWinningRevisions(source.db, target.db, { exclude: notMarker })
  const sample = list => list.slice(0, 20).join("\n    ") + (list.length > 20 ? `\n    … ${list.length - 20} more` : "")
  if (result.mismatched.length) console.log(`  ${result.mismatched.length} winners missing or different in the target:\n    ${sample(result.mismatched)}`)
  if (result.conflicted.length) console.log(`  ${result.conflicted.length} target documents with more than one leaf:\n    ${sample(result.conflicted)}`)
  if (result.extra.length) console.log(`  ${result.extra.length} target documents the source lacks (written after a cutover?):\n    ${sample(result.extra)}`)
  if (result.contentMismatched.length) console.log(`  Content or attachment differences:\n    ${sample(result.contentMismatched)}`)
  if (result.unresolved.length) console.log(`  Unresolved live source conflicts:\n    ${sample(result.unresolved)}`)
  console.log(result.ok ? "Verified: the target holds every winner as its only leaf." : "Not verified.")
  if (!result.ok) process.exitCode = 1
  return result.ok
}

/** Writes the marker with a compare-and-swap on its current revision. */
async function writeMarker(db, state, next) {
  const current = await readOrNull(db, SYNC_EPOCH_ID)
  await db.put({ ...(current ? { _rev: current._rev } : {}), _id: SYNC_EPOCH_ID, schema: 1, state, next })
}

async function freeze() {
  const { source, target, next } = move()
  await assertExists(source)
  await assertExists(target)
  const marker = readSyncEpoch(await readOrNull(source.db, SYNC_EPOCH_ID))
  if (await readOrNull(target.db, FENCE_ID) || await readOrNull(target.db, SYNC_EPOCH_ID)) throw new Error("The target contains epoch control documents; use a clean target")
  if (marker && marker.next !== next) throw new Error(`${source.name} already moves to ${marker.next}`)
  if (marker?.state === "ready") throw new Error(`${source.name} is already open on ${next}`)
  // The protocol first: from here on, app versions that cannot follow stop
  // at "update required" instead of syncing their losing branches onward.
  const compat = await readOrNull(source.db, SYNC_COMPAT_ID)
  if (!compat || Number(compat.minSyncProtocol) < EPOCH_PROTOCOL) {
    await source.db.put({ schema: 1, ...compat, _id: SYNC_COMPAT_ID, minSyncProtocol: EPOCH_PROTOCOL })
  }
  await writeMarker(source.db, "preparing", next)
  await installFence(source.db)
  await assertFence(source.db)
  console.log(`Frozen: ${source.name} announces its move to ${next}. Clients pause; run copy, then verify, then open.`)
}

async function open() {
  const { source, target, next } = move()
  const marker = readSyncEpoch(await readOrNull(source.db, SYNC_EPOCH_ID))
  if (marker?.state !== "preparing" || marker.next !== next) throw new Error(`Run freeze for ${next} first`)
  await assertFence(source.db)
  if (await readOrNull(target.db, FENCE_ID) || await readOrNull(target.db, SYNC_EPOCH_ID)) throw new Error("The target contains epoch control documents; use a clean target")
  const before = (await source.db.info()).update_seq
  if (!await verify()) throw new Error("The copy is not verified; run copy again, then open")
  if (JSON.stringify(before) !== JSON.stringify((await source.db.info()).update_seq)) throw new Error("The source changed during verification; verify again before opening")
  if (!await readOrNull(target.db, SYNC_COMPAT_ID)) throw new Error(`${target.name} has no ${SYNC_COMPAT_ID}; run copy again`)
  await writeMarker(source.db, "ready", next)
  console.log(`Open: clients move to ${next} as they next connect. Keep ${source.name} permanently as the frozen discovery endpoint.`)
}

async function abort() {
  const { source, next } = move()
  const marker = await readOrNull(source.db, SYNC_EPOCH_ID)
  if (!marker) { await removeFence(source.db); return console.log("No move announced; any incomplete freeze was removed.") }
  if (readSyncEpoch(marker)?.state === "ready") {
    throw new Error(`The move to ${next} is open; devices may already have moved, so it can no longer be aborted`)
  }
  await removeFence(source.db)
  await source.db.remove(marker)
  console.log(`Aborted: clients resume on ${source.name}. Delete ${next} by hand if it is no longer needed.`)
}

const commands = { analyze, copy, verify, freeze, open, abort }
const command = commands[process.argv[2]]
if (!command) {
  usage()
  process.exitCode = process.argv[2] ? 1 : 0
} else {
  command().catch(error => {
    // PouchDB errors can carry the request URL; never print credentials.
    console.error(String(error?.message ?? error).replace(/\/\/[^/@\s]+@/g, "//"))
    process.exitCode = 1
  })
}
