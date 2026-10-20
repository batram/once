// The OpenCV operations Indra's pipeline uses, on plain typed arrays.
// Images are { data, width, height } with one channel (Uint8Array for pages,
// Float32Array for ink maps). Coordinate rules follow OpenCV (half-pixel
// centres, area tables, 1/32 px warp quantization); arithmetic is float, so
// results can differ from OpenCV's fixed-point paths by one grey level.

// cv2 IMREAD_GRAYSCALE / cvtColor BGR2GRAY: 14-bit fixed-point BT.601 weights.
export function grayFromRgba(rgba, width, height) {
  const out = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    out[i] = (rgba[j] * 4899 + rgba[j + 1] * 9617 + rgba[j + 2] * 1868 + 8192) >> 14
  }
  return { data: out, width, height }
}

// cvRound: round half to even.
export function roundEven(v) {
  const r = Math.round(v)
  return Math.abs(v % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

const clampU8 = (v) => (v <= 0 ? 0 : v >= 255 ? 255 : roundEven(v))

// OpenCV computeResizeAreaTab, flattened: destination d takes source
// src[start[d] .. start[d + 1]) with weights w[...].
function areaTable(ssize, dsize) {
  const scale = ssize / dsize
  const src = [], w = []
  const start = new Int32Array(dsize + 1)
  for (let dx = 0; dx < dsize; dx++) {
    start[dx] = src.length
    const fsx1 = dx * scale
    const fsx2 = fsx1 + scale
    const cell = Math.min(scale, ssize - fsx1)
    let sx1 = Math.ceil(fsx1)
    let sx2 = Math.floor(fsx2)
    sx2 = Math.min(sx2, ssize - 1)
    sx1 = Math.min(sx1, sx2)
    if (sx1 - fsx1 > 1e-3) { src.push(sx1 - 1); w.push((sx1 - fsx1) / cell) }
    for (let sx = sx1; sx < sx2; sx++) { src.push(sx); w.push(1 / cell) }
    if (fsx2 - sx2 > 1e-3) { src.push(sx2); w.push(Math.min(Math.min(fsx2 - sx2, 1), cell) / cell) }
  }
  start[dsize] = src.length
  return { src: Int32Array.from(src), w: Float64Array.from(w), start }
}

// OpenCV linear coordinate: source index and fraction for each destination index.
function linearTable(ssize, dsize) {
  const scale = ssize / dsize
  const idx = new Int32Array(dsize)
  const frac = new Float64Array(dsize)
  for (let d = 0; d < dsize; d++) {
    let f = (d + 0.5) * scale - 0.5
    let s = Math.floor(f)
    f -= s
    if (s < 0) { s = 0; f = 0 }
    if (s >= ssize - 1) { s = ssize - 1; f = 0 }
    idx[d] = s
    frac[d] = f
  }
  return { idx, frac }
}

// cv2.resize for one channel. interp: "area" | "linear". Output type follows input.
export function resize(img, dw, dh, interp) {
  const { data, width: sw, height: sh } = img
  const isU8 = data instanceof Uint8Array
  const out = isU8 ? new Uint8Array(dw * dh) : new Float32Array(dw * dh)
  // OpenCV takes the area path only when no axis is enlarged.
  if (interp === "area" && sw >= dw && sh >= dh) {
    const tx = areaTable(sw, dw)
    const ty = areaTable(sh, dh)
    // Horizontal pass per source row, streamed into the vertical pass: a
    // destination row reads increasing source rows and shares at most its first
    // with the previous one, so two cached rows replace a sh x dw buffer. Same
    // sums in the same order as a full horizontal pass.
    const rows = [new Float64Array(dw), new Float64Array(dw)]
    const rowOf = [-1, -1]
    const hrow = (sy) => {
      const slot = rowOf[0] === sy ? 0 : rowOf[1] === sy ? 1 : -1
      if (slot >= 0) return rows[slot]
      const into = rowOf[0] < rowOf[1] ? 0 : 1 // replace the older row
      const r = rows[into], base = sy * sw
      for (let dx = 0; dx < dw; dx++) {
        let s = 0
        for (let k = tx.start[dx], e = tx.start[dx + 1]; k < e; k++) s += data[base + tx.src[k]] * tx.w[k]
        r[dx] = s
      }
      rowOf[into] = sy
      return r
    }
    const acc = new Float64Array(dw)
    for (let dy = 0; dy < dh; dy++) {
      acc.fill(0)
      for (let k = ty.start[dy], e = ty.start[dy + 1]; k < e; k++) {
        const r = hrow(ty.src[k]), wy = ty.w[k]
        for (let dx = 0; dx < dw; dx++) acc[dx] += r[dx] * wy
      }
      for (let dx = 0; dx < dw; dx++) out[dy * dw + dx] = isU8 ? clampU8(acc[dx]) : acc[dx]
    }
    return { data: out, width: dw, height: dh }
  }
  const lx = linearTable(sw, dw)
  const ly = linearTable(sh, dh)
  for (let dy = 0; dy < dh; dy++) {
    const y0 = ly.idx[dy]
    const y1 = Math.min(y0 + 1, sh - 1)
    const fy = ly.frac[dy]
    for (let dx = 0; dx < dw; dx++) {
      const x0 = lx.idx[dx]
      const x1 = Math.min(x0 + 1, sw - 1)
      const fx = lx.frac[dx]
      const top = data[y0 * sw + x0] * (1 - fx) + data[y0 * sw + x1] * fx
      const bot = data[y1 * sw + x0] * (1 - fx) + data[y1 * sw + x1] * fx
      const v = top * (1 - fy) + bot * fy
      out[dy * dw + dx] = isU8 ? clampU8(v) : v
    }
  }
  return { data: out, width: dw, height: dh }
}

// cv2.getRotationMatrix2D: 2x3 row-major.
export function rotationMatrix(cx, cy, degrees, scale = 1) {
  const a = (degrees * Math.PI) / 180
  const alpha = Math.cos(a) * scale
  const beta = Math.sin(a) * scale
  return [alpha, beta, (1 - alpha) * cx - beta * cy, -beta, alpha, beta * cx + (1 - alpha) * cy]
}

function invertAffine(m) {
  const [a, b, c, d, e, f] = m
  const det = a * e - b * d
  const ia = e / det, ib = -b / det, id = -d / det, ie = a / det
  return [ia, ib, -(ia * c + ib * f), id, ie, -(id * c + ie * f)]
}

// OpenCV's warpAffine coordinate scheme (imgwarp.cpp): the inverse map in
// 1/1024 px fixed point, per-column offsets precomputed, per-row origin plus a
// rounding delta, then shifted to 1/32 px (INTER_TAB_SIZE) for the weights.
function affineFixedPoint(m, w) {
  const [a, b, c, d, e, f] = invertAffine(m)
  const adelta = new Int32Array(w), bdelta = new Int32Array(w)
  for (let x = 0; x < w; x++) { adelta[x] = roundEven(a * x * 1024); bdelta[x] = roundEven(d * x * 1024) }
  return { adelta, bdelta, row: (y) => [roundEven((b * y + c) * 1024) + 16, roundEven((e * y + f) * 1024) + 16] }
}

// ------------------------------------------------ WebAssembly kernels (wasm/)
// warp.wat holds the two hot loops (skew row sums, u8 deskew warp) with the
// same arithmetic as the JS below, so results are bit-identical. JS JITs differ
// a lot on these loops (SpiderMonkey ~2.5x slower than V8); WASM does not.

let compiled = null // the WebAssembly.Module, kept for cheap re-instantiation
let instance = null // its exports; dropped after big jobs so the memory is freed
let resident = null // the ink map currently copied into kernel memory
const K = () => (instance ??= new WebAssembly.Instance(compiled).exports)
// WebAssembly memory never shrinks: after a job grew it past this, drop the
// instance (re-instantiating the 1.4 KB module takes microseconds) so a large
// page does not keep two page-sized buffers alive.
const KEEP_BYTES = 4 << 20
function releaseIfLarge() { if (instance && instance.memory.buffer.byteLength > KEEP_BYTES) { instance = null; resident = null } }

// Compiles the kernels; without this call (or after disableWasm) the JS
// versions run.
export async function initWasm() {
  if (compiled) return
  const { warpWasmBase64 } = await import("./wasm/warp-wasm.mjs")
  compiled = await WebAssembly.compile(Uint8Array.from(atob(warpWasmBase64), (c) => c.charCodeAt(0)))
}
export const disableWasm = () => { compiled = null; instance = null; resident = null }

// Lays out byte regions in the kernel memory (8-byte aligned), growing it when
// needed.
function layout(sizes) {
  const offsets = []
  let end = 0
  for (const n of sizes) { offsets.push(end); end += Math.ceil(n / 8) * 8 }
  const have = K().memory.buffer.byteLength
  if (end > have) K().memory.grow(Math.ceil((end - have) / 65536))
  return offsets
}

function writeAffine(m, w, h, adOff, bdOff, x0Off, y0Off) {
  const { adelta, bdelta, row } = affineFixedPoint(m, w)
  const buf = K().memory.buffer
  new Int32Array(buf, adOff, w).set(adelta)
  new Int32Array(buf, bdOff, w).set(bdelta)
  const x0 = new Int32Array(buf, x0Off, h), y0 = new Int32Array(buf, y0Off, h)
  for (let y = 0; y < h; y++) { const [X0, Y0] = row(y); x0[y] = X0; y0[y] = Y0 }
}

// For one ink map, a function m => row sums of its warp (warpRowSums). With the
// kernels the ink is copied into WebAssembly memory once, not once per angle.
export function rowSumsFor(img) {
  if (!compiled) return (m) => warpRowSums(img, m)
  const { data, width: w, height: h } = img
  return (m) => {
    const [ink, ad, bd, x0, y0, out] = layout([w * h * 4, w * 4, w * 4, h * 4, h * 4, h * 8])
    // Several ink maps (coarse half-size and full) share the memory, and the
    // instance may have been dropped: re-copy when this map is not resident.
    if (resident !== img) { new Float32Array(K().memory.buffer, ink, w * h).set(data); resident = img }
    writeAffine(m, w, h, ad, bd, x0, y0)
    K().rowsums(ink, w, h, ad, bd, x0, y0, out)
    return new Float64Array(K().memory.buffer, out, h).slice()
  }
}

// cv2.warpAffine with INTER_LINEAR into an image of the same size.
// border: "constant" (0) or "replicate".
export function warpAffine(img, m, border = "constant") {
  const { data, width: w, height: h } = img
  const isU8 = data instanceof Uint8Array
  if (isU8 && compiled) {
    const [src, dst, ad, bd, x0, y0] = layout([w * h, w * h, w * 4, w * 4, h * 4, h * 4])
    resident = null
    new Uint8Array(K().memory.buffer, src, w * h).set(data)
    writeAffine(m, w, h, ad, bd, x0, y0)
    K().warp_u8(src, dst, w, h, ad, bd, x0, y0, border === "replicate" ? 1 : 0)
    const out = new Uint8Array(K().memory.buffer, dst, w * h).slice()
    releaseIfLarge()
    return { data: out, width: w, height: h }
  }
  const out = isU8 ? new Uint8Array(w * h) : new Float32Array(w * h)
  const { adelta, bdelta, row } = affineFixedPoint(m, w)
  const replicate = border === "replicate"
  const px = (x, y) => {
    if (x >= 0 && y >= 0 && x < w && y < h) return data[y * w + x]
    if (!replicate) return 0
    return data[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
  }
  for (let y = 0; y < h; y++) {
    const [X0, Y0] = row(y)
    for (let x = 0; x < w; x++) {
      const X = (X0 + adelta[x]) >> 5, Y = (Y0 + bdelta[x]) >> 5
      const ix = X >> 5, iy = Y >> 5
      const fx = (X & 31) / 32, fy = (Y & 31) / 32
      let v
      if (ix >= 0 && iy >= 0 && ix < w - 1 && iy < h - 1) {
        const i = iy * w + ix
        v = (data[i] * (1 - fx) + data[i + 1] * fx) * (1 - fy) + (data[i + w] * (1 - fx) + data[i + w + 1] * fx) * fy
      } else if (!replicate && (ix < -1 || iy < -1 || ix >= w || iy >= h)) v = 0
      else v = (px(ix, iy) * (1 - fx) + px(ix + 1, iy) * fx) * (1 - fy) + (px(ix, iy + 1) * (1 - fx) + px(ix + 1, iy + 1) * fx) * fy
      out[y * w + x] = isU8 ? clampU8(v) : v
    }
  }
  return { data: out, width: w, height: h }
}

// Row sums of warpAffine(img, m) with a constant-0 border, without building the
// warped image: the same sampling as warpAffine, accumulated per row.
export function warpRowSums(img, m) {
  const { data, width: w, height: h } = img
  const { adelta, bdelta, row } = affineFixedPoint(m, w)
  const sums = new Float64Array(h)
  const tap = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? data[y * w + x] : 0)
  for (let y = 0; y < h; y++) {
    const [X0, Y0] = row(y)
    let s = 0
    for (let x = 0; x < w; x++) {
      const X = (X0 + adelta[x]) >> 5, Y = (Y0 + bdelta[x]) >> 5
      const ix = X >> 5, iy = Y >> 5
      if (ix >= 0 && iy >= 0 && ix < w - 1 && iy < h - 1) {
        const i = iy * w + ix
        const t0 = data[i], t1 = data[i + 1], b0 = data[i + w], b1 = data[i + w + 1]
        // Paper is 0 ink: most of a page samples four zeros.
        if (t0 === 0 && t1 === 0 && b0 === 0 && b1 === 0) continue
        const fx = (X & 31) / 32, fy = (Y & 31) / 32
        s += (t0 + (t1 - t0) * fx) * (1 - fy) + (b0 + (b1 - b0) * fx) * fy
      } else if (ix >= -1 && iy >= -1 && ix < w && iy < h) {
        const fx = (X & 31) / 32, fy = (Y & 31) / 32
        s += (tap(ix, iy) * (1 - fx) + tap(ix + 1, iy) * fx) * (1 - fy) + (tap(ix, iy + 1) * (1 - fx) + tap(ix + 1, iy + 1) * fx) * fy
      }
    }
    sums[y] = s
  }
  return sums
}

// cv2.connectedComponentsWithStats(mask, connectivity=4): labels numbered in
// raster order of each component's first pixel (0 = background).
export function connectedComponents(mask, w, h) {
  const parent = new Int32Array(w * h).fill(-1)
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!mask[i]) continue
      parent[i] = i
      const up = y > 0 && mask[i - w] ? find(i - w) : -1
      const left = x > 0 && mask[i - 1] ? find(i - 1) : -1
      if (up >= 0 && left >= 0) {
        const r = Math.min(up, left)
        parent[up] = r; parent[left] = r; parent[i] = r
      } else if (up >= 0) parent[i] = up
      else if (left >= 0) parent[i] = left
    }
  }
  const labels = new Int32Array(w * h)
  const ids = new Map()
  const stats = [null]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (!mask[i]) continue
      const r = find(i)
      let id = ids.get(r)
      if (id === undefined) { id = stats.length; ids.set(r, id); stats.push({ left: x, right: x, area: 0 }) }
      labels[i] = id
      const s = stats[id]
      if (x < s.left) s.left = x
      if (x > s.right) s.right = x
      s.area++
    }
  }
  return { n: stats.length, labels, stats }
}

// np.rot90(gray, -k): k quarter turns clockwise.
export function rotate90cw(img, k) {
  let cur = img
  for (let t = 0; t < ((k % 4) + 4) % 4; t++) {
    const { data, width: w, height: h } = cur
    const out = new data.constructor(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = data[y * w + x]
    cur = { data: out, width: h, height: w }
  }
  return cur
}
