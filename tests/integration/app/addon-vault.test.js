const test = require("node:test")
const assert = require("node:assert/strict")
const { createOnceApp } = require("../../../packages/app/dist")
const { createFakePlatform } = require("../../helpers/fake-platform")

test("vault creation waits for sync; an enabled vault permits credential changes and reconnecting only to the same database", async () => {
  const fake = createFakePlatform()
  let url = "https://user:old@sync.example.test/once", records = [], status
  fake.ports.syncSettingsStore.getSyncUrl = async () => url
  fake.ports.syncSettingsStore.setSyncUrl = async value => { url = value }
  fake.ports.syncService.onStatus = handler => { status = handler; return () => {} }
  fake.ports.listStore.readVault = async () => structuredClone(records)
  fake.ports.listStore.writeVault = async (value, parents) => {
    assert.deepEqual(parents, records.map(item => item.revision))
    records = [{ revision: "1-fixture", value: structuredClone(value) }]
  }
  const app = createOnceApp(fake.ports)
  await app.start()
  await assert.rejects(app.client.createAddonVault("a long test passphrase", false, "Laptop"), /wait until it is up to date/)
  status({ state: "up-to-date", message: "Up to date" })
  await app.client.createAddonVault("a long test passphrase", false, "Laptop")
  await app.client.setSyncUrl("https://user:new@sync.example.test/once/")
  assert.match(url, /user:new@/)
  await assert.rejects(app.client.setSyncUrl("https://sync.example.test/other"), /separate Once profile/)
  await app.client.setSyncUrl("")
  assert.equal(url, "")
  await assert.rejects(app.client.setSyncUrl("https://elsewhere.example.test/once"), /separate Once profile/)
  await app.client.setSyncUrl("https://user:new@sync.example.test/once")
  assert.match(url, /sync.example.test\/once/)
  assert.equal((await app.client.getAddonVaultStatus()).state, "ready")
})
