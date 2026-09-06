const test = require("node:test")
const assert = require("node:assert/strict")
const { parseHTML } = require("linkedom")
const { AddonSandboxSession } = require("../../../packages/ui-web/dist/addons/AddonSandboxSession")

test("concurrent tray operations are scoped, cancellation aborts host work and ignores late results", async () => {
  const sent = [], performed = []
  const session = new AddonSandboxSession("example", { post: message => sent.push(message), destroy() {} }, {
    perform: (op, signal) => { performed.push({ op, signal }); return "content" }, report() {}
  })
  const first = new AbortController(), second = new AbortController()
  const one = session.tray("assistant", { type: "open" }, { href: "https://one.test/" }, first.signal)
  const oneId = sent.at(-1).requestId
  const two = session.tray("assistant", { type: "open" }, { href: "https://two.test/" }, second.signal)
  const twoId = sent.at(-1).requestId
  await assert.rejects(session.tray("assistant", { type: "open" }, { href: "https://three.test/" }, new AbortController().signal), /Two addon requests/)
  session.receive({ type: "op", requestId: oneId, opId: 1, op: { name: "story.content", href: "https://two.test/" } })
  session.receive({ type: "op", requestId: twoId, opId: 2, op: { name: "story.content", href: "https://two.test/" } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(performed.length, 1)
  second.abort()
  await assert.rejects(two, /cancelled/)
  assert.equal(performed[0].signal.aborted, true)
  session.receive({ type: "result", requestId: twoId, value: "late" })
  session.receive({ type: "op", requestId: twoId, opId: 3, op: { name: "request", connection: "provider", request: {}, href: "" } })
  session.receive({ type: "result", requestId: oneId, value: "first result" })
  assert.equal(await one, "first result")
  assert.equal(performed.length, 1)
  session.dispose()
})

test("tray state survives row replacement, collapse and reopen without a second request", async () => {
  const previous = global.document
  const { document } = parseHTML("<html><body></body></html>")
  global.document = document
  const { AddonTrays } = require("../../../packages/ui-web/dist/addons/AddonTrays")
  const { applyStoryElements, refreshRowElements } = require("../../../packages/ui-web/dist/story/storyElements")
  let calls = 0
  const trays = new AddonTrays({ id: "example", trays: [{ id: "assistant", title: "Assistant" }] }, {
    ensure: async () => ({ tray: async () => { calls++; return { messages: [
      { role: "assistant", text: "<b>Safe text</b>\n\n**Formatted answer**" },
      { role: "user", text: "**Literal question**" }
    ], composer: "Question" } } })
  })
  const makeRow = () => {
    const row = document.createElement("story-item")
    row.story = { href: "https://story.test/", title: "Title", type: "HN" }
    document.body.append(row)
    return row
  }
  try {
    const row = makeRow()
    trays.toggle(row, "assistant")
    await new Promise(resolve => setImmediate(resolve))
    assert.match(row.querySelector(".addon_tray_message").textContent, /<b>Safe text<\/b>/)
    assert.equal(row.querySelector(".addon_tray_assistant strong").textContent, "Formatted answer")
    assert.equal(row.querySelector(".addon_tray_user").textContent, "**Literal question**")
    assert.equal(row.querySelector(".addon_tray_user strong"), null)
    assert.equal(row.querySelector("b"), null)
    refreshRowElements(row)
    assert.equal(row.querySelectorAll(".addon_tray").length, 1)
    row.remove()
    const replacement = makeRow()
    applyStoryElements(replacement)
    assert.equal(replacement.querySelectorAll(".addon_tray").length, 1)
    trays.toggle(replacement, "assistant")
    assert.equal(replacement.querySelectorAll(".addon_tray").length, 0)
    trays.toggle(replacement, "assistant")
    assert.equal(calls, 1)
    trays.reset()
    assert.equal(replacement.querySelectorAll(".addon_tray").length, 0)
  } finally { trays.dispose(); global.document = previous }
})

test("standalone declared connections are limited and settings cancel pending work", async () => {
  const sent = [], running = []
  const session = new AddonSandboxSession("example", { post: message => sent.push(message), destroy() {} }, {
    perform: (_op, signal) => new Promise(resolve => running.push({ signal, resolve })), report() {}
  })
  const op = { name: "request", connection: "provider", request: { method: "GET" }, href: "" }
  for (let opId = 1; opId <= 3; opId++) session.receive({ type: "op", opId, op })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(running.length, 2)
  assert.equal(sent.find(message => message.opId === 3).ok, false)
  session.settings({})
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(running.every(request => request.signal.aborted))
  for (const request of running) request.resolve("late")
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(sent.filter(message => message.type === "opResult").every(message => !message.ok))
  session.dispose()
})
