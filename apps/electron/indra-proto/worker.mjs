// Electron utilityProcess entry for the Indra OCR prototype (not shipped).
// Main posts { id, width, height, data: Uint8Array (grey) }; the reply is
// { id, result: ImageTextResult, ms } or { id, error }. Layout next to this
// file: engine/ (indra-js), ort/ (onnxruntime-web Node build + the reduced
// WASM runtime), models/ (*.extended.ort + meta.json).
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const ort = await import(pathToFileURL(path.join(here, "ort", "ort.node.min.mjs")).href)
ort.env.wasm.numThreads = 4
ort.env.wasm.wasmPaths = pathToFileURL(path.join(here, "ort") + path.sep).href
const { createIndra } = await import(pathToFileURL(path.join(here, "engine", "indra.mjs")).href)

const started = performance.now()
const indra = await createIndra({
  ort,
  fast: true,
  verifyDeskew: true,
  load: async (name) => new Uint8Array(fs.readFileSync(path.join(here, "models", name.replace(/\.onnx$/, ".extended.ort")))),
  sessionOptions: { executionProviders: ["wasm"] }
})
process.parentPort.postMessage({ ready: true, loadMs: Math.round(performance.now() - started) })

// Pixel quads -> the overlay's normalized corners; lines in reading order.
function toImageText(page, width, height) {
  const norm = ([x, y]) => ({ x: x / width, y: y / height })
  const lines = [], textLines = [], lineBounds = []
  for (const line of page.lines) {
    if (!line.text.trim()) continue
    const [x0, y0, x1, y1] = line.box
    textLines.push(line.text)
    lineBounds.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
    lines.push(line.words.map((w) => ({ text: w.text, topLeft: norm(w.quad[0]), topRight: norm(w.quad[1]), bottomLeft: norm(w.quad[3]) })))
  }
  return { lines, textLines, lineBounds }
}

let busy = Promise.resolve()
process.parentPort.on("message", (event) => {
  const { id, width, height, data } = event.data
  busy = busy.then(async () => {
    try {
      const t0 = performance.now()
      const page = await indra.ocr({ data: new Uint8Array(data), width, height })
      process.parentPort.postMessage({ id, result: toImageText(page, width, height), ms: Math.round(performance.now() - t0), timings: page.timings })
    } catch (error) {
      process.parentPort.postMessage({ id, error: String(error?.message ?? error) })
    }
  })
})
