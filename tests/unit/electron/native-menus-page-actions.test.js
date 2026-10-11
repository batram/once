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
      if (name === "@once/app/browsingSite") return require("@once/app/browsingSite")
      if (name === "./BrowsingData") return { confirmClearSiteData: async (_window, site) => ran.push({ cleared: site }) }
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
  // A web page's menu always ends with clearing its site's data.
  const CLEAR = ["separator", "Clear Data for a.test…"]
  const labels = () => {
    const all = menu.map(item => item.label ?? item.type)
    return all.at(-1)?.startsWith("Clear Data for ") ? all.slice(0, -2) : all
  }
  const click = label => menu.find(item => item.label === label).click()
  return { menus, owner, shell, contents, params, ran, labels, click, CLEAR, menu: () => menu }
}

test("a page's menu offers each add-on action for the page and, under a link, for the link", () => {
  const h = harness([{ id: "addon:what-wait-who-why/explain", label: "Explain" }])
  h.menus.showContentsMenu(h.owner, h.contents, h.params)
  assert.deepEqual(h.menu().map(item => item.label ?? item.type), ["Inspect", "separator", "Explain", ...h.CLEAR])
  h.click("Explain")
  assert.deepEqual(h.ran, [{ channel: "once:addons:page-action-run", id: "addon:what-wait-who-why/explain", page: { href: "https://a.test/page", title: "Page title" } }])

  h.menus.showContentsMenu(h.owner, h.contents, { ...h.params, linkURL: "https://a.test/link", linkText: "The link" })
  assert.deepEqual(h.labels().slice(-3), ["separator", "Explain", "Explain for Link"])
  h.click("Explain for Link")
  assert.deepEqual(h.ran.at(-1), { channel: "once:addons:page-action-run", id: "addon:what-wait-who-why/explain", page: { href: "https://a.test/link", title: "The link" } })
})

test("a web page's menu clears its whole site, a reader view its source's, and nothing else offers it", () => {
  const h = harness([])
  h.menus.showContentsMenu(h.owner, h.contents, { ...h.params, pageURL: "https://news.example.co.uk/story" })
  h.click("Clear Data for example.co.uk…")
  assert.deepEqual(h.ran.at(-1), { cleared: "example.co.uk" })
  h.menus.showContentsMenu(h.owner, h.contents, { ...h.params, pageURL: "once-reader://https/www.example.com/article" })
  assert.equal(h.menu().at(-1).label, "Clear Data for example.com…")
  h.menus.showContentsMenu(h.owner, h.shell, h.params)
  assert.ok(!h.menu().some(item => item.label?.startsWith("Clear Data")), "the shell's own window")
  h.menus.showContentsMenu(h.owner, h.contents, { ...h.params, pageURL: "about:blank" })
  assert.ok(!h.menu().some(item => item.label?.startsWith("Clear Data")), "a page off the web")
})

test("conditions filter the page and link independently, including reader source URLs", () => {
  const h = harness([{ id: "example.explain", label: "Explain", when: { domain: ["a.test"] } }])
  h.menus.showContentsMenu(h.owner, h.contents, { ...h.params, pageURL: "once-reader://https://a.test/article", linkURL: "https://other.test/" })
  assert.ok(h.labels().includes("Explain"))
  assert.ok(!h.labels().includes("Explain for Link"))
  h.click("Explain")
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
