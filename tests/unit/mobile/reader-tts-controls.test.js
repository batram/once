const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

const root = path.resolve(__dirname, "../../..")

function loadControls(document) {
  const source = fs.readFileSync(
    path.join(root, "apps/mobile/src/readerTtsControls.ts"),
    "utf8"
  )
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText
  const moduleObject = { exports: {} }
  Function("exports", "module", "require", "document", "Option", compiled)(
    moduleObject.exports,
    moduleObject,
    () => ({}),
    document,
    // linkedom has no Option constructor.
    document.defaultView.Option ?? function Option(text, value) {
      const option = document.createElement("option")
      option.textContent = text
      option.value = value
      return option
    }
  )
  return moduleObject.exports.installReaderTtsControls
}

test("host TTS bar is the single control surface in Reader mode", () => {
  const { document } = parseHTML(`
    <div id="reader_tts_pill" hidden>
      <button data-host-tts="prev"></button>
      <button data-host-tts="play"></button>
      <button data-host-tts="next"></button>
      <button data-host-tts="stop"></button>
      <details id="reader_tts_settings" open></details>
      <span id="reader_tts_rate_label"></span>
      <select id="reader_tts_voice"></select>
      <div id="reader_tts_rates"></div>
      <button data-host-ai="rewrite"></button>
      <button data-host-ai="undo" hidden></button>
      <div id="reader_ai_strip" hidden><span id="reader_ai_pages"></span><p id="reader_ai_status"></p><button data-host-ai="continue"></button><button data-host-ai="finish"></button></div>
    </div>
  `)
  const sent = []
  let listen
  const controller = {
    send: (message) => sent.push(message),
    subscribe: (listener) => { listen = listener; return () => undefined },
    refresh: () => undefined
  }
  const controls = loadControls(document)(controller)
  const pill = document.querySelector("#reader_tts_pill")
  const settings = document.querySelector("#reader_tts_settings")

  controls.setReaderMode(true)
  assert.equal(pill.hidden, false)
  document.querySelector('[data-host-tts="play"]').click()
  document.querySelector('[data-host-tts="stop"]').click()
  assert.deepEqual(sent.slice(-2), [
    { type: "ui-play-toggle" },
    { type: "ui-stop" }
  ])
  document.querySelector('[data-host-ai="rewrite"]').click()
  document.querySelector('[data-host-ai="undo"]').click()
  assert.deepEqual(sent.splice(-2), [{ type: "ui-ai", action: "rewrite" }, { type: "ui-ai", action: "undo" }])

  // A long scan read in parts: the strip above the bar offers the next pages and the rest.
  const strip = document.querySelector("#reader_ai_strip")
  // linkedom's select has no value setter.
  Object.defineProperty(document.querySelector("#reader_tts_voice"), "value", { value: "", writable: true })
  const speech = { playing: false, paused: false, rate: 1, segment: 0, voices: [], voice: "" }
  listen({ ...speech, ai: { running: false, canUndo: false, status: "", madeBy: "", pages: { through: 5, total: 29, ai: false, toEnd: false } } })
  assert.equal(strip.hidden, false)
  assert.equal(document.querySelector("#reader_ai_pages").textContent, "5/29")
  assert.equal(document.querySelector('[data-host-ai="continue"]').textContent, "Next 5")
  document.querySelector('[data-host-ai="continue"]').click()
  document.querySelector('[data-host-ai="finish"]').click()
  assert.deepEqual(sent.splice(-2), [{ type: "ui-ai", action: "continue" }, { type: "ui-ai", action: "finish" }])
  listen({ ...speech, ai: { running: true, canUndo: false, status: "Reading PDF page 12 of 29…", madeBy: "", pages: { through: 10, total: 29, ai: true, toEnd: true } } })
  assert.equal(document.querySelector('[data-host-ai="finish"]').textContent, "Stop")
  assert.equal(document.querySelector('[data-host-ai="finish"]').disabled, false, "reading to the end can be stopped")
  assert.equal(document.querySelector('[data-host-ai="continue"]').disabled, true)
  listen({ ...speech, ai: { running: false, canUndo: true, status: "", madeBy: "m", pages: { through: 29, total: 29, ai: true, toEnd: false } } })
  assert.equal(strip.hidden, true, "nothing is left to read")

  controls.setReaderMode(false)
  assert.equal(pill.hidden, true)
  assert.equal(settings.open, false)
  assert.deepEqual(sent.at(-1), { type: "ui-stop" })
})

test("hiding the bar or switching tabs keeps speech running; only stop and dismiss stop it", () => {
  const { document } = parseHTML(`
    <div id="reader_tts_pill" hidden>
      <button data-host-tts="prev"></button>
      <button data-host-tts="play"></button>
      <button data-host-tts="next"></button>
      <button data-host-tts="stop"></button>
      <details id="reader_tts_settings" open></details>
      <span id="reader_tts_rate_label"></span>
      <select id="reader_tts_voice"></select>
      <div id="reader_tts_rates"></div>
      <button data-host-ai="rewrite"></button>
      <button data-host-ai="undo" hidden></button>
      <div id="reader_ai_strip" hidden><span id="reader_ai_pages"></span><p id="reader_ai_status"></p><button data-host-ai="continue"></button><button data-host-ai="finish"></button></div>
    </div>
  `)
  const sent = []
  let refreshed = 0
  const controller = {
    send: (message) => sent.push(message),
    subscribe: () => () => undefined,
    refresh: () => { refreshed += 1 }
  }
  const controls = loadControls(document)(controller)
  const pill = document.querySelector("#reader_tts_pill")
  controls.setReaderMode(true)
  controls.setReaderMode(false)
  assert.equal(pill.hidden, true)
  controls.tabChanged()
  controls.setReaderMode(true)
  assert.equal(refreshed, 2, "showing the bar replays the selected reader")
  controls.setReaderMode(false)
  assert.deepEqual(sent, [], "leaving the panel or tab must not stop background speech")
  controls.stop()
  assert.deepEqual(sent, [{ type: "ui-stop" }])
  controls.setReaderMode(true)
  controls.dismiss()
  assert.equal(pill.hidden, true)
  assert.deepEqual(sent.at(-1), { type: "ui-stop" })
})
