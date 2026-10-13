/**
 * A brief "reading" flourish once recognition has found words: a soft sheen
 * of light glides diagonally across the image while the words light up in
 * reading order, each with a gently springing glow that takes its colour
 * from an iridescent ribbon flowing through the text, then melts away.
 * Purely decorative: no pointer events, skipped under reduced motion, and it
 * removes itself when done.
 */

interface Glyph { x: number; y: number; w: number; h: number }

// A blink, not a show: the words are ready to select at once, and anything
// slower (it was 1.6 s) read as waiting after a double click or tap.
const WAVE = 130 // ms for the reading wave to travel from first to last word
const RISE = 80 // ms for a word's glow to spring up
const LINGER = 0 // ms it holds before melting
const MELT = 190 // ms to melt away
const SHEEN = 285 // ms for the light to glide across the image
// Iridescent ribbon along the reading order: blue, violet, pink, peach.
const RIBBON = [[94, 155, 255], [167, 123, 255], [255, 126, 182], [255, 184, 107]]

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3
const easeInOutSine = (t: number) => -(Math.cos(Math.PI * t) - 1) / 2
/** A gentle spring: overshoots ~6% and settles. */
const easeOutBack = (t: number) => 1 + 2.1 * (t - 1) ** 3 + 1.1 * (t - 1) ** 2
const clamp01 = (t: number) => Math.min(1, Math.max(0, t))

function ribbon(at: number): string {
  const position = clamp01(at) * (RIBBON.length - 1)
  const index = Math.min(RIBBON.length - 2, Math.floor(position))
  const mix = position - index
  const [a, b] = [RIBBON[index], RIBBON[index + 1]]
  return a.map((value, channel) => Math.round(value + (b[channel] - value) * mix)).join(", ")
}

/** Mean luminance of the image, or null when it cannot be read (cross-origin). */
function luminance(image: HTMLImageElement): number | null {
  try {
    const probe = document.createElement("canvas")
    probe.width = probe.height = 24
    const context = probe.getContext("2d", { willReadFrequently: true })
    if (!context) return null
    context.drawImage(image, 0, 0, 24, 24)
    const data = context.getImageData(0, 0, 24, 24).data
    let sum = 0
    for (let i = 0; i < data.length; i += 4) sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]
    return sum / (data.length / 4) / 255
  } catch {
    return null
  }
}

function pill(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  context.beginPath()
  context.roundRect(x, y, w, h, h / 2.4)
  context.fill()
}

/** A word's glow: springs up slightly larger than the word, lingers, melts. */
function drawWord(context: CanvasRenderingContext2D, glyph: Glyph, at: number, color: string, peak: number,
  width: number, height: number) {
  if (at <= 0 || at > RISE + LINGER + MELT) return
  const rise = clamp01(at / RISE)
  const alpha = peak * (at < RISE ? easeOutCubic(rise) : 1 - easeInOutSine(clamp01((at - RISE - LINGER) / MELT)))
  if (alpha < 0.004) return
  const scale = 0.82 + 0.18 * easeOutBack(rise)
  const w = glyph.w * width, h = glyph.h * height
  const pad = Math.max(2, h * 0.18)
  const cx = glyph.x * width + w / 2, cy = glyph.y * height + h / 2
  const pw = (w + pad * 2) * scale, ph = (h + pad * 1.4) * scale
  context.fillStyle = `rgba(${color}, ${alpha * 0.35})`
  pill(context, cx - pw / 2 - pad, cy - ph / 2 - pad / 2, pw + pad * 2, ph + pad)
  context.fillStyle = `rgba(${color}, ${alpha})`
  pill(context, cx - pw / 2, cy - ph / 2, pw, ph)
}

/** A wide, soft band of light gliding from the top-left corner to the bottom-right. */
function drawSheen(context: CanvasRenderingContext2D, progress: number, width: number, height: number, tint: string, strength: number) {
  if (progress <= 0 || progress >= 1) return
  const span = width + height
  const center = -0.3 * span + easeInOutSine(progress) * 1.6 * span
  const band = span * 0.22
  const sheen = context.createLinearGradient(center - band, (center - band) * 0.5, center + band, (center + band) * 0.5)
  const a = strength * Math.sin(progress * Math.PI)
  sheen.addColorStop(0, `rgba(${tint}, 0)`)
  sheen.addColorStop(0.5, `rgba(${tint}, ${a})`)
  sheen.addColorStop(1, `rgba(${tint}, 0)`)
  context.fillStyle = sheen
  context.fillRect(0, 0, width, height)
}

/**
 * Starts the flourish over `clip`, the box `image`'s recognized words are drawn
 * in; `wordRects` gives their boxes in viewport pixels. Returns a canceller.
 */
export function playRecognitionScan(image: HTMLImageElement, clip: HTMLElement, wordRects: () => DOMRect[]): () => void {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return () => undefined
  const canvas = document.createElement("canvas")
  canvas.className = "scan"
  canvas.setAttribute("aria-hidden", "true")
  const context = canvas.getContext("2d")
  if (!context) return () => undefined
  clip.append(canvas)
  // Unknown (cross-origin) images are treated as paper: most OCR'd images are documents.
  const lightPage = (luminance(image) ?? 1) > 0.45
  // Paper takes a pastel wash that keeps the ink crisp; dark images a brighter, additive glow.
  const peak = lightPage ? 0.24 : 0.3
  let glyphs: Glyph[] = []
  let frame = 0
  let start = 0

  // Word boxes as fractions of the clip, in reading (DOM) order; zoom or scroll mid-play stays aligned.
  const measure = () => {
    const base = clip.getBoundingClientRect()
    if (!base.width || !base.height) return
    glyphs = wordRects().map((r) => {
      return { x: (r.left - base.left) / base.width, y: (r.top - base.top) / base.height,
        w: r.width / base.width, h: r.height / base.height }
    }).filter((glyph) => glyph.w > 0 && glyph.h > 0)
  }

  const total = WAVE + RISE + LINGER + MELT
  const draw = (now: number) => {
    const width = clip.clientWidth, height = clip.clientHeight
    const ratio = devicePixelRatio || 1
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
    }
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    const elapsed = now - start
    context.globalCompositeOperation = lightPage ? "source-over" : "lighter"
    // White light disappears on paper, so there the sheen is a faint cool gleam.
    drawSheen(context, elapsed / SHEEN, width, height, lightPage ? "120, 165, 255" : "255, 255, 255", lightPage ? 0.08 : 0.07)
    const last = Math.max(1, glyphs.length - 1)
    glyphs.forEach((glyph, index) => {
      // The wave eases through the text: unhurried at the start, settling at the end.
      const at = elapsed - easeInOutSine(index / last) * WAVE
      drawWord(context, glyph, at, ribbon(index / last), peak, width, height)
    })
    if (elapsed < total) frame = requestAnimationFrame(draw)
    else cancel()
  }

  const cancel = () => {
    cancelAnimationFrame(frame)
    canvas.remove()
  }

  // Start once the words are laid out over the image.
  frame = requestAnimationFrame((now) => {
    measure()
    if (!glyphs.length) { cancel(); return }
    start = now
    draw(now)
  })
  return cancel
}
