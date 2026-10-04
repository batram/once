import UIKit
import Capacitor
import WebKit

@objc(InAppBrowserSurfacePlugin)
public class InAppBrowserSurfacePlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate, WKUIDelegate, UIGestureRecognizerDelegate {
    public let identifier = "InAppBrowserSurfacePlugin"
    public let jsName = "InAppBrowserSurface"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "capturePreview", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectTab", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "navigate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goBack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goForward", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showMenu", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showPrompt", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "evaluateJavaScript", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "findInPage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearFind", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "presentFind", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "applyExtensionSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "extensionCommand", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "extensionPage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private weak var owner: InAppBrowserSurfacePlugin?
    private var memoryObserver: NSObjectProtocol?
    private var reclaimedURL: URL?
    private var adoptedWindow = false
    private var tabId = ""
    private var tabGeneration = ""
    private var selectedTab: String?
    private var tabs: [String: InAppBrowserSurfacePlugin] = [:]
    private var retiredTabs = Set<String>()

    public override func load() {
        memoryObserver = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification,
                                                                object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            for (id, tab) in self.tabs where id != self.selectedTab {
                guard let view = tab.surface, !view.isLoading else { continue }
                // Conservatively retain pages with playing media or opaque frames.
                view.evaluateJavaScript("document.querySelector('iframe') !== null || Array.from(document.querySelectorAll('audio,video')).some(m => !m.paused && !m.ended)") { [weak self, weak tab] value, error in
                    guard let self, let tab, error == nil, value as? Bool == false,
                          self.tabs[id] === tab, id != self.selectedTab, tab.surface === view else { return }
                    tab.reclaimedURL = view.url
                    tab.extensions.detach(view)
                    view.navigationDelegate = nil
                    view.uiDelegate = nil
                    view.removeFromSuperview()
                    tab.urlObservation = nil
                    tab.surface = nil
                    tab.refreshControl = nil
                    tab.navigationState.reset()
                }
            }
        }
    }

    deinit {
        if let memoryObserver { NotificationCenter.default.removeObserver(memoryObserver) }
    }

    // Capacitor invokes plugin methods on its bridge queue, but the tab maps and
    // their views are main-queue state. Returns true when the receiver should
    // run the call itself; otherwise the call was hopped or forwarded.
    func route(_ call: CAPPluginCall, _ method: @escaping (InAppBrowserSurfacePlugin) -> Void) -> Bool {
        if owner != nil { return true }
        guard Thread.isMainThread else {
            DispatchQueue.main.async { method(self) }
            return false
        }
        guard let target = target(call) else { return false }
        if target === self { return true }
        method(target)
        return false
    }

    private func target(_ call: CAPPluginCall) -> InAppBrowserSurfacePlugin? {
        if owner != nil { return self }
        guard let id = call.getString("tabId") ?? selectedTab else { return self }
        let generation = call.getString("generation") ?? ""
        if let tab = tabs[id], generation.isEmpty || tab.tabGeneration == generation { return tab }
        if retiredTabs.contains(id + ":" + generation) {
            call.reject("The tab runtime was closed")
            return nil
        }
        if let previous = tabs[id] {
            retiredTabs.insert(id + ":" + previous.tabGeneration)
            previous.closeGeneration += 1
            previous.surface?.stopLoading()
            if let view = previous.surface { extensions.detach(view); view.removeFromSuperview() }
        }
        let tab = InAppBrowserSurfacePlugin()
        tab.owner = self
        tab.tabId = id
        tab.tabGeneration = generation
        tab.bridge = bridge
        tab.webView = webView
        tab.extensions = extensions
        tab.contentRuleList = contentRuleList
        tab.extensionUserScripts = extensionUserScripts
        tabs[id] = tab
        return tab
    }

    @objc func selectTab(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.selectedTab = call.getString("tabId")
            for (id, tab) in self.tabs where id != self.selectedTab { tab.surface?.isHidden = true }
            if let id = self.selectedTab, let view = self.tabs[id]?.surface { self.extensions.select(view) }
            call.resolve()
        }
    }

    private func pageEvent(_ name: String, data: [String: Any]) {
        guard let owner else { notifyListeners(name, data: data); return }
        guard owner.tabs[tabId] === self else { return }
        var payload = data
        payload["tabId"] = tabId
        payload["generation"] = tabGeneration
        payload["title"] = surface?.title ?? ""
        owner.notifyListeners(name, data: payload)
    }

    private var savedBounds: JSObject = [:]
    var surface: WKWebView?
    private var refreshControl: UIRefreshControl?
    private let navigationState = BrowserNavigationState()
    private var urlObservation: NSKeyValueObservation?
    private var extensionSettingsGeneration = 0
    /// Bumped by close() so an open/navigate still waiting on extensions doesn't revive the surface.
    private var closeGeneration = 0
    private let filterPreparation = IOSFilterPreparation()
    private let ruleCompiler = IOSContentRuleCompiler()
    private var installedRuleJSON: String?
    private var contentRuleList: WKContentRuleList?
    private var extensionUserScripts: [WKUserScript] = []
    private lazy var extensions: WebExtensionHost = {
        let host = WebExtensionHost()
        host.changed = { [weak self] in self?.notifyListeners("extensionsChanged", data: [:]) }
        host.pageChanged = { [weak self] in self?.notifyListeners("extensionPageChanged", data: $0) }
        return host
    }()

    /// The find engine the reader frame uses, bundled as public/page-find.js
    /// (apps/mobile/src/pageFindRuntime.ts). WebKit's own finder reports no
    /// count and highlights only the current match, so the page runs this
    /// instead; it installs `window.__onceFind` once and is cheap afterwards.
    lazy var pageFindSource: String? = {
        guard let url = Bundle.main.url(forResource: "page-find", withExtension: "js", subdirectory: "public")
        else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }()

    private func embeddable(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw),
              url.scheme?.lowercased() == "http" || url.scheme?.lowercased() == "https"
        else { return nil }
        return url
    }

    private func ensureSurface(configuration supplied: WKWebViewConfiguration? = nil) -> WKWebView? {
        if let surface { return surface }
        guard let shell = bridge?.webView, let parent = shell.superview else { return nil }
        let configuration = supplied ?? WKWebViewConfiguration()
        if supplied == nil {
            configuration.webExtensionController = extensions.controller
            configuration.websiteDataStore = .default()
            if let contentRuleList { configuration.userContentController.add(contentRuleList) }
            for script in extensionUserScripts { configuration.userContentController.addUserScript(script) }
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        extensions.attach(view, parent: parent)
        if owner?.selectedTab == tabId { extensions.select(view) }
        view.navigationDelegate = self
        view.uiDelegate = self
        // Safari's edge swipes for the page's own history. The recognizers
        // below pick up the edges WebKit leaves alone (no history that way)
        // and hand them to the shell, which continues its back stack.
        view.allowsBackForwardNavigationGestures = true
        for edge in [UIRectEdge.left, UIRectEdge.right] {
            let recognizer = UIScreenEdgePanGestureRecognizer(
                target: self,
                action: #selector(edgeSwiped(_:))
            )
            recognizer.edges = edge
            recognizer.delegate = self
            view.addGestureRecognizer(recognizer)
            view.scrollView.panGestureRecognizer.require(toFail: recognizer)
        }
        let refreshControl = UIRefreshControl()
        refreshControl.addTarget(
            self,
            action: #selector(refreshBrowser(_:)),
            for: .valueChanged
        )
        view.scrollView.refreshControl = refreshControl
        parent.insertSubview(view, aboveSubview: shell)
        self.refreshControl = refreshControl
        surface = view
        applyBounds(savedBounds)
        urlObservation = view.observe(\.url, options: [.new]) { [weak self] view, _ in
            // Fragment/history changes may have no navigation delegate callbacks.
            if !view.isLoading { self?.history(view) }
        }
        return view
    }

    /// Only begins when WebKit has no history in that direction; otherwise the
    /// web view's own gesture runs and this one stays out of the way.
    public func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
        guard let edge = recognizer as? UIScreenEdgePanGestureRecognizer, let surface else { return true }
        return edge.edges == .left ? !surface.canGoBack : !surface.canGoForward
    }

    /// WebKit's own touch recognizers would otherwise claim the touch first.
    public func gestureRecognizer(
        _ recognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        recognizer is UIScreenEdgePanGestureRecognizer
    }

    @objc private func edgeSwiped(_ recognizer: UIScreenEdgePanGestureRecognizer) {
        guard recognizer.state == .ended, let view = recognizer.view else { return }
        let travel = recognizer.translation(in: view).x
        let back = recognizer.edges == .left
        // Mirrors the shell gesture's commit distance.
        guard back ? travel >= 72 : travel <= -72 else { return }
        pageEvent("edgeSwipe", data: ["direction": back ? "back" : "forward"])
    }

    @objc private func refreshBrowser(_ sender: UIRefreshControl) {
        guard let surface else {
            sender.endRefreshing()
            return
        }
        navigationState.reload(surface)
    }

    private func finishRefresh() {
        refreshControl?.endRefreshing()
    }

    private func applyBounds(_ object: JSObject) {
        savedBounds = object
        guard let surface else { return }
        // CSS viewport pixels and UIKit points share the same logical scale.
        surface.frame = CGRect(
            x: max(0, object["x"] as? Double ?? 0),
            y: max(0, object["y"] as? Double ?? 0),
            width: max(0, object["width"] as? Double ?? 0),
            height: max(0, object["height"] as? Double ?? 0)
        )
    }

    @objc func open(_ call: CAPPluginCall) {
        guard route(call, { $0.open(call) }) else { return }
        guard let url = embeddable(call.getString("url")) else {
            call.reject("Embedded browsing only supports http and https URLs")
            return
        }
        Task { @MainActor in
            let generation = self.closeGeneration
            await self.extensions.prepare()
            guard generation == self.closeGeneration else { call.resolve(); return }
            guard let view = self.ensureSurface() else {
                call.reject("Unable to create the embedded browser surface")
                return
            }
            self.applyBounds(call.getObject("bounds") ?? [:])
            view.isHidden = !(call.getBool("visible") ?? true)
            if self.adoptedWindow { self.adoptedWindow = false }
            else { self.navigationState.load(url, in: view) }
            call.resolve()
        }
    }

    @objc func navigate(_ call: CAPPluginCall) {
        guard route(call, { $0.navigate(call) }) else { return }
        guard let url = embeddable(call.getString("url")) else {
            call.reject("Embedded browsing only supports http and https URLs")
            return
        }
        Task { @MainActor in
            let generation = self.closeGeneration
            await self.extensions.prepare()
            guard generation == self.closeGeneration else { call.resolve(); return }
            guard let view = self.ensureSurface() else {
                call.reject("Unable to create the embedded browser surface")
                return
            }
            self.navigationState.load(url, in: view)
            call.resolve()
        }
    }

    @objc func reload(_ call: CAPPluginCall) {
        guard route(call, { $0.reload(call) }) else { return }
        DispatchQueue.main.async {
            if let surface = self.surface { self.navigationState.reload(surface) }
            call.resolve()
        }
    }

    @objc func goBack(_ call: CAPPluginCall) {
        guard route(call, { $0.goBack(call) }) else { return }
        DispatchQueue.main.async {
            if self.surface?.canGoBack == true { self.surface?.goBack() }
            call.resolve()
        }
    }

    @objc func goForward(_ call: CAPPluginCall) {
        guard route(call, { $0.goForward(call) }) else { return }
        DispatchQueue.main.async {
            if self.surface?.canGoForward == true { self.surface?.goForward() }
            call.resolve()
        }
    }

    @objc func setBounds(_ call: CAPPluginCall) {
        guard route(call, { $0.setBounds(call) }) else { return }
        DispatchQueue.main.async {
            self.applyBounds(call.jsObjectRepresentation)
            call.resolve()
        }
    }

    @objc func setVisible(_ call: CAPPluginCall) {
        guard route(call, { $0.setVisible(call) }) else { return }
        DispatchQueue.main.async {
            let visible = (call.getBool("visible") ?? false) && (self.owner == nil || self.owner?.selectedTab == self.tabId)
            if visible, let url = self.reclaimedURL {
                self.reclaimedURL = nil
                if let view = self.ensureSurface() { self.navigationState.load(url, in: view) }
            }
            self.surface?.isHidden = !visible
            call.resolve()
        }
    }

    @objc func showMenu(_ call: CAPPluginCall) {
        guard route(call, { $0.showMenu(call) }) else { return }
        DispatchQueue.main.async {
            guard let presenter = self.presenter() else {
                call.reject("Unable to present the native menu")
                return
            }
            if call.getBool("browserControls") == true {
                self.presentBrowserMenu(call, from: presenter)
                return
            }
            let alert = UIAlertController(
                title: call.getString("title"),
                message: nil,
                preferredStyle: .actionSheet
            )
            let items = call.getArray("items", JSObject.self) ?? []
            for item in items {
                guard let id = item["id"] as? String,
                      let label = item["label"] as? String else { continue }
                let action = UIAlertAction(title: label, style: .default) {
                    _ in call.resolve(["id": id])
                }
                action.isEnabled = item["enabled"] as? Bool ?? true
                alert.addAction(action)
            }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) {
                _ in call.resolve()
            })
            if let popover = alert.popoverPresentationController {
                let anchor = call.getObject("anchor") ?? [:]
                popover.sourceView = presenter.view
                popover.sourceRect = CGRect(
                    x: anchor["x"] as? Double ?? presenter.view.bounds.midX,
                    y: anchor["y"] as? Double ?? presenter.view.bounds.midY,
                    width: max(1, anchor["width"] as? Double ?? 1),
                    height: max(1, anchor["height"] as? Double ?? 1)
                )
            }
            presenter.present(alert, animated: true)
        }
    }

    /// The browser sheet, like Android's: history and reload act on the page
    /// here; Find and the shell's rows resolve back to the shell.
    private func presentBrowserMenu(_ call: CAPPluginCall, from presenter: UIViewController) {
        let surface = self.surface
        // The shell says which theme it resolved; without that, follow the system.
        let dark = call.getBool("dark") ?? (presenter.traitCollection.userInterfaceStyle == .dark)
        let sheet = BrowserMenuSheet(call: call, navigation: .init(
            canBack: surface?.canGoBack == true,
            canForward: surface?.canGoForward == true,
            canReload: surface != nil,
            back: { surface?.goBack() },
            forward: { surface?.goForward() },
            reload: { [weak self] in
                if let surface { self?.navigationState.reload(surface) }
            }
        ), dark: dark)
        sheet.configureSheet()
        presenter.present(sheet, animated: true)
    }

    @objc func applyExtensionSettings(_ call: CAPPluginCall) {
        guard let filterLists = call.getObject("filterLists"),
              let userscripts = call.getObject("userscripts") else {
            call.reject("filterLists and userscripts are required")
            return
        }
        Task { @MainActor in
            extensionSettingsGeneration += 1
            let generation = extensionSettingsGeneration
            installUserscripts(userscripts)

            let entries = (filterLists["lists"] as? [JSObject] ?? []).compactMap { entry -> URL? in
                guard entry["enabled"] as? Bool != false,
                      let raw = entry["url"] as? String,
                      let url = URL(string: raw),
                      url.scheme == "https" || url.scheme == "http" else { return nil }
                return url
            }
            // Warm extensions without holding startup; content rules don't depend on them.
            Task { @MainActor in await self.extensions.prepare() }
            do {
                let encodedRules = try await filterPreparation.prepare(entries).value
                guard generation == extensionSettingsGeneration else { call.resolve(); return }
                try await compileAndInstallRules(encodedRules, generation: generation)
                if generation == extensionSettingsGeneration { call.resolve() }
                else { call.resolve() }
            } catch {
                if generation == extensionSettingsGeneration {
                    filterPreparation.retryAfterFailure()
                    call.reject(error.localizedDescription)
                } else { call.resolve() }
            }
        }
    }

    @objc func extensionCommand(_ call: CAPPluginCall) {
        Task { @MainActor in
            await extensions.prepare()
            let action = call.getString("action") ?? "list"
            if action == "options" || action == "action", surface == nil {
                ensureSurface()?.isHidden = true
            }
            do {
                call.resolve(try extensions.command(action, id: call.getString("id") ?? "",
                                                    enabled: call.getBool("enabled") ?? true))
            } catch { call.reject(error.localizedDescription) }
        }
    }

    @objc func extensionPage(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let object = call.getObject("bounds") ?? [:]
            let bounds = CGRect(x: max(0, object["x"] as? Double ?? 0), y: max(0, object["y"] as? Double ?? 0),
                                width: max(0, object["width"] as? Double ?? 0), height: max(0, object["height"] as? Double ?? 0))
            self.extensions.pageCommand(call.getString("action") ?? "close", bounds: bounds)
            call.resolve()
        }
    }

    @MainActor
    private func compileAndInstallRules(_ encodedRules: String, generation: Int) async throws {
        guard generation == extensionSettingsGeneration else { return }
        guard encodedRules != installedRuleJSON else { return }
        // An empty update clears existing rules without compiling an invalid [].
        let list = try await ruleCompiler.compile(encodedRules)
        guard generation == extensionSettingsGeneration else { return }
        if let previous = contentRuleList {
            surface?.configuration.userContentController.remove(previous)
        }
        if let list { surface?.configuration.userContentController.add(list) }
        contentRuleList = list
        installedRuleJSON = encodedRules
        for tab in tabs.values {
            if let previous = tab.contentRuleList { tab.surface?.configuration.userContentController.remove(previous) }
            if let list { tab.surface?.configuration.userContentController.add(list) }
            tab.contentRuleList = list
        }
    }

    private func installUserscripts(_ document: JSObject) {
        for tab in tabs.values { tab.installUserscripts(document) }
        let controller = surface?.configuration.userContentController
        controller?.removeAllUserScripts()
        extensionUserScripts = []
        for entry in document["scripts"] as? [JSObject] ?? [] {
            guard entry["enabled"] as? Bool != false,
                  let id = entry["id"] as? String,
                  let body = entry["body"] as? String else { continue }
            let source = UserscriptInjection.source(id: id, body: body, metadata: entry)
            let runAt = entry["runAt"] as? String
            let script = WKUserScript(
                source: source,
                injectionTime: runAt == "document-start" ? .atDocumentStart : .atDocumentEnd,
                forMainFrameOnly: entry["noFrames"] as? Bool ?? false
            )
            extensionUserScripts.append(script)
            controller?.addUserScript(script)
        }
    }

    @objc func close(_ call: CAPPluginCall) {
        guard route(call, { $0.close(call) }) else { return }
        // Routed tabs run here on the main queue: retire the identity now so
        // calls already queued behind this close cannot revive the tab.
        if let owner {
            if owner.tabs[tabId] === self { owner.tabs.removeValue(forKey: tabId) }
            owner.retiredTabs.insert(tabId + ":" + tabGeneration)
            if owner.selectedTab == tabId { owner.selectedTab = nil }
        }
        DispatchQueue.main.async {
            self.closeGeneration += 1
            if let view = self.surface { self.extensions.detach(view) }
            self.surface?.stopLoading()
            self.surface?.navigationDelegate = nil
            self.surface?.uiDelegate = nil
            self.surface?.removeFromSuperview()
            self.urlObservation = nil
            self.surface = nil
            self.navigationState.reset()
            self.refreshControl = nil
            self.contentRuleList = nil
            self.installedRuleJSON = nil
            call.resolve()
        }
    }

    private func history(_ view: WKWebView) {
        extensions.navigationChanged(view)
        var value = navigationState.payload(view.url)
        value["canGoBack"] = view.canGoBack
        value["canGoForward"] = view.canGoForward
        pageEvent("historyChanged", data: value)
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === surface else { return }
        navigationState.started(navigation, url: webView.url)
        pageEvent("navigationStarted", data: navigationState.payload(navigationState.sourceURL))
    }

    public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard webView === surface, navigationState.isCurrent(navigation) else { return }
        pageEvent("navigationCommitted", data: navigationState.payload(webView.url))
        history(webView)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === surface, navigationState.isCurrent(navigation) else { return }
        finishRefresh()
        navigationState.finished(webView.url)
        pageEvent("navigationFinished", data: navigationState.payload(webView.url))
        history(webView)
    }

    public func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        navigationFailed(webView, navigation: navigation, error: error)
    }

    public func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        navigationFailed(webView, navigation: navigation, error: error)
    }

    private func navigationFailed(_ webView: WKWebView, navigation: WKNavigation?, error: Error) {
        guard webView === surface else { return }
        guard let value = navigationState.failed(navigation, url: webView.url, error: error) else { return }
        finishRefresh()
        pageEvent("navigationFailed", data: value)
    }

    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.cancel)
            return
        }
        // A user-activated HTTP(S) link may request an in-app window. Keep the
        // shared subframe/external-scheme policy unchanged for every other request.
        if navigationAction.targetFrame == nil, navigationAction.navigationType == .linkActivated,
           embeddable(url.absoluteString) != nil {
            decisionHandler(.allow)
            return
        }
        switch extensions.navigationDisposition(for: url, targetIsMainFrame: navigationAction.targetFrame?.isMainFrame) {
        case .allow: decisionHandler(.allow)
        case .external:
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        case .cancel: decisionHandler(.cancel)
        }
    }

    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
        if navigationResponse.isForMainFrame,
           let response = navigationResponse.response as? HTTPURLResponse {
            navigationState.statusCode = response.statusCode
        }
        if !navigationResponse.canShowMIMEType,
           let url = navigationResponse.response.url {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    public func webViewDidClose(_ webView: WKWebView) {
        extensions.closePage(requestedBy: webView)
    }

    public func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        guard embeddable(url.absoluteString) != nil else { UIApplication.shared.open(url); return nil }
        let root = owner ?? self
        let tab = InAppBrowserSurfacePlugin()
        tab.owner = root
        tab.tabId = UUID().uuidString
        tab.tabGeneration = UUID().uuidString
        tab.bridge = bridge
        tab.webView = self.webView
        tab.extensions = extensions
        tab.contentRuleList = contentRuleList
        tab.extensionUserScripts = extensionUserScripts
        tab.adoptedWindow = true
        root.tabs[tab.tabId] = tab
        guard let view = tab.ensureSurface(configuration: configuration) else { root.tabs.removeValue(forKey: tab.tabId); return nil }
        view.isHidden = true
        root.notifyListeners("newTabRequested", data: ["tabId": tab.tabId, "generation": tab.tabGeneration,
                                                     "url": url.absoluteString, "navigationId": 0])
        return view
    }
}
