const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

test("toolbar and unpinned tools follow conditions across navigation and reader mode", async () => {
  const { document, Event } = parseHTML("<html><body><div id='toolbar'></div></body></html>")
  const previous = { document: global.document, Event: global.Event }
  Object.assign(global, { document, Event })
  const page = require("../../../packages/ui-web/dist/addons/pageAddons")
  const load = file => {
    const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../../apps/electron/src/browser", file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const exports = {}
    Function("exports", "require", "document", code)(exports, name => {
      if (name === "@once/ui-web") return page
      if (name === "./reader-url") return load("reader-url.ts")
      if (name === "../ExtensionToolbar") return {
        TOOLBAR_PINS_CHANGED: "pins", isToolPinned: () => true, bindUnpinMenu() {}, shellIconData: async () => null
      }
      return {}
    }, document)
    return exports
  }
  const ran = []
  const release = page.registerPageAction({ id: "generic.explain", label: "Explain", surfaces: ["button", "menu"],
    when: { domain: ["example.test"] }, appliesTo: target => new URL(target.href).hostname === "example.test",
    run: target => { ran.push(target.href); return true } })
  try {
    let sent
    const host = document.getElementById("toolbar")
    const toolbar = new (load("PageAddonActions.ts").PageAddonActions)({ addons: { pageActions: {
      set: async items => { sent = items }, onRun() {}
    } } }, host)
    const button = host.querySelector("button")
    assert.deepEqual(sent[0].when, { domain: ["example.test"] })
    toolbar.setTab({ url: "https://other.test/", title: "Other" })
    assert.equal(button.disabled, true)
    assert.equal((await toolbar.tools())[0].enabled, false)
    toolbar.setTab({ url: "once-reader://https://example.test/article", title: "Article" })
    assert.equal(button.disabled, false)
    assert.equal((await toolbar.tools())[0].enabled, true)
    button.click()
    toolbar.run("addon:generic.explain")
    assert.deepEqual(ran, ["https://example.test/article", "https://example.test/article"])
    toolbar.setTab({ url: "about:blank" })
    assert.equal(button.disabled, true)
  } finally { release(); Object.assign(global, previous) }
})
