const test = require("node:test")
const assert = require("node:assert/strict")
const crypto = require("node:crypto")
const { readAddonsDocument } = require("../../../packages/core/dist")
const { AddonSync } = require("../../../packages/app/dist/AddonSync")
const { AddonVault } = require("../../../packages/app/dist/AddonVault")
const { decryptVault, readEnvelope } = require("../../../packages/app/dist/vaultCrypto")

const passphrase = "correct horse example vault"
const code = "export default function activate() {}"
const integrity = `sha256-${crypto.createHash("sha256").update(code).digest("base64")}`
const manifest = { protocol: 1, id: "vault-example", name: "Vault example", version: "1.0.0", script: { url: "once-addon://local/example/main.js", integrity },
  connections: [{ id: "provider", endpoint: "endpoint", secret: "token", auth: "bearer" }],
  settings: { type: "object", properties: { endpoint: { type: "string", format: "url", default: "https://provider.test/messages" }, token: { type: "string", format: "secret" } } }, contributions: [] }
const installed = () => readAddonsDocument({ version: 1, addons: [{ enabled: true, manifest, options: {} }] })

function device(records = [], protection = "os") {
  let counter = 0
  const local = new Map(), cache = new Map([[`addon-script:${integrity}`, code]])
  const state = { records: structuredClone(records), legacy: installed(), changes: 0, requests: [] }
  const store = {
    async readVault() { return structuredClone(state.records) },
    async writeVault(value, parents) {
      assert.deepEqual([...parents].sort(), state.records.map(item => item.revision).sort())
      state.records = [{ revision: `${++counter}-${crypto.randomUUID()}`, value: structuredClone(value) }]
    },
    get: async (_id, fallback) => fallback,
    set: async () => {}
  }
  const secrets = { protection, get: async name => local.get(name) || "", set: async (name, value) => { if (value) local.set(name, value); else local.delete(name) } }
  const platform = { listStore: store, secretStore: secrets, cacheStore: { get: async name => cache.get(name), set: async (name, value) => cache.set(name, value) },
    fetch: async (_url, init) => { state.requests.push(init.headers.get("authorization")); return new Response("ok") } }
  const settings = { getAddons: async () => structuredClone(state.legacy), saveAddons: async doc => { state.legacy = doc },
    updateAddons: async change => { state.legacy = change(state.legacy) } }
  const sync = new AddonSync(platform, settings, () => state.changes++)
  return { state, local, cache, store, secrets, sync, client: sync.methods() }
}
async function setup() {
  const first = device()
  await first.client.saveAddonSecret(manifest.id, "token", "https://provider.test/messages", "private-test-token")
  const result = await first.sync.create(passphrase, true, "Laptop")
  return { first, result }
}

test("configure once: second client unlocks settings, imported code and token; server sees no plaintext", async () => {
  const { first, result } = await setup()
  const server = JSON.stringify(first.state.records)
  for (const value of ["private-test-token", code, "provider.test", "Vault example", passphrase, result.recoveryKey]) assert.equal(server.includes(value), false)
  assert.equal(first.local.has(`addon:${manifest.id}:token`), false)
  assert.equal(first.state.legacy.addons.length, 0)
  const second = device(first.state.records, null)
  second.cache.clear()
  assert.equal((await second.client.getAddonVaultStatus()).state, "locked")
  assert.equal((await second.client.getAddonVaultStatus()).protectedStorage, false)
  assert.equal((await second.client.getAddons()).addons.length, 0)
  await assert.rejects(second.client.unlockAddonVault("wrong passphrase", false, false, "Browser"), /Could not unlock/)
  await second.client.unlockAddonVault(passphrase, false, false, "Browser")
  const doc = await second.client.getAddons()
  assert.deepEqual(doc, JSON.parse(JSON.stringify(installed())))
  assert.equal(await second.client.getAddonScript(integrity), code)
  assert.equal(await second.client.hasAddonSecret(manifest.id, "token", "https://provider.test/messages"), true)
  await second.client.requestAddonConnection(doc.addons[0].manifest, doc.addons[0].options, "provider", { method: "POST", body: "{}" })
  assert.deepEqual(second.state.requests, ["Bearer private-test-token"])
  assert.equal(JSON.stringify([...second.local.values()]).includes("private-test-token"), false)
  const restarted = new AddonVault(second.store, second.secrets, () => {})
  assert.equal((await restarted.status()).state, "locked")
  const nativeRestart = new AddonVault(first.store, first.secrets, () => {})
  assert.equal((await nativeRestart.status()).state, "ready")
})

test("token replacement and clearing propagate; old local tokens never restore deleted credentials", async () => {
  const { first } = await setup()
  const second = device(first.state.records)
  await second.client.unlockAddonVault(passphrase, false, true, "Phone")
  await first.client.saveAddonSecret(manifest.id, "token", "https://provider.test/messages", "replacement-token")
  second.state.records = structuredClone(first.state.records)
  const doc = await second.client.getAddons()
  await second.client.requestAddonConnection(doc.addons[0].manifest, doc.addons[0].options, "provider", { method: "POST" })
  assert.equal(second.state.requests.at(-1), "Bearer replacement-token")
  await first.client.saveAddonSecret(manifest.id, "token", "https://provider.test/messages", "")
  second.state.records = structuredClone(first.state.records)
  second.local.set(`addon:${manifest.id}:token`, JSON.stringify({ endpoint: "https://provider.test/messages", value: "old-local" }))
  assert.equal(await second.client.hasAddonSecret(manifest.id, "token", "https://provider.test/messages"), false)
  await first.client.updateAddons(doc => ({ ...doc, addons: [] }))
  second.state.records = structuredClone(first.state.records)
  assert.equal((await second.client.getAddons()).addons.length, 0)
})

test("tampered snapshots, replacement manifests, endpoint changes and missing vault fail closed", async () => {
  const { first } = await setup()
  const doc = await first.client.getAddons()
  const entry = doc.addons[0]
  await assert.rejects(first.client.requestAddonConnection({ ...entry.manifest, version: "2.0.0" }, entry.options, "provider", {}), /not approved/)
  await assert.rejects(first.client.requestAddonConnection(entry.manifest, { endpoint: "https://different.test/" }, "provider", {}), /connection changed/)
  assert.equal(first.state.requests.length, 0)
  first.state.records[0].value.payload.data = "AAAA"
  assert.equal((await first.client.getAddonVaultStatus()).state, "error")
  assert.equal((await first.client.getAddons()).addons.length, 0)
  await assert.rejects(first.client.saveAddonSecret(manifest.id, "token", "https://provider.test/messages", "value"), /verification failed/)
  first.state.records = []
  assert.match((await first.client.getAddonVaultStatus()).message, /vault is missing/)
  assert.equal((await first.client.getAddons()).addons.length, 0)
})

test("offline concurrent edits pause connections until an explicitly selected snapshot resolves them", async () => {
  const { first } = await setup()
  const second = device(first.state.records)
  await second.client.unlockAddonVault(passphrase, false, false, "Phone")
  await first.client.saveAddonSecret(manifest.id, "token", "https://provider.test/messages", "")
  await second.client.saveAddonSecret(manifest.id, "token", "https://provider.test/messages", "offline-replacement")
  await second.client.saveAddonSecret(manifest.id, "token", "https://provider.test/messages", "another-offline-replacement")
  const deletion = first.state.records[0]
  first.state.records.push(second.state.records[0])
  assert.equal((await first.client.getAddonVaultStatus()).state, "conflict")
  assert.equal((await first.client.getAddons()).addons.length, 0)
  const choices = await first.client.getAddonVaultChoices()
  assert.equal(choices.length, 2)
  assert.equal(choices.find(item => item.revision === deletion.revision).connections.length, 0)
  await first.client.resolveAddonVault(deletion.revision, choices.map(item => item.revision))
  assert.equal((await first.client.getAddonVaultStatus()).state, "ready")
  assert.equal(await first.client.hasAddonSecret(manifest.id, "token", "https://provider.test/messages"), false)
  second.state.records = structuredClone(first.state.records)
  assert.equal((await second.client.getAddonVaultStatus()).state, "ready")
  assert.equal(await second.client.hasAddonSecret(manifest.id, "token", "https://provider.test/messages"), false)
})

test("recovery unlock, passphrase change, lock and history rollback checks", async () => {
  const { first, result } = await setup()
  const original = structuredClone(first.state.records)
  await first.client.lockAddonVault()
  assert.equal((await first.client.getAddonVaultStatus()).state, "locked")
  await first.client.unlockAddonVault(result.recoveryKey, true, false, "Recovered laptop")
  await first.client.changeAddonVaultPassphrase("a different strong passphrase")
  await first.client.lockAddonVault()
  await assert.rejects(first.client.unlockAddonVault(passphrase, false, false, ""), /Could not unlock/)
  await first.client.unlockAddonVault("a different strong passphrase", false, false, "")
  assert.equal((await first.client.getAddonVaultStatus()).state, "ready")
  first.state.records = original
  assert.equal((await first.client.getAddonVaultStatus()).state, "conflict")
})

test("sharing a development snapshot includes settings and existing tokens without syncing its local path", async () => {
  const first = device()
  first.state.legacy = { version: 1, addons: [] }
  await first.sync.create(passphrase, false, "Laptop")
  await first.client.saveAddonSecret(manifest.id, "token", "https://provider.test/messages", "dev-token", true)
  await first.client.shareAddonSnapshot(installed().addons[0], code)
  const next = device(first.state.records)
  next.cache.clear()
  await next.client.unlockAddonVault(passphrase, false, false, "Phone")
  assert.equal((await next.client.getAddons()).addons[0].manifest.script.url, `once-addon://local/${manifest.id}/main.js`)
  assert.equal(await next.client.hasAddonSecret(manifest.id, "token", "https://provider.test/messages"), true)
  assert.equal(await next.client.getAddonScript(integrity), code)
})

test("vault header authentication detects modifications even with a remembered device key", async () => {
  const { first } = await setup()
  const pin = JSON.parse(first.local.get("once:addon-vault"))
  const envelope = readEnvelope(first.state.records[0].value)
  envelope.salt = "00".repeat(16)
  await assert.rejects(decryptVault(envelope, pin.key), /verification failed/)
})

test("JSON key order does not affect authenticated envelope decoding", async () => {
  const { first } = await setup()
  const envelope = first.state.records[0].value
  envelope.password = { data: envelope.password.data, iv: envelope.password.iv }
  envelope.recovery = { data: envelope.recovery.data, iv: envelope.recovery.iv }
  assert.equal((await first.client.getAddonVaultStatus()).state, "ready")
})

test("migration returns a recovery key even if the local remembered-key write fails", async () => {
  const first = device()
  const originalSet = first.secrets.set
  first.secrets.set = async (name, value) => {
    if (name === "once:addon-vault") throw new Error("Fixture storage unavailable")
    return originalSet(name, value)
  }
  const result = await first.sync.create(passphrase, true, "Laptop")
  assert.match(result.recoveryKey, /^[a-f0-9]{64}$/)
  assert.match(result.warning, /device key could not be saved/)
  const other = device(first.state.records)
  await other.client.unlockAddonVault(result.recoveryKey, true, false, "Phone")
  assert.equal((await other.client.getAddonVaultStatus()).state, "ready")
})

test("saving a token while migration is pending updates the vault, without leaving a local token", async () => {
  const first = device()
  const creating = first.sync.create(passphrase, false, "Laptop")
  const saving = first.client.saveAddonSecret(manifest.id, "token", "https://provider.test/messages", "after-migration")
  await creating
  await saving
  assert.equal(first.local.has(`addon:${manifest.id}:token`), false)
  const doc = await first.client.getAddons()
  await first.client.requestAddonConnection(doc.addons[0].manifest, doc.addons[0].options, "provider", { method: "POST" })
  assert.deepEqual(first.state.requests, ["Bearer after-migration"])
})
