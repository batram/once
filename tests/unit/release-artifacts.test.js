const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")
const { version } = require("../../package.json")

const verifier = path.resolve(__dirname, "../../scripts/verify-release-artifacts.js")

function fixture(files) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-release-artifacts-"))
  for (const file of files) {
    const target = path.join(directory, file)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, "fixture")
  }
  return directory
}

function verify(target, directory) {
  return spawnSync(process.execPath, [verifier, target, directory], {
    encoding: "utf8"
  })
}

test("accepts the exact Linux release artifact names", (context) => {
  const directory = fixture([
    `deb/x64/once_${version}_amd64.deb`,
    `zip/linux/x64/Once-linux-x64-${version}.zip`
  ])
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = verify("electron-linux", directory)
  assert.equal(result.status, 0, result.stderr)
})

test("rejects a Linux release without its Debian package", (context) => {
  const directory = fixture([`Once-linux-x64-${version}.zip`])
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = verify("electron-linux", directory)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing Linux Debian package/)
})

test("rejects a Linux release without its portable ZIP", (context) => {
  const directory = fixture([`once_${version}_amd64.deb`])
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = verify("electron-linux", directory)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing Linux Electron ZIP/)
})

test("rejects wrong-version and Windows-only ZIP artifacts for Linux", (context) => {
  const directory = fixture([
    `once_${version}_amd64.deb`,
    "Once-linux-x64-99.99.99.zip",
    `Once-win32-x64-${version}.zip`
  ])
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = verify("electron-linux", directory)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing Linux Electron ZIP/)
})

test("accepts the exact macOS release artifact names for both architectures", (context) => {
  const directory = fixture([
    `Once-${version}-arm64.dmg`,
    `zip/darwin/arm64/Once-darwin-arm64-${version}.zip`,
    `Once-${version}-x64.dmg`,
    `zip/darwin/x64/Once-darwin-x64-${version}.zip`
  ])
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = verify("electron-macos", directory)
  assert.equal(result.status, 0, result.stderr)
})

test("rejects a macOS release that only covers one architecture", (context) => {
  const directory = fixture([
    `Once-${version}-arm64.dmg`,
    `Once-darwin-arm64-${version}.zip`
  ])
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = verify("electron-macos", directory)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing macOS x64 disk image/)
})

test("rejects a macOS release without its disk image", (context) => {
  const directory = fixture([
    `Once-darwin-arm64-${version}.zip`,
    `Once-darwin-x64-${version}.zip`
  ])
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = verify("electron-macos", directory)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing macOS arm64 disk image/)
})

test("accepts a complete cross-platform published release", (context) => {
  const directory = fixture([
    `once-firefox-v${version}.xpi`,
    `once-chrome-v${version}.zip`,
    `Once-${version} Setup.exe`,
    `Once-${version}-full.nupkg`,
    `Once-win32-x64-${version}.zip`,
    "RELEASES",
    `once_${version}_amd64.deb`,
    `Once-linux-x64-${version}.zip`,
    `Once-${version}-arm64.dmg`,
    `Once-darwin-arm64-${version}.zip`,
    `Once-${version}-x64.dmg`,
    `Once-darwin-x64-${version}.zip`
  ])
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = verify("release", directory)
  assert.equal(result.status, 0, result.stderr)
})

test("rejects a published release without the macOS artifacts", (context) => {
  const directory = fixture([
    `once-firefox-v${version}.xpi`,
    `once-chrome-v${version}.zip`,
    `Once-${version} Setup.exe`,
    `Once-${version}-full.nupkg`,
    `Once-win32-x64-${version}.zip`,
    "RELEASES",
    `once_${version}_amd64.deb`,
    `Once-linux-x64-${version}.zip`
  ])
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }))

  const result = verify("release", directory)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Missing macOS arm64 disk image/)
})
