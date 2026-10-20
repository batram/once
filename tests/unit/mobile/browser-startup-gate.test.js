const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const exportsObject = {}
const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/src/browserStartupGate.ts"), "utf8")
Function("exports", ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText)(exportsObject)
const { gateBrowserStartup } = exportsObject

function surface(calls = []) {
  return {
    calls,
    open: async options => { calls.push(["open", options]) },
    navigate: async url => { calls.push(["navigate", url]) },
    close: async () => { calls.push(["close"]) },
    setBounds: async () => {},
    setVisible: async () => {},
    forTab: () => surface(calls)
  }
}

test("each tab waits for initial protection while shell layout remains usable", async () => {
  const host = surface()
  const gate = gateBrowserStartup(host)
  const tab = host.forTab({ tabId: "one", generation: "one" })
  const opening = tab.open({ url: "https://example.test", bounds: { width: 100 }, visible: true })
  await tab.setBounds({ width: 320 })
  await tab.setVisible(false)
  assert.deepEqual(host.calls, [])
  gate.release()
  await opening
  assert.deepEqual(host.calls, [["open", { url: "https://example.test", bounds: { width: 320 }, visible: false }]])
})

test("a closed tab and superseded navigation never open after startup", async () => {
  const host = surface()
  const gate = gateBrowserStartup(host)
  const closed = host.forTab({ tabId: "closed" })
  const active = host.forTab({ tabId: "active" })
  const pending = [
    closed.open({ url: "https://closed.test" }),
    active.open({ url: "https://stale.test" }),
    active.navigate("https://latest.test")
  ]
  await closed.close()
  gate.release()
  await Promise.all(pending)
  assert.deepEqual(host.calls, [["close"], ["navigate", "https://latest.test"]])
})

test("failed initialization rejects queued navigation rather than opening unprotected", async () => {
  const host = surface()
  const gate = gateBrowserStartup(host)
  const pending = host.navigate("https://example.test")
  gate.fail(new Error("initial settings failed"))
  await assert.rejects(pending, /initial settings failed/)
  assert.deepEqual(host.calls, [])
})

test("closing cancels old work without preventing the surface from being reused", async () => {
  const host = surface()
  const gate = gateBrowserStartup(host)
  const old = host.navigate("https://old.test")
  await host.close()
  const next = host.navigate("https://new.test")
  gate.release()
  await Promise.all([old, next])
  assert.deepEqual(host.calls, [["close"], ["navigate", "https://new.test"]])
})
