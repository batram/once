import UIKit
import WebKit

/// Owns only the browsing surface; extensions never receive the Capacitor shell.
@available(iOS 18.4, *)
@MainActor
final class WebExtensionHost: NSObject, WKWebExtensionControllerDelegate, WKWebExtensionWindow {
    let controller: WKWebExtensionController
    private var contexts: [String: WKWebExtensionContext] = [:]
    private var failures: [String: String] = [:]
    private var loading: Task<Void, Never>?
    private var reading: ExtensionTab?
    private var page: ExtensionTab?
    private var popup: WKWebExtension.Action?
    private weak var parent: UIView?
    var changed: () -> Void = {}
    var pageChanged: ([String: Any]) -> Void = { _ in }
    private let bundles: [(id: String, directory: String, name: String)] = [
        ("ublock-origin-lite", "ublock-origin-lite", "uBlock Origin Lite"),
        ("addon@darkreader.org", "darkreader", "Dark Reader"),
        ("sponsorBlocker@ajay.app", "sponsorblock", "SponsorBlock"),
        ("{aecec67f-0d10-4fa7-b7c7-609a2db280cf}", "violentmonkey", "Violentmonkey")
    ]

    init(configuration: WKWebExtensionController.Configuration? = nil) {
        controller = WKWebExtensionController(configuration: configuration ?? .default())
        super.init()
        controller.delegate = self
    }

    func prepare() async {
        if let loading { await loading.value; return }
        let task = Task { @MainActor in
            for bundle in bundles {
                do { try await loadBundle(bundle) }
                catch { failures[bundle.id] = error.localizedDescription }
            }
            changed()
        }
        loading = task
        await task.value
    }

    private func loadBundle(_ bundle: (id: String, directory: String, name: String)) async throws {
        if bundle.directory == "ublock-origin-lite" {
            guard #available(iOS 18.6, *) else { throw hostError("This uBO Lite release requires iOS 18.6 or later.") }
        }
        guard let url = Bundle.main.url(forResource: bundle.directory, withExtension: nil,
                                        subdirectory: "public/extensions") else {
            throw hostError("Bundled \(bundle.name) resources are missing. Run the iOS asset build.")
        }
        let ext = try await WKWebExtension(resourceBaseURL: url)
        let context = WKWebExtensionContext(for: ext)
        // Stable identities and base URLs preserve extension storage across launches.
        context.uniqueIdentifier = bundle.id == "ublock-origin-lite" ? "once.ublock-origin-lite" : bundle.id
        context.baseURL = URL(string: "webkit-extension://once-\(bundle.directory)/")!
        for permission in ext.requestedPermissions { context.setPermissionStatus(.grantedExplicitly, for: permission) }
        for pattern in ext.requestedPermissionMatchPatterns.union(ext.allRequestedMatchPatterns) { context.setPermissionStatus(.grantedExplicitly, for: pattern) }
        if bundle.directory == "ublock-origin-lite", let all = try? WKWebExtension.MatchPattern(string: "<all_urls>") {
            context.setPermissionStatus(.grantedExplicitly, for: all)
        }
        contexts[bundle.id] = context
        if UserDefaults.standard.bool(forKey: "once.extension.disabled.\(bundle.id)") != true {
            try controller.load(context)
            try await context.loadBackgroundContent()
        }
    }

    func attach(_ view: WKWebView, parent: UIView) {
        self.parent = parent
        let tab = ExtensionTab(view: view, owner: self)
        reading = tab
        controller.didOpenWindow(self)
        controller.didOpenTab(tab)
        controller.didFocusWindow(self)
    }

    func navigationChanged() {
        if let reading { controller.didChangeTabProperties([.URL, .title, .loading], for: reading) }
    }

    func detach() {
        closePage()
        guard let reading else { return }
        controller.didCloseTab(reading, windowIsClosing: true)
        controller.didCloseWindow(self)
        self.reading = nil
        parent = nil
    }

    func catalog() -> [[String: Any]] {
        bundles.map { bundle in
            guard let context = contexts[bundle.id] else {
                return ["id": bundle.id, "name": bundle.name, "description": "Bundled browser extension",
                        "version": "", "enabled": false, "bundled": true, "hasOptions": false,
                        "hasAction": false, "permissions": [], "disabledReason": failures[bundle.id] ?? ""]
            }
            let ext = context.webExtension
            return ["id": bundle.id, "name": ext.displayName ?? bundle.name,
                    "description": ext.displayDescription ?? "", "version": ext.version ?? "",
                    "enabled": context.isLoaded, "bundled": true,
                    "hasOptions": context.optionsPageURL != nil,
                    "hasAction": ext.manifest["action"] != nil || ext.manifest["browser_action"] != nil,
                    "permissions": ext.requestedPermissions.map(\.rawValue).sorted(),
                    "disabledReason": ([failures[bundle.id]].compactMap { $0 } + context.errors.map(\.localizedDescription)).joined(separator: "\n")]
        }
    }

    func command(_ action: String, id: String, enabled: Bool) throws -> [String: Any] {
        if action == "list" { return ["extensions": catalog()] }
        guard let context = contexts[id] else { throw hostError(failures[id] ?? "Extension not found") }
        switch action {
        case "enable":
            closePage()
            if enabled && !context.isLoaded { try controller.load(context) }
            if !enabled && context.isLoaded { try controller.unload(context) }
            UserDefaults.standard.set(!enabled, forKey: "once.extension.disabled.\(id)")
            changed()
        case "options":
            guard context.isLoaded else { throw hostError("Enable the extension first") }
            guard let url = context.optionsPageURL else { return ["noPage": true] }
            try open(url, context: context)
        case "action":
            guard context.isLoaded else { throw hostError("Enable the extension first") }
            guard let reading else { return ["noPage": true] }
            context.userGesturePerformed(in: reading)
            context.performAction(for: reading)
        default: throw hostError("iOS currently supports bundled extensions only")
        }
        return ["extensions": catalog()]
    }

    func pageCommand(_ action: String, bounds: CGRect?) {
        if action == "close" { closePage() }
        if action == "reload" { page?.view.reload() }
        if action == "bounds", let bounds { page?.view.frame = bounds }
    }

    func closePage(requestedBy view: WKWebView) {
        guard page?.view === view else { return }
        closePage()
    }

    func closePage() {
        if let page {
            page.view.removeFromSuperview()
            if popup == nil { controller.didCloseTab(page, windowIsClosing: false) }
        }
        page = nil
        popup?.closePopup()
        popup = nil
        pageChanged(["open": false, "popup": false, "title": "", "status": "", "count": 0])
    }

    private func present(_ view: WKWebView, context: WKWebExtensionContext, isPopup: Bool) throws {
        guard let parent else { throw hostError("Open a webpage before opening extension settings") }
        let tab = ExtensionTab(view: view, owner: self)
        page = tab
        view.uiDelegate = reading?.view.uiDelegate
        view.frame = .zero // The shell measures its toolbar and sends bounds before display.
        parent.addSubview(view)
        if !isPopup { controller.didOpenTab(tab) }
        pageChanged(["open": true, "popup": isPopup, "title": context.webExtension.displayName ?? "Extension",
                     "status": "", "count": 1])
    }

    private func open(_ url: URL, context: WKWebExtensionContext) throws {
        let configuration: WKWebViewConfiguration
        if url.scheme == context.baseURL.scheme && url.host == context.baseURL.host {
            guard let extensionConfiguration = context.webViewConfiguration else { throw hostError("Extension is not loaded") }
            configuration = extensionConfiguration
        } else if url.scheme == "https" || url.scheme == "http" {
            // Help and onboarding links are ordinary browser tabs, never loaded
            // into an extension-privileged web view or the Capacitor shell.
            configuration = WKWebViewConfiguration()
            configuration.webExtensionController = controller
            configuration.websiteDataStore = .default()
        } else { throw hostError("Unsupported extension page URL") }
        closePage()
        let view = WKWebView(frame: .zero, configuration: configuration)
        try present(view, context: context, isPopup: false)
        view.load(URLRequest(url: url))
    }

    func tabs(for context: WKWebExtensionContext) -> [any WKWebExtensionTab] {
        [reading, popup == nil ? page : nil].compactMap { $0 }
    }
    func activeTab(for context: WKWebExtensionContext) -> (any WKWebExtensionTab)? { popup == nil ? page ?? reading : reading }
    func webExtensionController(_ controller: WKWebExtensionController, openWindowsFor context: WKWebExtensionContext) -> [any WKWebExtensionWindow] { reading == nil ? [] : [self] }
    func webExtensionController(_ controller: WKWebExtensionController, focusedWindowFor context: WKWebExtensionContext) -> (any WKWebExtensionWindow)? { reading == nil ? nil : self }

    func webExtensionController(_ controller: WKWebExtensionController, openOptionsPageFor context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
        do {
            guard let url = context.optionsPageURL else { throw hostError("No options page") }
            try open(url, context: context)
            completionHandler(nil)
        } catch { completionHandler(error) }
    }

    func webExtensionController(_ controller: WKWebExtensionController, presentActionPopup action: WKWebExtension.Action, for context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
        do {
            guard let view = action.popupWebView else { throw hostError("No extension popup") }
            closePage()
            popup = action
            try present(view, context: context, isPopup: true)
            completionHandler(nil)
        } catch { completionHandler(error) }
    }

    func webExtensionController(_ controller: WKWebExtensionController, openNewTabUsing configuration: WKWebExtension.TabConfiguration, for context: WKWebExtensionContext, completionHandler: @escaping ((any WKWebExtensionTab)?, Error?) -> Void) {
        do {
            guard let url = configuration.url else { throw hostError("No extension page URL") }
            // A background install event may offer onboarding before the browser
            // exists. Decline that tab without failing extension initialization.
            guard parent != nil, reading != nil else { completionHandler(nil, nil); return }
            try open(url, context: context)
            completionHandler(page, nil)
        } catch { completionHandler(nil, error) }
    }
}

@available(iOS 18.4, *)
extension WebExtensionHost {
    enum NavigationDisposition { case allow, external, cancel }

    /// Internal tool frames stay in WebKit, which enforces web_accessible_resources.
    func navigationDisposition(for url: URL, targetIsMainFrame: Bool?) -> NavigationDisposition {
        if url.scheme == "http" || url.scheme == "https" {
            return targetIsMainFrame == nil ? .external : .allow
        }
        if url.scheme == "about" {
            return targetIsMainFrame == false && ["about:blank", "about:srcdoc"].contains(String(url.absoluteString.prefix { $0 != "#" })) ? .allow : .cancel
        }
        if url.scheme == "webkit-extension" {
            let loadedOrigin = contexts.values.contains {
                $0.isLoaded && $0.baseURL.scheme == url.scheme && $0.baseURL.host == url.host && $0.baseURL.port == url.port
            }
            return targetIsMainFrame == false && loadedOrigin ? .allow : .cancel
        }
        return .external
    }
}

private func hostError(_ message: String) -> NSError {
    NSError(domain: "OnceWebExtensions", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

@available(iOS 18.4, *)
@MainActor
private final class ExtensionTab: NSObject, WKWebExtensionTab {
    let view: WKWebView
    weak var owner: WebExtensionHost?
    init(view: WKWebView, owner: WebExtensionHost) { self.view = view; self.owner = owner }
    func window(for context: WKWebExtensionContext) -> (any WKWebExtensionWindow)? { owner }
    func webView(for context: WKWebExtensionContext) -> WKWebView? { view }
    func url(for context: WKWebExtensionContext) -> URL? { view.url }
    func title(for context: WKWebExtensionContext) -> String? { view.title }
    func isLoadingComplete(for context: WKWebExtensionContext) -> Bool { !view.isLoading }
    func size(for context: WKWebExtensionContext) -> CGSize { view.bounds.size }
    func reload(fromOrigin: Bool, for context: WKWebExtensionContext, completionHandler: @escaping (Error?) -> Void) {
        if fromOrigin { view.reloadFromOrigin() } else { view.reload() }
        completionHandler(nil)
    }
}
