const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const ts = require("typescript")

function load() {
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    "../../../apps/electron/src/ReaderTtsRelay.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  Function("exports", "require", compiled)(module.exports, name => {
    if (name === "electron") return { app: { getPath: () => os.tmpdir() }, ipcMain: { handle() {}, on() {} } }
    if (name === "node:fs") return fs
    if (name === "node:path") return path
    if (name === "./browser/readerTtsIpc") return { READER_TTS_IPC: { stop: "once:reader-tts:stop" } }
    if (name === "./browser/reader-url") return { sourceUrlFromReaderUrl: () => null }
    throw Error(`unexpected import ${name}`)
  })
  return module.exports
}

function speaker(name) {
  const sent = []
  let destroyed = false
  const listeners = []
  return {
    name, sent,
    isDestroyed: () => destroyed,
    send: channel => sent.push(channel),
    once: (_event, listener) => listeners.push(listener),
    destroy() { destroyed = true; for (const listener of listeners) listener() }
  }
}

test("settings survive a round trip through the profile file, invalid parts dropped", () => {
  const { ReaderTtsStore, ReaderTtsRelay } = load()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-reader-tts-"))
  try {
    const relay = new ReaderTtsRelay(new ReaderTtsStore(path.join(directory, "nested", "reader-tts.json")))
    assert.deepEqual(relay.preferences(), { voice: "", rates: {} })
    relay.remember({ voice: "once-wafli-slt", rates: { "": 2, "once-wafli-slt": 1.5, bad: 9, worse: "3" }, extra: true })
    assert.deepEqual(relay.preferences(), { voice: "once-wafli-slt", rates: { "": 2, "once-wafli-slt": 1.5 } })
    relay.remember("nonsense")
    assert.deepEqual(relay.preferences(), { voice: "", rates: {} })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test("one reader speaks at a time: a new claim stops the previous reader only", () => {
  const { ReaderTtsStore, ReaderTtsRelay } = load()
  const relay = new ReaderTtsRelay(new ReaderTtsStore(path.join(os.tmpdir(), "unused-reader-tts.json")))
  const first = speaker("first"), second = speaker("second")
  relay.claim(first)
  relay.claim(first)
  assert.deepEqual(first.sent, [])
  relay.claim(second)
  assert.deepEqual(first.sent, ["once:reader-tts:stop"])
  assert.deepEqual(second.sent, [])
  relay.release(first)
  relay.claim(first)
  assert.deepEqual(second.sent, ["once:reader-tts:stop"])
  // A reader that stopped on its own, or went away, is not told again.
  relay.release(first)
  relay.claim(second)
  assert.deepEqual(first.sent, ["once:reader-tts:stop"])
  second.destroy()
  relay.claim(first)
  assert.deepEqual(second.sent, ["once:reader-tts:stop"])
})
