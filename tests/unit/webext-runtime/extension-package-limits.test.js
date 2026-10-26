const test = require("node:test")
const assert = require("node:assert/strict")
const { validateArchiveEntries, unpackExtension, prepareExtension } = require("../../../packages/webext-runtime/dist")
const MiB = 1024 * 1024
const entry = (name, size) => ({ name, size, isDirectory: false, data: () => { throw new Error("should not inflate") } })

test("AMO limits accept 200 decimal MB, <250 MiB expanded and <=100 MiB per file", () => {
  // Validation only inspects length; avoid allocating the entire archive for these boundary checks.
  const archive = { length: 200_000_000 }
  assert.doesNotThrow(() => validateArchiveEntries(archive, [entry("a", 100 * MiB), entry("b", 100 * MiB), entry("c", 50 * MiB - 1)]))
  assert.throws(() => validateArchiveEntries({ length: 200_000_001 }, []), /200 MB/)
  assert.throws(() => validateArchiveEntries(archive, [entry("a", 100 * MiB + 1)]), /100 MiB/)
  assert.throws(() => validateArchiveEntries(archive, [entry("a", 100 * MiB), entry("b", 100 * MiB), entry("c", 50 * MiB)]), /250 MiB/)
})

test("a constrained host rejects large archives before passing them to its native unzip bridge", async () => {
  const host = { maxArchiveBytes: 32 * MiB, unzip: () => { throw new Error("must not cross the bridge") } }
  await assert.rejects(unpackExtension(host, { length: 32 * MiB + 1 }, "unused"), /32 MiB/)
  assert.throws(() => validateArchiveEntries({ length: 1 }, [entry("a", 100 * MiB), entry("b", 28 * MiB)], 128 * MiB), /128 MiB/)
})

test("overlarge remote responses are cancelled before consuming their body", async () => {
  let cancelled = false
  const host = { fetch: async () => new Response(new ReadableStream({ cancel: () => { cancelled = true } }), {
    headers: { "content-length": "200000001" }
  }) }
  await assert.rejects(prepareExtension(host, "https://addons.mozilla.org/firefox/downloads/file/1/example.xpi"), /size limit/)
  assert.equal(cancelled, true)
})
