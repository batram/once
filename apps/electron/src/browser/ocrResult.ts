import type { ImageTextResult, ImageTextPoint } from "@once/ui-web/imageText/imageTextTypes"

const MAX_LINES = 5000
const MAX_WORDS = 20_000
function point(value: ImageTextPoint): boolean {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y) && value.x >= -0.1 && value.x <= 1.1 && value.y >= -0.1 && value.y <= 1.1)
}

/** The native process is another untrusted input boundary; never trust a JSON type assertion. */
export function readOcrResult(value: unknown): ImageTextResult {
  const result = value as ImageTextResult | null
  if (!result || !Array.isArray(result.lines) || !Array.isArray(result.textLines) || !Array.isArray(result.lineBounds) ||
    result.lines.length > MAX_LINES || result.textLines.length !== result.lines.length || result.lineBounds.length !== result.lines.length) throw new Error("Invalid recognition result")
  let words = 0
  for (let index = 0; index < result.lines.length; index++) {
    const line = result.lines[index], text = result.textLines[index], box = result.lineBounds[index]
    if (!Array.isArray(line) || (words += line.length) > MAX_WORDS || typeof text !== "string" || text.length > 10_000 || !box ||
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.x < -410 || box.y < -410 || box.width < 0 || box.height < 0 ||
      box.x > 4506 || box.y > 4506 || box.width > 4506 || box.height > 4506) throw new Error("Invalid recognition geometry")
    for (const word of line) if (!word || typeof word.text !== "string" || word.text.length > 10_000 ||
      !point(word.topLeft) || !point(word.topRight) || !point(word.bottomLeft)) throw new Error("Invalid recognized word")
  }
  return result
}
