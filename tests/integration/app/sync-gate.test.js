const test = require("node:test")
const assert = require("node:assert/strict")
const { createOnceApp } = require("../../../packages/app/dist")
const { createFakePlatform } = require("../../helpers/fake-platform")

function platform({ url = "", provenance, consent, hasLocalData = false, secrets } = {}) {
  const fake = createFakePlatform([], { secrets })
  const state = { url, connections: [], statuses: [], urlListeners: new Set() }
  fake.ports.syncUrlProvenance = provenance
  fake.ports.syncSettingsStore.getSyncUrl = async () => state.url
  fake.ports.syncSettingsStore.setSyncUrl = async (value) => { state.url = value }
  fake.ports.syncSettingsStore.onSyncUrlChanged = (handler) => { state.urlListeners.add(handler); return () => state.urlListeners.delete(handler) }
  fake.ports.syncService.syncFrom = (value) => { state.connections.push(value) }
  fake.ports.syncService.hasLocalData = async () => hasLocalData
  fake.ports.syncService.onStatus = (handler) => { state.status = handler; return () => undefined }
  if (consent) fake.ports.syncConsent = consent
  state.changeUrlElsewhere = async (value) => {
    state.url = value
    state.urlListeners.forEach((handler) => handler())
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return { fake, state }
}

const lastConnection = (state) => state.connections.at(-1)

test("the first connection binds the profile; startup and external URL changes cannot redirect it", async () => {
  const { fake, state } = platform({ url: "https://user:pw@sync.example.test/once" })
  const app = createOnceApp(fake.ports)
  await app.start()
  assert.equal(lastConnection(state), "https://user:pw@sync.example.test/once")
  assert.equal(fake.secrets.get("once:sync-destination"), "https://sync.example.test/once")
  await app.client.setSyncUrl("https://user:new@sync.example.test/once/")
  assert.equal(lastConnection(state), "https://user:new@sync.example.test/once/")
  await assert.rejects(app.client.setSyncUrl("https://sync.example.test/other"), /separate Once profile/)
  assert.match(state.url, /user:new@/, "a refused URL is never saved")
  await state.changeUrlElsewhere("https://elsewhere.example.test/once")
  assert.equal(lastConnection(state), "", "replication stops instead of following the new URL")
  assert.match(app.client.getSyncStatus().message, /separate Once profile/)
  assert.equal(fake.secrets.get("once:sync-destination"), "https://sync.example.test/once")

  const restarted = platform({ url: "https://elsewhere.example.test/once", secrets: fake.secrets })
  await createOnceApp(restarted.fake.ports).start()
  assert.ok(!restarted.state.connections.some(Boolean), "a restart with a different saved URL connects nowhere")
})

test("an existing vault destination is the binding after an upgrade", async () => {
  const secrets = new Map([["once:addon-vault-destination", "https://vault.example.test/once"]])
  const { fake, state } = platform({ url: "https://vault.example.test/other", secrets, hasLocalData: true })
  const app = createOnceApp(fake.ports)
  await app.start()
  assert.ok(!state.connections.some(Boolean))
  assert.match(app.client.getSyncStatus().message, /separate Once profile/)
})

test("a browser-synced URL over existing local data waits for the user to confirm it", async () => {
  const { fake, state } = platform({ url: "https://sync.example.test/once", provenance: "browser", hasLocalData: true })
  const app = createOnceApp(fake.ports)
  await app.start()
  assert.ok(!state.connections.some(Boolean))
  assert.match(app.client.getSyncStatus().message, /Press Save in Settings › Sync to confirm/)
  await app.client.setSyncUrl("https://sync.example.test/once")
  assert.equal(lastConnection(state), "https://sync.example.test/once")
  assert.equal(fake.secrets.get("once:sync-destination"), "https://sync.example.test/once")
})

test("without consent nothing connects; granting resumes and withdrawing stops replication", async () => {
  let granted = false
  const listeners = new Set()
  const consent = {
    granted: async () => granted,
    request: async () => { granted = true; listeners.forEach((handler) => handler()); return true },
    onChanged: (handler) => { listeners.add(handler); return () => listeners.delete(handler) }
  }
  const { fake, state } = platform({ url: "https://sync.example.test/once", consent })
  const app = createOnceApp(fake.ports)
  await app.start()
  assert.ok(!state.connections.some(Boolean))
  assert.equal(await app.client.getSyncConsent(), "required")
  assert.match(app.client.getSyncStatus().message, /allow sending data/)
  await app.client.requestSyncConsent()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lastConnection(state), "https://sync.example.test/once")
  granted = false
  listeners.forEach((handler) => handler())
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(lastConnection(state), "")
})
