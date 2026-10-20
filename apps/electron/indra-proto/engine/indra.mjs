// Indra OCR image pipeline in JavaScript on ONNX Runtime (onnxruntime-web WASM or
// onnxruntime-node): orientation, deskew, line detection, CTC recognition, line
// splitting, reading order and layout blocks. A port of indra-ocr 0.3.1
// (pipeline.py, det_post.py, rec_preproc.py, order_post.py, layout_post.py).
// The weights are not part of this code: the caller passes a loader that
// returns the bytes of det.onnx, rec.onnx, order.onnx, orient.onnx, meta.json.
// Not ported: PDF text layers, markdown, the CJK and math recognizers.

import { connectedComponents, disableWasm, initWasm, resize, roundEven, rotate90cw, rotationMatrix, rowSumsFor, warpAffine } from "./imageops.mjs"

const ADAPTIVE_MIN_H = 9
const ADAPTIVE_TARGET_H = 12
const ADAPTIVE_MAX_SIDE = 2048
const SPLIT_GAP = 3.0
const GUTTER_GAP = 1.6
const GUTTER_EDGES = 3
const ORIENT_SIDE = 768
const ORIENT_MIN = 0.95
const MIN_CONF = 0.5
const DESKEW_MAX = 5
const DESKEW_MIN = 0.3
const CORE_X_SHRINK = 0.15
const OUT_STRIDE = 2
const INPUT_MULTIPLE = 32
const LINE_HEIGHT = 32
const PAD_Y = 0.2
const PAD_X = 0.3
const WIDTH_MULTIPLE = 8
export const BLOCK_CLASSES = ["Text", "Section-Header", "Page-Header", "Page-Footer", "List-Group", "Table", "Caption", "Footnote", "Table-Of-Contents", "Form"]
const GRID = new Set(["Table", "Form", "Table-Of-Contents"].map((c) => BLOCK_CLASSES.indexOf(c)))

const now = () => performance.now()
const median = (values) => {
  const s = Float64Array.from(values).sort()
  const n = s.length
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}
const argmax = (arr) => { let k = 0; for (let i = 1; i < arr.length; i++) if (arr[i] > arr[k]) k = i; return k }
const stableArgsort = (keys) => Array.from(keys.keys()).sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b))

// ---------------------------------------------------------------- vocabulary

function makeVocab(json) {
  const { chars, blank = 0 } = JSON.parse(json)
  if (blank !== 0) throw new Error("only blank=0 vocabularies are supported")
  const hasCommands = chars.some((c) => Array.from(c).length > 1)
  const isAlpha = (s) => s.length > 0 && /^\p{L}+$/u.test(s)
  return {
    spaceId: chars.indexOf(" ") + 1,
    decode(ids) {
      const toks = ids.filter((i) => i > 0 && i <= chars.length).map((i) => chars[i - 1])
      if (!hasCommands) return toks.join("")
      let out = ""
      toks.forEach((t, k) => {
        out += t
        const next = toks[k + 1] ?? ""
        // "\\alpha" + "x" must not read back as "\\alphax"
        if (t.length > 2 && t[0] === "\\" && isAlpha(t.slice(1)) && isAlpha(Array.from(next)[0] ?? "")) out += " "
      })
      return out
    }
  }
}

// ------------------------------------------------------------- page geometry

// Ink map padded with 0 to outW x outH (a model input).
function inkMap(small, outW, outH) {
  const out = new Float32Array(outW * outH)
  for (let y = 0; y < small.height; y++) for (let x = 0; x < small.width; x++) out[y * outW + x] = 1 - small.data[y * small.width + x] / 255
  return out
}

function thumb(gray, side) {
  const s = side / Math.max(gray.width, gray.height)
  return resize(gray, Math.max(1, roundEven(gray.width * s)), Math.max(1, roundEven(gray.height * s)), "area")
}

export const estimateSkew = (gray, side = 800) => skewFromThumb(thumb(gray, side))

// pipeline.estimate_skew on an 800 px thumbnail. coarseHalf: run the 0.5°
// coarse pass on a half-size copy (a quarter of the pixels); the 0.1° fine pass
// stays at full thumbnail size. Not in Python: an opt-in speed-up.
function skewFromThumb(small, coarseHalf = false) {
  const inkOf = (t) => {
    const ink = new Float32Array(t.data.length)
    for (let i = 0; i < ink.length; i++) ink[i] = (255 - t.data[i]) / 255
    return { data: ink, width: t.width, height: t.height }
  }
  const img = inkOf(small)
  let sum = 0
  for (let i = 0; i < img.data.length; i++) sum += img.data[i]
  if (sum / img.data.length < 0.003) return 0
  const sharpnessOf = (im) => {
    const sums = rowSumsFor(im)
    return (a) => {
      const p = sums(rotationMatrix(im.width / 2, im.height / 2, a))
      let total = 0
      for (let y = 1; y < p.length; y++) total += (p[y] - p[y - 1]) ** 2
      return total
    }
  }
  // The fine pass revisits angles the coarse pass scored (keyed to 0.01°),
  // unless the coarse pass ran at another size.
  const memo = (fn) => { const seen = new Map(); return (a) => { const key = Math.round(a * 100); if (!seen.has(key)) seen.set(key, fn(a)); return seen.get(key) } }
  const fine = memo(sharpnessOf(img))
  const coarseScore = coarseHalf ? sharpnessOf(inkOf(resize(small, Math.max(1, roundEven(small.width / 2)), Math.max(1, roundEven(small.height / 2)), "area"))) : fine
  const best = (angles, score) => angles.reduce((b, a) => { const s = score(a); return s > b.s ? { a, s } : b }, { a: angles[0], s: -Infinity }).a
  const coarse = best(Array.from({ length: Math.floor((2 * DESKEW_MAX + 1e-6) / 0.5) + 1 }, (_, i) => -DESKEW_MAX + 0.5 * i), coarseScore)
  return best(Array.from({ length: 11 }, (_, i) => coarse - 0.5 + 0.1 * i), fine)
}

// The four corners (top-left, top-right, bottom-right, bottom-left) of a box
// in the deskewed page, mapped back to the input page: a tilted quad.
function unrotateQuad(box, degrees, w, h) {
  const [x0, y0, x1, y1] = box
  const m = rotationMatrix(w / 2, h / 2, -degrees)
  const r = (v) => Math.round(v * 10) / 10
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(([x, y]) => [r(m[0] * x + m[1] * y + m[2]), r(m[3] * x + m[4] * y + m[5])])
}

function unrotateBox(box, degrees, w, h) {
  const m = rotationMatrix(w / 2, h / 2, -degrees)
  const [x0, y0, x1, y1] = box
  const xs = [], ys = []
  for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) { xs.push(m[0] * x + m[1] * y + m[2]); ys.push(m[3] * x + m[4] * y + m[5]) }
  const clip = (v, hi) => Math.round(Math.min(hi, Math.max(0, v)) * 10) / 10
  return [clip(Math.min(...xs), w), clip(Math.min(...ys), h), clip(Math.max(...xs), w), clip(Math.max(...ys), h)]
}

// ---------------------------------------------------------------- detection

function pageToInput(gray, longSide) {
  const { width: w, height: h } = gray
  const scale = longSide / Math.max(h, w)
  const nh = Math.max(1, roundEven(h * scale)), nw = Math.max(1, roundEven(w * scale))
  const small = nh === h && nw === w ? gray : resize(gray, nw, nh, scale < 1 ? "area" : "linear")
  const ph = Math.ceil(nh / INPUT_MULTIPLE) * INPUT_MULTIPLE
  const pw = Math.ceil(nw / INPUT_MULTIPLE) * INPUT_MULTIPLE
  return { data: inkMap(small, pw, ph), width: pw, height: ph, scale }
}

function decodeDet(out, h, w, thresh = 0.5, minArea = 2) {
  const plane = h * w
  const prob = new Float32Array(plane)
  const mask = new Uint8Array(plane)
  for (let i = 0; i < plane; i++) { prob[i] = 1 / (1 + Math.exp(-out[i])); mask[i] = prob[i] > thresh ? 1 : 0 }
  const { n, labels, stats } = connectedComponents(mask, w, h)
  if (n <= 1) return []
  const cnt = new Float64Array(n), top = new Float64Array(n), bot = new Float64Array(n), sc = new Float64Array(n)
  for (let i = 0; i < plane; i++) {
    const id = labels[i]
    if (!id) continue
    const ys = (Math.floor(i / w) + 0.5) * OUT_STRIDE
    cnt[id]++
    top[id] += ys - out[plane + i]
    bot[id] += ys + out[2 * plane + i]
    sc[id] += prob[i]
  }
  const boxes = []
  for (let i = 1; i < n; i++) {
    if (stats[i].area < minArea) continue
    const c = Math.max(cnt[i], 1)
    const y0 = top[i] / c, y1 = bot[i] / c
    const lh = Math.max(1, y1 - y0)
    const ex = Math.min(CORE_X_SHRINK * lh, 0.5 * lh)
    boxes.push([stats[i].left * OUT_STRIDE - ex, y0, (stats[i].right + 1) * OUT_STRIDE + ex, y1, sc[i] / c])
  }
  return boxes
}

// --------------------------------------------------------------- recognition

function cropLine(gray, box, height = LINE_HEIGHT) {
  const [x0, y0, x1, y1] = box
  const h = Math.max(1, y1 - y0)
  const ix0 = Math.floor(x0 - PAD_X * h), iy0 = Math.floor(y0 - PAD_Y * h)
  const ix1 = Math.ceil(x1 + PAD_X * h), iy1 = Math.ceil(y1 + PAD_Y * h)
  const cw = Math.max(1, ix1 - ix0), ch = Math.max(1, iy1 - iy0)
  const crop = new Uint8Array(cw * ch).fill(255)
  const sx0 = Math.max(0, ix0), sy0 = Math.max(0, iy0), sx1 = Math.min(gray.width, ix1), sy1 = Math.min(gray.height, iy1)
  for (let y = sy0; y < sy1; y++) crop.set(gray.data.subarray(y * gray.width + sx0, y * gray.width + sx1), (y - iy0) * cw + (sx0 - ix0))
  const outW = Math.max(WIDTH_MULTIPLE, Math.min(4096, roundEven((cw * height) / ch)))
  // The resized grey crop (u8); recognize() turns it into ink inside the batch.
  return resize({ data: crop, width: cw, height: ch }, outW, height, ch > height ? "area" : "linear")
}

function widthBatches(widths, maxBatch = 64, maxRatio = 1.3, minWidth = 64, maxArea = 64 * 640) {
  const order = stableArgsort(widths)
  const batches = []
  for (const i of order) {
    const last = batches[batches.length - 1]
    const w = Math.max(widths[i], minWidth)
    if (last && last.length < maxBatch && w <= maxRatio * Math.max(widths[last[0]], minWidth) && (last.length + 1) * w <= maxArea) last.push(i)
    else batches.push([i])
  }
  return batches
}

// --------------------------------------------------------------- reading order

function lineFeatures(boxes, W, H, texts) {
  const n = boxes.length
  const f = new Float32Array(n * 16)
  const hs = boxes.map((b) => Math.max(b[3] - b[1], 1e-3))
  const medH = median(hs)
  const isDigit = (c) => /\p{Nd}/u.test(c) || /[²³¹⁰-⁹₀-₉①-⑨]/u.test(c)
  boxes.forEach((b, i) => {
    const w = Math.max(b[2] - b[0], 1e-3), h = hs[i]
    const row = [b[0] / W, b[1] / H, b[2] / W, b[3] / H, (b[0] + b[2]) / (2 * W), (b[1] + b[3]) / (2 * H), w / W, Math.log(h / medH), Math.log(w / h) / 4, (medH / H) * 20]
    const t = Array.from((texts[i] ?? "").trim())
    if (t.length) {
      const head = t.slice(0, 3).join("").replace(/[.)]+$/u, "")
      row.push(Math.log1p(t.length) / 5, t.filter(isDigit).length / t.length,
        "•-–▪◦*·→".includes(t[0]) || (head.length > 0 && Array.from(head).every(isDigit) && t.length > 3) ? 1 : 0,
        t[t.length - 1] === "-" ? 1 : 0, ".!?:;".includes(t[t.length - 1]) ? 1 : 0, /\p{Lu}/u.test(t[0]) ? 1 : 0)
    } else row.push(0, 0, 0, 0, 0, 0)
    f.set(row, i * 16)
  })
  return f
}

// a: n*n row-major pairwise "i before j" logits.
function decodeOrder(a, n, sweeps = 4) {
  if (n <= 1) return Array.from({ length: n }, (_, i) => i)
  const lp = new Float64Array(n * n)
  for (let i = 0; i < n * n; i++) { const x = -a[i]; lp[i] = -(Math.max(0, x) + Math.log1p(Math.exp(-Math.abs(x)))) }
  const key = new Float64Array(n)
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { key[i] -= lp[i * n + j]; key[j] += lp[i * n + j] }
  let order = stableArgsort(key)
  for (let s = 0; s < sweeps; s++) {
    let improved = false
    for (const x of [...order]) {
      const rest = order.filter((v) => v !== x)
      const m = rest.length
      const gains = new Float64Array(m + 1)
      let acc = 0
      for (let k = m - 1; k >= 0; k--) { acc += lp[x * n + rest[k]]; gains[k] = acc }
      acc = 0
      for (let k = 0; k < m; k++) { acc += lp[rest[k] * n + x]; gains[k + 1] += acc }
      const k = argmax(gains)
      const cur = order.indexOf(x)
      if (gains[k] > gains[cur] + 1e-6) { order = [...rest.slice(0, k), x, ...rest.slice(k)]; improved = true }
    }
    if (!improved) break
  }
  return order
}

function orderTopDown(boxes) {
  if (!boxes.length) return []
  const cy = boxes.map((b) => (b[1] + b[3]) / 2)
  const h = Math.max(median(boxes.map((b) => b[3] - b[1])) * 0.5, 1e-3)
  const row = cy.map((c) => roundEven(c / h))
  return Array.from(boxes.keys()).sort((i, j) => row[i] - row[j] || boxes[i][0] - boxes[j][0] || i - j)
}

function orderXycut(boxes) {
  const bestCut = (ids, axis) => {
    const lo = ids.map((i) => boxes[i][axis]), hi = ids.map((i) => boxes[i][axis + 2])
    const o = stableArgsort(lo)
    let end = hi[o[0]], bestGap = 0, bestK = -1
    for (let k = 1; k < o.length; k++) {
      const gap = lo[o[k]] - end
      if (gap > bestGap) { bestGap = gap; bestK = k }
      end = Math.max(end, hi[o[k]])
    }
    return { gap: bestGap, k: bestK, o }
  }
  const rec = (ids) => {
    if (ids.length <= 1) return ids
    const y = bestCut(ids, 1), x = bestCut(ids, 0)
    if (y.k < 0 && x.k < 0) return orderTopDown(ids.map((i) => boxes[i])).map((k) => ids[k])
    const { k, o } = y.gap >= x.gap ? y : x
    return [...rec(o.slice(0, k).map((i) => ids[i])), ...rec(o.slice(k).map((i) => ids[i]))]
  }
  return rec(Array.from(boxes.keys()))
}

// Average-linkage clustering of "same block" logits (order_post._cluster).
function cluster(logits, n) {
  if (!n) return []
  const S = Float64Array.from(logits)
  for (let i = 0; i < n; i++) S[i * n + i] = 0
  const size = new Float64Array(n).fill(1)
  const alive = new Uint8Array(n).fill(1)
  const members = Array.from({ length: n }, (_, i) => [i])
  const M = Float64Array.from(S)
  for (let i = 0; i < n; i++) M[i * n + i] = -Infinity
  const best = new Int32Array(n), bestV = new Float64Array(n)
  const rowArgmax = (j) => { let k = 0; for (let c = 1; c < n; c++) if (M[j * n + c] > M[j * n + k]) k = c; return k }
  for (let j = 0; j < n; j++) { best[j] = rowArgmax(j); bestV[j] = M[j * n + best[j]] }
  for (let it = 0; it < n - 1; it++) {
    let a = argmax(bestV)
    let b = best[a]
    if (bestV[a] <= 0) break
    if (a > b) [a, b] = [b, a]
    for (let c = 0; c < n; c++) S[a * n + c] += S[b * n + c]
    for (let r = 0; r < n; r++) S[r * n + a] += S[r * n + b]
    S[a * n + a] = 0
    size[a] += size[b]
    alive[b] = 0
    members[a].push(...members[b])
    const row = new Float64Array(n)
    for (let c = 0; c < n; c++) row[c] = alive[c] && c !== a ? S[a * n + c] / (size[a] * size[c]) : -Infinity
    for (let c = 0; c < n; c++) { M[a * n + c] = row[c]; M[c * n + a] = row[c]; M[b * n + c] = -Infinity; M[c * n + b] = -Infinity }
    bestV[b] = -Infinity
    best[a] = argmax(row)
    bestV[a] = row[best[a]]
    for (let j = 0; j < n; j++) {
      if (!alive[j] || j === a || (best[j] !== a && best[j] !== b)) continue
      best[j] = rowArgmax(j)
      bestV[j] = M[j * n + best[j]]
    }
    for (let j = 0; j < n; j++) if (alive[j] && j !== a && row[j] > bestV[j]) { best[j] = a; bestV[j] = row[j] }
  }
  return members.filter((_, i) => alive[i]).map((m) => m.sort((x, y) => x - y))
}

function classOf(block, cls) {
  const sum = new Float64Array(BLOCK_CLASSES.length)
  for (const i of block) for (let c = 0; c < sum.length; c++) sum[c] += cls[i * sum.length + c]
  return argmax(sum)
}

function decodeBlocksOrder(a, same, boxes, cls) {
  const n = boxes.length
  if (n <= 1) return Array.from({ length: n }, (_, i) => i)
  const blocks = cluster(same, n)
  const inner = blocks.map((b) => {
    const bx = b.map((i) => boxes[i])
    const local = GRID.has(classOf(b, cls)) ? orderTopDown(bx) : orderXycut(bx)
    return local.map((k) => b[k])
  })
  const m = blocks.length
  const g = new Float64Array(m * m)
  for (let p = 0; p < m; p++) for (let q = 0; q < m; q++) {
    if (p === q) continue
    let s = 0
    for (const i of blocks[p]) for (const j of blocks[q]) s += a[i * n + j]
    g[p * m + q] = s / (blocks[p].length * blocks[q].length)
  }
  // up - up.T with up the strict upper triangle: antisymmetric block logits.
  const ab = new Float32Array(m * m)
  for (let p = 0; p < m; p++) for (let q = p + 1; q < m; q++) { ab[p * m + q] = g[p * m + q]; ab[q * m + p] = -g[p * m + q] }
  return decodeOrder(ab, m).flatMap((k) => inner[k])
}

function pageBlocks(boxes, texts, order, cls, same, n) {
  const blocks = []
  for (const i of order) {
    const last = blocks[blocks.length - 1]
    if (last && same[last[last.length - 1] * n + i] > 0) last.push(i)
    else blocks.push([i])
  }
  return blocks.map((blk) => {
    const b = blk.map((i) => boxes[i])
    const r = (v) => Math.round(v * 10) / 10
    return { label: BLOCK_CLASSES[classOf(blk, cls)], bbox: [r(Math.min(...b.map((x) => x[0]))), r(Math.min(...b.map((x) => x[1]))), r(Math.max(...b.map((x) => x[2]))), r(Math.max(...b.map((x) => x[3])))], lines: blk }
  })
}

// --------------------------------------------------------------------- engine

// fast: opt-in speed-ups that change arithmetic slightly (shared thumbnail for
// orientation and skew, coarse skew pass at half size). Off = Python parity.
// sessionOptions: an object, or name => object for per-model choices (e.g. det on WebGPU).
// recBatch: { maxBatch, maxArea } for the recognizer's width batches.
// verifyDeskew: when the page is tilted, detect on both the straightened and the
// original page and keep the one with more confident text (box width x score).
// Not in Python: its skew search can lock onto screen moire (a photographed
// monitor read 38 % CER deskewed, 5 % as is). Costs one detection on tilted pages.
export async function createIndra({ ort, load, sessionOptions = {}, fast = false, recBatch = {}, detLongSide, verifyDeskew = false, wasmKernels = true } = {}) {
  // wasmKernels: run the skew search and deskew warp in WebAssembly (bit-identical).
  if (wasmKernels) await initWasm()
  else disableWasm()
  const options = { executionProviders: ["wasm"], graphOptimizationLevel: "all", ...sessionOptions }
  const session = async (name) => ort.InferenceSession.create(await load(name), typeof sessionOptions === "function" ? { executionProviders: ["wasm"], graphOptimizationLevel: "all", ...sessionOptions(name) } : options)
  const meta = JSON.parse(new TextDecoder().decode(await load("meta.json")))
  const vocab = makeVocab(meta.vocab)
  // One at a time: the WebGPU build of onnxruntime-web fails ("multiple calls to
  // initWasm()") when its first sessions are created concurrently.
  const sessions = []
  for (const name of ["det.onnx", "rec.onnx", "order.onnx", "orient.onnx"]) sessions.push(await session(name))
  const [det, rec, order, orient] = sessions
  // detLongSide: detector input size (default meta.det_long_side, 1024); experiments only.
  const longSide = detLongSide ?? meta.det_long_side
  const isSpace = (id) => id === vocab.spaceId
  const tensor = (type, data, dims) => new ort.Tensor(type, data, dims)

  async function orientation(gray) {
    const small = thumb(gray, ORIENT_SIDE)
    const x = inkMap(small, ORIENT_SIDE, ORIENT_SIDE)
    const out = await orient.run({ x: tensor("float32", x, [1, 1, ORIENT_SIDE, ORIENT_SIDE]) })
    const p = out.p.data
    const k = argmax(p)
    return p[k] > ORIENT_MIN ? k : 0
  }

  async function detectAt(gray, side) {
    const input = pageToInput(gray, side)
    const out = await det.run({ x: tensor("float32", input.data, [1, 1, input.height, input.width]) })
    const [, , h, w] = out.out.dims
    return { boxes: decodeDet(out.out.data, h, w), scale: input.scale }
  }

  async function detect(gray) {
    let { boxes, scale } = await detectAt(gray, longSide)
    if (boxes.length >= 8) {
      const medH = median(boxes.map((b) => b[3] - b[1]))
      if (medH < ADAPTIVE_MIN_H) {
        const ls = Math.floor(Math.floor(Math.min(ADAPTIVE_MAX_SIDE, (longSide * ADAPTIVE_TARGET_H) / Math.max(medH, 1))) / 32) * 32
        if (ls > longSide) ({ boxes, scale } = await detectAt(gray, ls))
      }
    }
    return boxes.map((b) => [
      Math.min(gray.width, Math.max(0, b[0] / scale)), Math.min(gray.height, Math.max(0, b[1] / scale)),
      Math.min(gray.width, Math.max(0, b[2] / scale)), Math.min(gray.height, Math.max(0, b[3] / scale)), b[4]
    ])
  }

  // Per box: { text, conf, toks: [[id, pageX]] }.
  async function recognize(gray, boxes, batch = 64) {
    const crops = boxes.map((b) => cropLine(gray, b))
    const out = boxes.map(() => ({ text: "", conf: 0, toks: [] }))
    for (const idx of widthBatches(crops.map((c) => c.width), recBatch.maxBatch ?? batch, 1.3, 64, recBatch.maxArea ?? 64 * 640)) {
      const wm = Math.ceil(Math.max(...idx.map((j) => crops[j].width)) / WIDTH_MULTIPLE) * WIDTH_MULTIPLE
      // Ink (1 - grey / 255) written straight from the u8 crops, right-padded
      // with 0: a page's crops stay u8 (a quarter of float) until batched.
      const x = new Float32Array(idx.length * LINE_HEIGHT * wm)
      const widths = new BigInt64Array(idx.length)
      idx.forEach((j, k) => {
        const c = crops[j]
        for (let y = 0; y < LINE_HEIGHT; y++) {
          const src = y * c.width, dst = (k * LINE_HEIGHT + y) * wm
          for (let i = 0; i < c.width; i++) x[dst + i] = 1 - c.data[src + i] / 255
        }
        widths[k] = BigInt(c.width)
      })
      const res = await rec.run({ x: tensor("float32", x, [idx.length, 1, LINE_HEIGHT, wm]), widths: tensor("int64", widths, [idx.length]) })
      const T = res.ids.dims[1]
      const stride = wm / Math.max(T, 1)
      idx.forEach((j, k) => {
        const n = Number(res.lengths.data[k])
        const [x0, , x1] = boxes[j]
        const h = Math.max(1, boxes[j][3] - boxes[j][1])
        const ix0 = Math.floor(x0 - PAD_X * h)
        const f = (Math.ceil(x1 + PAD_X * h) - ix0) / crops[j].width
        const ids = [], toks = []
        let confSum = 0
        for (let t = 0; t < n; t++) {
          const id = Number(res.ids.data[k * T + t])
          if (id === 0 || (t > 0 && id === Number(res.ids.data[k * T + t - 1]))) continue
          ids.push(id)
          toks.push([id, ix0 + (t + 0.5) * stride * f])
          confSum += res.conf.data[k * T + t]
        }
        const conf = ids.length ? confSum / ids.length : 0
        out[j] = conf >= MIN_CONF ? { text: vocab.decode(ids), conf, toks } : { text: "", conf, toks: [] }
      })
    }
    return out
  }

  function gutterCuts(boxes, recs) {
    return boxes.map((b, i) => {
      const h = Math.max(1, b[3] - b[1])
      const xs = recs[i].toks.filter((t) => !isSpace(t[0])).map((t) => t[1])
      const mine = []
      for (let k = 0; k + 1 < xs.length; k++) {
        const a = xs[k], c = xs[k + 1]
        if (c - a <= GUTTER_GAP * h) continue
        const gl = a + 0.35 * h, gr = c - 0.35 * h
        let near = 0
        boxes.forEach((o, j) => { if (j !== i && (Math.abs(o[2] - gl) < 0.5 * h || Math.abs(o[0] - gr) < 0.5 * h)) near++ })
        if (near >= GUTTER_EDGES) mine.push((a + c) / 2)
      }
      return mine
    })
  }

  function splitLine(box, toks, gap, at) {
    const h = Math.max(1, box[3] - box[1])
    const segs = [[]]
    let prev = null
    for (const tk of toks) {
      const x = tk[1]
      if (!isSpace(tk[0])) {
        if (prev !== null && (x - prev > gap * h || at.some((c) => prev < c && c < x))) segs.push([])
        prev = x
      }
      segs[segs.length - 1].push(tk)
    }
    if (segs.length === 1) return [{ box: box.slice(0, 4), text: vocab.decode(toks.map((t) => t[0])), toks }]
    const out = []
    for (const sg of segs) {
      const text = vocab.decode(sg.map((t) => t[0])).trim()
      const xs = sg.filter((t) => !isSpace(t[0])).map((t) => t[1])
      if (text && xs.length) out.push({ box: [Math.max(box[0], Math.min(...xs) - 0.35 * h), box[1], Math.min(box[2], Math.max(...xs) + 0.35 * h), box[3]], text, toks: sg })
    }
    return out
  }

  async function readingOrder(boxes, texts, W, H) {
    const n = boxes.length
    if (n < 2) return { order: n ? orderXycut(boxes) : [] }
    const feats = lineFeatures(boxes, W, H, texts)
    const out = await order.run({ feats: tensor("float32", feats, [1, n, 16]), mask: tensor("bool", new Uint8Array(n).fill(1), [1, n]) })
    const a = out.a.data, cls = out.cls.data, same = out.same.data
    return { order: decodeBlocksOrder(a, same, boxes, cls), cls, same }
  }

  // gray: { data: Uint8Array, width, height }. Returns lines in reading order
  // ({ box: [x0, y0, x1, y1], text, conf, words }), layout blocks and timings.
  async function ocr(input, { turn = true } = {}) {
    const t = {}
    let t0 = now()
    let gray = input
    // fast: one 800 px thumbnail feeds both orientation (resized to 768) and skew.
    let small = fast ? thumb(gray, 800) : null
    const k = turn ? await orientation(small ?? gray) : 0
    if (k) { gray = rotate90cw(gray, k); if (small) small = rotate90cw(small, k) }
    t.turn_ms = now() - t0
    let t1 = now()
    let skew = skewFromThumb(small ?? thumb(gray, 800), fast)
    t.skew_ms = now() - t1
    t1 = now()
    let detected = null
    if (Math.abs(skew) >= DESKEW_MIN) {
      const straight = warpAffine(gray, rotationMatrix(gray.width / 2, gray.height / 2, skew), "replicate")
      if (verifyDeskew) {
        // Keep the deskew only if the detector finds at least as much confident
        // text on the straightened page (box width x score) as on the original.
        const coverage = (boxes) => boxes.reduce((sum, b) => sum + (b[2] - b[0]) * b[4], 0)
        const t2 = now()
        const [onStraight, onOriginal] = [await detect(straight), await detect(gray)]
        t.verify_ms = now() - t2
        if (coverage(onStraight) >= coverage(onOriginal)) { gray = straight; detected = onStraight } else { skew = 0; detected = onOriginal }
      } else gray = straight
    } else skew = 0
    t.deskew_ms = now() - t1
    t.orient_ms = now() - t0
    t0 = now()
    detected ??= await detect(gray)
    t.det_ms = now() - t0
    t0 = now()
    const recs = await recognize(gray, detected)
    t.rec_ms = now() - t0
    t0 = now()
    const cuts = gutterCuts(detected, recs)
    const parts = detected.flatMap((b, i) => splitLine(b, recs[i].toks, SPLIT_GAP, cuts[i]).map((p) => ({ ...p, conf: recs[i].conf })))
    const boxes = parts.map((p) => p.box)
    const texts = parts.map((p) => p.text)
    const { order: ord, cls, same } = await readingOrder(boxes, texts, gray.width, gray.height)
    t.order_ms = now() - t0
    const lines = ord.map((i) => ({ box: boxes[i].map((v) => Math.round(v * 10) / 10), text: parts[i].text, conf: Math.round(parts[i].conf * 1e4) / 1e4, toks: parts[i].toks }))
    const blocks = cls ? pageBlocks(boxes, texts, ord, cls, same, boxes.length) : []
    for (const ln of lines) { ln.words = words(ln, skew, gray); ln.quad = unrotateQuad(ln.box, skew, gray.width, gray.height); delete ln.toks }
    if (skew) {
      for (const ln of lines) ln.box = unrotateBox(ln.box, skew, gray.width, gray.height)
      for (const b of blocks) b.bbox = unrotateBox(b.bbox, skew, gray.width, gray.height)
    }
    t.total_ms = t.orient_ms + t.det_ms + t.rec_ms + t.order_ms
    return { lines, blocks, rotation: 90 * k, skew: Math.round(skew * 100) / 100, timings: t }
  }

  // Word boxes from CTC character positions: the line's y-extent, x from the
  // first to the last character centre of each space-separated run, widened by
  // half a character pitch. Built in the deskewed page, then mapped back.
  function words(line, skew, gray) {
    const toks = line.toks
    if (!toks.length) return []
    const [x0, y0, x1, y1] = line.box
    const out = []
    let cur = []
    const flush = () => {
      if (!cur.length) return
      const xs = cur.map((t) => t[1])
      const pitch = cur.length > 1 ? (xs[xs.length - 1] - xs[0]) / (cur.length - 1) : (y1 - y0) * 0.5
      const upright = [Math.max(x0, xs[0] - pitch / 2), y0, Math.min(x1, xs[xs.length - 1] + pitch / 2), y1]
      const quad = unrotateQuad(upright, skew, gray.width, gray.height)
      const box = skew ? unrotateBox(upright, skew, gray.width, gray.height) : upright.map((v) => Math.round(v * 10) / 10)
      out.push({ text: vocab.decode(cur.map((t) => t[0])), box, quad })
      cur = []
    }
    for (const tk of toks) { if (isSpace(tk[0])) flush(); else cur.push(tk) }
    flush()
    return out
  }

  return { ocr, version: "indra-js 0.1 (port of indra-ocr 0.3.1)" }
}
