// Usage: node tests/e2e/mobile/run-ios-extension-host.js <booted simulator UUID>
// Run `node scripts/fetch-ios-extensions.js` first. No changes to the Once app's data.
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { setTimeout: delay } = require("node:timers/promises")
const root = path.resolve(__dirname, "../../..")
const device = process.argv[2]
if (!device) throw new Error("Pass the UUID of a booted iOS 18.4+ simulator")
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).trim()
const bundleID = "com.once.hosttest"

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "once-extension-host-"))
  const app = path.join(temporary, "Host.app")
  const extensions = path.join(app, "public/extensions")
  fs.mkdirSync(extensions, { recursive: true })
  for (const name of ["darkreader", "sponsorblock", "ublock-origin-lite", "violentmonkey"]) {
    const source = path.join(root, "vendor/extensions", name === "ublock-origin-lite" ? name : `ios/${name}`)
    fs.cpSync(source, path.join(extensions, name), { recursive: true })
  }
  fs.copyFileSync(path.join(__dirname, "fixtures/extension-video.mp4"), path.join(app, "extension-video.mp4"))
  const info = path.join(app, "Info.plist")
  fs.writeFileSync(info, JSON.stringify({
    CFBundleIdentifier: bundleID, CFBundleName: "Extension Host Test", CFBundleExecutable: "Host",
    CFBundlePackageType: "APPL", CFBundleVersion: "1", CFBundleShortVersionString: "1.0",
    MinimumOSVersion: "18.4", LSRequiresIPhoneOS: true, UILaunchScreen: {}
  }))
  run("plutil", ["-convert", "xml1", info])
  const sdk = run("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"])
  const arch = process.arch === "arm64" ? "arm64" : "x86_64"
  run("xcrun", ["--sdk", "iphonesimulator", "swiftc", "-parse-as-library", "-target", `${arch}-apple-ios18.4-simulator`,
    "-sdk", sdk, path.join(__dirname, "ios-extension-host.swift"),
    path.join(__dirname, "ios-violentmonkey-host.swift"),
    path.join(__dirname, "ios-ublock-tools.swift"),
    "apps/mobile/ios/App/App/WebExtensionHost.swift", "-o", path.join(app, "Host")])
  run("codesign", ["--force", "--sign", "-", app])
  try { run("xcrun", ["simctl", "terminate", device, bundleID]) } catch { /* not running */ }
  run("xcrun", ["simctl", "uninstall", device, bundleID])
  run("xcrun", ["simctl", "install", device, app])
  const container = run("xcrun", ["simctl", "get_app_container", device, bundleID, "data"])
  const report = path.join(container, "Documents/results.json")
  fs.rmSync(report, { force: true })
  run("xcrun", ["simctl", "launch", device, bundleID, ...process.argv.slice(3)])
  let result
  for (let attempts = 0; attempts < 360; attempts++) {
    await delay(500)
    if (!fs.existsSync(report)) continue
    try { result = JSON.parse(fs.readFileSync(report, "utf8")) } catch { continue }
    if (result.done) break
  }
  const output = path.join(root, "artifacts/extension-support/host-results.json")
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.writeFileSync(output, JSON.stringify(result ?? { failure: "Timed out" }, null, 2))
  assert.equal(result?.done, true, `Native test timed out; inspect ${output}`)
  assert.equal(result.failure, undefined)
  assert.deepEqual(result.errors, [])
  for (const name of ["zapper", "picker"]) {
    assert.equal(result[name + "IgnoresPageClose"], true)
    assert.equal(result[name + "PopupClosed"], true)
    assert.ok(result[name + "Overlay"].some(frame => frame.width > 0 && frame.height > 0))
    assert.equal(result[name + "Frame"].loading, false)
    assert.equal(result[name + "TargetHidden"], true)
    assert.equal(result[name + "HiddenAfterReload"], name === "picker")
  }
  assert.equal(result.pickerCanCreate, true)
  assert.equal(result.navigationPolicyPassed, true)
  assert.ok(result.internalNavigations.filter(entry => entry.url === "about:blank").every(entry => entry.allowed && !entry.mainFrame))
  for (const tool of ["zapper", "picker"]) {
    assert.ok(result.internalNavigations.some(entry => entry.url.endsWith(`/${tool}-ui.html`) && entry.allowed && !entry.mainFrame))
  }
  if (process.argv.includes("--ubol-only")) {
    console.log(`Native uBlock tools passed. Report: ${output}`)
    fs.rmSync(temporary, { recursive: true, force: true })
    return
  }
  assert.ok(result.darkPage.styles > 0)
  assert.equal(result.darkDisabled.styles, 0)
  assert.match(result.darkAfterRestart, /Extension is disabled/)
  assert.ok(result.darkReenabled > 0)
  assert.ok(result.darkPopup.width <= result.darkPopup.viewport)
  assert.ok(result.sponsorOptions.width <= result.sponsorOptions.viewport)
  assert.equal(result.sponsorStoredSetting, 7)
  assert.ok(result.sponsorVideo.seeks.some(time => time >= 8 && time < 8.5), "SponsorBlock must seek past the supplied segment")
  assert.equal(result.vmScriptRun.count, "1")
  assert.equal(result.vmScriptRun.color, "rgb(12, 34, 56)")
  assert.equal(result.vmAfterRestart.count, "2")
  assert.equal(result.vmUnmatched, null)
  assert.ok(result.vmOptions.width <= result.vmOptions.viewport)
  const scriptId = result.vmExport.items[0].script.props.id
  assert.deepEqual(result.vmExport.values[scriptId], { count: "n1", afterWake: "n42" })
  assert.equal(result.vmContentRunsAfterWake, "1", "Background recovery must not execute content scripts again")
  const contentId = result.vmExport.items.find(item => item.script.meta.name === "Once VM content fixture").script.props.id
  assert.deepEqual(result.vmExport.values[contentId], { afterWake: "n43" })
  console.log(`Native extension behavior passed. Report: ${output}`)
  fs.rmSync(temporary, { recursive: true, force: true })
}
main().catch(error => { console.error(error); process.exitCode = 1 })
