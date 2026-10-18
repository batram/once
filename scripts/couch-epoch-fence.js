// A frozen source rejects ordinary writes even from administrators. Only
// the control documents may change until the operator explicitly aborts.
const FENCE_ID = "_design/once-epoch-freeze"
const VALIDATION = `function (next, previous, user, security) {
  if (user.roles.indexOf('_admin') !== -1 &&
      ['_design/once-epoch-freeze', 'once_sync_epoch', 'once_sync_compat'].indexOf(next._id) !== -1) return;
  throw { forbidden: 'Once epoch source is frozen; ordinary writes are disabled' };
}`

async function installFence(db) {
  const current = await db.get(FENCE_ID).catch(error => { if (error.status === 404) return null; throw error })
  await db.put({ _id: FENCE_ID, ...(current ? { _rev: current._rev } : {}), language: "javascript", validate_doc_update: VALIDATION })
}

async function assertFence(db) {
  const doc = await db.get(FENCE_ID)
  if (doc.validate_doc_update !== VALIDATION) throw new Error("The source write barrier is missing or changed; freeze it before copying or opening")
}

async function removeFence(db) {
  const doc = await db.get(FENCE_ID).catch(error => { if (error.status === 404) return null; throw error })
  if (doc) await db.remove(doc)
}

module.exports = { FENCE_ID, VALIDATION, installFence, assertFence, removeFence }
