const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")

function fixture(hostname = "m.youtube.com") {
  const listeners = new Map()
  const sent = []
  let receive, disconnect
  let ad = false
  const media = { duration: 120, currentTime: 42, playbackRate: 1.5, seekable: { length: 1 } }
  const location = { hostname, href: `https://${hostname}/watch?v=fixture` }
  const document = { title: "Example video - YouTube", addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name), querySelector(selector) {
      if (selector.startsWith("video")) return media
      if (selector.startsWith(".ad-")) return ad ? {} : null
      if (selector.includes("slim-owner")) return { textContent: "Example channel" }
      return null
    } }
  const port = { postMessage: value => sent.push(value), onMessage: { addListener: fn => { receive = fn } },
    onDisconnect: { addListener: fn => { disconnect = fn } } }
  const context = vm.createContext({ document, location })
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/extensions/once-surface/media.js"), "utf8"), context)
  context.installOnceMediaBridge(port)
  return { media, location, sent, listeners, receive: value => receive?.(value), disconnect: () => disconnect?.(), ad: value => { ad = value } }
}

test("YouTube metadata and timeline are opt-in and update on SPA navigation", () => {
  const f = fixture()
  f.listeners.get("timeupdate")()
  assert.equal(f.sent.length, 0)
  f.receive({ type: "media-observe", enabled: true })
  assert.equal(f.sent[0].title, "Example video")
  assert.equal(f.sent[0].artist, "Example channel")
  assert.equal(f.sent[0].position, 42)
  assert.equal(f.sent[0].rate, 1.5)
  f.location.href = "https://m.youtube.com/watch?v=next"
  f.listeners.get("yt-navigate-finish")()
  assert.equal(f.sent.at(-1).url, f.location.href)
  f.disconnect()
  assert.equal(f.listeners.size, 0)
})

test("YouTube seeking rejects stale pages, ads, live media, and invalid numbers", () => {
  const f = fixture()
  f.receive({ type: "media-observe", enabled: true })
  const seek = position => f.receive({ type: "media-command", action: "seek", url: f.location.href, position })
  seek(999)
  assert.equal(f.media.currentTime, 120)
  seek(-5)
  assert.equal(f.media.currentTime, 0)
  seek(NaN)
  assert.equal(f.media.currentTime, 0)
  f.ad(true)
  seek(30)
  assert.equal(f.media.currentTime, 0)
  f.ad(false)
  f.media.duration = Infinity
  seek(30)
  assert.equal(f.media.currentTime, 0)
  f.media.duration = 120
  f.receive({ type: "media-command", action: "seek", url: "https://m.youtube.com/watch?v=old", position: 30 })
  assert.equal(f.media.currentTime, 0)
  f.receive({ type: "media-observe", enabled: false })
  seek(30)
  assert.equal(f.media.currentTime, 0)
})

test("other sites get basic metadata without YouTube scraping", () => {
  for (const hostname of ["example.com", "notyoutube.com", "youtube.com.example.com"]) {
    const f = fixture(hostname)
    f.receive({ type: "media-observe", enabled: true })
    assert.equal(f.sent[0].title, "Example video - YouTube")
    assert.equal(f.sent[0].artist, "")
  }
  assert.ok(fixture("www.youtube-nocookie.com").listeners.size > 0)
})
