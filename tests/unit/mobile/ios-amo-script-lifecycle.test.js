const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

test("settings refreshes restore AMO in existing tabs without registering duplicate handlers", { skip: process.platform !== "darwin" }, t => {
  const root = path.resolve(__dirname, "../../../apps/mobile/ios/App/App")
  const plugin = fs.readFileSync(path.join(root, "InAppBrowserSurfacePlugin.swift"), "utf8")
  const bridge = fs.readFileSync(path.join(root, "AmoInstallBridge.swift"), "utf8")
  const reset = plugin.slice(plugin.indexOf("    private func installUserscripts("), plugin.indexOf("    @objc func close("))
  const install = bridge.slice(bridge.indexOf("    func installSurfaceScripts("), bridge.indexOf("    /// Tells open AMO pages"))
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "once-amo-lifecycle-"))
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }))
  const source = `
import Foundation
import WebKit
typealias JSObject = [String: Any]
final class Surface { let configuration = WKWebViewConfiguration() }
enum UserscriptInjection {
    static func script(_ entry: JSObject) -> WKUserScript? {
        WKUserScript(source: entry["source"] as! String, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    }
}
final class AmoBridgeHandler: NSObject, WKScriptMessageHandlerWithReply {
    init(_ root: Plugin) {}
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) { replyHandler(nil, nil) }
}
final class Plugin {
    static let amoPageScript: WKUserScript? = WKUserScript(source: "AMO", injectionTime: .atDocumentStart, forMainFrameOnly: true)
    static let amoControllers = NSHashTable<WKUserContentController>.weakObjects()
    var tabs: [String: Plugin] = [:]
    var owner: Plugin?
    var surface: Surface? = Surface()
    var extensionUserScripts: [WKUserScript] = []
    func installMediaObserver(_ c: WKUserContentController) { c.addUserScript(WKUserScript(source: "MEDIA", injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
    func installContextMenuTracker(_ c: WKUserContentController) { c.addUserScript(WKUserScript(source: "MENU", injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
    func installExternalLinkHandler(_ c: WKUserContentController) { c.addUserScript(WKUserScript(source: "EXTERNAL", injectionTime: .atDocumentStart, forMainFrameOnly: true)) }
${install}
${reset}
    func refresh(_ script: String?) { installUserscripts(["scripts": script.map { [["source": $0]] } ?? []]) }
}
let root = Plugin(), tab = Plugin()
tab.owner = root
root.tabs["existing"] = tab
for plugin in [root, tab] { plugin.installAmoBridge(plugin.surface!.configuration.userContentController) }
for script in [Optional("FIRST"), Optional("REPLACEMENT"), nil] {
    root.refresh(script)
    for plugin in [root, tab] {
        let scripts = plugin.surface!.configuration.userContentController.userScripts.map(\\.source)
        precondition(Set(scripts) == Set(["AMO", "MEDIA", "MENU", "EXTERNAL"] + (script.map { [$0] } ?? [])))
        precondition(scripts.count == 4 + (script == nil ? 0 : 1))
        plugin.installAmoBridge(plugin.surface!.configuration.userContentController)
        precondition(plugin.surface!.configuration.userContentController.userScripts.count == scripts.count)
    }
}
print("AMO script lifecycle passed")
`
  const file = path.join(temporary, "main.swift")
  const binary = path.join(temporary, "lifecycle")
  fs.writeFileSync(file, source)
  execFileSync("xcrun", ["--sdk", "macosx", "swiftc", file, "-o", binary], { stdio: "pipe" })
  assert.match(execFileSync(binary, { encoding: "utf8", timeout: 20_000 }), /AMO script lifecycle passed/)
})
