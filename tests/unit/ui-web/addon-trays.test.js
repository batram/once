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
  const previousCustomEvent = global.CustomEvent
  const { document, CustomEvent } = parseHTML("<html><body></body></html>")
  global.document = document
  global.CustomEvent = CustomEvent
  const { AddonTrays } = require("../../../packages/ui-web/dist/addons/AddonTrays")
  const { applyStoryElements, refreshRowElements, renderStoryTrays, STORY_TRAYS_CHANGED } = require("../../../packages/ui-web/dist/story/storyElements")
  let calls = 0
  let currentRow
  const reading = document.createElement("div")
  document.addEventListener(STORY_TRAYS_CHANGED, () => {
    if (currentRow) renderStoryTrays(currentRow, reading)
  })
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
    currentRow = row
    trays.toggle(row, "assistant")
    await new Promise(resolve => setImmediate(resolve))
    assert.match(row.querySelector(".addon_tray_message").textContent, /<b>Safe text<\/b>/)
    assert.equal(row.querySelector(".addon_tray_assistant strong").textContent, "Formatted answer")
    assert.equal(row.querySelector(".addon_tray_user").textContent, "**Literal question**")
    assert.equal(row.querySelector(".addon_tray_user strong"), null)
    assert.equal(row.querySelector("b"), null)
    assert.match(reading.textContent, /Formatted answer/)
    refreshRowElements(row)
    assert.equal(row.querySelectorAll(".addon_tray").length, 1)
    row.remove()
    const replacement = makeRow()
    currentRow = replacement
    applyStoryElements(replacement)
    assert.equal(replacement.querySelectorAll(".addon_tray").length, 1)
    trays.toggle(replacement, "assistant")
    assert.equal(replacement.querySelectorAll(".addon_tray").length, 0)
    assert.equal(reading.childElementCount, 0)
    trays.toggle(replacement, "assistant")
    assert.equal(calls, 1)
    trays.reset()
    assert.equal(replacement.querySelectorAll(".addon_tray").length, 0)
    assert.equal(reading.childElementCount, 0)
  } finally { trays.dispose(); global.document = previous; global.CustomEvent = previousCustomEvent }
})

test("the open story's mirror row shares the conversation but opens its tray on its own", async () => {
  const previous = global.document
  const previousCustomEvent = global.CustomEvent
  const { document, CustomEvent } = parseHTML('<html><body><div id="selected_container"></div><div id="stories"></div></body></html>')
  global.document = document
  global.CustomEvent = CustomEvent
  const { AddonTrays } = require("../../../packages/ui-web/dist/addons/AddonTrays")
  let calls = 0
  const trays = new AddonTrays({ id: "example", trays: [{ id: "assistant", title: "Assistant" }] }, {
    ensure: async () => ({ tray: async () => { calls++; return { messages: [{ role: "assistant", text: "Shared answer" }] } } })
  })
  const makeRow = host => {
    const row = document.createElement("story-item")
    row.story = { href: "https://story.test/", title: "Title", type: "HN" }
    host.append(row)
    return row
  }
  const listed = makeRow(document.querySelector("#stories"))
  const mirrored = makeRow(document.querySelector("#selected_container"))
  try {
    trays.toggle(listed, "assistant")
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(listed.querySelectorAll(".addon_tray").length, 1)
    assert.equal(mirrored.querySelectorAll(".addon_tray").length, 0)
    assert.equal(trays.expanded(listed, "assistant"), true)
    assert.equal(trays.expanded(mirrored, "assistant"), false)
    // Opening the mirror reuses the answer already there: no second request.
    trays.toggle(mirrored, "assistant")
    assert.match(mirrored.querySelector(".addon_tray_message").textContent, /Shared answer/)
    assert.equal(calls, 1)
    mirrored.querySelector('button[aria-label="Close"]').click()
    assert.equal(mirrored.querySelectorAll(".addon_tray").length, 0)
    assert.equal(listed.querySelectorAll(".addon_tray").length, 1)
  } finally { trays.dispose(); global.document = previous; global.CustomEvent = previousCustomEvent }
})

test("titled messages fold behind disclosures whose state outlives a redraw and ends with the conversation", async () => {
  const previous = global.document
  const previousCustomEvent = global.CustomEvent
  const { document, CustomEvent, Event } = parseHTML("<html><body></body></html>")
  global.document = document
  global.CustomEvent = CustomEvent
  const { AddonTrays } = require("../../../packages/ui-web/dist/addons/AddonTrays")
  const { refreshRowElements } = require("../../../packages/ui-web/dist/story/storyElements")
  const messages = [
    { role: "assistant", text: "The answer." },
    { role: "assistant", title: "Key entities", collapsed: true, text: "- **Entity**", sources: [{ title: "Source", url: "https://source.test/" }] },
    { role: "assistant", title: "Summary", text: "Open by default." }
  ]
  const trays = new AddonTrays({ id: "example", trays: [{ id: "assistant", title: "Assistant" }] }, {
    ensure: async () => ({ tray: async (_tray, event) => ({ messages: event.type === "clear" ? [] : messages }) })
  })
  const row = document.createElement("story-item")
  row.story = { href: "https://story.test/", title: "Title", type: "HN" }
  document.body.append(row)
  try {
    trays.toggle(row, "assistant")
    await new Promise(resolve => setImmediate(resolve))
    const folds = () => Array.from(row.querySelectorAll("details.addon_tray_disclosure"))
    assert.deepEqual(folds().map(fold => [fold.querySelector("summary").textContent, fold.hasAttribute("open")]), [["Key entities", false], ["Summary", true]])
    assert.equal(folds()[0].querySelector(".addon_tray_disclosure_body .addon_tray_source").textContent, "Source")
    assert.equal(folds()[0].querySelector("strong").textContent, "Entity")
    assert.equal(row.querySelectorAll(".addon_tray_message").length, 3)
    folds()[0].setAttribute("open", "")
    folds()[0].dispatchEvent(new Event("toggle"))
    refreshRowElements(row)
    assert.deepEqual(folds().map(fold => fold.hasAttribute("open")), [true, true])
    row.querySelector(".addon_tray_controls button:last-child").click()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(folds().length, 0)
    trays.toggle(row, "assistant")
    trays.toggle(row, "assistant")
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(folds().map(fold => fold.hasAttribute("open")), [false, true])
  } finally { trays.dispose(); global.document = previous; global.CustomEvent = previousCustomEvent }
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
