const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs/promises")
const os = require("node:os")
const path = require("node:path")
const PouchDB = require("pouchdb")
const { PouchListStore } = require("../../../packages/persistence/dist")
const { AddonVault } = require("../../../packages/app/dist/AddonVault")

test("real replication preserves encrypted packages and exposes conflicting offline edits for explicit resolution", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-vault-replication-"))
  const firstDb = new PouchDB(path.join(directory, "first"))
  const secondDb = new PouchDB(path.join(directory, "second"))
  const server = new PouchDB(path.join(directory, "server"))
  const make = db => {
    const local = new Map()
    const store = new PouchListStore(db)
    return { store, vault: new AddonVault(store, { get: async key => local.get(key) || "", set: async (key, value) => local.set(key, value) }, () => {}) }
  }
  const first = make(firstDb), second = make(secondDb)
  const passphrase = "test passphrase for replication"
  try {
    await first.vault.create(passphrase, false, "Laptop", { document: { version: 1, addons: [] }, secrets: { "addon:vault-example:token": "private-token" },
      scripts: {}, generation: 1, commit: "", author: "", updatedAt: "" })
    await firstDb.replicate.to(server)
    const saved = await server.get("addon_vault")
    assert.equal(JSON.stringify(saved).includes("private-token"), false)
    await secondDb.replicate.from(server)
    assert.equal((await second.vault.status()).state, "locked")
    await second.vault.unlock(passphrase, false, false, "Phone")
    assert.equal((await second.vault.read()).secrets["addon:vault-example:token"], "private-token")
    await first.vault.update(data => { data.secrets = {} })
    const deletion = (await first.store.readVault())[0]
    await second.vault.update(data => { data.secrets["addon:vault-example:token"] = "offline-token" })
    await firstDb.replicate.to(server)
    await secondDb.replicate.to(server)
    await firstDb.replicate.from(server)
    const choices = await first.vault.choices()
    assert.equal(choices.length, 2)
    assert.equal((await first.vault.status()).state, "conflict")
    await assert.rejects(first.vault.update(() => {}), /concurrent edits/)
    await assert.rejects(first.store.writeVault({}, [deletion.revision]), /changed/)
    await first.vault.resolve(deletion.revision, choices.map(item => item.revision))
    assert.equal((await first.store.readVault()).length, 1)
    await firstDb.replicate.to(server)
    await secondDb.replicate.from(server)
    assert.equal((await second.vault.status()).state, "ready")
    assert.deepEqual((await second.vault.read()).secrets, {})
  } finally {
    await Promise.all([firstDb.destroy(), secondDb.destroy(), server.destroy()])
    await fs.rmdir(directory)
  }
})
