const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const vm = require("node:vm")
const path = require("node:path")
const { spawnSync } = require("node:child_process")
const ts = require("typescript")

function source(name, imports = {}) {
  const file = path.resolve(__dirname, "../../../apps/electron/src/browser", name + ".ts")
  const output = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports = {}
  vm.runInNewContext(output, { exports, require: id => imports[id] ?? require(id), Buffer, AbortSignal, AbortController, setTimeout, clearTimeout })
  return exports
}

test("OCR admission is bounded and queued cancellation does not start work", async () => {
  const { OcrQueue } = source("OcrQueue")
  const queue = new OcrQueue(1, 1)
  let release, started = 0
  const first = queue.run(new AbortController().signal, () => new Promise(resolve => { release = resolve }))
  await Promise.resolve()
  const cancelled = new AbortController()
  const waiting = queue.run(cancelled.signal, async () => { started++ })
  await assert.rejects(queue.run(new AbortController().signal, async () => {}), /busy/)
  const rejected = assert.rejects(waiting)
  cancelled.abort()
  await rejected
  release()
  await first
  await new Promise(resolve => setImmediate(resolve))
  await queue.run(new AbortController().signal, async () => { started++ })
  assert.equal(started, 1)
})

test("native OCR output requires bounded, finite, aligned geometry", () => {
  const { readOcrResult } = source("ocrResult")
  const valid = { lines: [[{ text: "Text", topLeft: { x: .1, y: .1 }, topRight: { x: .2, y: .1 }, bottomLeft: { x: .1, y: .2 } }]],
    textLines: ["Text"], lineBounds: [{ x: 10, y: 10, width: 10, height: 10 }] }
  assert.equal(readOcrResult(valid), valid)
  for (const value of [null, {}, { ...valid, lineBounds: [] }, { ...valid, textLines: [5] },
    { ...valid, lines: [[{ ...valid.lines[0][0], topLeft: { x: Infinity, y: 0 } }]] },
    { ...valid, lineBounds: [{ x: 0, y: 0, width: -1, height: 0 }] }]) assert.throws(() => readOcrResult(value), /Invalid/)
})

const helper = path.resolve(__dirname, "../../../apps/electron/.native/once-image-text.exe")
test("the Windows AppContainer worker decodes an image and rejects bytes that are none", { skip: process.platform !== "win32" || !fs.existsSync(helper) }, () => {
  const { createCanvas } = require("@napi-rs/canvas")
  const canvas = createCanvas(100, 100)
  const context = canvas.getContext("2d")
  context.fillStyle = "white"
  context.fillRect(0, 0, 100, 100)
  const run = input => spawnSync(helper, [], { input, windowsHide: true, timeout: 25000 })
  const good = run(canvas.toBuffer("image/png"))
  assert.equal(good.status, 0, good.stderr.toString())
  assert.deepEqual(JSON.parse(good.stdout), { lines: [], textLines: [], lineBounds: [] })
  const bad = run(Buffer.from("not an image at all"))
  assert.equal(bad.status, 1)
  assert.notEqual(bad.stderr.toString().trim(), "")
})
