const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { installRawAssetLoader } = require("../../helpers/raw-assets")

function load() {
  installRawAssetLoader()
  const { window } = parseHTML("<html><body></body></html>")
  globalThis.window = window
  globalThis.document = window.document
  globalThis.DOMParser = window.DOMParser
  globalThis.Element = window.Element
  globalThis.HTMLElement = window.HTMLElement
  return { ...require("../../../packages/ui-web/dist/addons/trayMessages"), window }
}

test("while busy, the status says what the add-on reported early, or Working… when it reported nothing", () => {
  const { renderTrayStatus } = load()
  assert.equal(renderTrayStatus({ messages: [], status: "Fetched article." }, true, "", false).textContent, "Working…")
  assert.equal(renderTrayStatus({ messages: [], status: "Reading the article…" }, true, "", true).textContent, "Reading the article…")
  assert.equal(renderTrayStatus({ messages: [], status: "" }, true, "", true).textContent, "Working…")
  assert.equal(renderTrayStatus({ messages: [], status: "Fetched article." }, false, "", true).textContent, "Fetched article.")
  assert.equal(renderTrayStatus({ messages: [], status: "x" }, false, "It failed", true).textContent, "It failed")
})

test("a fold the reader opened stays open when an earlier section lands late and moves it", () => {
  const { renderTrayMessages, window } = load()
  const disclosed = new Map()
  const explanation = { role: "assistant", text: "The lead." }
  const summary = { role: "assistant", title: "Summary", collapsed: true, text: "- one\n- two" }
  const first = renderTrayMessages({ messages: [explanation, summary] }, disclosed)
  const fold = first[1]
  assert.equal(fold.tagName, "DETAILS")
  assert.equal(fold.hasAttribute("open"), false)
  // The reader opens the summary.
  fold.setAttribute("open", "")
  fold.dispatchEvent(new window.Event("toggle"))
  // The web section arrives and takes the place before the summary.
  const web = { role: "assistant", title: "From the web", text: "- found", sources: [{ title: "[S1] A page", url: "https://example.test/" }] }
  const second = renderTrayMessages({ messages: [explanation, web, summary] }, disclosed)
  const titles = second.filter(element => element.tagName === "DETAILS").map(element => element.querySelector("summary span").textContent)
  assert.deepEqual(titles, ["From the web", "Sources", "Summary"])
  assert.equal(second[1].hasAttribute("open"), true, "an untouched section shows as the add-on asked")
  assert.equal(second[3].hasAttribute("open"), true, "the summary stays open")
  // A second summary later is its own fold, closed as asked.
  const third = renderTrayMessages({ messages: [explanation, web, summary, { role: "user", text: "and?" }, { ...summary, text: "- three" }] }, disclosed)
  const folds = third.filter(element => element.tagName === "DETAILS" && element.querySelector("summary span").textContent === "Summary")
  assert.deepEqual(folds.map(element => element.hasAttribute("open")), [true, false])
})
