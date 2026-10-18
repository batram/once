/** Runs unchanged against the native Android adapter and the desktop SQLite test bridge. */
async function nativeStorageConformance(PouchDB, prefix) {
  const check = (condition, message) => { if (!condition) throw new Error(message) }
  const open = name => new PouchDB(prefix + name, { adapter: "native-sqlite" })
  const source = open("source"), target = open("target")
  const started = performance.now()
  try {
    const data = "AAECA//+".repeat(600000) // 3.6 MB: exceeds Android CursorWindow's usual limit.
    await source.put({ _id: "attachment", _attachments: { "large.bin": { content_type: "application/octet-stream", data } } })
    await source.bulkDocs(Array.from({ length: 270 }, (_, i) => ({ _id: `row_${String(i).padStart(4, "0")}`, value: i })))
    const keyed = await source.allDocs({ keys: Array.from({ length: 270 }, (_, i) => `row_${String(i).padStart(4, "0")}`), include_docs: true })
    check(keyed.rows.length === 270 && keyed.rows[269].doc.value === 269, "Bulk key lookup exceeded native snapshot capacity")
    const first = await source.put({ _id: "conflict", value: "base" })
    await source.bulkDocs([
      { _id: "conflict", _rev: "2-aaaa", _revisions: { start: 2, ids: ["aaaa", first.rev.split("-")[1]] }, value: "left" },
      { _id: "conflict", _rev: "2-bbbb", _revisions: { start: 2, ids: ["bbbb", first.rev.split("-")[1]] }, value: "right" }
    ], { new_edits: false })
    await source.put({ _id: "_local/checkpoint-test", value: "durable" })
    await PouchDB.replicate(source, target, { batch_size: 100 })
    const conflict = await target.get("conflict", { conflicts: true })
    check(conflict._rev === "2-bbbb" && conflict._conflicts?.[0] === "2-aaaa", "Revision branches changed")
    check((await target.get("attachment", { attachments: true }))._attachments["large.bin"].data === data, "Large attachment changed")
    const page = await target.allDocs({ startkey: "row_0200", endkey: "row_0100", descending: true, limit: 37 })
    check(page.rows.length === 37 && page.rows[0].id === "row_0200" && page.rows[36].id === "row_0164", "Reverse range or limit failed")
    const removed = await source.get("row_0000")
    await source.remove(removed)
    await PouchDB.replicate(source, target)
    check((await target.allDocs({ keys: ["row_0000"] })).rows[0].value.deleted === true, "Deletion not replicated")
    await source.compact()
    check((await source.get("attachment", { attachments: true }))._attachments["large.bin"].data === data, "Compaction lost attachment")
    check((await source.get("conflict", { conflicts: true }))._conflicts.length === 1, "Compaction lost conflict")
    await source.close()
    const reopened = open("source")
    check((await reopened.get("_local/checkpoint-test")).value === "durable", "Local checkpoint lost after close")
    check((await reopened.get("attachment", { attachments: true }))._attachments["large.bin"].data === data, "Attachment lost after reopen")
    await reopened.destroy()
    return { ok: true, elapsedMs: Math.round(performance.now() - started), documents: 272, attachmentBytes: 3600000 }
  } finally {
    await target.destroy()
    try { await source.destroy() } catch { /* already closed and destroyed above */ }
  }
}
module.exports = { nativeStorageConformance }
