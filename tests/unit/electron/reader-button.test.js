const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

const source = (file) => path.resolve(__dirname, "../../../apps/electron/src", file)

/** Transpiles one shell module; `modules` answers its relative imports. */
function load(file, modules = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(source(file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  Function("exports", "require", compiled)(module.exports, (name) => {
    if (modules[name]) return modules[name]
    throw Error(`unexpected import ${name}`)
  })
  return module.exports
}

const readerUrl = load("browser/reader-url.ts")
const { bindReaderButton } = load("browser/ReaderButton.ts", { "./reader-url": readerUrl })
const { ReaderRequests } = load("ReaderRequests.ts")

const PAGE = "https://example.com/article"
const READER = `once-reader://${"0123456789abcdef".repeat(2)}/${PAGE}`

function shell(url) {
  const calls = []
  const button = { disabled: false }
  const requests = {
    start: (tabId, target) => calls.push(["start", tabId, target]),
    openBeside: (target) => calls.push(["openBeside", target]),
    cancel: (tabId) => calls.push(["cancel", tabId])
  }
  const bridge = { tabs: {
    openUrl: async (target, disposition) => calls.push(["openUrl", target, disposition]),
    navigate: async (tabId, target) => calls.push(["navigate", tabId, target])
  } }
  bindReaderButton(button, { bridge, requests, active: () => ({ id: "t1", url }), setError: () => {} })
  const event = (fields) => ({ button: 0, ctrlKey: false, metaKey: false, preventDefault() { this.prevented = true }, ...fields })
  return { button, calls, event }
}

test("a plain click reads the page in its own tab; Ctrl, Cmd and middle click open the reader beside it", () => {
  const plain = shell(PAGE)
  plain.button.onclick(plain.event({}))
  assert.deepEqual(plain.calls, [["start", "t1", PAGE]])

  for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
    const beside = shell(PAGE)
    beside.button.onclick(beside.event(modifier))
    assert.deepEqual(beside.calls, [["openBeside", PAGE]])
  }

  const middle = shell(PAGE)
  const press = middle.event({ button: 1 })
  middle.button.onmousedown(press)
  assert.equal(press.prevented, true, "a middle press does not start autoscroll")
  const release = middle.event({ button: 1 })
  middle.button.onauxclick(release)
  assert.equal(release.prevented, true)
  assert.deepEqual(middle.calls, [["openBeside", PAGE]])
  middle.button.onauxclick(middle.event({ button: 2 }))
  assert.equal(middle.calls.length, 1, "a right click is not a middle click")

  const disabled = shell(PAGE)
  disabled.button.disabled = true
  disabled.button.onauxclick(disabled.event({ button: 1 }))
  assert.deepEqual(disabled.calls, [], "a disabled button ignores the middle click it still receives")
})

test("from the reader, a click returns to the page and Ctrl or middle click opens the page beside it", () => {
  const back = shell(READER)
  back.button.onclick(back.event({}))
  assert.deepEqual(back.calls, [["cancel", "t1"], ["navigate", "t1", PAGE]])

  const beside = shell(READER)
  beside.button.onauxclick(beside.event({ button: 1 }))
  assert.deepEqual(beside.calls, [["openUrl", PAGE, "middle"]])
})

test("a reader opened beside the page arrives even after its tab moved on, and a failure opens beside too", async () => {
  const opened = []
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
  const host = {
    hasTab: () => false,
    deliver: async () => assert.fail("nothing in a tab is replaced"),
    fail: () => assert.fail("no tab shows the failure"),
    openBeside: async (html, sourceUrl) => opened.push(["reader", html, sourceUrl]),
    failBeside: async (url, error) => opened.push(["error", url, error.message]),
    changed: () => {}
  }
  const requests = new ReaderRequests(async (url, deliver) => {
    if (url.endsWith("/broken")) throw new Error("HTTP 403")
    await deliver("<article>Read</article>", url)
  }, host)
  requests.openBeside(PAGE)
  requests.openBeside("https://example.com/broken")
  await settle()
  assert.deepEqual(opened, [["reader", "<article>Read</article>", PAGE], ["error", "https://example.com/broken", "HTTP 403"]])
  assert.equal(requests.isPending("t1"), false, "a reader beside the page holds no tab's request")
})
