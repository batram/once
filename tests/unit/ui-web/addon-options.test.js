const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { renderAddonOptions, readDevAddonOptions, devAddonEnabled } = require("../../../packages/ui-web/dist/settings/addonOptions")

test("development options persist locally, preserve drafts, restore defaults and remain editable while disabled", async () => {
  const { window } = parseHTML('<html><body><div id="addon_options"></div></body></html>')
  const names = ["window", "document", "CustomEvent", "Event", "HTMLInputElement", "HTMLTextAreaElement", "localStorage"]
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]))
  const storage = new Map()
  for (const name of names) globalThis[name] = window[name]
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  const entry = { enabled: true, manifest: { id: "dev-example", name: "Example", settings: {
    type: "object", properties: { prompt: { type: "string", format: "multiline", maxLength: 16000, default: "Packaged prompt" } }
  } } }
  const client = { updateAddons: () => { throw new Error("Development options must not sync") } }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  try {
    renderAddonOptions(client, [entry], new Set(["dev-example"]))
    const prompt = document.querySelector("textarea")
    assert.equal(prompt.value, "Packaged prompt")
    prompt.value = "Draft"
    prompt.dispatchEvent(new window.Event("input"))
    renderAddonOptions(client, [{ ...entry, options: { prompt: "Remote" } }], new Set(["dev-example"]))
    assert.equal(document.querySelector("textarea"), prompt)
    assert.equal(prompt.value, "Draft")
    prompt.dispatchEvent(new window.Event("change"))
    await settle()
    assert.equal(readDevAddonOptions("dev-example").prompt, "Draft")
    const button = label => Array.from(document.querySelectorAll("button")).find(item => item.textContent === label)
    // Restoring is offered only while the value differs from the default, and names it.
    assert.equal(button("Restore default").hidden, false)
    assert.equal(button("Restore default").title, "Default: Packaged prompt")
    button("Restore default").click()
    await settle()
    assert.equal(prompt.value, "Packaged prompt")
    assert.equal(button("Restore default").hidden, true)
    assert.equal(readDevAddonOptions("dev-example").prompt, "Packaged prompt")
    button("Disable").click()
    await settle()
    assert.equal(devAddonEnabled("dev-example"), false)
    assert.notEqual(prompt.disabled, true)
    storage.set("once:dev-addon:dev-example", "null")
    assert.deepEqual(readDevAddonOptions("dev-example"), {})

    // Every page opens with its source. A folder offers to install itself; an
    // installed copy that hides a linked folder says so and offers both ways out.
    const calls = []
    const controls = new Map([
      ["dev-example", { kind: "folder", directory: "C:\\work\\example", install: async () => calls.push("install"), unload: async () => calls.push("unload") }],
      ["shadowed", { kind: "shadowed", directory: "C:\\work\\shadowed", version: "2.0.0", upToDate: false, useFolder: async () => calls.push("use"), replace: async () => { calls.push("replace"); return "Installed copy updated to 2.0.0 from the folder; settings and tokens kept." } }]
    ])
    const plain = { enabled: true, manifest: { id: "shadowed", name: "Shadowed" } }
    const fromUrl = { enabled: true, manifest: { id: "remote", name: "Remote" }, source: { url: "https://example.org/once-addon.json" } }
    renderAddonOptions(client, [entry, plain, fromUrl], new Set(["dev-example"]), controls)
    const cardOf = id => document.querySelector(`[data-addon="${id}"] .addon_source`)
    assert.match(cardOf("dev-example").textContent, /linked folder on this device/)
    assert.equal(cardOf("dev-example").querySelector(".addon_source_path").textContent, "C:\\work\\example")
    assert.equal(document.querySelector('[data-addon="dev-example"]').dataset.addonOrigin, "Linked folder example · this device")
    // A folder with newer files is a thing to do, not a warning; the card says what it has.
    assert.ok(cardOf("shadowed").classList.contains("addon_source--update"))
    assert.equal(cardOf("shadowed").classList.contains("addon_source--attention"), false)
    assert.match(cardOf("shadowed").textContent, /Linked folder with newer files \(2\.0\.0\)/)
    assert.equal(document.querySelector('[data-addon="shadowed"]').dataset.addonOrigin, "Imported copy · folder linked")
    assert.equal(cardOf("remote").querySelector(".addon_source_path").textContent, "https://example.org/once-addon.json")
    assert.equal(button("Use this version on my devices"), undefined)
    button("Install this version").click()
    button("Run from the folder instead").click()
    button("Update installed copy from folder").click()
    await settle()
    assert.deepEqual(calls, ["install", "use", "replace"])
    // An action that worked says so in the card's own voice, not in red.
    const outcome = cardOf("shadowed").querySelector("[role=status]")
    assert.equal(outcome.textContent, "Installed copy updated to 2.0.0 from the folder; settings and tokens kept.")
    assert.equal(outcome.dataset.tone, "ok")
    // Once the installed copy holds the folder's files there is nothing to update, and the card says so calmly.
    const current = new Map(controls)
    current.set("shadowed", { ...controls.get("shadowed"), files: "same", upToDate: true })
    renderAddonOptions(client, [entry, plain, fromUrl], new Set(["dev-example"]), current)
    assert.match(cardOf("shadowed").textContent, /up to date/)
    assert.equal(cardOf("shadowed").classList.contains("addon_source--update"), false)
    assert.equal(button("Update installed copy from folder"), undefined)
    // A shadowed page's actions install the folder as it was read; an edit to
    // the folder changes nothing visible about the installed copy, so the page
    // has to notice the folder itself or its button keeps installing stale files.
    const edited = new Map(controls)
    edited.set("shadowed", { ...controls.get("shadowed"), files: "edited", replace: async () => calls.push("replace edited") })
    renderAddonOptions(client, [entry, plain, fromUrl], new Set(["dev-example"]), edited)
    button("Update installed copy from folder").click()
    await settle()
    assert.equal(calls.at(-1), "replace edited")
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = previous[name]
    }
  }
})

test("a model setting offers the provider's list through the connection the provider setting names", async () => {
  const { window } = parseHTML('<html><body><div id="addon_options"></div></body></html>')
  const names = ["window", "document", "CustomEvent", "Event", "HTMLInputElement", "HTMLTextAreaElement", "localStorage"]
  const previous = Object.fromEntries(names.map(name => [name, globalThis[name]]))
  const storage = new Map()
  for (const name of names) globalThis[name] = window[name]
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  const entry = { enabled: true, options: { provider: "anthropic", endpoint: "https://api.anthropic.com/v1/messages" }, manifest: { id: "ai", name: "AI",
    connections: [{ id: "anthropic", endpoint: "endpoint", secret: "token", auth: "x-api-key", models: "models" }, { id: "local", endpoint: "endpoint" }],
    settings: { type: "object", properties: {
      provider: { type: "string", enum: ["anthropic", "local"], default: "anthropic" },
      endpoint: { type: "string", format: "url", default: "" },
      token: { type: "string", format: "secret" },
      model: { type: "string", default: "", suggestions: { connectionField: "provider" } },
      other: { type: "string", default: "", suggestions: { connection: "local" } }
    } } } }
  const calls = []
  const client = {
    hasAddonSecret: async () => true,
    listAddonModels: async (manifest, options, connection, localOnly) => {
      calls.push({ connection, endpoint: options.endpoint, localOnly })
      return [{ id: "claude-haiku-5-5", name: "" }, { id: "claude-opus-5-5", name: "Claude Opus 5.5" }]
    }
  }
  const settle = () => new Promise(resolve => setImmediate(resolve))
  try {
    renderAddonOptions(client, [entry], new Set(["ai"]))
    const input = document.getElementById("addon_option_ai_model")
    const picker = document.getElementById("addon_option_ai_model_models")
    const button = document.querySelector('[data-testid="addon-option-ai-model-load-models"]')
    assert.equal(button.textContent, "Load models")
    // The endpoint is saved and a token exists for it, so the list loads without a click.
    await settle()
    assert.deepEqual(calls, [{ connection: "anthropic", endpoint: "https://api.anthropic.com/v1/messages", localOnly: true }])
    assert.deepEqual(Array.from(picker.children).map(option => [option.value, option.textContent]),
      [["claude-haiku-5-5", "claude-haiku-5-5"], ["claude-opus-5-5", "claude-opus-5-5 — Claude Opus 5.5"], ["\u0000other", "Other model ID…"]])
    assert.equal(picker.hidden, false)
    assert.match(button.nextSibling.textContent, /2 models listed/)
    // The saved value is not in the list, so the select sits on "Other…" and the text field stays in view.
    assert.equal(picker.value, "\u0000other")
    assert.equal(input.hidden, false)
    // Picking a model writes it into the setting, saves it as typing would, and takes the text field away.
    picker.querySelector('option[value="claude-opus-5-5"]').selected = true
    picker.dispatchEvent(new window.Event("change"))
    await settle()
    assert.equal(input.value, "claude-opus-5-5")
    assert.equal(input.hidden, true)
    assert.equal(readDevAddonOptions("ai").model, "claude-opus-5-5")
    // "Other…" brings the text field back without touching the saved value.
    picker.querySelector('option[value="\u0000other"]').selected = true
    picker.dispatchEvent(new window.Event("change"))
    assert.equal(input.hidden, false)
    assert.equal(readDevAddonOptions("ai").model, "claude-opus-5-5")
    button.click()
    await settle()
    assert.equal(calls.length, 2, "the button asks again")
    // A connection without a model list is said so, without a request.
    const other = document.querySelector('[data-testid="addon-option-ai-other-load-models"]')
    assert.equal(document.getElementById("addon_option_ai_other_models").hidden, true)
    other.click()
    await settle()
    assert.equal(calls.length, 2)
    assert.match(other.nextSibling.textContent, /does not list its models/)
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = previous[name]
    }
  }
})
