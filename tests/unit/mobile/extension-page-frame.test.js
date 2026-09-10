const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

// The frame is shell DOM below the active panel's header; the native host only
// receives the rectangle under the bar, so the app keeps its own chrome.
test("extension page frame follows native state and reports the rectangle under its bar", async () => {
  const { window, document } = parseHTML(`<html><body>
    <div id="left_panel" active_panel="settings">
      <div class="panel" data-panel="settings"><div class="bar">Settings</div></div>
      <div class="panel" data-panel="reading"><form id="reading_url_form"></form></div>
    </div></body></html>`)
  const rects = new Map([
    ["settings", { left: 0, top: 0, width: 400, height: 700, bottom: 700 }],
    ["bar", { left: 0, top: 0, width: 400, height: 40, bottom: 40 }],
    ["extension_page_bar", { left: 0, top: 40, width: 400, height: 52, bottom: 92 }]
  ])
  for (const element of document.querySelectorAll("*")) {
    element.getBoundingClientRect = () => rects.get(element.className || element.dataset?.panel || element.id) ??
      rects.get(element.getAttribute("data-panel")) ?? { left: 0, top: 0, width: 0, height: 0, bottom: 0 }
  }
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/mobile/src/extensionPageFrame.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  class ResizeObserver { observe() {} }
  class MutationObserver { observe() {} }
  const commands = []
  let listener
  const surface = {
    extensionPage: async command => { commands.push(command) },
    addListener: async (event, callback) => { assert.equal(event, "extensionPageChanged"); listener = callback; return () => {} }
  }
  const opens = []
  Function("exports", "document", "window", "ResizeObserver", "MutationObserver", "requestAnimationFrame", compiled)(
    exports, document, window, ResizeObserver, MutationObserver, callback => callback())
  const frame = exports.bindExtensionPageFrame(surface, open => opens.push(open))
  await new Promise(resolve => setTimeout(resolve, 0))
  const element = document.querySelector("#extension_page_frame")
  element.querySelector(".extension_page_bar").getBoundingClientRect = () => rects.get("extension_page_bar")
  assert.equal(element.hidden, true)
  assert.equal(await frame.close(), false, "nothing to close while no page is open")

  listener({ open: true, popup: false, title: "uBlock Origin", status: "Loading…", count: 1 })
  assert.equal(element.hidden, false)
  assert.deepEqual(opens, [true])
  assert.equal(element.querySelector(".extension_page_title").textContent, "uBlock Origin")
  assert.equal(element.querySelector(".extension_page_status").textContent, "Loading…")
  assert.equal(element.querySelector(".extension_page_close").getAttribute("aria-label"), "Close uBlock Origin")
  assert.equal(element.style.top, "40px", "the frame starts under the settings title bar")
  assert.deepEqual(commands.at(-1), { action: "bounds", bounds: { x: 0, y: 92, width: 400, height: 608 } })

  element.querySelector(".extension_page_reload").onclick()
  assert.deepEqual(commands.at(-1), { action: "reload" })
  assert.equal(await frame.close(), true)
  assert.deepEqual(commands.at(-1), { action: "close" })
  listener({ open: false, popup: false, title: "", status: "", count: 0 })
  assert.equal(element.hidden, true)
  assert.deepEqual(opens, [true, false])
})
