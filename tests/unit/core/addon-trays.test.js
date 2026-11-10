const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const core = require("../../../packages/core/dist")

const example = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../examples/addons/what-wait-who-why/once-addon.json"), "utf8"))
const manifest = () => ({ ...example, script: { url: "https://example.test/main.js", integrity: "sha256-" + "a".repeat(43) + "=" } })

test("AI manifest round-trips trays, connections, prompts and never secret option values", () => {
  // The shipped add-on keeps no secret of its own any more, so one is declared here.
  const withSecret = manifest()
  withSecret.settings = { ...withSecret.settings, properties: { ...withSecret.settings.properties, openaiToken: { type: "string", format: "secret" } } }
  const result = core.readAddonManifest(withSecret)
  assert.equal(result.ok, true, JSON.stringify(result.reports))
  assert.equal(result.manifest.settings.properties.openaiToken.format, "secret")
  const options = core.validateConfig(result.manifest.settings, { openaiToken: "must-not-sync", explainPrompt: "x".repeat(16000) })
  assert.equal(options.openaiToken, undefined)
  assert.equal(options.explainPrompt.length, 16000)
  const doc = core.readAddonsDocument({ version: 1, addons: [{ enabled: true, manifest: withSecret, options: { openaiToken: "must-not-sync", webSearch: true } }] })
  assert.deepEqual(doc.addons[0].options.webSearch, true, "the other options are kept")
  const text = core.presentAddons(doc)
  assert.equal(text.includes("must-not-sync"), false)
  assert.equal(core.parseAddonsText(text).addons[0].manifest.trays[0].id, "assistant")
  assert.equal(core.parseAddonsText(text).addons[0].manifest.connections.length, 1)
  const collector = core.readConfigSchema({ type: "string", maxLength: 16000, format: "multiline" })
  assert.throws(() => core.validateConfig(collector, "x".repeat(2001)), /too long/)
})

test("invalid tray references, secret defaults and connection schemas are rejected", () => {
  const refusal = (value) => {
    const read = core.readAddonManifest(value)
    assert.equal(read.ok, false)
    return read.reports.map(report => report.message).join("; ")
  }
  assert.match(refusal({ ...manifest(), trays: [] }), /undeclared tray/)
  assert.match(refusal({ ...manifest(), connections: [{ id: "bad", endpoint: "model" }] }), /must name a URL setting/)
  // Added beside the existing settings: replacing them would also break the
  // connection's endpoint, and the manifest would be refused for that instead.
  const changed = manifest()
  changed.settings = { ...changed.settings, properties: { ...changed.settings.properties, token: { type: "string", format: "secret", default: "secret" } } }
  assert.match(refusal(changed), /Secrets cannot have defaults/)
})

test("model lists stay on the endpoint's origin and suggestions must name a connection that has one", () => {
  const result = core.readAddonManifest(manifest())
  assert.equal(result.ok, true, JSON.stringify(result.reports))
  assert.deepEqual(result.manifest.capabilities, ["fetch:https://www.youtube.com/*", "ai", "search"])
  assert.equal(result.manifest.settings.properties.model, undefined)
  assert.equal(core.addonModelsUrl("https://api.example.test/v1/chat/completions", "../models"), "https://api.example.test/v1/models")
  assert.equal(core.addonModelsUrl("https://api.example.test/v1/messages", "models"), "https://api.example.test/v1/models")
  assert.throws(() => core.addonModelsUrl("https://api.example.test/v1/messages", "https://other.test/models"), /origin/)
  const bad = (change) => { const value = manifest(); value.settings = { type: "object", properties: { endpoint: { type: "string", format: "url" }, provider: { type: "string", enum: ["openai"] }, model: { type: "string" }, webSearch: { type: "boolean" } } }; value.connections = [{ id: "openai", endpoint: "endpoint", models: "models" }, { id: "youtube", endpoint: "endpoint" }]; change(value); return core.readAddonManifest(value).ok }
  // The base is valid, so each refusal below is for the one thing it changes.
  assert.equal(bad(() => {}), true)
  assert.equal(bad(value => { value.settings.properties.model.suggestions = { connection: "openai" } }), true)
  assert.equal(bad(value => { value.connections[0].models = "https://other.test/models" }), false)
  assert.equal(bad(value => { value.settings.properties.model.suggestions = { connection: "youtube" } }), false)
  assert.equal(bad(value => { value.settings.properties.model.suggestions = { connectionField: "webSearch" } }), false)
  assert.equal(bad(value => { value.settings.properties.model.suggestions = { connection: "openai", connectionField: "provider" } }), false)
  assert.equal(bad(value => { value.settings.properties.provider.suggestions = { connection: "openai" } }), false, "an enum cannot take suggestions")
  assert.deepEqual(core.readAddonModels(JSON.stringify({ data: [{ id: "b", display_name: "B" }, { id: "a" }, { id: "a" }, { id: 3 }] })), [{ id: "a", name: "" }, { id: "b", name: "B" }])
  assert.deepEqual(core.readAddonModels(JSON.stringify(["z", "y"])), [{ id: "y", name: "" }, { id: "z", name: "" }])
  assert.throws(() => core.readAddonModels("{}"), /unexpected format/)
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

test("conversation snapshots and commands crossing a surface boundary are checked like tray views", () => {
  const snapshot = { addon: { id: "a", name: "A" }, tray: { id: "t", title: "T" }, story: { href: "https://story.test/", title: "S" },
    view: { messages: [{ role: "assistant", text: "hi" }] }, busy: true, error: "", draft: "d" }
  const read = core.readConversationSnapshot(snapshot)
  assert.deepEqual(read.story, { href: "https://story.test/", title: "S" })
  assert.equal(read.busy, true)
  assert.equal(read.view.messages[0].text, "hi")
  assert.throws(() => core.readConversationSnapshot({ ...snapshot, story: { href: "javascript:alert(1)", title: "S" } }), /conversation story/)
  assert.throws(() => core.readConversationSnapshot({ ...snapshot, view: { messages: [{ role: "system", text: "x" }] } }), /Invalid tray message/)
  assert.throws(() => core.readConversationSnapshot({ ...snapshot, draft: "x".repeat(8001) }), /Invalid conversation snapshot/)
  assert.deepEqual(core.readConversationCommand({ type: "submit", text: "q" }), { type: "submit", text: "q" })
  assert.deepEqual(core.readConversationCommand({ type: "action", action: "more" }), { type: "action", action: "more" })
  assert.deepEqual(core.readConversationCommand({ type: "stop", extra: 1 }), { type: "stop" })
  assert.deepEqual(core.readConversationCommand({ type: "refresh" }), { type: "refresh" })
  assert.equal(core.readConversationSnapshot({ ...snapshot, canRefresh: true }).canRefresh, true)
  assert.throws(() => core.readConversationCommand({ type: "action", action: "bad space" }), /Invalid conversation action/)
  assert.throws(() => core.readConversationCommand({ type: "open" }), /Unknown conversation command/)
  assert.throws(() => core.readConversationCommand(null), /Invalid conversation command/)
  const key = { addon: "example", tray: "assistant", story: "https://story.test/a b?x=1" }
  const search = core.conversationSearch(key)
  assert.deepEqual(core.readConversationKey(`once-addon://conversation/index.html?${search}`), { ...key, story: "https://story.test/a%20b?x=1" })
  assert.equal(core.readConversationKey("once-addon://conversation/index.html?addon=example&tray=assistant"), null)
  assert.equal(core.readConversationKey("once-addon://conversation/index.html?addon=bad%20id&tray=t&story=https%3A%2F%2Fs.test%2F"), null)
  assert.equal(core.readConversationKey("once-addon://conversation/index.html?addon=a&tray=t&story=javascript%3Aalert(1)"), null)
  assert.equal(core.readConversationKey("not a url"), null)
})

test("connection requests cannot set authentication headers or arbitrary HTTP methods", () => {
  assert.throws(() => core.readAddonRequest({ headers: { Authorization: "secret" } }), /header/)
  assert.throws(() => core.readAddonRequest({ method: "DELETE" }), /GET and POST/)
  assert.throws(() => core.readAddonRequest({ body: "é".repeat(600000) }), /too large/)
  assert.throws(() => core.addonEndpoint("https://user:pass@example.test/"), /without credentials/)
})

test("shared AI sandbox operations validate image inputs and expose credential-free requests", () => {
  const request = { instructions: "Read", messages: [{ role: "user", content: [{ type: "image", mediaType: "image/png", base64: "aGVsbG8=" }] }], selection: { connection: "configured", model: "vision" }, endpoint: "https://untrusted.test", token: "must-not-cross" }
  const message = core.readSandboxMessage({ type: "op", opId: 1, op: { name: "ai.generate", href: "", request } })
  assert.ok(message)
  assert.equal(message.op.request.token, undefined)
  assert.equal(message.op.request.endpoint, undefined)
  assert.equal(core.readSandboxMessage({ type: "op", opId: 1, op: { name: "ai.generate", href: "", request: { ...request, messages: [{ role: "system", content: "bad" }] } } }), null)
  assert.equal(core.readSandboxMessage({ type: "op", opId: 1, op: { name: "ai.generate", href: "", request: { ...request, messages: [{ role: "user", content: [{ type: "image", mediaType: "image/svg+xml", base64: "aGVsbG8=" }] }] } } }), null)
})
