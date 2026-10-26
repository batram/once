import Foundation
import WebKit

/// The native half of "Add to Once" on addons.mozilla.org: the page script
/// (public/amo-page-shim.js, apps/mobile/src/amoPageShim.ts) runs in every
/// top frame and does nothing off AMO; its calls arrive here and are answered
/// for that origin's top frame only, through the same review as the settings page.
extension InAppBrowserSurfacePlugin {
    static let amoHost = "addons.mozilla.org"
    /// The controllers already carrying the handler (a popup shares its opener's).
    private static let amoControllers = NSHashTable<WKUserContentController>.weakObjects()
    private static let amoPageScript: WKUserScript? = {
        guard let url = Bundle.main.url(forResource: "amo-page-shim", withExtension: "js", subdirectory: "public"),
              let source = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        return WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page)
    }()

    func installAmoBridge(_ controller: WKUserContentController) {
        guard let script = Self.amoPageScript else { return }
        if !controller.userScripts.contains(where: { $0 === script }) { controller.addUserScript(script) }
        guard !Self.amoControllers.contains(controller) else { return }
        Self.amoControllers.add(controller)
        controller.addScriptMessageHandler(AmoBridgeHandler(owner ?? self), contentWorld: .page, name: "onceAmo")
    }

    /// Tells open AMO pages that the catalog changed, so their buttons follow.
    func notifyAmoPages() {
        let root = owner ?? self
        for view in ([root.surface] + root.tabs.values.map(\.surface)).compactMap({ $0 })
        where view.url?.host?.lowercased() == InAppBrowserSurfacePlugin.amoHost {
            view.evaluateJavaScript("typeof __onceAmoChanged === 'function' && __onceAmoChanged(); undefined") { _, _ in }
        }
    }

    /// Answers one bridge call; the page URL comes from WebKit, not the page.
    func amoRequest(_ body: [String: Any], page: URL?) async throws -> Any? {
        await extensions.prepare()
        let id = body["id"] as? String ?? ""
        switch body["method"] as? String {
        case "addon":
            guard let row = extensions.catalog().first(where: { $0["id"] as? String == id }) else { return NSNull() }
            let enabled = row["enabled"] as? Bool ?? false
            return ["id": id, "version": row["version"] as? String ?? "", "isEnabled": enabled, "isActive": enabled,
                    "canUninstall": row["bundled"] as? Bool != true]
        case "install":
            guard let page, ExtensionSource.kind(of: page.absoluteString) != .none else {
                return ["status": "failed", "error": "Open an add-on's page to install it"]
            }
            do {
                let result = try await extensions.perform("install", id: "", source: page.absoluteString, enabled: true)
                return ["status": result["cancelled"] as? Bool == true ? "cancelled" : "installed"]
            } catch { return ["status": "failed", "error": error.localizedDescription] }
        case "uninstall":
            let result = try await extensions.perform("remove", id: id, source: nil, enabled: true)
            return result["cancelled"] as? Bool != true
        case "enabled":
            _ = try extensions.command("enable", id: id, enabled: body["enabled"] as? Bool ?? true)
            return NSNull()
        default:
            throw hostError("Unknown add-on manager call")
        }
    }
}

/// Root-only, like the media observer: one handler may serve several surfaces.
final class AmoBridgeHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var root: InAppBrowserSurfacePlugin?
    init(_ root: InAppBrowserSurfacePlugin) { self.root = root }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        let frame = message.frameInfo
        guard frame.isMainFrame, frame.securityOrigin.protocol == "https",
              frame.securityOrigin.host.lowercased() == InAppBrowserSurfacePlugin.amoHost,
              let body = message.body as? [String: Any], let root else {
            replyHandler(nil, "Not available on this page")
            return
        }
        let page = frame.request.url
        Task { @MainActor in
            do { replyHandler(try await root.amoRequest(body, page: page), nil) }
            catch { replyHandler(nil, error.localizedDescription) }
        }
    }
}
