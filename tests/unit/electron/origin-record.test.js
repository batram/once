const assert = require("node:assert/strict")
const fs = require("node:fs")
const Module = require("node:module")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const ts = require("typescript")

const originalTs = Module._extensions[".ts"]
Module._extensions[".ts"] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename
  }).outputText
  module._compile(output, filename)
}
test.after(() => {
  if (originalTs) Module._extensions[".ts"] = originalTs
  else delete Module._extensions[".ts"]
})

const { OriginRecord, webOrigin } = require("../../../apps/electron/src/browser/OriginRecord.ts")

function tempFile() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-origin-record-"))
  test.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, "nested", "browsing-origins.json")
}

test("only web pages have an origin, and it keeps the port", () => {
  assert.equal(webOrigin("https://app.example.com:8443/x?y#z"), "https://app.example.com:8443")
  assert.equal(webOrigin("http://example.com/"), "http://example.com")
  assert.equal(webOrigin("about:blank"), null)
  assert.equal(webOrigin("once-reader://https/example.com/"), null)
  assert.equal(webOrigin("not a url"), null)
})

test("the record answers per site, survives a restart, and forgets on request", () => {
  const file = tempFile()
  const record = new OriginRecord(file, 100, 60_000)
  for (const url of [
    "https://example.com/a", "https://app.example.com:8443/b", "http://cdn.example.com/c",
    "https://notexample.com/", "https://other.test/", "about:blank", "https://example.com/again"
  ]) record.record(url)
  assert.deepEqual(record.originsFor("example.com").sort(),
    ["http://cdn.example.com", "https://app.example.com:8443", "https://example.com"])
  record.flush()

  const reopened = new OriginRecord(file, 100, 60_000)
  assert.deepEqual(reopened.originsFor("example.com").length, 3)
  reopened.forget("example.com")
  assert.deepEqual(reopened.originsFor("example.com"), [])
  assert.deepEqual(new OriginRecord(file).originsFor("other.test"), ["https://other.test"])

  reopened.clear()
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), [])
})

test("the oldest origin goes first once the limit is reached, and a revisit keeps one", () => {
  const record = new OriginRecord(tempFile(), 3, 60_000)
  for (const host of ["a", "b", "c"]) record.record(`https://${host}.test/`)
  record.record("https://a.test/again")
  record.record("https://d.test/")
  assert.deepEqual(["a", "b", "c", "d"].filter((host) => record.originsFor(`${host}.test`).length), ["a", "c", "d"])
})

test("an unreadable or tampered file starts an empty record rather than failing startup", () => {
  const file = tempFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, "{not json")
  const warn = console.warn
  console.warn = () => {}
  try {
    assert.deepEqual(new OriginRecord(file).originsFor("example.com"), [])
  } finally {
    console.warn = warn
  }
  fs.writeFileSync(file, JSON.stringify(["https://example.com", "javascript:alert(1)", 42, "https://example.com/path"]))
  assert.deepEqual(new OriginRecord(file).originsFor("example.com"), ["https://example.com"])
})

test("new origins are saved after a delay, revisits alone write nothing", async () => {
  const file = tempFile()
  const record = new OriginRecord(file, 100, 20)
  record.record("https://example.com/")
  assert.equal(fs.existsSync(file), false)
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), ["https://example.com"])
  const written = fs.statSync(file).mtimeMs
  record.record("https://example.com/other")
  await new Promise((resolve) => setTimeout(resolve, 80))
  assert.equal(fs.statSync(file).mtimeMs, written)
})
