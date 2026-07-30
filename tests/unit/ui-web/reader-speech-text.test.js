const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")
const { parseHTML } = require("linkedom")

const source = fs.readFileSync(path.resolve(
  __dirname,
  "../../../packages/ui-web/src/reader/readerSpeechText.ts"
), "utf8")
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const textPolicy = { exports: {} }
Function("exports", "module", compiled)(textPolicy.exports, textPolicy)

test("reader speech normalization removes visual punctuation and simplifies URLs", () => {
  assert.equal(
    textPolicy.exports.normalizeReaderSpeechText(
      "Read\u200B https://www.example.com/story?q=1… A & B — #today!!!"
    ),
    "Read example.com A and B , today!"
  )
})

test("reader speech chunking observes the maximum at sentence and word boundaries", () => {
  assert.deepEqual(
    textPolicy.exports.splitReaderSpeechText("First sentence. Second sentence.", 20),
    ["First sentence.", "Second sentence."]
  )
  assert.deepEqual(
    textPolicy.exports.splitReaderSpeechText("alpha beta gamma", 10),
    ["alpha beta", "gamma"]
  )
})

test("reader speech segmentation uses leaf blocks and preserves their DOM owner", () => {
  const { document } = parseHTML("<article><div><p>First.</p><p>Second.</p></div></article>")
  const paragraphs = document.querySelectorAll("p")
  paragraphs.forEach((paragraph) => { paragraph.innerText = paragraph.textContent })
  const segments = textPolicy.exports.createReaderSpeechSegments(
    document.querySelector("article")
  )
  assert.deepEqual(segments.map(({ text }) => text), ["First.", "Second."])
  assert.equal(segments[0].element, paragraphs[0])
  assert.equal(segments[1].element, paragraphs[1])
})
