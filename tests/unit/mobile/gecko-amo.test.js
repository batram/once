const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")
const { parseHTML } = require("linkedom")

const script = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/extensions/once-surface/amo.js"), "utf8")
const settle = () => new Promise(resolve => setImmediate(resolve))
function harness({ reply = async () => ({ extensions: [] }), origin = "https://addons.mozilla.org", top = true } = {}) {
  const { document, window: dom } = parseHTML(`<html><head><script id="redux-store-state" type="application/json">${JSON.stringify({
    addons: { byID: { 1: { slug: "example", guid: "example@test" } } }
  })}</script></head><body><div class="AMInstallButton"><a class="AMInstallButton-button" href="https://addons.mozilla.org/example.xpi">Add to Firefox</a></div></body></html>`)
  const events = new Map()
  const posts = []
  const window = { addEventListener: (type, handler) => events.set(type, handler) }
  window.top = top ? window : {}
  const location = new URL(origin + "/en-US/android/addon/example/")
  vm.runInNewContext(script, {
    window, document, location, MutationObserver: dom.MutationObserver,
    browser: { runtime: { sendNativeMessage: async (name, body) => { posts.push({ name, ...body }); return JSON.stringify(await reply(body)) } } }
  })
  const button = () => document.querySelector(".AMInstallButton-button")
  const activate = async (key) => {
    const event = { type: key ? "keydown" : "click", key, target: button(), prevented: false, stopped: false,
      preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } }
    await events.get(event.type)?.(event)
    return event
  }
  return { document, events, posts, button, activate, location }
}

test("Gecko AMO integration stays in the HTTPS Mozilla top frame", () => {
  for (const options of [{ origin: "https://example.com" }, { origin: "http://addons.mozilla.org" }, { top: false }]) {
    const ui = harness(options)
    assert.equal(ui.button().textContent, "Add to Firefox")
    assert.equal(ui.events.size, 0)
  }
})

test("Android XPI links are relabelled and captured before AMO can launch Firefox", async () => {
  const ui = harness({ reply: async () => ({ extensions: [{ id: "example@test" }] }) })
  assert.equal(ui.button().textContent, "Add to Once")
  assert.equal(ui.button().getAttribute("href"), "#")
  assert.equal(ui.button().getAttribute("role"), "button")
  const event = await ui.activate()
  assert.ok(event.prevented && event.stopped)
  assert.deepEqual(ui.posts, [{ name: "once_amo", action: "install" }])
  assert.equal(ui.button().textContent, "Added to Once")
  assert.equal(ui.button().getAttribute("aria-disabled"), "true")
  await ui.activate()
  assert.equal(ui.posts.length, 1)
})

test("cancelled review is retryable, including keyboard activation", async () => {
  const ui = harness({ reply: async () => ({ cancelled: true }) })
  await ui.activate("Tab")
  assert.equal(ui.posts.length, 0)
  for (const key of ["Enter", " "]) {
    const event = await ui.activate(key)
    assert.ok(event.prevented && event.stopped)
    assert.equal(ui.button().textContent, "Add to Once")
    assert.equal(ui.button().getAttribute("aria-disabled"), "false")
  }
  assert.equal(ui.posts.length, 2)
})

test("download errors remain on the listing and allow retry without duplicate prompts", async () => {
  let reject
  const ui = harness({ reply: () => new Promise((resolve, fail) => { reject = fail }) })
  const install = ui.activate()
  assert.equal(ui.button().textContent, "Adding to Once…")
  await ui.activate()
  assert.equal(ui.posts.length, 1)
  reject(new Error("Not compatible with Android"))
  await install
  assert.equal(ui.button().textContent, "Add to Once")
  assert.match(ui.document.querySelector('[role="alert"]').textContent, /Not compatible with Android/)
})

test("native validation errors retain their explanation across the JSON reply", async () => {
  const ui = harness({ reply: async () => ({ error: "This extension version is not listed as compatible with Firefox for Android" }) })
  await ui.activate()
  assert.match(ui.document.querySelector('[role="alert"]').textContent, /not listed as compatible with Firefox for Android/)
  assert.equal(ui.button().getAttribute("aria-disabled"), "false")
})

test("installed state refreshes after returning from Settings and React cannot restore the XPI link", async () => {
  let extensions = [{ id: "example@test" }]
  const ui = harness({ reply: async () => ({ extensions }) })
  await ui.events.get("pageshow")()
  assert.equal(ui.button().textContent, "Added to Once")
  extensions = []
  await ui.events.get("focus")()
  assert.equal(ui.button().textContent, "Add to Once")
  ui.button().outerHTML = '<a class="AMInstallButton-button" href="intent://firefox">Add to Firefox</a>'
  await settle()
  assert.equal(ui.button().textContent, "Add to Once")
  assert.equal(ui.button().getAttribute("href"), "#")
  ui.button().setAttribute("href", "https://addons.mozilla.org/another.xpi")
  await settle()
  assert.equal(ui.button().getAttribute("href"), "#")
})

test("client-side navigation does not retain another listing's installed state", async () => {
  const ui = harness({ reply: async () => ({ extensions: [{ id: "example@test" }] }) })
  await ui.activate()
  ui.location.pathname = "/en-US/firefox/addon/another/"
  ui.button().textContent = "Add to Firefox"
  await settle()
  assert.equal(ui.button().textContent, "Add to Once")
})
