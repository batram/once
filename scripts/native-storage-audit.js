/** Read-only DevTools audit of the native adapter; does not open/close the application's Pouch handle. */
async function auditNativeStorage(name = "once_mobile_native_v1") {
  const bridge = globalThis.Capacitor.Plugins.NativeDatabase
  const encode = value => Array.from(new TextEncoder().encode(value), byte => byte.toString(16).padStart(2, "0")).join("")
  const bytes = value => Uint8Array.from(atob(value), char => char.charCodeAt(0))
  const json = value => value === null ? null : JSON.parse(new TextDecoder().decode(bytes(value)))
  const get = async keys => (await bridge.execute({ operation: "getMany", name, keys: keys.map(encode) })).values
  const meta = async () => (await get(["ÿmeta-storeÿ_local_doc_count", "ÿmeta-storeÿ_local_last_update_seq"])).map(json)
  const start = await meta()
  const metadata = []
  const { iterator } = await bridge.execute({ operation: "iteratorOpen", name, gte: encode("ÿdocument-storeÿ"), lt: encode("ÿdocument-storeĀ") })
  try {
    let done = false
    while (!done) {
      const page = await bridge.execute({ operation: "iteratorNext", name, iterator })
      for (const row of page.rows) metadata.push(json(row.value))
      done = page.done
    }
  } finally { await bridge.execute({ operation: "iteratorEnd", name, iterator }) }
  const attachments = [], missingBodies = [], conflicts = []
  let leafCount = 0
  for (const doc of metadata) {
    const pending = doc.rev_tree.map(tree => tree.ids)
    let leaves = 0, live = 0
    while (pending.length) {
      const node = pending.pop()
      if (node[2].length) pending.push(...node[2])
      else { leaves++; if (!node[1].deleted) live++ }
    }
    leafCount += leaves
    if (live > 1) conflicts.push(doc.id)
  }
  for (let offset = 0; offset < metadata.length; offset += 200) {
    const batch = metadata.slice(offset, offset + 200)
    const bodies = await get(batch.map(doc => "ÿby-sequenceÿ" + String(doc.rev_map[doc.winningRev]).padStart(16, "0")))
    for (let index = 0; index < batch.length; index++) {
      const doc = batch[index], body = json(bodies[index])
      if (!body) { missingBodies.push(doc.id); continue }
      for (const [attachmentName, attachment] of Object.entries(body._attachments || {})) {
        const [value] = await get(["ÿattach-binary-storeÿ" + attachment.digest])
        if (value === null) { missingBodies.push(doc.id + "/" + attachmentName); continue }
        const data = bytes(value)
        const digest = await crypto.subtle.digest("SHA-256", data)
        attachments.push({ id: doc.id, rev: doc.winningRev, name: attachmentName, bytes: data.length,
          sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") })
      }
    }
  }
  const end = await meta()
  return { at: new Date().toISOString(), name, documents: end[0], updateSeq: end[1], stable: JSON.stringify(start) === JSON.stringify(end),
    deleted: metadata.filter(doc => doc.deleted).length, leafCount, conflicts, missingBodies, attachments,
    winners: metadata.map(doc => ({ id: doc.id, rev: doc.winningRev, deleted: doc.deleted })) }
}
if (typeof module !== "undefined") module.exports = { auditNativeStorage }
