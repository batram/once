const test = require("node:test")
const assert = require("node:assert/strict")
const { readPdfSandboxMessage, readPdfHostMessage, PDF_SANDBOX_PROTOCOL } = require("../../../packages/platform-web/dist/pdfSandboxProtocol")
const { createPdfTextPort } = require("../../../packages/platform-web/dist/pdfText")
// The bundled worker's location is a webpack asset Node cannot resolve; tests name it.
const workerUrl = "pdf/pdf.worker.js"

const tick = () => new Promise(resolve => setImmediate(resolve))

test("messages from the PDF sandbox are validated before the shell uses them", () => {
  assert.equal(readPdfSandboxMessage(null), null)
  assert.equal(readPdfSandboxMessage({ type: "load" }), null)
  assert.deepEqual(readPdfSandboxMessage({ type: "ready", protocol: 1 }), { type: "ready", protocol: 1 })
  // Asset names are file names of known kinds, never paths.
  assert.deepEqual(readPdfSandboxMessage({ type: "asset", requestId: 1, kind: "cMapUrl", filename: "UniJIS-UCS2-H.bcmap" }), { type: "asset", requestId: 1, kind: "cMapUrl", filename: "UniJIS-UCS2-H.bcmap" })
  assert.equal(readPdfSandboxMessage({ type: "asset", requestId: 1, kind: "cMapUrl", filename: "../index.js" }), null)
  assert.equal(readPdfSandboxMessage({ type: "asset", requestId: 1, kind: "cMapUrl", filename: ".hidden" }), null)
  assert.equal(readPdfSandboxMessage({ type: "asset", requestId: 1, kind: "shellUrl", filename: "a.bin" }), null)
  assert.equal(readPdfSandboxMessage({ type: "recognize", requestId: 2, image: "not bytes" }), null)
  assert.equal(readPdfSandboxMessage({ type: "recognize", requestId: 2, image: new Uint8Array(0) }), null)
  assert.equal(readPdfSandboxMessage({ type: "result", result: { pages: [{ lines: ["x"], method: "html" }] } }), null)
  assert.equal(readPdfSandboxMessage({ type: "result", result: { pages: [{ lines: ["x"], lineBounds: [{ x: 1, y: 2, width: Infinity, height: 3 }], method: "ocr" }] } }), null)
  assert.equal(readPdfSandboxMessage({ type: "result", result: { pages: [{ lines: ["x", 2], method: "embedded" }] } }), null)
  assert.equal(readPdfSandboxMessage({ type: "result", result: { pages: Array.from({ length: 201 }, () => ({ lines: [], method: "embedded" })) } }), null)
  const valid = readPdfSandboxMessage({ type: "result", result: { title: "T".repeat(600), pages: [{ lines: ["a", "b"], lineBounds: [{ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 2, width: 1, height: 1 }], method: "embedded", extra: 1 }] } })
  assert.equal(valid.result.title.length, 512)
  assert.deepEqual(valid.result.pages, [{ lines: ["a", "b"], lineBounds: [{ x: 0, y: 0, width: 1, height: 1 }, { x: 0, y: 2, width: 1, height: 1 }], method: "embedded" }])
  assert.equal(readPdfSandboxMessage({ type: "error", message: "e".repeat(5000) }).message.length, 2000)
  assert.equal(readPdfHostMessage({ type: "extract", protocol: 1, bytes: "x", workerSource: "" }), null)
  assert.deepEqual(readPdfHostMessage({ type: "asset", requestId: 3, error: "nope" }), { type: "asset", requestId: 3, error: "nope" })
})

function frameHarness(t, { fetched = {} } = {}) {
  const previous = { window: global.window, document: global.document, location: global.location, fetch: global.fetch }
  const frames = []
  const listeners = new Set()
  global.location = { href: "https://shell.test/app/index.html" }
  global.window = {
    addEventListener: (_event, fn) => listeners.add(fn),
    removeEventListener: (_event, fn) => listeners.delete(fn)
  }
  global.document = {
    createElement() {
      const frame = { dataset: {}, sent: [], attributes: {} }
      frame.setAttribute = (name, value) => { frame.attributes[name] = value }
      frame.contentWindow = { postMessage: (message, _origin, transfer) => frame.sent.push({ message, transfer }) }
      frame.remove = () => { frame.removed = true }
      return frame
    },
    body: { append: frame => frames.push(frame) }
  }
  global.fetch = async url => {
    const body = fetched[url]
    if (!body) return { ok: false, status: 404 }
    if (body === "oversized") return {
      ok: true, status: 200,
      headers: { get: () => String(33 * 1024 * 1024) },
      body: { cancel: async () => {} },
      arrayBuffer: async () => { throw new Error("oversized asset was read") }
    }
    return { ok: true, status: 200, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) }
  }
  t.after(() => Object.assign(global, previous))
  const send = (frame, data) => { for (const listener of listeners) listener({ source: frame.contentWindow, data }) }
  return { frames, send, listeners }
}

const workerSource = new TextEncoder().encode("// worker")

test("the PDF port runs each document in a fresh opaque frame and validates what comes back", async t => {
  const { frames, send, listeners } = frameHarness(t, { fetched: {
    "https://shell.test/app/pdf/pdf.worker.js": workerSource,
    "https://shell.test/app/pdf/cmaps/Identity-H.bcmap": new Uint8Array([1, 2, 3]),
    "https://shell.test/app/pdf/cmaps/too-big.bcmap": "oversized"
  } })
  const recognized = []
  const recognition = { async recognizeImage(bytes) { recognized.push(bytes); return { lines: ["Scanned line"], lineBounds: [{ x: 0, y: 0, width: 10, height: 2 }] } } }
  const port = createPdfTextPort({ sandboxUrl: "https://shell.test/app/pdf-sandbox.html", workerUrl })
  const extraction = port.extract(new Uint8Array([37, 80, 68, 70]), recognition)
  await tick()
  const frame = frames[0]
  assert.equal(frame.attributes.sandbox, "allow-scripts")
  assert.equal(frame.hidden, true)
  assert.equal(frame.src, "https://shell.test/app/pdf-sandbox.html")
  assert.equal(frame.sent.length, 0, "nothing is sent before the frame is ready")

  // A stranger's message is ignored.
  for (const listener of listeners) listener({ source: {}, data: { type: "ready", protocol: PDF_SANDBOX_PROTOCOL } })
  assert.equal(frame.sent.length, 0)

  send(frame, { type: "ready", protocol: PDF_SANDBOX_PROTOCOL })
  const extract = frame.sent[0]
  assert.equal(extract.message.type, "extract")
  assert.equal(extract.message.protocol, PDF_SANDBOX_PROTOCOL)
  assert.deepEqual(extract.message.bytes, new Uint8Array([37, 80, 68, 70]))
  assert.equal(extract.message.workerSource, "// worker")
  assert.equal(extract.message.recognition, true)
  assert.equal(extract.message.pageImages, 0, "pictures are only rendered on request")
  assert.deepEqual(extract.transfer, [extract.message.bytes.buffer])

  send(frame, { type: "asset", requestId: 1, kind: "cMapUrl", filename: "Identity-H.bcmap" })
  send(frame, { type: "asset", requestId: 2, kind: "standardFontDataUrl", filename: "missing.pfb" })
  send(frame, { type: "asset", requestId: 5, kind: "cMapUrl", filename: "too-big.bcmap" })
  send(frame, { type: "asset", requestId: 3, kind: "cMapUrl", filename: "../../index.html" })
  await tick(); await tick()
  const reply = id => frame.sent.map(({ message }) => message).find(message => message.requestId === id)
  assert.deepEqual(reply(1), { type: "asset", requestId: 1, bytes: new Uint8Array([1, 2, 3]) })
  assert.match(reply(2).error, /Unable to load/)
  assert.match(reply(5).error, /PDF asset too large/)
  assert.equal(frame.sent.length, 4, "a path traversal request is dropped")

  send(frame, { type: "recognize", requestId: 4, image: new Uint8Array([137, 80]) })
  await tick()
  assert.deepEqual(recognized, [new Uint8Array([137, 80])])
  assert.deepEqual(reply(4), { type: "recognized", requestId: 4, result: { lines: ["Scanned line"], lineBounds: [{ x: 0, y: 0, width: 10, height: 2 }] } })

  send(frame, { type: "result", result: { pages: [{ lines: ["x"], method: "nope" }] } })
  assert.equal(frame.removed, undefined, "a malformed result is dropped, not accepted")
  send(frame, { type: "result", result: { title: "Doc", pages: [{ lines: ["Embedded"], method: "embedded" }, { lines: ["Scanned line"], method: "ocr" }] } })
  assert.deepEqual(await extraction, { title: "Doc", pages: [{ lines: ["Embedded"], method: "embedded" }, { lines: ["Scanned line"], method: "ocr" }] })
  assert.equal(frame.removed, true)
  assert.equal(listeners.size, 0)

  // The next document gets a frame of its own.
  const second = port.extract(new Uint8Array([1]))
  await tick()
  assert.equal(frames.length, 2)
  send(frames[1], { type: "ready", protocol: PDF_SANDBOX_PROTOCOL })
  assert.equal(frames[1].sent[0].message.recognition, false)
  send(frames[1], { type: "recognize", requestId: 1, image: new Uint8Array([1]) })
  await tick()
  assert.match(frames[1].sent[1].message.error, /not available/)
  send(frames[1], { type: "error", message: "This PDF is password-protected." })
  await assert.rejects(second, /password-protected/)
  assert.equal(frames[1].removed, true)
})

test("a sandbox that never starts, or never finishes, is torn down on its deadline", async t => {
  const { frames } = frameHarness(t, { fetched: { "https://shell.test/app/pdf/pdf.worker.js": workerSource } })
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const port = createPdfTextPort({ sandboxUrl: "https://shell.test/app/pdf-sandbox.html", workerUrl, timeoutMs: 1000 })
  const extraction = port.extract(new Uint8Array([1]))
  await tick()
  const rejected = assert.rejects(extraction, /timed out/)
  t.mock.timers.tick(1000)
  await rejected
  assert.equal(frames[0].removed, true)
})

test("page pictures arrive with their page numbers, and abort removes the parser", async t => {
  const { frames, send, listeners } = frameHarness(t, { fetched: { "https://shell.test/app/pdf/pdf.worker.js": workerSource } })
  const abort = new AbortController(), pages = [], progress = []
  const port = createPdfTextPort({ sandboxUrl: "https://shell.test/app/pdf-sandbox.html", workerUrl })
  const extraction = port.extract(new Uint8Array([37, 80, 68, 70]), undefined, {
    signal: abort.signal, onPage: (page, total) => progress.push([page, total]),
    pageImages: 16, onPageImage: (page, image) => pages.push([page, image.length])
  })
  await tick()
  const frame = frames[0]
  send(frame, { type: "ready", protocol: PDF_SANDBOX_PROTOCOL })
  assert.equal(frame.sent[0].message.pageImages, 16)
  assert.equal(frame.sent[0].message.recognition, false)
  send(frame, { type: "progress", page: 3, total: 5 })
  send(frame, { type: "page-image", page: 3, image: new Uint8Array([1, 2, 3]) })
  send(frame, { type: "page-image", page: 0, image: new Uint8Array([1]) })
  send(frame, { type: "page-image", page: 4, image: "not bytes" })
  await tick()
  assert.deepEqual(progress, [[3, 5]])
  assert.deepEqual(pages, [[3, 3]], "malformed pictures are dropped")
  const rejected = assert.rejects(extraction, /cancelled/)
  abort.abort()
  await rejected
  assert.equal(frame.removed, true)
  assert.equal(listeners.size, 0)
})
