import Capacitor
import UIKit
import WebKit

/// The shell WebView, which adds "Paste and Go" and "Clear" to the text menu
/// while the web address field has focus. WKContentView, the actual first
/// responder, asks its WKWebView both whether an action applies and who
/// performs it.
final class ShellWebView: WKWebView {
    weak var addressBar: AddressBarPlugin?

    private var pastesAndGoes: Bool {
        addressBar?.editing == true && UIPasteboard.general.hasStrings
    }

    private var clears: Bool {
        addressBar?.editing == true && addressBar?.hasText == true
    }

    private func offers(_ action: Selector) -> Bool? {
        switch action {
        case #selector(pasteAndGo(_:)): return pastesAndGoes
        case #selector(clearAddress(_:)): return clears
        default: return nil
        }
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        offers(action) ?? super.canPerformAction(action, withSender: sender)
    }

    override func target(forAction action: Selector, withSender sender: Any?) -> Any? {
        if let offered = offers(action) { return offered ? self : nil }
        return super.target(forAction: action, withSender: sender)
    }

    /// WebKit builds its text menu from its own list of actions, so the items
    /// are placed after Paste here rather than left to the standard menu.
    override func buildMenu(with builder: UIMenuBuilder) {
        super.buildMenu(with: builder)
        guard builder.system == .context else { return }
        var items: [UICommand] = []
        if pastesAndGoes { items.append(UICommand(title: "Paste and Go", action: #selector(pasteAndGo(_:)))) }
        if clears { items.append(UICommand(title: "Clear", action: #selector(clearAddress(_:)))) }
        guard !items.isEmpty else { return }
        builder.replaceChildren(ofMenu: .standardEdit) { children in
            let actions = children.compactMap { ($0 as? UICommand)?.action }
            let added = items.filter { !actions.contains($0.action) }
            var next = children
            let paste = children.firstIndex { ($0 as? UICommand)?.action == #selector(paste(_:)) }
            next.insert(contentsOf: added, at: paste.map { $0 + 1 } ?? next.endIndex)
            return next
        }
    }

    override func pasteAndGo(_ sender: Any?) {
        guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
        addressBar?.pasteAndGo(text)
    }

    @objc func clearAddress(_ sender: Any?) {
        addressBar?.clear()
    }
}

@objc(AddressBarPlugin)
public class AddressBarPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AddressBarPlugin"
    public let jsName = "AddressBar"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setEditing", returnType: CAPPluginReturnPromise)
    ]

    /// Main queue only: the menu reads it while validating its items.
    private(set) var editing = false
    private(set) var hasText = false

    @objc func setEditing(_ call: CAPPluginCall) {
        let editing = call.getBool("editing") ?? false
        let hasText = call.getBool("hasText") ?? false
        DispatchQueue.main.async {
            self.editing = editing
            self.hasText = hasText
            call.resolve()
        }
    }

    func pasteAndGo(_ text: String) {
        notifyListeners("pasteAndGo", data: ["text": text])
    }

    func clear() {
        notifyListeners("clear", data: [:])
    }
}
