const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

function harness(pageActions) {
  let menu
  const ran = []
  const load = file => {
    const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../../apps/electron/src/browser", file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const module = { exports: {} }
    Function("exports", "require", compiled)(module.exports, name => {
      if (name === "./PageActions") return pageActionsModule
      if (name === "./reader-url") return load("reader-url.ts")
      if (name === "@once/core") return require("@once/core")
      if (name === "@once/platform-electron/bridge") return { ELECTRON_IPC: { addonsPageActionRun: "once:addons:page-action-run" } }
      if (name !== "electron") return {}
      return {
        Menu: { buildFromTemplate: template => { menu = template; return { popup() {} } } },
        clipboard: { writeText() {} },
        shell: { openExternal() {} }
      }
    })
    return module.exports
  }
  const pageActionsModule = load("PageActions.ts")
  const shell = { isDestroyed: () => false, send: (channel, id, page) => ran.push({ channel, id, page }) }
  const owner = { window: { isDestroyed: () => false, webContents: shell } }
  const menus = new (load("NativeMenus.ts").NativeMenus)({
    normalizeUrl: url => url || null,
    createTab: async () => "tab",
    createWindow: async () => {}
  })
  menus.pageActions.set(owner, pageActions)
  const contents = { isDestroyed: () => false, getTitle: () => "Page title" }
  const params = { x: 1, y: 1, isEditable: false, selectionText: "", linkURL: "", linkText: "", pageURL: "https://a.test/page", editFlags: {} }
  const labels = () => menu.map(item => item.label ?? item.type)
  return { menus, owner, shell, contents, params, ran, labels, menu: () => menu }
}

test("a page's menu offers each add-on action for the page and, under a link, for the link", () => {
  const h = harness([{ id: "addon:what-wait-who-why/explain", label: "Explain" }])
  h.menus.showContentsMenu(h.owner, h.contents, h.params)
  assert.deepEqual(h.labels(), ["Inspect", "separator", "Explain"])
  h.menu().at(-1).click()
  assert.deepEqual(h.ran, [{ channel: "once:addons:page-action-run", id: "addon:what-wait-who-why/explain", page: { href: "https://a.test/page", title: "Page title" } }])

  h.menus.showContentsMenu(h.owner, h.contents, { ...h.params, linkURL: "https://a.test/link", linkText: "The link" })
  assert.deepEqual(h.labels().slice(-3), ["separator", "Explain", "Explain for Link"])
  h.menu().at(-1).click()
  assert.deepEqual(h.ran.at(-1), { channel: "once:addons:page-action-run", id: "addon:what-wait-who-why/explain", page: { href: "https://a.test/link", title: "The link" } })
})

test("conditions filter the page and link independently, including reader source URLs", () => {
  const h = harness([{ id: "example.explain", label: "Explain", when: { domain: ["a.test"] } }])
  h.menus.showContentsMenu(h.owner, h.contents, { ...h.params, pageURL: "once-reader://https://a.test/article", linkURL: "https://other.test/" })
  assert.ok(h.labels().includes("Explain"))
  assert.ok(!h.labels().includes("Explain for Link"))
  h.menu().at(-1).click()
  assert.equal(h.ran.at(-1).page.href, "https://a.test/article")
  h.menus.showContentsMenu(h.owner, h.contents, { ...h.params, pageURL: "https://other.test/", linkURL: "https://a.test/link" })
  assert.ok(!h.labels().includes("Explain"))
  assert.ok(h.labels().includes("Explain for Link"))
  h.menus.pageActions.set(h.owner, [{ id: "broken", label: "Broken", when: { domain: "not a list" } }])
  h.menus.showContentsMenu(h.owner, h.contents, h.params)
  assert.deepEqual(h.labels(), ["Inspect"])
})

test("no add-on items for the shell's own window, a non-web page, malformed actions, or none at all", () => {
  const h = harness([{ id: "example.explain", label: "Explain" }, { id: "bad id!", label: "x" }, { id: "blank", label: "  " }, "junk"])
  h.menus.showContentsMenu(h.owner, h.shell, h.params)
  assert.deepEqual(h.labels(), ["Inspect"])
  h.menus.showContentsMenu(h.owner, h.contents, { ...h.params, pageURL: "about:blank" })
  assert.deepEqual(h.labels(), ["Inspect"])
  // Synthetic menu params (the e2e harness emits them) may carry no page URL at all.
  h.menus.showContentsMenu(h.owner, h.contents, { ...h.params, pageURL: undefined })
  assert.deepEqual(h.labels(), ["Inspect"])
  const none = harness([])
  none.menus.showContentsMenu(none.owner, none.contents, none.params)
  assert.deepEqual(none.labels(), ["Inspect"])
})
