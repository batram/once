const test = require("node:test")
const assert = require("node:assert/strict")
const { AddonSandboxSession } = require("../../../packages/ui-web/dist/addons/AddonSandboxSession")
const { SANDBOX_PROTOCOL } = require("../../../packages/core/dist/addons")

const story = (href) => ({
  href, redirectedHref: href, commentUrl: "", title: "T", type: "HN", domain: "example.org",
  timestamp: "", readState: "unread", stared: false, tags: [], substories: [], fields: {}
})

function harness() {
  const sent = []
  const performed = []
  const reports = []
  let destroyed = 0
  const session = new AddonSandboxSession("demo", {
    post: (message) => sent.push(message),
    destroy: () => { destroyed += 1 }
  }, {
    perform: (op) => { performed.push(op) },
    report: (message) => reports.push(message)
  })
  return { session, sent, performed, reports, destroyed: () => destroyed }
}

test("load posts the code and resolves on ready; requests get ids and answers", async () => {
  const { session, sent } = harness()
  const loading = session.load("export default () => {}", { a: 1 })
  assert.deepEqual(sent[0], { type: "load", protocol: SANDBOX_PROTOCOL, addonId: "demo", code: "export default () => {}", settings: { a: 1 } })
  session.receive({ type: "ready", protocol: SANDBOX_PROTOCOL })
  await loading

  const invoked = session.invoke("ping", story("https://example.org/a"))
  const request = sent.at(-1)
  assert.equal(request.type, "invoke")
  assert.equal(request.action, "ping")
  session.receive({ type: "result", requestId: request.requestId, value: 42 })
  assert.equal(await invoked, 42)

  const badges = session.badges("score", [story("https://example.org/a"), story("https://example.org/b")])
  const badgeRequest = sent.at(-1)
  session.receive({ type: "result", requestId: badgeRequest.requestId, value: ["12 pts", 7, "x".repeat(100)] })
  const texts = await badges
  assert.equal(texts.length, 2)
  assert.deepEqual(texts, ["12 pts", ""])
})

test("operations run only for the story of the open request, or badges it computed", async () => {
  const { session, sent, performed, reports } = harness()
  const invoked = session.invoke("ping", story("https://example.org/a"))
  const { requestId } = sent.at(-1)
  session.receive({ type: "op", requestId, op: { name: "openUrl", href: "https://example.org/a", url: "https://x.test/", target: "blank" } })
  session.receive({ type: "op", requestId, op: { name: "openUrl", href: "https://example.org/other", url: "https://x.test/" } })
  session.receive({ type: "op", op: { name: "notify", href: "https://example.org/a", text: "no request" } })
  session.receive({ type: "op", requestId, op: { name: "openUrl", href: "https://example.org/a", url: "javascript:1" } })
  session.receive({ type: "result", requestId, value: null })
  await invoked
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(performed, [{ name: "openUrl", href: "https://example.org/a", url: "https://x.test/", target: "blank" }])
  assert.equal(reports.length, 2)
  assert.match(reports[0], /not asked about/)

  const badges = session.badges("score", [story("https://example.org/c")])
  const badgeRequest = sent.at(-1)
  session.receive({ type: "result", requestId: badgeRequest.requestId, value: [] })
  await badges
  session.receive({ type: "op", op: { name: "updateBadge", href: "https://example.org/c", contribution: "score", text: "later" } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(performed.at(-1), { name: "updateBadge", href: "https://example.org/c", contribution: "score", text: "later" })
})

test("a crash closes the frame, fails what waits, and switches the add-on off after three", async () => {
  const { session, sent, reports, destroyed } = harness()
  for (let attempt = 0; attempt < 3; attempt++) {
    const loading = session.load("code", {})
    const invoked = session.invoke("ping", story("https://example.org/a"))
    session.receive({ type: "error", message: "boom" })
    await assert.rejects(loading, /boom/)
    await assert.rejects(invoked, /closed/)
    assert.equal(destroyed(), attempt + 1)
  }
  assert.equal(session.disabled, true)
  await assert.rejects(session.invoke("ping", story("https://example.org/a")), /switched off/)
  assert.equal(reports.filter((line) => /boom/.test(line)).length, 3)
  assert.ok(sent.length > 0)
})

test("fetch and storage operations run without a story and get their answer posted back", async () => {
  const sent = []
  const session = new AddonSandboxSession("demo", { post: (m) => sent.push(m), destroy: () => {} }, {
    perform: async (op) => {
      if (op.name === "fetch") return { status: 200, text: "body of " + op.url }
      if (op.name === "storage.get") return 42
      throw new Error("refused")
    },
    report: () => {}
  })
  session.receive({ type: "op", opId: 1, op: { name: "fetch", url: "https://api.example/x" } })
  session.receive({ type: "op", opId: 2, op: { name: "storage.get", key: "count" } })
  session.receive({ type: "op", opId: 3, op: { name: "storage.set", key: "count", value: 1 } })
  await new Promise((resolve) => setImmediate(resolve))
  const results = sent.filter((m) => m.type === "opResult").sort((a, b) => a.opId - b.opId)
  assert.deepEqual(results, [
    { type: "opResult", opId: 1, ok: true, value: { status: 200, text: "body of https://api.example/x" } },
    { type: "opResult", opId: 2, ok: true, value: 42 },
    { type: "opResult", opId: 3, ok: false, error: "refused" }
  ])
  // A story operation with an opId outside any request is refused with an answer, not silence.
  session.receive({ type: "op", opId: 4, op: { name: "notify", href: "https://a/", text: "hi" } })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(sent.at(-1), { type: "opResult", opId: 4, ok: false, error: "not allowed for this story" })
})

test("malformed messages are ignored", async () => {
  const { session, performed, reports } = harness()
  for (const junk of [null, "x", {}, { type: "op", op: { name: "openUrl", href: "ftp://x", url: "https://x/" } }, { type: "result" }]) {
    session.receive(junk)
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(performed, [])
  assert.deepEqual(reports, [])
})
