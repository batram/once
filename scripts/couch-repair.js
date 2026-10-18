const { createHash } = require("node:crypto")

function revisions(doc) { return [doc._rev, ...(doc._conflicts || [])].sort() }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)) }
function writable(doc) {
  return Object.fromEntries(Object.entries(structuredClone(doc))
    .filter(([key]) => !["_conflicts", "_deleted_conflicts", "_revisions", "_revs_info"].includes(key)))
}

/** Archive every live branch before changing anything. Never force a revision or retry a stale plan. */
async function repairDocument(db, plan, archive) {
  const current = await db.get(plan.id, { conflicts: true, attachments: true })
  if (current._rev !== plan.winner || !same(revisions(current), [...plan.revisions].sort())) {
    throw new Error(`Repair plan is stale: ${plan.id}`)
  }
  const branches = [current]
  for (const rev of current._conflicts || []) branches.push(await db.get(plan.id, { rev, attachments: true }))
  await archive({ id: plan.id, branches })
  const next = writable(current)
  if (plan.attachment) {
    const { name, sha256, fingerprint } = plan.attachment
    const attachment = next._attachments?.[name]
    if (!attachment?.data) throw new Error(`Missing repair attachment: ${plan.id}`)
    const bytes = Buffer.from(attachment.data, "base64")
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new Error(`Repair attachment changed: ${plan.id}`)
    if (name === "thumb.jpg" && createHash("sha1").update(bytes).digest("hex") !== next.contentHash) {
      throw new Error(`Invalid thumbnail: ${plan.id}`)
    }
    if (fingerprint) next.stored_content = { ...next.stored_content, fingerprint: `sha256:${sha256}` }
  }
  // Recheck after durable archival, including same-revision content divergence.
  const fresh = await db.get(plan.id, { conflicts: true, attachments: true })
  if (!same(current, fresh)) throw new Error(`Document changed during archival: ${plan.id}`)
  const result = await db.put(next)
  if (!result.ok) throw new Error(`Repair write failed: ${plan.id}`)
  await archive({ id: plan.id, written: result.rev })
  let remaining = [...(current._conflicts || [])]
  for (const rev of remaining.slice()) {
    const check = await db.get(plan.id, { conflicts: true })
    if (check._rev !== result.rev || !same([...(check._conflicts || [])].sort(), [...remaining].sort())) {
      throw new Error(`Concurrent edit during repair: ${plan.id}`)
    }
    const deleted = await db.put({ _id: plan.id, _rev: rev, _deleted: true })
    if (!deleted.ok) throw new Error(`Branch removal failed: ${plan.id}`)
    remaining = remaining.filter(item => item !== rev)
    await archive({ id: plan.id, retired: rev, tombstone: deleted.rev })
  }
  const after = await db.get(plan.id, { conflicts: true, attachments: true })
  if (after._rev !== result.rev || after._conflicts?.length) throw new Error(`Repair did not settle: ${plan.id}`)
  if (!same(writable(after), { ...next, _rev: result.rev })) {
    // CouchDB normalizes attachment transport metadata; compare the actual payload separately.
    const expected = { ...next }; const actual = writable(after)
    for (const doc of [expected, actual]) {
      delete doc._rev
      for (const attachment of Object.values(doc._attachments || {})) {
        delete attachment.revpos; delete attachment.digest; delete attachment.length; delete attachment.stub
      }
    }
    if (!same(expected, actual)) throw new Error(`Repair verification failed: ${plan.id}`)
  }
  return { id: plan.id, revision: result.rev, retired: current._conflicts?.length || 0 }
}

module.exports = { repairDocument }
