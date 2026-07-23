#!/usr/bin/env node

const crypto = require("node:crypto")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")

const DEFAULT_LIMIT = 100
const BULK_GET_BATCH_SIZE = 10
const MIN_REQUEST_INTERVAL_MS = 250
const REQUEST_TIMEOUT_MS = 30_000
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000]
const REPAIR_DOCUMENT = Symbol("repairDocument")
let lastRequestStartedAt = 0

function usage() {
  console.log(`Usage:
  set ONCE_COUCHDB_URL=https://user:password@example.org/once
  node scripts/list-recent-couchdb-story-changes.js [limit|start-end] [--changed-only]
  node scripts/list-recent-couchdb-story-changes.js [limit] --force-fix

Lists story documents among the most recent CouchDB change rows.
Ranges are zero-based and end-exclusive: 0-100, 100-200, 200-300.
Ranges are for read-only inspection; force-fix uses safe internal batches.
Shows each revision's read state before and after the change.
Use --changed-only to hide rows whose read state did not change.
Use --force-fix to restore verified read/skipped -> unread changes.
Revision bodies are loaded in sequential batches of ${BULK_GET_BATCH_SIZE}.
Requests are paced, time out, and retry with server-aware backoff.
Without --force-fix this script is read-only. Credentials are never printed.`)
}

function databaseUrl(rawUrl) {
  const url = new URL(rawUrl)
  if (!url.pathname || url.pathname === "/") {
    throw new Error("ONCE_COUCHDB_URL must include the database name")
  }
  url.search = ""
  url.hash = ""
  return url
}

function changesUrl(dbUrl, limit) {
  const url = new URL(dbUrl)
  url.pathname = `${url.pathname.replace(/\/$/, "")}/_changes`
  url.searchParams.set("descending", "true")
  url.searchParams.set("limit", String(limit))
  return url
}

function requestOptions(url) {
  if (!url.username && !url.password) return {}

  const username = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  url.username = ""
  url.password = ""
  return {
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
    }
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function fetchGently(url, options = {}, retryDelays = RETRY_DELAYS_MS) {
  let lastError

  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    const waitForPacing = Math.max(
      0,
      lastRequestStartedAt + MIN_REQUEST_INTERVAL_MS - Date.now()
    )
    if (waitForPacing > 0) await sleep(waitForPacing)
    lastRequestStartedAt = Date.now()

    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
      if (response.status !== 429 && response.status < 500) return response

      lastError = new Error(
        `CouchDB returned HTTP ${response.status} ${response.statusText}`
      )
      const retryAfter = retryAfterMilliseconds(response)
      await response.body?.cancel()
      if (attempt < retryDelays.length) {
        await sleep(retryAfter ?? retryDelays[attempt])
      }
    } catch (error) {
      lastError = error
      if (attempt < retryDelays.length) {
        await sleep(retryDelays[attempt])
      }
    }
  }

  throw lastError
}

function retryAfterMilliseconds(response) {
  const value = response.headers.get("retry-after")
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

function bulkGetUrl(dbUrl) {
  const url = new URL(dbUrl)
  url.pathname = `${url.pathname.replace(/\/$/, "")}/_bulk_get`
  url.searchParams.set("revs", "true")
  return url
}

function revisionKey(documentId, revision) {
  return `${documentId}\0${revision}`
}

async function bulkGetRevisions(dbUrl, options, requestedRevisions) {
  if (requestedRevisions.length === 0) return new Map()
  const response = await fetchGently(
    bulkGetUrl(dbUrl),
    {
      ...options,
      method: "POST",
      headers: {
        ...options.headers,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        docs: requestedRevisions.map(({ id, rev }) => ({ id, rev }))
      })
    }
  )
  if (!response.ok) {
    throw new Error(
      `CouchDB returned HTTP ${response.status} ${response.statusText} from _bulk_get`
    )
  }
  const body = await response.json()
  if (!Array.isArray(body.results)) {
    throw new Error("CouchDB returned an invalid _bulk_get response")
  }

  const documents = new Map()
  body.results.forEach((result) => {
    result.docs?.forEach((entry) => {
      const document = entry.ok
      if (document?._id && document?._rev) {
        documents.set(revisionKey(document._id, document._rev), document)
      }
    })
  })
  return documents
}

function bulkDocsUrl(dbUrl) {
  const url = new URL(dbUrl)
  url.pathname = `${url.pathname.replace(/\/$/, "")}/_bulk_docs`
  return url
}

async function repairStoryChanges(dbUrl, options, stories) {
  const documents = stories
    .map((story) => story[REPAIR_DOCUMENT])
    .filter(Boolean)
  const summary = { repaired: 0, conflicts: 0, errors: [] }

  for (const batch of chunks(documents, BULK_GET_BATCH_SIZE)) {
    const response = await fetchGently(
      bulkDocsUrl(dbUrl),
      {
        ...options,
        method: "POST",
        headers: {
          ...options.headers,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ docs: batch })
      },
      []
    )
    if (!response.ok) {
      throw new Error(
        `CouchDB returned HTTP ${response.status} ${response.statusText} from _bulk_docs after ${summary.repaired} repair(s)`
      )
    }

    const results = await response.json()
    if (!Array.isArray(results)) {
      throw new Error("CouchDB returned an invalid _bulk_docs response")
    }
    results.forEach((result) => {
      if (result.ok) {
        summary.repaired += 1
      } else if (result.error === "conflict") {
        summary.conflicts += 1
      } else {
        summary.errors.push(
          `${result.id ?? "(unknown document)"}: ${result.error ?? "unknown error"}${result.reason ? ` (${result.reason})` : ""}`
        )
      }
    })
    process.stderr.write(
      `\rRestored ${summary.repaired}/${documents.length} stories`
    )
  }

  if (documents.length > 0) process.stderr.write("\n")
  return summary
}

function parentRevision(document) {
  const revisions = document?._revisions
  if (
    !Number.isInteger(revisions?.start) ||
    !Array.isArray(revisions?.ids) ||
    revisions.ids.length < 2
  ) {
    return null
  }
  return `${revisions.start - 1}-${revisions.ids[1]}`
}

function truncate(value, maxLength = 40) {
  const text = String(value)
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 1)}…`
}

function describeStoryChange(change, index, currentDocuments, parentDocuments) {
  const revision = change.changes?.[0]?.rev ?? change.doc?._rev
  if (!revision) {
    return {
      "#": index + 1,
      before: "(unknown)",
      after: change.doc?.read_state ?? "(missing)",
      title: truncate(change.doc?.title ?? "(untitled)"),
      story: truncate(change.doc?.href ?? change.id.slice("sto_".length)),
      revision: "(unknown)"
    }
  }

  const current = currentDocuments.get(revisionKey(change.id, revision))
  const parent = parentRevision(current)
  const previous = parent
    ? parentDocuments.get(revisionKey(change.id, parent))
    : null

  const description = {
    "#": index + 1,
    before: parent
      ? previous?.read_state ?? "(unavailable)"
      : "(new document)",
    after: current?.read_state ?? change.doc?.read_state ?? "(missing)",
    title: truncate(current?.title ?? change.doc?.title ?? "(untitled)"),
    story: truncate(
      current?.href ?? change.doc?.href ?? change.id.slice("sto_".length)
    ),
    revision
  }
  if (
    current?.read_state === "unread" &&
    (previous?.read_state === "read" || previous?.read_state === "skipped")
  ) {
    description[REPAIR_DOCUMENT] = repairedDocument(
      current,
      previous.read_state
    )
  }
  return description
}

function repairedDocument(current, restoredReadState) {
  const repaired = { ...current }
  delete repaired._revisions
  delete repaired._revs_info
  delete repaired._conflicts
  delete repaired._deleted_conflicts
  repaired.read_state = restoredReadState
  const previousUpdate = Number(repaired.sync_updated_at?.read_state) || 0
  repaired.sync_updated_at = {
    ...repaired.sync_updated_at,
    read_state: Math.max(Date.now(), previousUpdate + 1)
  }
  return repaired
}

function chunks(items, size) {
  const result = []
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size))
  }
  return result
}

function parseChangeWindow(value = String(DEFAULT_LIMIT)) {
  const range = /^(\d+)-(\d+)$/.exec(value)
  if (range) {
    const start = Number.parseInt(range[1], 10)
    const end = Number.parseInt(range[2], 10)
    if (end <= start) {
      throw new Error("range end must be greater than range start")
    }
    if (end > 10_000) {
      throw new Error("range end must not exceed 10000")
    }
    return { start, end }
  }

  const limit = Number.parseInt(value, 10)
  if (!/^\d+$/.test(value) || limit < 1 || limit > 10_000) {
    throw new Error(
      "limit must be 1-10000, or use an end-exclusive range such as 100-200"
    )
  }
  return { start: 0, end: limit }
}

async function loadStoryChanges(dbUrl, options, storyChanges) {
  const stories = []
  let processed = 0

  for (const batch of chunks(storyChanges, BULK_GET_BATCH_SIZE)) {
    const currentRequests = batch
      .map((change) => ({
        id: change.id,
        rev: change.changes?.[0]?.rev ?? change.doc?._rev
      }))
      .filter((request) => request.rev)
    const currentDocuments = await bulkGetRevisions(
      dbUrl,
      options,
      currentRequests
    )
    const parentRequests = currentRequests
      .map(({ id, rev }) => {
        const parent = parentRevision(
          currentDocuments.get(revisionKey(id, rev))
        )
        return parent ? { id, rev: parent } : null
      })
      .filter(Boolean)
    const parentDocuments = await bulkGetRevisions(
      dbUrl,
      options,
      parentRequests
    )

    batch.forEach((change, batchIndex) => {
      stories.push(
        describeStoryChange(
          change,
          processed + batchIndex,
          currentDocuments,
          parentDocuments
        )
      )
    })
    processed += batch.length
    process.stderr.write(`\rInspected ${processed}/${storyChanges.length} stories`)
  }

  if (storyChanges.length > 0) process.stderr.write("\n")
  return stories
}

function acquireDatabaseLock(dbUrl) {
  const identity = `${dbUrl.origin}${dbUrl.pathname}`
  const hash = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 16)
  const lockPath = path.join(os.tmpdir(), `once-couchdb-inspect-${hash}.lock`)

  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" })
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    const existingPid = Number.parseInt(fs.readFileSync(lockPath, "utf8"), 10)
    if (Number.isInteger(existingPid) && processIsRunning(existingPid)) {
      throw new Error(
        `another inspection is already running for this database (process ${existingPid})`
      )
    }
    fs.unlinkSync(lockPath)
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" })
  }

  let released = false
  return () => {
    if (released) return
    released = true
    try {
      if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
        fs.unlinkSync(lockPath)
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
}

function processIsRunning(processId) {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}

async function main() {
  const cliArgs = process.argv.slice(2)
  if (cliArgs.includes("--help") || cliArgs.includes("-h")) {
    usage()
    return
  }

  const rawUrl = process.env.ONCE_COUCHDB_URL
  if (!rawUrl) {
    usage()
    throw new Error("ONCE_COUCHDB_URL is not set")
  }

  const changedOnly = cliArgs.includes("--changed-only")
  const forceFix = cliArgs.includes("--force-fix")
  const positionalArguments = cliArgs.filter(
    (argument) =>
      argument !== "--changed-only" && argument !== "--force-fix"
  )
  if (positionalArguments.length > 1) {
    throw new Error(`unexpected argument: ${positionalArguments[1]}`)
  }
  const changeWindow = parseChangeWindow(positionalArguments[0])
  if (forceFix && positionalArguments[0]?.includes("-")) {
    throw new Error(
      "ranged --force-fix is unsafe because each repair shifts the live _changes offsets; use a numeric limit instead (repairs are already written in batches of 10)"
    )
  }

  const dbUrl = databaseUrl(rawUrl)
  const options = requestOptions(dbUrl)
  const releaseLock = acquireDatabaseLock(dbUrl)
  process.once("exit", releaseLock)
  process.once("SIGINT", () => process.exit(130))
  process.once("SIGTERM", () => process.exit(143))

  const url = changesUrl(dbUrl, changeWindow.end)
  const response = await fetchGently(url, options)
  if (!response.ok) {
    throw new Error(`CouchDB returned HTTP ${response.status} ${response.statusText}`)
  }

  const body = await response.json()
  if (!Array.isArray(body.results)) {
    throw new Error("CouchDB returned an invalid _changes response")
  }

  const selectedChanges = body.results.slice(
    changeWindow.start,
    changeWindow.end
  )
  const storyChanges = selectedChanges.filter(
    (change) => change.id?.startsWith("sto_") && !change.deleted
  )
  let stories = await loadStoryChanges(dbUrl, options, storyChanges)
  if (forceFix) {
    stories = stories.filter((story) => story[REPAIR_DOCUMENT])
  } else if (changedOnly) {
    stories = stories.filter(
      (story) =>
        !story.before.startsWith("(") &&
        !story.after.startsWith("(") &&
        story.before !== story.after
    )
  }

  console.log(
    `${stories.length} story document(s) found in change rows ${changeWindow.start}-${changeWindow.end} (${selectedChanges.length} row(s) returned)${
      forceFix
        ? " eligible for read-state restoration"
        : changedOnly
          ? " with a read-state change"
          : ""
    }.`
  )
  console.table(stories)

  if (forceFix && stories.length > 0) {
    const summary = await repairStoryChanges(dbUrl, options, stories)
    console.log(
      `Restored ${summary.repaired} story read state(s); ${summary.conflicts} skipped because the document changed during the scan.`
    )
    summary.errors.forEach((error) => console.error(`Repair failed: ${error}`))
    if (summary.conflicts > 0 || summary.errors.length > 0) {
      process.exitCode = 2
    }
  }
}

main().catch((error) => {
  const cause =
    error.cause instanceof Error ? ` (${error.cause.message})` : ""
  console.error(`Unable to list CouchDB changes: ${error.message}${cause}`)
  process.exitCode = 1
})
