const test = require("node:test")
const assert = require("node:assert/strict")
const { FENCE_ID, VALIDATION, installFence, assertFence, removeFence } = require("../../../scripts/couch-epoch-fence")

test("the server barrier blocks ordinary writes even for admins, while permitting only admin control updates", () => {
  const validate = new Function(`return (${VALIDATION})`)()
  for (const roles of [[], ["sync"], ["_admin"]]) {
    for (const doc of [{ _id: "sto_pending" }, { _id: "dev_phone", _deleted: true }, { _id: "sources", _rev: "3-aaa" }]) {
      assert.throws(() => validate(doc, null, { roles }, {}), error => /source is frozen/.test(error.forbidden))
    }
  }
  for (const id of [FENCE_ID, "once_sync_compat", "once_sync_epoch"]) {
    assert.doesNotThrow(() => validate({ _id: id }, null, { roles: ["_admin"] }, {}))
    assert.throws(() => validate({ _id: id }, null, { roles: ["sync"] }, {}))
  }
})

test("install and abort preserve the prior fence revision, and a changed fence fails verification", async () => {
  let held = null
  const db = {
    get: async id => { assert.equal(id, FENCE_ID); if (!held) throw { status: 404 }; return held },
    put: async doc => { if (held) assert.equal(doc._rev, held._rev); held = { ...doc, _rev: "2-fence" } },
    remove: async doc => { assert.equal(doc._rev, held._rev); held = null }
  }
  await installFence(db)
  await assertFence(db)
  await installFence(db)
  held.validate_doc_update = "function () {}"
  await assert.rejects(assertFence(db), /missing or changed/)
  await removeFence(db)
  assert.equal(held, null)
  await removeFence(db)
})
