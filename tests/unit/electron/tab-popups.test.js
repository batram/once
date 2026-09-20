const test = require("node:test")
const assert = require("node:assert/strict")
const { EventEmitter } = require("node:events")
const fs = require("node:fs")
const path = require("node:path")
const ts = require("typescript")

function harness() {
  let time = 0
  let menu
  const created = []
  const loaded = []
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/electron/src/browser/TabPopups.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  Function("exports", "require", compiled)(module.exports, name => {
    assert.equal(name, "electron")
    return { Menu: { buildFromTemplate: template => { menu = template; return { popup() {} } } } }
  })
  const contents = new EventEmitter()
  contents.setWindowOpenHandler = handler => { contents.open = handler }
  contents.isDestroyed = () => false
  const owner = { window: { isDestroyed: () => false } }
  const entry = { view: { webContents: contents } }
  const policy = new module.exports.TabPopups({
    ownerFor: () => owner,
    notify() {},
    normalizeUrl: url => { if (!/^https?:/.test(url)) throw Error("Unsupported"); return url },
    createPopup: (...params) => {
      created.push(params)
      return { loadURL: async (...params) => { loaded.push(params) } }
    }
  }, () => time)
  policy.bind(entry)
  const request = { url: "https://example.test/sample", frameName: "sample", features: "",
    disposition: "new-window", referrer: { url: "https://example.test/", policy: "default" } }
  return { contents, entry, policy, request, created, loaded,
    mouse: type => contents.emit("before-mouse-event", {}, { type }),
    key: (key, extra = {}, event = {}) => policy.keyDown(entry, event, { type: "keyDown", key, ...extra }),
    advance: amount => { time += amount },
    menu: () => { policy.showBlocked(entry, { x: 1, y: 1 }); return menu }
  }
}

test("blocks automatic popups, but permits one popup per mouse activation", () => {
  const h = harness()
  assert.equal(h.contents.open(h.request).action, "deny")
  h.mouse("mouseMove")
  assert.equal(h.contents.open(h.request).action, "deny")
  h.mouse("mouseDown")
  const allowed = h.contents.open(h.request)
  assert.equal(allowed.action, "allow")
  const options = { webPreferences: { sandbox: true } }
  allowed.createWindow(options)
  assert.equal(h.created[0][3], options)
  assert.equal(h.contents.open(h.request).action, "deny")
  h.mouse("mouseUp")
  assert.equal(h.contents.open(h.request).action, "deny")
})

test("activation expires and does not survive navigation", () => {
  const h = harness()
  h.mouse("mouseDown")
  h.advance(5000)
  assert.equal(h.contents.open(h.request).action, "deny")
  h.mouse("mouseDown")
  h.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
  assert.equal(h.entry.blockedPopups.length, 0)
  assert.equal(h.contents.open(h.request).action, "deny")
})

test("keyboard activation excludes shell shortcuts, modifiers and repeats", () => {
  const h = harness()
  for (const [key, extra, event] of [
    ["Escape"], ["Shift"], ["l", { control: true }, { defaultPrevented: true }], ["Enter", { isAutoRepeat: true }],
    ["Enter", {}, { defaultPrevented: true }]
  ]) {
    h.key(key, extra, event)
    assert.equal(h.contents.open(h.request).action, "deny")
  }
  h.key("Enter")
  assert.equal(h.contents.open(h.request).action, "allow")
  h.key("Enter", { control: true })
  assert.equal(h.contents.open(h.request).action, "allow")
})

test("blocked requests are bounded and unsupported URLs cannot be opened", () => {
  const h = harness()
  assert.equal(h.contents.open({ ...h.request, url: "file:///secret" }).action, "deny")
  assert.equal(h.entry.blockedPopups, undefined)
  for (let i = 0; i < 100; i++) h.contents.open(h.request)
  assert.equal(h.entry.blockedPopups.length, 20)
})

test("manual opening preserves POST and referrer, and a stale menu cannot open again", () => {
  const h = harness()
  const body = { contentType: "multipart/form-data", boundary: "sample-boundary",
    data: [{ type: "rawData", bytes: Buffer.from("sample") }] }
  h.contents.open({ ...h.request, postBody: body })
  const menu = h.menu()
  menu[0].click()
  assert.equal(h.created.length, 1)
  assert.deepEqual(h.loaded[0], [h.request.url, {
    httpReferrer: h.request.referrer, postData: body.data,
    extraHeaders: "Content-Type: multipart/form-data; boundary=sample-boundary"
  }])
  menu[0].click()
  assert.equal(h.created.length, 1)
  h.contents.open(h.request)
  const stale = h.menu()
  h.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false })
  stale[0].click()
  assert.equal(h.created.length, 1)
})
