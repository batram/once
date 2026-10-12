function compatibilityDatabase(database = {}) {
  const docs = new Map()
  return Object.assign(database, {
    async get(id) { if (!docs.has(id)) throw { status: 404 }; return structuredClone(docs.get(id)) },
    async put(doc) { const previous = docs.get(doc._id); if (previous && previous._rev !== doc._rev) throw { status: 409 }; const rev = `${Number(previous?._rev?.split("-")[0] ?? 0) + 1}-fixture`; docs.set(doc._id, { ...structuredClone(doc), _rev: rev }); return { rev } },
    ...(!database.changes ? { changes() { return { on() { return this }, cancel() {} } } } : {})
  })
}
async function eventually(check) {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
  throw new Error("Expected asynchronous sync state did not arrive")
}
module.exports = { compatibilityDatabase, eventually }
