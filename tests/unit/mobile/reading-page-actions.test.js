const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

test("mobile menu actions render for direct, comments, redirected and unlisted pages", async () => {
  const { document, Event, CustomEvent } = parseHTML("<html><body></body></html>")
  const previous = { document: global.document, Event: global.Event, CustomEvent: global.CustomEvent }
  Object.assign(global, { document, Event, CustomEvent })
  const ui = { ...require("../../../packages/ui-web/dist/addons/pageAddons"), ...require("../../../packages/ui-web/dist/story/storyElements") }
  const { AddonTrays } = require("../../../packages/ui-web/dist/addons/AddonTrays")
  const load = file => {
    const code = ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/src", file), "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    }).outputText
    const exports = {}
    // Sending to another device has nothing to offer without tab sync.
    Function("exports", "require", code)(exports, () => ({ ...ui, sendPageItems: () => [], runSendItem: () => false }))
    return exports
  }
  const content = document.createElement("div")
  document.body.append(content)
  const reading = new (load("readingAddonTrays.ts").ReadingAddonTrays)(content, () => {})
  const row = document.createElement("story-item")
  row.story = { href: "https://article.test/", comment_url: "https://forum.test/comments", title: "Listed", type: "HN" }
  row.dataset.redirected_url = "https://mirror.test/"
  document.body.append(row)
  let currentUrl = ""
  const actions = load("readingPageActions.ts").readingPageActions({ session: { snapshot: () => ({ currentUrl }) }, tabs: { activeId: null } })
  const trays = new AddonTrays({ id: "generic", trays: [{ id: "assistant", title: "Assistant" }] }, {
    ensure: async () => ({ tray: async () => ({ messages: [{ role: "assistant", text: "Ready" }] }) })
  })
  const release = ui.registerPageAction({ id: "generic.explain", label: "Explain", surfaces: ["menu"], appliesTo: () => true,
    run: target => { trays.togglePage(target, "assistant"); return true } })
  try {
    for (const [href, story] of [[row.story.href, null], [row.story.comment_url, row], [row.dataset.redirected_url, row], ["https://unlisted.test/", null]]) {
      currentUrl = href
      reading.setStory(story)
      reading.setPage(href)
      assert.equal(actions.list().length, 1)
      actions.run("generic.explain")
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(content.firstChild.hidden, false, href)
      assert.match(content.textContent, /Ready/)
      assert.equal(reading.close(), true)
      assert.equal(content.firstChild.hidden, true)
    }
    reading.setPage(row.story.href)
    trays.toggle(row, "assistant")
    trays.togglePage({ href: row.story.href }, "assistant")
    reading.close()
    assert.equal(content.firstChild.hidden, true, "Back closes both a row and page view")
  } finally { release(); trays.dispose(); Object.assign(global, previous) }
})
