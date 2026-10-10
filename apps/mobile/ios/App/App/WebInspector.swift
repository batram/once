import Foundation
import Capacitor
import WebKit

/// Whether Safari's Web Inspector may attach to the app's web views, release
/// builds included. Off unless the user turns it on in the error log; every
/// web view the app makes is tracked so the switch applies at once.
enum WebInspector {
    private static let key = "once.webInspector"
    private static let views = NSHashTable<WKWebView>.weakObjects()

    static var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set {
            UserDefaults.standard.set(newValue, forKey: key)
            views.allObjects.forEach { $0.isInspectable = newValue }
        }
    }

    static func track(_ view: WKWebView) {
        views.add(view)
        view.isInspectable = enabled
    }
}

@objc(WebInspectorPlugin)
public class WebInspectorPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "WebInspectorPlugin"
    public let jsName = "WebInspector"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "set", returnType: CAPPluginReturnPromise)
    ]

    override public func load() {
        // Capacitor already decided for the shell (Debug builds are always
        // inspectable); only a user's opt-in widens that.
        if let view = bridge?.webView, WebInspector.enabled || !view.isInspectable { WebInspector.track(view) }
    }

    @objc func get(_ call: CAPPluginCall) {
        call.resolve(["enabled": WebInspector.enabled])
    }

    @objc func set(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            if let view = self.bridge?.webView { WebInspector.track(view) }
            WebInspector.enabled = enabled
            call.resolve()
        }
    }
}
