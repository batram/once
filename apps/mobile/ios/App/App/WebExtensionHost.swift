import UIKit
import WebKit

/// Owns only the browsing surface; extensions never receive the Capacitor shell.
@available(iOS 18.4, *)
@MainActor
final class WebExtensionHost: NSObject, WKWebExtensionControllerDelegate, WKWebExtensionWindow {
    let controller: WKWebExtensionController
    var contexts: [String: WKWebExtensionContext] = [:]
    var failures: [String: String] = [:]
    /// User-installed packages, in install order, as the catalog file records them.
    var installed: [InstalledExtension] = []
    let store: ExtensionPackageStore
    /// Confirms installs and removals and picks local files; nil confirms silently (test hosts).
    var presenter: ExtensionInstallPresenter?
    private var icons: [String: String] = [:]
    private var loading: Task<Void, Never>?
    private var reading: ExtensionTab?
    private var readingTabs: [ObjectIdentifier: ExtensionTab] = [:]
    private var page: ExtensionTab?
    /// The browsing surface the page or popup was opened over.
    private var pageOwner: ObjectIdentifier?
    private var popup: WKWebExtension.Action?
    private weak var parent: UIView?
    var changed: () -> Void = {}
    var pageChanged: ([String: Any]) -> Void = { _ in }
    let bundles: [(id: String, directory: String, name: String)] = [
        ("ublock-origin-lite", "ublock-origin-lite", "uBlock Origin Lite"),
        ("addon@darkreader.org", "darkreader", "Dark Reader"),
        ("sponsorBlocker@ajay.app", "sponsorblock", "SponsorBlock"),
        ("{aecec67f-0d10-4fa7-b7c7-609a2db280cf}", "violentmonkey", "Violentmonkey")
    ]

    init(configuration: WKWebExtensionController.Configuration? = nil, store: ExtensionPackageStore = .default) {
        controller = WKWebExtensionController(configuration: configuration ?? .default())
        self.store = store
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
            installed = store.load()
            store.prune(keeping: installed)
            for entry in installed {
                do { try await loadInstalled(entry) }
                catch { failures[entry.id] = error.localizedDescription }
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
        // Stable identities and base URLs preserve extension storage across launches.
        let context = makeContext(for: ext, identifier: bundle.id == "ublock-origin-lite" ? "once.ublock-origin-lite" : bundle.id,
                                  host: "once-\(bundle.directory)")
        if bundle.directory == "ublock-origin-lite", let all = try? WKWebExtension.MatchPattern(string: "<all_urls>") {
            context.setPermissionStatus(.grantedExplicitly, for: all)
        }
        contexts[bundle.id] = context
        if isEnabled(bundle.id) {
            try controller.load(context)
            // uBO installs its rules before the first navigation. Other event-page
            // backgrounds wake through WebKit when content scripts or tools need them.
            if bundle.directory == "ublock-origin-lite" {
                try await context.loadBackgroundContent()
            }
        }
    }

    /// A user-installed package from the catalog; its enabled state is the same switch bundles use.
    private func loadInstalled(_ entry: InstalledExtension) async throws {
        guard !contexts.keys.contains(entry.id) else { throw hostError("\(entry.name) is included with Once") }
        let ext = try await WKWebExtension(resourceBaseURL: store.directory(entry.directory))
        let context = makeContext(for: ext, identifier: entry.id, host: WebExtensionHost.hostName(for: entry.id))
        contexts[entry.id] = context
        if isEnabled(entry.id) { try controller.load(context) }
    }

    /// The packaged icon as the small PNG the settings rows and the browser sheet
    /// draw, as Android sends it; rendered once per version, kept for the catalog.
    private func iconDataUrl(for ext: WKWebExtension, id: String) -> String? {
        let key = "\(id)@\(ext.version ?? "")"
        if let cached = icons[key] { return cached.isEmpty ? nil : cached }
        let size = CGSize(width: 40, height: 40)
        let png = ext.icon(for: size).flatMap { image in
            UIGraphicsImageRenderer(size: size, format: .default()).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }.pngData()
        }
        let value = png.map { "data:image/png;base64," + $0.base64EncodedString() } ?? ""
        icons[key] = value
        return value.isEmpty ? nil : value
    }

    func makeContext(for ext: WKWebExtension, identifier: String, host: String) -> WKWebExtensionContext {
        let context = WKWebExtensionContext(for: ext)
        context.uniqueIdentifier = identifier
        context.baseURL = URL(string: "webkit-extension://\(host)/")!
        for permission in ext.requestedPermissions { context.setPermissionStatus(.grantedExplicitly, for: permission) }
        for pattern in ext.requestedPermissionMatchPatterns.union(ext.allRequestedMatchPatterns) { context.setPermissionStatus(.grantedExplicitly, for: pattern) }
        return context
    }

    /// A stable origin for any Firefox id (ids may carry braces and @), so storage survives updates.
    static func hostName(for id: String) -> String {
        "once-x" + ExtensionSource.sha256(Data(id.utf8)).prefix(24)
    }

    func isEnabled(_ id: String) -> Bool { UserDefaults.standard.bool(forKey: "once.extension.disabled.\(id)") != true }

    /// Every surface is a tab of this one window: it opens with the first and
    /// closes with the last. Selection, not attachment, focuses it.
    func attach(_ view: WKWebView, parent: UIView) {
        self.parent = parent
        let tab = ExtensionTab(view: view, owner: self)
        if readingTabs.isEmpty { controller.didOpenWindow(self) }
        readingTabs[ObjectIdentifier(view)] = tab
        controller.didOpenTab(tab)
    }

    /// nil when the selected tab has no surface (reader mode, not yet opened),
    /// so actions never land on a hidden background page.
    func select(_ view: WKWebView?) {
        let wasFocused = reading != nil
        reading = view.flatMap { readingTabs[ObjectIdentifier($0)] }
        if (reading != nil) != wasFocused { controller.didFocusWindow(reading == nil ? nil : self) }
    }

    func navigationChanged(_ view: WKWebView) {
        if let tab = readingTabs[ObjectIdentifier(view)] { controller.didChangeTabProperties([.URL, .title, .loading], for: tab) }
    }

    func detach(_ view: WKWebView) {
        guard let tab = readingTabs.removeValue(forKey: ObjectIdentifier(view)) else { return }
        // A page left behind would sit in the hierarchy over no browser.
        if page != nil || popup != nil, pageOwner == ObjectIdentifier(view) || readingTabs.isEmpty { closePage() }
        controller.didCloseTab(tab, windowIsClosing: readingTabs.isEmpty)
        // The selected tab lost its surface; the plugin reselects when it returns.
        if reading === tab { reading = nil }
        if readingTabs.isEmpty {
            controller.didCloseWindow(self)
            parent = nil
        }
    }

    func catalog() -> [[String: Any]] {
        bundles.map { entry(id: $0.id, name: $0.name, version: "", installed: nil) } +
            installed.map { entry(id: $0.id, name: $0.name, version: $0.version, installed: $0) }
    }

    /// The row the settings page shows; a bundle names no source, its row says "Included with Once".
    private func entry(id: String, name: String, version: String, installed: InstalledExtension?) -> [String: Any] {
        var row: [String: Any] = ["id": id, "name": name, "version": version, "bundled": installed == nil,
                                  "description": installed == nil ? "Bundled browser extension" : "Installed browser extension",
                                  "enabled": false, "hasOptions": false, "hasAction": false, "permissions": [],
                                  "warnings": installed?.warnings ?? [], "disabledReason": failures[id] ?? ""]
        if let installed { row["source"] = installed.source }
        guard let context = contexts[id] else { return row }
        let ext = context.webExtension
        row["name"] = ext.displayName ?? name
        row["description"] = ext.displayDescription ?? ""
        row["version"] = ext.version ?? version
        row["enabled"] = context.isLoaded
        row["hasOptions"] = context.optionsPageURL != nil
        row["hasAction"] = ext.manifest["action"] != nil || ext.manifest["browser_action"] != nil
        row["permissions"] = ext.requestedPermissions.map(\.rawValue).sorted()
        if let icon = iconDataUrl(for: ext, id: id) { row["iconDataUrl"] = icon }
        // WebKit's manifest notes (an empty `commands` entry, say) explain a failed
        // load; on a running extension they are compatibility notes, not a reason.
        let notes = context.errors.map(\.localizedDescription)
        row["disabledReason"] = ([failures[id]].compactMap { $0 } + (context.isLoaded ? [] : notes)).joined(separator: "\n")
        if installed == nil { row["warnings"] = notes }
        return row
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
        default: throw hostError("Unknown extension command \(action)")
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
        pageOwner = nil
        popup?.closePopup()
        popup = nil
        pageChanged(["open": false, "popup": false, "title": "", "status": "", "count": 0])
    }

    private func present(_ view: WKWebView, context: WKWebExtensionContext, isPopup: Bool) throws {
        guard let parent else { throw hostError("Open a webpage before opening extension settings") }
        let tab = ExtensionTab(view: view, owner: self)
        page = tab
        pageOwner = reading.map { ObjectIdentifier($0.view) }
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
        WebInspector.track(view)
        try present(view, context: context, isPopup: false)
        view.load(URLRequest(url: url))
    }

    func tabs(for context: WKWebExtensionContext) -> [any WKWebExtensionTab] {
        Array(readingTabs.values) + [popup == nil ? page : nil].compactMap { $0 }
    }
    func activeTab(for context: WKWebExtensionContext) -> (any WKWebExtensionTab)? { popup == nil ? page ?? reading : reading }
    func webExtensionController(_ controller: WKWebExtensionController, openWindowsFor context: WKWebExtensionContext) -> [any WKWebExtensionWindow] { readingTabs.isEmpty ? [] : [self] }
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

func hostError(_ message: String) -> NSError {
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
