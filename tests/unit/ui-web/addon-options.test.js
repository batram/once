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
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) Reflect.deleteProperty(globalThis, name)
      else globalThis[name] = previous[name]
    }
  }
})
