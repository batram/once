const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const core = require("../../../packages/core/dist")

const example = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../examples/addons/what-wait-who-why/once-addon.json"), "utf8"))
const manifest = () => ({ ...example, script: { url: "https://example.test/main.js", integrity: "sha256-" + "a".repeat(43) + "=" } })

test("AI manifest round-trips trays, connections, prompts and never secret option values", () => {
  const result = core.readAddonManifest(manifest())
  assert.equal(result.ok, true, JSON.stringify(result.reports))
  const options = core.validateConfig(result.manifest.settings, { openaiToken: "must-not-sync", explainPrompt: "x".repeat(16000) })
  assert.equal(options.openaiToken, undefined)
  assert.equal(options.explainPrompt.length, 16000)
  const doc = core.readAddonsDocument({ version: 1, addons: [{ enabled: true, manifest: manifest(), options: { openaiToken: "must-not-sync" } }] })
  const text = core.presentAddons(doc)
  assert.equal(text.includes("must-not-sync"), false)
  assert.equal(core.parseAddonsText(text).addons[0].manifest.trays[0].id, "assistant")
  assert.equal(core.parseAddonsText(text).addons[0].manifest.connections.length, 4)
  const collector = core.readConfigSchema({ type: "string", maxLength: 16000, format: "multiline" })
  assert.throws(() => core.validateConfig(collector, "x".repeat(2001)), /too long/)
})

test("invalid tray references, secret defaults and connection schemas are rejected", () => {
  assert.equal(core.readAddonManifest({ ...manifest(), trays: [] }).ok, false)
  assert.equal(core.readAddonManifest({ ...manifest(), connections: [{ id: "bad", endpoint: "model" }] }).ok, false)
  const changed = manifest()
  changed.settings = { type: "object", properties: { token: { type: "string", format: "secret", default: "secret" } } }
  assert.equal(core.readAddonManifest(changed).ok, false)
})

test("tray views only allow bounded text and safe source URLs", () => {
  assert.equal(core.readTrayView({ messages: [{ role: "assistant", text: "<script>text</script>" }] }).messages[0].text, "<script>text</script>")
  assert.throws(() => core.readTrayView({ messages: [{ role: "assistant", text: "answer", sources: [{ title: "bad", url: "javascript:alert(1)" }] }] }), /Invalid source/)
  assert.throws(() => core.readTrayView({ messages: [{ role: "assistant", text: "x".repeat(256001) }] }), /too large/)
  assert.throws(() => core.readTrayView({ messages: [], actions: [{ id: "bad space", label: "bad" }] }), /Invalid tray action/)
  assert.equal(core.readTrayView({ messages: [], status: "failed", statusTone: "error" }).statusTone, "error")
  assert.equal(core.readTrayView({ messages: [], status: "ready" }).statusTone, undefined)
  assert.throws(() => core.readTrayView({ messages: [], statusTone: "warning" }), /Invalid tray status tone/)
})

test("connection requests cannot set authentication headers or arbitrary HTTP methods", () => {
  assert.throws(() => core.readAddonRequest({ headers: { Authorization: "secret" } }), /header/)
  assert.throws(() => core.readAddonRequest({ method: "DELETE" }), /GET and POST/)
  assert.throws(() => core.readAddonRequest({ body: "é".repeat(600000) }), /too large/)
  assert.throws(() => core.addonEndpoint("https://user:pass@example.test/"), /without credentials/)
})
