function compatibilityDatabase(database = {}) {
  const docs = new Map()
  return Object.assign(database, {
    async get(id) { if (!docs.has(id)) throw { status: 404 }; return structuredClone(docs.get(id)) },
    async put(doc) { const previous = docs.get(doc._id); if (previous && previous._rev !== doc._rev) throw { status: 409 }; const rev = `${Number(previous?._rev?.split("-")[0] ?? 0) + 1}-fixture`; docs.set(doc._id, { ...structuredClone(doc), _rev: rev }); return { rev } },
    ...(!database.changes ? { changes() { return { on() { return this }, cancel() {} } } } : {})
  })
}
/**
 * Polls until `check` (sync or async) is truthy. The deadline is about ten
 * seconds: real database I/O can take that long on a loaded runner.
 */
async function eventually(check, what = "the expected asynchronous sync state") {
  for (let attempt = 0; attempt < 2000; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error(`Timed out waiting for ${what}`)
}
module.exports = { compatibilityDatabase, eventually }
