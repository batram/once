const test = require("node:test")
const assert = require("node:assert/strict")
const { ocrParagraphs } = require("../../../packages/app/dist/ocrParagraphs")

function recognize(lines, boxes) {
  return { lines, lineBounds: boxes.map(([x, y, width, height = 16]) => ({ x, y, width, height })) }
}

test("OCR joins wrapped sentences and multiple sentences within a visual paragraph", () => {
  const result = recognize([
    "There are two schools of thought. By far the",
    "most common way is chain of command, which means that you always",
    "flow communication through your manager.",
    "Instead of a problem getting solved quickly, people are forced",
    "to talk to their manager."
  ], [[20, 20, 600], [20, 46, 600], [20, 72, 420], [20, 118, 600], [20, 144, 250]])
  assert.deepEqual(ocrParagraphs(result), [
    "There are two schools of thought. By far the most common way is chain of command, which means that you always flow communication through your manager.",
    "Instead of a problem getting solved quickly, people are forced to talk to their manager."
  ])
})

test("OCR preserves headings, paragraph gaps and list starts while joining wrapped items", () => {
  const result = recognize(["Subject: A memo", "A long introductory paragraph that", "continues here.",
    "1. Read the book on writing and", "read it three times.", "2. Write naturally."],
  [[20, 10, 180], [20, 50, 600], [20, 76, 150], [20, 122, 440], [35, 148, 220], [20, 174, 220]])
  assert.deepEqual(ocrParagraphs(result), ["Subject: A memo", "A long introductory paragraph that continues here.",
    "1. Read the book on writing and read it three times.", "2. Write naturally."])
})

test("OCR avoids merging columns and differently sized headings", () => {
  assert.deepEqual(ocrParagraphs(recognize(["Column one", "column two"], [[20, 20, 200], [350, 46, 200]])), ["Column one", "column two"])
  assert.deepEqual(ocrParagraphs(recognize(["A heading", "body text begins"], [[20, 20, 250, 30], [20, 56, 400, 16]])), ["A heading", "body text begins"])
})

test("text-only OCR only joins clear continuations, preserving headings and lists", () => {
  assert.deepEqual(ocrParagraphs({ lines: ["Subject: A memo", "A sentence wraps", "within a paragraph.", "Another paragraph.", "1. A list", "continues here", "2. Next item"] }),
    ["Subject: A memo", "A sentence wraps within a paragraph.", "Another paragraph.", "1. A list continues here", "2. Next item"])
})

test("line-end hyphens do not gain a spurious space, and soft hyphens are removed", () => {
  assert.deepEqual(ocrParagraphs({ lines: ["A well-", "known fact.", "Communica\u00ad", "tion matters."] }), ["A well-known fact.", "Communication matters."])
})

test("missing, invalid or empty bounds fall back safely without losing text", () => {
  assert.deepEqual(ocrParagraphs({ lines: [" A sentence ", "", "continues here.", "End."], lineBounds: [{ x: 0, y: 0, width: NaN, height: 10 }] }),
    ["A sentence continues here.", "End."])
})

test("memo paragraph gaps remain distinct even when only ten pixels larger than line gaps", () => {
  // Representative Vision bounds from the Tesla memo: 18px glyphs, 28px line
  // steps, and 38px steps at paragraph boundaries.
  const result = recognize(["Subject: Communication Within Tesla", "There are two schools of thought. By far the",
    "most common way is chain of command,", "through your manager.", "Instead of a problem getting solved quickly,",
    "people are forced to talk to their manager."],
  [[12, 12, 266, 18], [14, 50, 692, 18], [12, 78, 656, 18], [12, 106, 320, 18], [12, 144, 702, 18], [12, 172, 700, 18]])
  assert.deepEqual(ocrParagraphs(result), ["Subject: Communication Within Tesla",
    "There are two schools of thought. By far the most common way is chain of command, through your manager.",
    "Instead of a problem getting solved quickly, people are forced to talk to their manager."])
})
