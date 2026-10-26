const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync, spawnSync } = require("node:child_process")
const AdmZip = require("adm-zip")

const root = path.resolve(__dirname, "../../..")
const source = path.join(root, "apps/mobile/ios/App/App/ExtensionArchive.swift")

function hasSwift() {
  if (process.platform !== "darwin") return false
  return spawnSync("xcrun", ["-f", "swiftc"], { stdio: "ignore" }).status === 0
}

const driver = `
import Foundation
let args = CommandLine.arguments
let data: Data
do { data = try ExtensionArchive.read(URL(fileURLWithPath: args[1])) }
catch {
    print(String(data: try! JSONSerialization.data(withJSONObject: ["readError": error.localizedDescription]), encoding: .utf8)!)
    exit(0)
}
let out = URL(fileURLWithPath: args[2])
var result: [String: Any] = [:]
do {
    result["entries"] = try ExtensionArchive.entries(of: data).map { ["name": $0.name, "isDirectory": $0.isDirectory, "size": $0.size] }
} catch { result["entriesError"] = error.localizedDescription }
do { try ExtensionArchive.extract(data, to: out); result["extracted"] = true } catch { result["extractError"] = error.localizedDescription }
result["outputExists"] = FileManager.default.fileExists(atPath: out.path)
print(String(data: try! JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
`

function compileDriver(directory) {
  fs.writeFileSync(path.join(directory, "main.swift"), driver)
  const binary = path.join(directory, "archive-test")
  execFileSync("xcrun", ["--sdk", "macosx", "swiftc", "-O", "-o", binary, source, path.join(directory, "main.swift")], { stdio: "pipe" })
  return binary
}

/** Runs the driver on `archive`, returning its JSON report plus the output directory it used. */
function run(binary, directory, name, archive) {
  const archivePath = path.join(directory, `${name}.zip`)
  const output = path.join(directory, `${name}-out`)
  fs.writeFileSync(archivePath, archive)
  const report = JSON.parse(execFileSync(binary, [archivePath, output], { encoding: "utf8" }))
  return { ...report, output }
}

function zipOf(files) {
  const zip = new AdmZip()
  for (const [name, body, stored] of files) {
    zip.addFile(name, Buffer.isBuffer(body) ? body : Buffer.from(body))
    if (stored) zip.getEntry(name).header.method = 0
  }
  return zip.toBuffer()
}

function walk(directory, prefix = "") {
  const names = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name
    if (entry.isDirectory()) names.push(relative + "/", ...walk(path.join(directory, entry.name), relative + "/"))
    else names.push(relative)
  }
  return names
}

test("ExtensionArchive unpacks XPI files with the Electron runtime's rules", { skip: !hasSwift() }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-ios-extension-archive-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const binary = compileDriver(directory)
  const big = Buffer.from("console.log('hello from the archive');\n".repeat(200))

  await t.test("extracts nested directories with deflated and stored files", () => {
    const archive = zipOf([
      ["manifest.json", '{"manifest_version":2,"name":"demo"}'],
      ["scripts/", Buffer.alloc(0)],
      ["scripts/background.js", big],
      ["scripts/lib/stored.txt", "kept verbatim", true],
      ["scripts/lib/empty.txt", ""]
    ])
    const report = run(binary, directory, "normal", archive)
    assert.equal(report.extractError, undefined)
    assert.equal(report.extracted, true)
    assert.deepEqual(report.entries, [
      { name: "manifest.json", isDirectory: false, size: 36 },
      { name: "scripts/", isDirectory: true, size: 0 },
      { name: "scripts/background.js", isDirectory: false, size: big.length },
      { name: "scripts/lib/empty.txt", isDirectory: false, size: 0 },
      { name: "scripts/lib/stored.txt", isDirectory: false, size: 13 }
    ])
    assert.deepEqual(walk(report.output), [
      "manifest.json", "scripts/", "scripts/background.js", "scripts/lib/", "scripts/lib/empty.txt", "scripts/lib/stored.txt"
    ])
    assert.equal(fs.readFileSync(path.join(report.output, "scripts/background.js"), "utf8"), big.toString())
    assert.equal(fs.readFileSync(path.join(report.output, "scripts/lib/stored.txt"), "utf8"), "kept verbatim")
    assert.equal(fs.readFileSync(path.join(report.output, "scripts/lib/empty.txt")).length, 0)
  })

  await t.test("accepts an exact 200 MB mapped archive and rejects one byte over before reading", () => {
    // A ZIP with a large prefix exercises the archive boundary without allocating 200 MB in the test runner.
    const archive = zipOf([["manifest.json", "{}"]])
    const padding = 200_000_000 - archive.length
    const central = archive.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    const end = archive.length - 22
    archive.writeUInt32LE(padding, central + 42)
    archive.writeUInt32LE(archive.readUInt32LE(end + 16) + padding, end + 16)
    const input = path.join(directory, "boundary.xpi")
    const output = path.join(directory, "boundary-out")
    const fd = fs.openSync(input, "w")
    fs.writeSync(fd, archive, 0, archive.length, padding)
    fs.closeSync(fd)
    const report = JSON.parse(execFileSync(binary, [input, output], { encoding: "utf8" }))
    assert.equal(report.extracted, true)
    assert.equal(fs.readFileSync(path.join(output, "manifest.json"), "utf8"), "{}")
    fs.truncateSync(input, 200_000_001)
    const oversized = JSON.parse(execFileSync(binary, [input, output + "-oversized"], { encoding: "utf8" }))
    assert.equal(oversized.readError, "XPI exceeds the 200 MB limit")
  })

  await t.test("extracts more than 32 MiB compressed and 128 MiB expanded", () => {
    const archive = zipOf([
      ["manifest.json", "{}"],
      ["stored.bin", Buffer.alloc(33 * 1024 * 1024, 42), true],
      ["deflated.bin", Buffer.alloc(100 * 1024 * 1024, 7)]
    ])
    const report = run(binary, directory, "large", archive)
    assert.equal(report.extracted, true, report.extractError)
    assert.equal(fs.statSync(path.join(report.output, "stored.bin")).size, 33 * 1024 * 1024)
    assert.equal(fs.statSync(path.join(report.output, "deflated.bin")).size, 100 * 1024 * 1024)
  })

  await t.test("rejects Mozilla's expanded and per-file boundaries before extraction", () => {
    const archive = zipOf([["a", "a"], ["b", "b"], ["c", "c"]])
    const records = []
    for (let offset = 0; offset < archive.length - 4; offset++) {
      if (archive.readUInt32LE(offset) === 0x02014b50) records.push(offset)
    }
    const hugeFile = Buffer.from(archive)
    hugeFile.writeUInt32LE(100 * 1024 * 1024 + 1, records[0] + 24)
    assert.equal(run(binary, directory, "huge-file", hugeFile).extractError, "XPI file exceeds the 100 MiB limit")
    for (const [index, size] of [100, 100, 50].entries()) archive.writeUInt32LE(size * 1024 * 1024, records[index] + 24)
    const expanded = run(binary, directory, "huge-expanded", archive)
    assert.equal(expanded.extractError, "Expanded XPI must be smaller than 250 MiB")
    assert.equal(expanded.outputExists, false)
  })

  await t.test("refuses unsafe paths and leaves nothing behind", () => {
    // adm-zip sanitises `..` and backslashes itself, so those names are patched in over a same-length placeholder.
    const cases = {
      traversal: ["zz/evil.js", "../evil.js"],
      backslash: ["scripts/evil.js", "scripts\\evil.js"],
      device: ["scripts/CON.txt"],
      trailingDot: ["scripts/evil."],
      control: ["scripts/ev\u0001l.js"]
    }
    for (const [label, [placeholder, name = placeholder]] of Object.entries(cases)) {
      let archive = zipOf([["manifest.json", "{}"], [placeholder, "x"]])
      if (name !== placeholder) {
        assert.equal(Buffer.byteLength(name), Buffer.byteLength(placeholder))
        archive = Buffer.from(archive.toString("latin1").replaceAll(placeholder, name), "latin1")
      }
      const report = run(binary, directory, `unsafe-${label}`, archive)
      assert.equal(report.extractError, "XPI contains an unsafe or duplicate file path", label)
      assert.equal(report.outputExists, false, label)
      assert.equal(report.entries.length, 2, `${label}: entries(of:) still lists the archive`)
    }
  })

  await t.test("refuses duplicate names that differ only in case", () => {
    const report = run(binary, directory, "duplicate", zipOf([["Manifest.json", "{}"], ["manifest.json", "{}"]]))
    assert.equal(report.extractError, "XPI contains an unsafe or duplicate file path")
    assert.equal(report.outputExists, false)
  })

  await t.test("refuses data that is not a ZIP", () => {
    for (const [label, buffer] of [["text", Buffer.from("not a zip archive at all, just some text padding")], ["empty", Buffer.alloc(0)]]) {
      const report = run(binary, directory, `nonzip-${label}`, buffer)
      assert.equal(report.entriesError, "Invalid XPI archive", label)
      assert.equal(report.extractError, "Invalid XPI archive", label)
      assert.equal(report.outputExists, false, label)
    }
  })

  await t.test("rejects a corrupted deflate stream or CRC", () => {
    const archive = zipOf([["manifest.json", "{}"], ["scripts/background.js", big]])
    const localHeader = archive.indexOf("scripts/background.js")
    const nameLength = archive.readUInt16LE(localHeader - 4)
    const extraLength = archive.readUInt16LE(localHeader - 2)
    const dataStart = localHeader + nameLength + extraLength
    for (const offset of [dataStart + 3, dataStart + 12, dataStart + 20]) {
      const damaged = Buffer.from(archive)
      damaged[offset] ^= 0xff
      const report = run(binary, directory, `damaged-${offset}`, damaged)
      assert.ok(["XPI file is corrupt", "XPI file size mismatch", "Invalid XPI archive"].includes(report.extractError), report.extractError)
      assert.equal(report.outputExists, false)
    }
    const wrongCrc = Buffer.from(archive)
    const central = wrongCrc.lastIndexOf("scripts/background.js")
    wrongCrc.writeUInt32LE((wrongCrc.readUInt32LE(central - 30) ^ 0x1234) >>> 0, central - 30)
    const report = run(binary, directory, "wrong-crc", wrongCrc)
    assert.equal(report.extractError, "XPI file is corrupt")
    assert.equal(report.outputExists, false)
  })

  await t.test("refuses encrypted entries and other compression methods", () => {
    const archive = zipOf([["manifest.json", "{}"], ["scripts/background.js", big]])
    const encrypted = Buffer.from(archive)
    const central = encrypted.lastIndexOf("scripts/background.js")
    encrypted.writeUInt16LE(encrypted.readUInt16LE(central - 38) | 1, central - 38)
    assert.equal(run(binary, directory, "encrypted", encrypted).entriesError, "Invalid XPI archive")
    const bzip = Buffer.from(archive)
    bzip.writeUInt16LE(12, central - 36)
    assert.equal(run(binary, directory, "bzip", bzip).entriesError, "Invalid XPI archive")
  })

  await t.test("round-trips the vendored Violentmonkey package", { skip: !fs.existsSync(path.join(root, "vendor/extensions/violentmonkey")) }, () => {
    const vendored = path.join(root, "vendor/extensions/violentmonkey")
    const zip = new AdmZip()
    zip.addLocalFolder(vendored)
    const report = run(binary, directory, "violentmonkey", zip.toBuffer())
    assert.equal(report.extractError, undefined)
    assert.deepEqual(walk(report.output), walk(vendored))
    assert.deepEqual(fs.readFileSync(path.join(report.output, "manifest.json")), fs.readFileSync(path.join(vendored, "manifest.json")))
    assert.ok(report.entries.length > 10)
  })
})
