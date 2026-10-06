const test = require("node:test")
const assert = require("node:assert/strict")

async function history() {
  const { ReadingHistory } = await import("../../../apps/mobile/src/readingHistory.ts")
  return new ReadingHistory()
}

const A = "https://example.com/a"
const B = "https://example.com/b"
const C = "https://example.com/c"
const D = "https://example.com/d"

function shape(value) {
  const { entries, cursor } = value.snapshot()
  return entries.map((entry, index) =>
    `${index === cursor ? ">" : ""}${entry.url.slice(-1)}${entry.reader ? "*" : ""}${entry.native ?? "-"}`)
}

test("Back from Reader mode goes to the previous page, and Forward returns to the reader", async () => {
  const list = await history()
  list.observe("browser", A)
  list.nativeReported([A], 0)
  list.observe("browser", B)
  list.nativeReported([A, B], 1)
  list.observe("reader", B)
  assert.deepEqual(shape(list), ["a0", ">b*1"])

  const back = list.step("back")
  assert.equal(back.entry.url, A)
  assert.equal(back.entry.reader, false)
  assert.equal(back.nativeIndex, 0)
  list.observe("browser", A)
  list.nativeReported([A, B], 0)
  assert.deepEqual(shape(list), [">a0", "b*1"])

  const forward = list.step("forward")
  assert.equal(forward.entry.reader, true)
  assert.equal(forward.nativeIndex, 1)
})

test("a link opened from Reader mode comes back to the reader", async () => {
  const list = await history()
  list.observe("browser", A)
  list.nativeReported([A], 0)
  list.observe("reader", A)
  list.observe("browser", B)
  list.nativeReported([A, B], 1)
  assert.deepEqual(shape(list), ["a*0", ">b1"])

  const back = list.step("back")
  assert.deepEqual([back.entry.url, back.entry.reader, back.nativeIndex], [A, true, 0])
})

test("an article opened straight into Reader mode is an entry of its own", async () => {
  const list = await history()
  list.observe("reader", A)
  assert.equal(list.canStep("back"), false)
  list.observe("browser", B)
  list.nativeReported([B], 0)
  assert.deepEqual(shape(list), ["a*-", ">b0"])

  // The native page has nothing before B, so the reader is the shell's to show.
  assert.equal(list.nativeMayStep("back"), false)
  const back = list.step("back")
  assert.deepEqual([back.entry.url, back.entry.reader, back.nativeIndex], [A, true, null])
  list.observe("reader", A)

  // Another link from that reader replaces B; the page left behind is no entry.
  list.observe("browser", C)
  list.nativeReported([B, C], 1)
  assert.deepEqual(shape(list), ["a*-", ">c1"])
})

test("a reader opened in a tab with history goes back to the page before it", async () => {
  const list = await history()
  list.observe("browser", A)
  list.nativeReported([A], 0)
  list.observe("reader", B)
  list.observe("browser", C)
  list.nativeReported([A, C], 1)
  assert.deepEqual(shape(list), ["a0", "b*-", ">c1"])

  // Back to the Reader-only entry moves the hidden page to A, its home.
  const toReader = list.step("back")
  assert.deepEqual([toReader.entry.url, toReader.nativeIndex], [B, 0])
  list.observe("reader", B)
  assert.equal(list.nativeReported([A, C], 0), null)
  assert.deepEqual(shape(list), ["a0", ">b*-", "c1"])

  // A then needs no native move; Forward twice walks to C again.
  const toA = list.step("back")
  assert.deepEqual([toA.entry.url, toA.nativeIndex], [A, null])
  list.observe("browser", A)
  list.step("forward")
  list.observe("reader", B)
  const toC = list.step("forward")
  assert.deepEqual([toC.entry.url, toC.nativeIndex], [C, 1])
})

test("the page moving through its own history moves the list with it", async () => {
  const list = await history()
  list.observe("browser", A)
  list.nativeReported([A], 0)
  list.observe("browser", B)
  list.nativeReported([A, B], 1)
  const moved = list.nativeReported([A, B], 0)
  assert.equal(moved.url, A)
  assert.deepEqual(shape(list), [">a0", "b1"])
  assert.equal(list.nativeMayStep("forward"), true)
})

test("a page hidden behind Reader mode does not take the reader away", async () => {
  const list = await history()
  list.observe("browser", A)
  list.nativeReported([A], 0)
  list.observe("reader", A)
  assert.equal(list.nativeReported([A, B], 1), null)
  assert.deepEqual(shape(list), [">a*0", "b1"])
})

test("leaving Reader mode on a Reader-only entry makes the page load that entry", async () => {
  const list = await history()
  list.observe("browser", A)
  list.nativeReported([A], 0)
  list.observe("reader", B)
  list.observe("browser", B)
  list.nativeReported([A, B], 1)
  assert.deepEqual(shape(list), ["a0", ">b1"])
})

test("redirects rewrite the current entry and new pages drop the forward entries", async () => {
  const list = await history()
  list.observe("browser", A)
  list.nativeReported([A], 0)
  list.nativeReported([`${A}?redirected`], 0)
  assert.deepEqual(list.snapshot(), { entries: [{ url: `${A}?redirected`, reader: false, native: 0 }], cursor: 0 })
  list.observe("browser", B)
  list.nativeReported([`${A}?redirected`, B], 1)
  list.observe("reader", B)
  list.step("back")
  list.observe("browser", `${A}?redirected`)
  list.nativeReported([`${A}?redirected`, B], 0)
  list.observe("browser", D)
  list.nativeReported([`${A}?redirected`, D], 1)
  assert.deepEqual(list.snapshot().entries.map(entry => [entry.url, entry.reader]), [[`${A}?redirected`, false], [D, false]])
  assert.equal(list.canStep("forward"), false)
})

test("fragments stay on their entry's document", async () => {
  const { sameDocument } = await import("../../../apps/mobile/src/readingHistory.ts")
  assert.equal(sameDocument(`${A}#x`, A), true)
  assert.equal(sameDocument(A, B), false)
})
