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
    button("Restore default").click()
    await settle()
    assert.equal(prompt.value, "Packaged prompt")
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
      ["shadowed", { kind: "shadowed", directory: "C:\\work\\shadowed", useFolder: async () => calls.push("use"), replace: async () => calls.push("replace") }]
    ])
    const plain = { enabled: true, manifest: { id: "shadowed", name: "Shadowed" } }
    const fromUrl = { enabled: true, manifest: { id: "remote", name: "Remote" }, source: { url: "https://example.org/once-addon.json" } }
    renderAddonOptions(client, [entry, plain, fromUrl], new Set(["dev-example"]), controls)
    const cardOf = id => document.querySelector(`[data-addon="${id}"] .addon_source`)
    assert.match(cardOf("dev-example").textContent, /linked folder on this device/)
    assert.equal(cardOf("dev-example").querySelector(".addon_source_path").textContent, "C:\\work\\example")
    assert.equal(document.querySelector('[data-addon="dev-example"]').dataset.addonOrigin, "Linked folder · This device")
    assert.ok(cardOf("shadowed").classList.contains("addon_source--attention"))
    assert.match(cardOf("shadowed").textContent, /being ignored/)
    assert.equal(document.querySelector('[data-addon="shadowed"]').dataset.addonOrigin, "Installed · Linked folder not in use")
    assert.equal(cardOf("remote").querySelector(".addon_source_path").textContent, "https://example.org/once-addon.json")
    assert.equal(button("Use this version on my devices"), undefined)
    button("Install this version").click()
    button("Use the folder instead").click()
    button("Update installed copy from folder").click()
    await settle()
    assert.deepEqual(calls, ["install", "use", "replace"])
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
