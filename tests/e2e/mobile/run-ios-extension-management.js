// Usage: node tests/e2e/mobile/run-ios-extension-management.js <booted simulator UUID>
// Uses production Swift and local Mozilla fixtures; never touches the Once app's data or the network.
const fs = require("node:fs")
const path = require("node:path")
const os = require("node:os")
const assert = require("node:assert/strict")
const { execFileSync } = require("node:child_process")
const { setTimeout: delay } = require("node:timers/promises")
const AdmZip = require("adm-zip")
const root = path.resolve(__dirname, "../../..")
const device = process.argv[2]
if (!device) throw new Error("Pass the UUID of a booted iOS 18.4+ simulator")
const bundleID = "com.once.managementtest"
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim()

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "once-extension-management-"))
  const app = path.join(temporary, "Host.app")
  fs.mkdirSync(app)
  try {
    for (const [name, version, id] of [
      ["1.0", "1.0", "review@once.invalid"], ["2.0", "2.0", "review@once.invalid"],
      ["other", "1.0", "other@once.invalid"], ["fresh", "1.0", "fresh@once.invalid"]
    ]) {
      const zip = new AdmZip()
      zip.addFile("manifest.json", Buffer.from(JSON.stringify({ manifest_version: 3, name: "Installer fixture", version,
        browser_specific_settings: { gecko: { id } }, permissions: ["storage"] })))
      zip.writeZip(path.join(app, name + ".xpi"))
    }
    const plist = path.join(app, "Info.plist")
    fs.writeFileSync(plist, JSON.stringify({ CFBundleIdentifier: bundleID, CFBundleName: "Management Test", CFBundleExecutable: "Host",
      CFBundlePackageType: "APPL", CFBundleVersion: "1", CFBundleShortVersionString: "1.0", MinimumOSVersion: "18.4",
      LSRequiresIPhoneOS: true, UILaunchScreen: {} }))
    run("plutil", ["-convert", "xml1", plist])
    const sdk = run("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-path"])
    run("xcrun", ["--sdk", "iphonesimulator", "swiftc", "-parse-as-library", "-target",
      `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-ios18.4-simulator`, "-sdk", sdk,
      path.join(__dirname, "ios-extension-management.swift"),
      ...["WebExtensionHost", "WebExtensionManagement", "WebExtensionInstaller", "ExtensionArchive", "ExtensionCatalogSnapshot"].map(name => `apps/mobile/ios/App/App/${name}.swift`),
      "-o", path.join(app, "Host")])
    run("codesign", ["--force", "--sign", "-", app])
    // Clear only this test app, so reruns start with fresh preferences and WebKit data.
    run("xcrun", ["simctl", "uninstall", device, bundleID])
    run("xcrun", ["simctl", "install", device, app])
    const container = run("xcrun", ["simctl", "get_app_container", device, bundleID, "data"])
    run("xcrun", ["simctl", "launch", device, bundleID])
    const file = path.join(container, "Documents/results.json")
    let result
    for (let attempt = 0; attempt < 120; attempt++) {
      await delay(500)
      if (!fs.existsSync(file)) continue
      try { result = JSON.parse(fs.readFileSync(file, "utf8")) } catch { continue }
      if (result.done) break
    }
    assert.equal(result?.done, true, "Native management test timed out")
    assert.equal(result.failure, undefined, JSON.stringify(result))
    for (const key of ["rollbackLoadedAndDisabled", "laterSavePreservesOldVersion", "firstInstallRollback", "directURLUpdate", "rejectsChangedIdentity", "prunePreservesInstalled", "removalCompleted"]) {
      assert.equal(result[key], true, key)
    }
    console.log("Native extension management regressions passed:", result)
  } finally {
    try { run("xcrun", ["simctl", "terminate", device, bundleID]) } catch { /* May not have launched. */ }
    try { run("xcrun", ["simctl", "uninstall", device, bundleID]) } catch { /* May not have installed. */ }
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
