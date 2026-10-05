const assert = require("node:assert/strict")
const test = require("node:test")
const {
  normalizeReaderTtsPreferences,
  readerTtsRateForVoice
} = require("../../../packages/ui-web/dist/reader/readerTtsPreferences")

test("reader speech speeds are kept per voice, falling back to the default voice's", () => {
  const preferences = normalizeReaderTtsPreferences({
    voice: "aria",
    rates: { "": 1.5, aria: 2.5, broken: 40, text: "2" }
  })
  assert.deepEqual(preferences, { voice: "aria", rates: { "": 1.5, aria: 2.5 } })
  assert.equal(readerTtsRateForVoice(preferences, "aria"), 2.5)
  assert.equal(readerTtsRateForVoice(preferences, "vicki"), 1.5)
  assert.equal(readerTtsRateForVoice(normalizeReaderTtsPreferences(null), "vicki"), 1)
})

test("a single stored speed migrates to the default voice without overriding one", () => {
  assert.deepEqual(normalizeReaderTtsPreferences(null, "1.75"), { voice: "", rates: { "": 1.75 } })
  assert.deepEqual(normalizeReaderTtsPreferences(null, null), { voice: "", rates: {} })
  assert.deepEqual(
    normalizeReaderTtsPreferences({ voice: "", rates: { "": 2 } }, 1.75),
    { voice: "", rates: { "": 2 } }
  )
})
