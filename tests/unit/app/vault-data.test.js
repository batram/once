const test = require("node:test")
const assert = require("node:assert/strict")
const { readVaultData } = require("../../../packages/app/dist/vaultData")

const manifest = { protocol: 1, id: "example-addon", name: "Example", version: "1.0.0", script: { url: "once-addon://local/example-addon/main.js", integrity: "sha256-" + "a".repeat(43) + "=" },
  trays: [{ id: "tray", title: "Tray" }], contributions: [{ kind: "action", id: "open", label: "Open", icon: "ai-question", group: "discovery", surfaces: ["menu"], run: { tray: "tray" } }],
  connections: [{ id: "provider", endpoint: "endpoint", secret: "token", auth: "bearer" }],
  settings: { type: "object", properties: { endpoint: { type: "string", format: "url", default: "" }, token: { type: "string", format: "secret" }, model: { type: "string", default: "" } } } }
const vault = (addons) => ({ document: { version: 1, addons }, secrets: {}, scripts: {}, generation: 1, commit: "c", author: "a", updatedAt: "now" })

test("a vault written by a newer Once opens here: unknown manifest fields are carried, not refused", () => {
  const newer = { ...manifest, connections: [{ ...manifest.connections[0], futureField: "x" }],
    settings: { ...manifest.settings, properties: { ...manifest.settings.properties, model: { type: "string", default: "", futureHint: { from: "provider" } } } } }
  const data = readVaultData(vault([{ enabled: true, manifest: newer, options: { model: "m" } }]))
  assert.equal(data.document.addons[0].manifest.connections[0].futureField, "x", "the stored bytes stay as written")
})

test("a vault holding an add-on this Once cannot read at all still fails closed", () => {
  assert.throws(() => readVaultData(vault([{ enabled: true, manifest: { ...manifest, id: "bad id" } }])), /cannot read/)
  assert.throws(() => readVaultData(vault([{ enabled: true, manifest }, { enabled: true, manifest }])), /cannot read/, "a duplicate would be dropped")
  assert.equal(readVaultData(vault([{ enabled: true, manifest }])).document.addons.length, 1)
})
