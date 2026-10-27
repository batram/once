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

test("changing the device-local URL reconnects immediately and survives restart", async () => {
  const { fake, state } = platform({ url: "https://user:pw@sync.example.test/once" })
  const app = createOnceApp(fake.ports)
  await app.start()
  assert.equal(lastConnection(state), "https://user:pw@sync.example.test/once")
  assert.equal(fake.secrets.get("once:sync-destination"), "https://sync.example.test/once")
  await app.client.setSyncUrl("https://user:new@sync.example.test/once/")
  assert.equal(lastConnection(state), "https://user:new@sync.example.test/once/")
  await app.client.setSyncUrl("https://sync.example.test/other")
  assert.equal(state.url, "https://sync.example.test/other")
  assert.deepEqual(state.connections.slice(-2), ["", state.url], "the old connection stops before the new one starts")
  const restarted = platform({ url: state.url, secrets: fake.secrets, hasLocalData: true })
  await createOnceApp(restarted.fake.ports).start()
  assert.equal(lastConnection(restarted.state), state.url)
  await state.changeUrlElsewhere("https://elsewhere.example.test/once")
  assert.equal(lastConnection(state), state.url)
  assert.equal(fake.secrets.get("once:sync-destination"), state.url)
  await app.client.setSyncUrl("")
  assert.equal(lastConnection(state), "")
  await app.client.setSyncUrl("https://sync.example.test/once")
  assert.equal(lastConnection(state), "https://sync.example.test/once")
})

test("a legacy vault destination does not prevent switching the device-local URL", async () => {
  const secrets = new Map([["once:addon-vault-destination", "https://vault.example.test/once"]])
  const { fake, state } = platform({ url: "https://vault.example.test/other", secrets, hasLocalData: true })
  const app = createOnceApp(fake.ports)
  await app.start()
  assert.equal(lastConnection(state), state.url)
  assert.equal(fake.secrets.get("once:sync-destination"), state.url)
})

test("a changed browser-synced destination waits for Save, then reconnects and persists", async () => {
  const { fake, state } = platform({ url: "https://sync.example.test/once", provenance: "browser", hasLocalData: true,
    secrets: new Map([["once:sync-destination", "https://sync.example.test/once"]]) })
  const app = createOnceApp(fake.ports)
  await app.start()
  await state.changeUrlElsewhere("https://sync.example.test/other")
  assert.equal(lastConnection(state), "")
  assert.match(app.client.getSyncStatus().message, /Press Save/)
  await app.client.setSyncUrl(state.url)
  assert.equal(lastConnection(state), state.url)
  const restarted = platform({ url: state.url, provenance: "browser", hasLocalData: true, secrets: fake.secrets })
  await createOnceApp(restarted.fake.ports).start()
  assert.equal(lastConnection(restarted.state), state.url)
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
