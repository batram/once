const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const originalTs = Module._extensions[".ts"]
Module._extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}
// SecureSettings imports electron for its defaults; the tests inject their own.
const originalLoad = Module._load
Module._load = function (request, ...rest) {
  if (request === "electron") return { app: { name: "once", getPath: () => os.tmpdir() }, safeStorage: {} }
  if (request === "@once/core") return { DEFAULT_CACHE_MINUTES: 60 }
  return originalLoad.call(this, request, ...rest)
}
test.after(() => {
  Module._load = originalLoad
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
})

const { SecureSettings } = require("../../../apps/electron/src/SecureSettings.ts")

function fakeCipher(available) {
  return {
    available,
    isAvailable() { return this.available },
    encrypt: (value) => `enc:${value}`,
    decrypt: (encrypted) => encrypted.replace(/^enc:/, "")
  }
}

function setup(available) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "once-secure-settings-"))
  const filePath = path.join(dir, "settings.json")
  const cipher = fakeCipher(available)
  const warnings = []
  const settings = new SecureSettings(filePath, cipher, (m) => warnings.push(m))
  const stored = () => JSON.parse(fs.readFileSync(filePath, "utf8"))
  return { settings, cipher, warnings, stored }
}

test("encrypts the sync URL and secrets when the OS cipher is available", async () => {
  const { settings, stored, warnings } = setup(true)
  await settings.setSyncUrl("https://u:p@example.org/db")
  await settings.setSecret("source:hn", "token")
  assert.equal(stored().encryptedSyncUrl, "enc:https://u:p@example.org/db")
  assert.equal(stored().encryptedSecrets["source:hn"], "enc:token")
  assert.equal(await settings.getSyncUrl(), "https://u:p@example.org/db")
  assert.equal(await settings.getSecret("source:hn"), "token")
  assert.deepEqual(warnings, [])
})

test("falls back to unencrypted storage, once warned, when the cipher is unavailable", async () => {
  const { settings, stored, warnings } = setup(false)
  await settings.setSyncUrl("https://u:p@example.org/db")
  await settings.setSecret("source:hn", "token")
  assert.equal(stored().plainSyncUrl, "https://u:p@example.org/db")
  assert.equal(stored().encryptedSyncUrl, undefined)
  assert.equal(stored().plainSecrets["source:hn"], "token")
  assert.equal(await settings.getSyncUrl(), "https://u:p@example.org/db")
  assert.equal(await settings.getSecret("source:hn"), "token")
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /unencrypted/)
})

test("re-encrypts plain values on the next save once the cipher returns", async () => {
  const { settings, cipher, stored } = setup(false)
  await settings.setSyncUrl("https://old")
  await settings.setSecret("source:hn", "token")
  cipher.available = true
  await settings.setSyncUrl("https://new")
  await settings.setSecret("source:hn", "token2")
  assert.equal(stored().plainSyncUrl, undefined)
  assert.equal(stored().encryptedSyncUrl, "enc:https://new")
  assert.deepEqual(stored().plainSecrets, {})
  assert.equal(stored().encryptedSecrets["source:hn"], "enc:token2")
  assert.equal(await settings.getSyncUrl(), "https://new")
})

test("clearing a secret removes both stored forms", async () => {
  const { settings, cipher, stored } = setup(false)
  await settings.setSecret("source:hn", "plain")
  cipher.available = true
  await settings.setSecret("source:lo", "token")
  await settings.setSecret("source:hn", "")
  await settings.setSecret("source:lo", "")
  assert.deepEqual(stored().plainSecrets, {})
  assert.deepEqual(stored().encryptedSecrets, {})
  assert.equal(await settings.getSecret("source:hn"), "")
})

test("an encrypted value from an earlier build fails to read only until it is replaced", async () => {
  const { settings, cipher } = setup(true)
  await settings.setSyncUrl("https://old")
  cipher.available = false
  await assert.rejects(() => settings.getSyncUrl(), /saved by an earlier build/)
  await settings.setSyncUrl("https://new")
  assert.equal(await settings.getSyncUrl(), "https://new")
})

test("a cipher that is available but refuses to decrypt falls back to the plain copy or explains itself", async () => {
  const { settings, cipher } = setup(false)
  await settings.setSyncUrl("https://plain")
  cipher.available = true
  await settings.setSecret("source:hn", "token")
  cipher.decrypt = () => { throw new Error("The user name or passphrase you entered is not correct.") }
  // The sync URL was never re-encrypted, so its plain copy still reads.
  assert.equal(await settings.getSyncUrl(), "https://plain")
  await assert.rejects(() => settings.getSecret("source:hn"), /refused to decrypt.*Save it again/)
  await settings.setSecret("source:hn", "token2")
  cipher.decrypt = (encrypted) => encrypted.replace(/^enc:/, "")
  assert.equal(await settings.getSecret("source:hn"), "token2")
})
