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
    document.defaultView.Option
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
    </div>
  `)
  const sent = []
  const controller = {
    send: (message) => sent.push(message),
    subscribe: () => () => undefined
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

  controls.setReaderMode(false)
  assert.equal(pill.hidden, true)
  assert.equal(settings.open, false)
  assert.deepEqual(sent.at(-1), { type: "ui-stop" })
})
