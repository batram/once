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

for (const settlement of ["one device", "both devices"]) {
  test(`the same edit settles on ${settlement} and stays settled after replication`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "once-vault-duplicate-"))
    const firstDb = new PouchDB(path.join(directory, "first"))
    const secondDb = new PouchDB(path.join(directory, "second"))
    const server = new PouchDB(path.join(directory, "server"))
    const make = db => {
      const local = new Map()
      const store = new PouchListStore(db)
      const secrets = { get: async key => local.get(key) || "", set: async (key, value) => local.set(key, value) }
      return { store, secrets, vault: new AddonVault(store, secrets, () => {}) }
    }
    const first = make(firstDb), second = make(secondDb)
    const passphrase = "test passphrase for replication"
    const sync = async () => {
      for (const db of [firstDb, secondDb]) await db.replicate.to(server)
      for (const db of [firstDb, secondDb]) await db.replicate.from(server)
    }
    try {
      await first.vault.create(passphrase, true, "Laptop", { document: { version: 1, addons: [] }, secrets: {}, scripts: {},
        generation: 1, commit: "", author: "", updatedAt: "" })
      await sync()
      await second.vault.unlock(passphrase, false, true, "Phone")
      const offer = data => { data.document = { ...data.document, bundled: { "vault-example": "1.0.0" } } }
      await first.vault.update(offer)
      await second.vault.update(offer)
      await sync()
      assert.equal((await first.store.readVault()).length, 2, "both replicas hold both branches")
      const winner = (await first.store.readVault())[0].revision
      assert.equal((await second.store.readVault())[0].revision, winner, "every replica picks the same winner")
      // Settle on the device that wrote the winner, ensuring the losing writer
      // must accept the result without ever reading the concurrent branches.
      const winnerChoice = (await first.vault.choices()).find(choice => choice.revision === winner)
      const settling = winnerChoice.author === "Laptop" ? first : second
      const receiving = settling === first ? second : first
      assert.equal((await settling.vault.status()).state, "ready")
      if (settlement === "both devices") assert.equal((await receiving.vault.status()).state, "ready")
      await sync()
      for (const device of [first, second]) {
        assert.equal((await device.vault.status()).state, "ready")
        assert.equal((await device.store.readVault()).length, 1)
        assert.equal((await device.vault.read()).generation, 3, "settlement advances once, even when both devices settle")
      }
      await sync()
      const settledRevision = (await first.store.readVault())[0].revision
      assert.equal((await second.store.readVault())[0].revision, settledRevision)
      const restarted = new AddonVault(receiving.store, receiving.secrets, () => {})
      assert.equal((await restarted.status()).state, "ready", "the remembered pin accepts the result after restarting")
      await second.vault.update(data => { data.secrets = { "addon:vault-example:token": "later" } })
      await sync()
      assert.equal((await first.vault.read()).secrets["addon:vault-example:token"], "later", "later edits build on the winner")

      // Different builds record different offers at once: both combine them,
      // concurrently, and the two identical combinations then settle as duplicates.
      await first.vault.update(data => { data.document = { ...data.document, bundled: { "vault-example": "1.2.0" } } })
      await second.vault.update(data => { data.document = { ...data.document, bundled: { "vault-example": "1.10.0", "other-addon": "0.1.0" } } })
      await sync()
      assert.equal((await first.store.readVault()).length, 2)
      assert.equal((await first.vault.status()).state, "ready")
      assert.equal((await second.vault.status()).state, "ready")
      await sync()
      for (const device of [first, second]) {
        assert.equal((await device.vault.status()).state, "ready")
        assert.equal((await device.store.readVault()).length, 1)
        assert.deepEqual((await device.vault.read()).document.bundled, { "vault-example": "1.10.0", "other-addon": "0.1.0" })
      }
    } finally {
      await Promise.all([firstDb.destroy(), secondDb.destroy(), server.destroy()])
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}
