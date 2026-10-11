const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const swift = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/ios/App/App/TabMediaObserver.swift"), "utf8")
const source = swift.match(/static let source = """\n([\s\S]*?)\n {4}"""/)[1]

function fixture() {
  const events = new Map()
  const windowEvents = new Map()
  const messages = []
  class Media {
    paused = false
    ended = false
    muted = false
    volume = 1
    webkitPresentationMode = "inline"
    listeners = new Map()
    addEventListener(type, fn) { this.listeners.set(type, fn) }
  }
  const document = { pictureInPictureElement: null, addEventListener: (type, fn) => events.set(type, fn) }
  const window = { addEventListener: (type, fn) => windowEvents.set(type, fn),
    webkit: { messageHandlers: { onceMedia: { postMessage: message => messages.push(JSON.parse(JSON.stringify(message))) } } } }
  vm.runInNewContext(source, { window, document, HTMLMediaElement: Media })
  const media = new Media()
  const emit = type => (media.listeners.get(type) || events.get(type))({ target: media, type })
  return { media, document, window, messages, emit, windowEvents }
}

test("iOS reports muted PiP independently of audible playback and retains it while paused", () => {
  const f = fixture()
  f.media.muted = true
  f.emit("play")
  assert.equal(f.messages.length, 0)
  f.media.webkitPresentationMode = "picture-in-picture"
  f.emit("webkitpresentationmodechanged")
  assert.equal(f.messages.at(-1).playing, false)
  assert.equal(f.messages.at(-1).pip, true)
  f.media.paused = true
  f.emit("pause")
  assert.equal(f.messages.length, 1)
  f.media.webkitPresentationMode = "inline"
  f.emit("webkitpresentationmodechanged")
  assert.equal(f.messages.at(-1).pip, false)
})

test("iOS PiP exit wins over stale standard and legacy getters", () => {
  const f = fixture()
  f.document.pictureInPictureElement = f.media
  f.media.webkitPresentationMode = "picture-in-picture"
  f.emit("webkitpresentationmodechanged")
  assert.equal(f.window.__onceMedia.pictureInPicture, true)
  f.media.webkitPresentationMode = "inline"
  f.emit("webkitpresentationmodechanged")
  assert.equal(f.messages.at(-1).pip, false)
  f.emit("playing")
  assert.equal(f.messages.at(-1).pip, false)
  f.media.webkitPresentationMode = "picture-in-picture"
  f.emit("enterpictureinpicture")
  f.emit("leavepictureinpicture")
  f.emit("pause")
  assert.equal(f.messages.at(-1).pip, false)
  assert.equal(f.window.__onceMedia.pictureInPicture, false)
})

test("iOS handles standard PiP events, audible playback changes and page disposal", () => {
  const f = fixture()
  f.emit("playing")
  assert.equal(f.messages.at(-1).playing, true)
  f.document.pictureInPictureElement = f.media
  f.emit("enterpictureinpicture")
  assert.equal(f.messages.at(-1).pip, true)
  f.media.paused = true
  f.emit("pause")
  assert.equal(f.messages.at(-1).playing, false)
  assert.equal(f.messages.at(-1).pip, true)
  f.document.pictureInPictureElement = null
  f.emit("leavepictureinpicture")
  assert.equal(f.messages.at(-1).pip, false)
  f.media.webkitPresentationMode = "picture-in-picture"
  f.emit("webkitpresentationmodechanged")
  f.windowEvents.get("pagehide")()
  assert.equal(f.messages.at(-1).pip, false)
})
