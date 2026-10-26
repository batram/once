const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

test("native settings apply filters and scripts without initializing the browser extension host", { skip: process.platform !== "darwin" }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-lazy-extensions-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const root = path.resolve(__dirname, "../../../apps/mobile/ios/App/App")
  const plugin = fs.readFileSync(path.join(root, "InAppBrowserSurfacePlugin.swift"), "utf8")
  const method = plugin.slice(plugin.indexOf("    @objc func applyExtensionSettings("), plugin.indexOf("    @objc func extensionCommand("))
  fs.writeFileSync(path.join(directory, "Support.swift"), fs.readFileSync(path.join(root, "ExtensionSupport.swift"), "utf8")
    .replace("import Capacitor", "typealias JSObject = [String: Any]"))
  fs.writeFileSync(path.join(directory, "Driver.swift"), `
import Foundation
@MainActor final class CAPPluginCall: NSObject {
    var finished: () -> Void = {}
    func getObject(_ name: String) -> JSObject? { name == "filterLists" ? ["lists": []] : ["scripts": [["id": "kept"]]] }
    func resolve() { finished() }
    func reject(_ message: String) { preconditionFailure(message) }
}
@MainActor final class UnusedHost { func prepare() async { preconditionFailure("Unnecessary preparation") } }
@MainActor final class SettingsHarness: NSObject {
    var extensionSettingsGeneration = 0
    let filterPreparation = IOSFilterPreparation()
    var installedScripts: JSObject = [:]
    var installedRules: String?
    var extensions: UnusedHost { preconditionFailure("Settings initialized the extension controller") }
    func installUserscripts(_ value: JSObject) { installedScripts = value }
    func compileAndInstallRules(_ value: String, generation: Int) async throws { installedRules = value }
${method}
}
@main struct Driver {
    @MainActor static func main() async {
        let host = SettingsHarness(), call = CAPPluginCall()
        await withCheckedContinuation { continuation in
            call.finished = { continuation.resume() }
            host.applyExtensionSettings(call)
        }
        precondition(host.installedRules == "[]")
        precondition((host.installedScripts["scripts"] as? [JSObject])?.count == 1)
        // Drain another actor turn: a fire-and-forget warmup must also be caught.
        await Task.yield()
        print("Lazy native settings passed")
    }
}
`)
  const binary = path.join(directory, "lazy-test")
  execFileSync("xcrun", ["--sdk", "macosx", "swiftc", "-parse-as-library", path.join(directory, "Support.swift"), path.join(directory, "Driver.swift"), "-o", binary], { stdio: "pipe" })
  assert.match(execFileSync(binary, { encoding: "utf8", timeout: 20000 }), /Lazy native settings passed/)
})
