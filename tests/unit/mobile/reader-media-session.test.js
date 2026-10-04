const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const root = path.resolve(__dirname, "../../..")

function load() {
  const source = fs.readFileSync(path.join(root, "apps/mobile/src/readerMediaSession.ts"), "utf8")
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const moduleObject = { exports: {} }
  Function("exports", "module", "require", compiled)(moduleObject.exports, moduleObject, () => ({
    Capacitor: { isNativePlatform: () => false },
    registerPlugin: () => { throw new Error("not native") }
  }))
  return moduleObject.exports.installReaderMediaSession
}

test("system media controls follow the speaking reader and send commands back", async () => {
  let speech, command
  const commands = []
  const tts = {
    onSpeech: listener => { speech = listener; return () => undefined },
    command: action => commands.push(action)
  }
  const calls = []
  const plugin = {
    update: async options => { calls.push(["update", options]) },
    clear: async () => { calls.push(["clear"]) },
    addListener: async (event, listener) => { command = listener; return { remove: async () => undefined } }
  }
  const frame = {}
  load()(tts, source => source === frame ? { title: "Article", subtitle: "example.test" } : null, plugin)
  await Promise.resolve()

  speech(null, null)
  assert.deepEqual(calls, [], "nothing to clear before anything was shown")
  speech(frame, { playing: true, paused: false, segment: 2, segments: 9 })
  speech(frame, { playing: true, paused: true, segment: 2 })
  speech(null, null)
  assert.deepEqual(calls, [
    ["update", { title: "Article", subtitle: "example.test", playing: true, paused: false, index: 2, count: 9 }],
    ["update", { title: "Article", subtitle: "example.test", playing: true, paused: true, index: 2, count: 0 }],
    ["clear"]
  ])
  command({ action: "next" })
  assert.deepEqual(commands, ["next"])
})

test("without a native platform nothing is installed", () => {
  let subscribed = false
  load()({ onSpeech: () => { subscribed = true } }, () => ({ title: "", subtitle: "" }))
  assert.equal(subscribed, false)
})
