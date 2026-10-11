const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

function fixture() {
  class Document extends EventTarget {}
  class Video extends EventTarget {
    constructor(document) {
      super()
      this.ownerDocument = document
      this.wrappedJSObject = this
      this.isConnected = true
      this.readyState = 4
      this.videoWidth = 640
      this.videoHeight = 360
      this.attributes = new Map()
    }
    hasAttribute(name) { return this.attributes.has(name) }
    toggleAttribute(name, value) { if (value) this.attributes.set(name, ""); else this.attributes.delete(name) }
    getBoundingClientRect() { return { x: 12, y: 40, width: 320, height: 180 } }
  }
  const document = new Document()
  const video = new Video(document)
  document.querySelector = () => video
  const page = { Document, HTMLVideoElement: Video, EventTarget, Event, Promise, DOMException }
  const window = new EventTarget()
  window.wrappedJSObject = page
  const sent = [], listeners = new Set()
  const port = { postMessage: message => sent.push(message),
    onMessage: { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener) } }
  const activation = { isActive: true }
  let presentations = 0, cleanups = 0
  const context = vm.createContext({ window, document, HTMLVideoElement: Video, navigator: { userActivation: activation },
    exportFunction: fn => fn, XPCNativeWrapper: function (value) { return value },
    Event, innerWidth: 360, innerHeight: 700, setTimeout, clearTimeout,
    presentOncePipVideo: () => { presentations++; return () => { cleanups++ } } })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/extensions/once-surface/pictureInPicture.js"), "utf8"), context)
  const disconnect = context.installOncePictureInPicture(port)
  const receive = message => { for (const listener of listeners) listener(message) }
  receive({ type: "pip-capability", enabled: true })
  return { document, video, activation, sent, receive, disconnect,
    get presentations() { return presentations }, get cleanups() { return cleanups } }
}

test("a standard request enters native PiP without fullscreen and resolves its window", async () => {
  const f = fixture()
  let entered = 0, resized = 0
  f.video.addEventListener("enterpictureinpicture", event => { entered++; assert.ok(event.pictureInPictureWindow) })
  f.video.onenterpictureinpicture = () => assert.fail("Replaced handler must not run")
  f.video.onenterpictureinpicture = event => {
    assert.equal(f.document.pictureInPictureElement, f.video)
    assert.equal(event.pictureInPictureWindow.width, 192)
    assert.equal(event.pictureInPictureWindow.height, 108)
  }
  const promise = f.video.requestPictureInPicture()
  assert.equal(f.presentations, 1, "The video must be prepared before native entry starts")
  assert.equal(f.sent[0].action, "enter")
  assert.equal(f.sent[0].width, 640)
  assert.equal(f.document.pictureInPictureElement, null)
  f.receive({ type: "pip-state", enabled: true, direct: true, width: 192, height: 108 })
  f.receive({ type: "pip-result", id: f.sent[0].id })
  const window = await promise
  assert.equal(f.document.pictureInPictureElement, f.video)
  assert.equal(window.width, 192)
  assert.equal(window.height, 108)
  assert.equal(entered, 1)
  assert.equal(f.presentations, 1)
  window.addEventListener("resize", () => resized++)
  let handlerSize
  window.onresize = () => { handlerSize = window.width }
  f.receive({ type: "pip-state", enabled: true, direct: true, width: 240, height: 135 })
  assert.equal(window.width, 240)
  assert.equal(resized, 1)
  assert.equal(handlerSize, 240)
  window.onresize = null
  assert.equal(window.onresize, null)
  f.disconnect()
})

test("standard exit and native return restore the page and dispatch leave", async () => {
  const f = fixture()
  let left = 0
  f.video.addEventListener("leavepictureinpicture", () => left++)
  const entered = f.video.requestPictureInPicture()
  f.receive({ type: "pip-state", enabled: true, direct: true, width: 192, height: 108 })
  f.receive({ type: "pip-result", id: 1 })
  await entered
  const exited = f.document.exitPictureInPicture()
  assert.equal(f.sent[1].action, "exit")
  f.receive({ type: "pip-state", enabled: false, width: 0, height: 0 })
  f.receive({ type: "pip-result", id: 2 })
  await exited
  assert.equal(f.document.pictureInPictureElement, null)
  assert.equal(left, 1)
  assert.equal(f.cleanups, 1)
  f.disconnect()
  assert.equal("requestPictureInPicture" in f.video, false)
})

test("PiP rejects missing activation, disabled videos and unsupported devices", async () => {
  const f = fixture()
  f.activation.isActive = false
  await assert.rejects(f.video.requestPictureInPicture(), { name: "NotAllowedError" })
  f.activation.isActive = true
  f.video.disablePictureInPicture = true
  await assert.rejects(f.video.requestPictureInPicture(), { name: "InvalidStateError" })
  f.video.disablePictureInPicture = false
  f.video.readyState = 0
  await assert.rejects(f.video.requestPictureInPicture(), { name: "InvalidStateError" })
  f.receive({ type: "pip-capability", enabled: false })
  await assert.rejects(f.video.requestPictureInPicture(), { name: "NotSupportedError" })
  assert.equal(f.sent.length, 0)
  f.disconnect()
})

test("native rejection and disconnected requests reject rather than claiming PiP", async () => {
  const f = fixture()
  const denied = f.video.requestPictureInPicture()
  f.receive({ type: "pip-result", id: 1, name: "NotAllowedError", error: "Android denied PiP" })
  await assert.rejects(denied, { name: "NotAllowedError" })
  assert.equal(f.cleanups, 1, "Denied entry must restore the inline video")
  assert.equal(f.document.pictureInPictureElement, null)
  const abandoned = f.video.requestPictureInPicture()
  f.disconnect()
  await assert.rejects(abandoned, { name: "AbortError" })
  assert.equal(f.cleanups, 2)
})
