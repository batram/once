const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const vm = require("node:vm")

const swift = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/ios/App/App/TabMediaObserver.swift"), "utf8")
const source = swift.match(/static let presentationSource = """\n([\s\S]*?)\n {4}"""/)[1]

function fixture() {
  const calls = []
  class Video {
    webkitPresentationMode = "fullscreen"
    webkitExitFullscreen(...args) { calls.push({ media: this, args }); this.webkitPresentationMode = "inline" }
    webkitExitFullScreen(...args) { calls.push({ media: this, args }); this.webkitPresentationMode = "inline" }
    webkitSetPresentationMode(mode) { this.webkitPresentationMode = mode }
  }
  const descriptors = ["webkitExitFullscreen", "webkitExitFullScreen"].map(name => Object.getOwnPropertyDescriptor(Video.prototype, name))
  vm.runInNewContext(source, { HTMLVideoElement: Video })
  return { Video, calls, descriptors }
}

test("legacy fullscreen cleanup leaves a manually entered iOS PiP window open", () => {
  const { Video, calls } = fixture()
  const video = new Video()
  video.webkitSetPresentationMode("picture-in-picture")
  // YouTube's delayed fullscreen cleanup after the native PiP button.
  video.webkitExitFullscreen()
  video.webkitExitFullScreen()
  assert.equal(video.webkitPresentationMode, "picture-in-picture")
  assert.equal(calls.length, 0)
  // Explicit PiP exit remains available, including the native close control's
  // resulting presentation change.
  video.webkitSetPresentationMode("inline")
  assert.equal(video.webkitPresentationMode, "inline")
})

test("both iOS fullscreen exit aliases preserve normal calls and property descriptors", () => {
  const { Video, calls, descriptors } = fixture()
  for (const [index, name] of ["webkitExitFullscreen", "webkitExitFullScreen"].entries()) {
    const video = new Video()
    video[name]("argument")
    assert.equal(video.webkitPresentationMode, "inline")
    assert.deepEqual(calls.at(-1), { media: video, args: ["argument"] })
    const actual = Object.getOwnPropertyDescriptor(Video.prototype, name)
    for (const key of ["configurable", "writable", "enumerable"]) assert.equal(actual[key], descriptors[index][key])
  }
})

test("iOS presentation compatibility skips missing legacy APIs", () => {
  class Video { webkitPresentationMode = "inline" }
  vm.runInNewContext(source, { HTMLVideoElement: Video })
  assert.equal(Video.prototype.webkitExitFullscreen, undefined)
  assert.equal(Video.prototype.webkitExitFullScreen, undefined)
})
