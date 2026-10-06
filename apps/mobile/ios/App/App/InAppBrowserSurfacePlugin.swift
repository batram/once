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
        CAPPluginMethod(name: "goToHistoryIndex", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setHistoryGestures", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setContextMenuItems", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showMenu", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "closeBrowserMenu", returnType: CAPPluginReturnPromise),
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

    private(set) weak var owner: InAppBrowserSurfacePlugin?
    private var memoryObserver: NSObjectProtocol?
    private var backgroundObserver: NSObjectProtocol?
    private var reclaimedURL: URL?
    private var adoptedWindow = false
    // Opened by a page's window.open, so that page's script may close it again.
    private var openedByPage = false
    private var tabId = ""
    private var tabGeneration = ""
    private var selectedTab: String?
    private(set) var tabs: [String: InAppBrowserSurfacePlugin] = [:]
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
                    tab.dropSurface()
                }
            }
        }
        // The audio background mode (for reader speech) would otherwise let
        // page audio play on; unless the user keeps it, pause it as before.
        backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification,
                                                                    object: nil, queue: .main) { [weak self] _ in
            guard let self, !PlaybackAudioSession.shared.keepsPageMedia else { return }
            for view in ([self.surface] + self.tabs.values.map(\.surface)).compactMap({ $0 }) {
                view.pauseAllMediaPlayback {}
            }
        }
    }

    deinit {
        if let memoryObserver { NotificationCenter.default.removeObserver(memoryObserver) }
        if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
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
            previous.retire()
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
            self.extensions.select(self.selectedTab.flatMap { self.tabs[$0]?.surface })
            call.resolve()
        }
    }

    func pageEvent(_ name: String, data: [String: Any]) {
        guard let owner else { notifyListeners(name, data: data); return }
        guard owner.tabs[tabId] === self else { return }
        var payload = data
        payload["tabId"] = tabId
        payload["generation"] = tabGeneration
        payload["title"] = surface?.title ?? ""
        owner.notifyListeners(name, data: payload)
    }

    private var savedBounds: JSObject = [:]
    /// Off while the shell's history differs from WebKit's next to the current page.
    private var webKitSwipes = true
    /// Long-press menus waiting for the shell's items, by request; the root plugin holds them.
    var pendingMenus: [String: ([ShellMenuItem]) -> Void] = [:]
    var surface: WKWebView?
    /// Set once a tab instance is closed or superseded; it never gets a surface again.
    private var retired = false
    /// What open/setVisible last asked for; a surface created later starts that way.
    private var wantsVisible = false
    /// The bare root plugin is the single legacy surface while no tabs exist.
    private var isSelected: Bool { owner.map { $0.selectedTab == tabId } ?? tabs.isEmpty }
    private var refreshControl: UIRefreshControl?
    let navigationState = BrowserNavigationState()
    private var urlObservation: NSKeyValueObservation?
    private var extensionSettingsGeneration = 0
    /// Bumped by close() so an open/navigate still waiting on extensions doesn't revive the surface.
    private var closeGeneration = 0
    private let filterPreparation = IOSFilterPreparation()
    private let ruleCompiler = IOSContentRuleCompiler()
    private var installedRuleJSON: String?
    private var contentRuleList: WKContentRuleList?
    private var extensionUserScripts: [WKUserScript] = []
    /// Frames (by their script's token) currently playing audible media.
    var playingFrames = Set<String>()
    var mediaPlaying = false
    /// Root-only: a popup's configuration shares its opener's controller, and
    /// adding a second handler under the same name throws.
    let mediaControllers = NSHashTable<WKUserContentController>.weakObjects()
    lazy var mediaScript = WKUserScript(source: MediaObserver.source, injectionTime: .atDocumentStart,
                                                forMainFrameOnly: false, in: MediaObserver.world)
    private(set) lazy var extensions: WebExtensionHost = {
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

    func embeddable(_ raw: String?) -> URL? {
        guard let raw, let url = URL(string: raw),
              url.scheme?.lowercased() == "http" || url.scheme?.lowercased() == "https"
        else { return nil }
        return url
    }

    private func ensureSurface(configuration supplied: WKWebViewConfiguration? = nil) -> WKWebView? {
        if let surface { return surface }
        guard !retired, let shell = bridge?.webView, let parent = shell.superview else { return nil }
        let configuration = supplied ?? WKWebViewConfiguration()
        if supplied == nil {
            configuration.webExtensionController = extensions.controller
            configuration.websiteDataStore = .default()
            if let contentRuleList { configuration.userContentController.add(contentRuleList) }
            for script in extensionUserScripts { configuration.userContentController.addUserScript(script) }
        }
        installMediaObserver(configuration.userContentController)
        installContextMenuTracker(configuration.userContentController)
        // iPhone WebKit defaults to fullscreen-only video; like Safari, play
        // inline wherever the page allows it (playsinline).
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        // A background tab's surface must not flash over the selected one.
        view.isHidden = !(wantsVisible && isSelected)
        extensions.attach(view, parent: parent)
        if isSelected { extensions.select(view) }
        view.navigationDelegate = self
        view.uiDelegate = self
        // Safari's edge swipes for the page's own history. The recognizers
        // below pick up the edges WebKit leaves alone (no history that way)
        // and hand them to the shell, which continues its back stack.
        view.allowsBackForwardNavigationGestures = webKitSwipes
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
        // Inside the shell, which is the bridge controller's root view: UIKit
        // presents WebKit's context menus from the nearest view controller
        // above the page, and a sibling of the shell has none. The shell sits
        // at the parent's origin, so bounds keep meaning shell CSS pixels.
        shell.addSubview(view)
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
        guard surface.allowsBackForwardNavigationGestures else { return true }
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

    func finishRefresh() {
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
        // A newer page supersedes whatever a memory warning reclaimed.
        reclaimedURL = nil
        Task { @MainActor in
            let generation = self.closeGeneration
            await self.extensions.prepare()
            guard generation == self.closeGeneration else { call.resolve(); return }
            self.wantsVisible = call.getBool("visible") ?? true
            guard let view = self.ensureSurface() else {
                call.reject("Unable to create the embedded browser surface")
                return
            }
            self.applyBounds(call.getObject("bounds") ?? [:])
            view.isHidden = !(self.wantsVisible && self.isSelected)
            if self.adoptedWindow {
                self.adoptedWindow = false
                self.replayNavigation(view)
            } else { self.navigationState.load(url, in: view) }
            call.resolve()
        }
    }

    @objc func navigate(_ call: CAPPluginCall) {
        guard route(call, { $0.navigate(call) }) else { return }
        guard let url = embeddable(call.getString("url")) else {
            call.reject("Embedded browsing only supports http and https URLs")
            return
        }
        reclaimedURL = nil
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

    /// A position in the page's own history, as reported in historyChanged.
    @objc func goToHistoryIndex(_ call: CAPPluginCall) {
        guard route(call, { $0.goToHistoryIndex(call) }) else { return }
        DispatchQueue.main.async {
            if let surface = self.surface, let index = call.getInt("index"),
               let item = surface.backForwardList.item(at: index - surface.backForwardList.backList.count) {
                surface.go(to: item)
            }
            call.resolve()
        }
    }

    /// Which directions WebKit's own swipe may take. The shell takes the others:
    /// a Reader-mode entry there is not a page WebKit holds.
    @objc func setHistoryGestures(_ call: CAPPluginCall) {
        guard route(call, { $0.setHistoryGestures(call) }) else { return }
        DispatchQueue.main.async {
            self.webKitSwipes = call.getBool("back", true) && call.getBool("forward", true)
            self.surface?.allowsBackForwardNavigationGestures = self.webKitSwipes
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
            self.wantsVisible = call.getBool("visible") ?? false
            let visible = self.wantsVisible && (self.owner == nil || self.isSelected)
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
            // The element the shell opened it from, else where the user last
            // touched (a row in the sheet that just closed), else the bottom
            // right, nearest the thumb.
            let view = presenter.view!
            let source: CGRect
            if let anchor = call.getObject("anchor") {
                source = CGRect(
                    x: anchor["x"] as? Double ?? 0,
                    y: anchor["y"] as? Double ?? 0,
                    width: max(1, anchor["width"] as? Double ?? 1),
                    height: max(1, anchor["height"] as? Double ?? 1)
                )
            } else if let touch = LastTouchRecorder.location {
                source = CGRect(origin: view.convert(touch, from: nil), size: CGSize(width: 1, height: 1))
            } else {
                let safe = view.bounds.inset(by: view.safeAreaInsets)
                source = CGRect(x: safe.maxX - 24, y: safe.maxY - 24, width: 1, height: 1)
            }
            let dark = call.getBool("dark") ?? (presenter.traitCollection.userInterfaceStyle == .dark)
            presenter.present(AnchoredMenu(call: call, dark: dark, sourceView: view, sourceRect: source), animated: true)
        }
    }

    /// Closes a browser sheet a row held open for its own menu, when the
    /// shell showed none after all. A sheet already gone is fine.
    @objc func closeBrowserMenu(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            var current = self.bridge?.viewController
            while let presented = current?.presentedViewController {
                if let sheet = presented as? BrowserMenuSheet, sheet.isHeld {
                    sheet.dismiss(animated: true)
                    break
                }
                current = presented
            }
            call.resolve()
        }
    }

    /// The browser sheet, like Android's: history and reload act on the page
    /// here; Find and the shell's rows resolve back to the shell.
    private func presentBrowserMenu(_ call: CAPPluginCall, from presenter: UIViewController) {
        let surface = self.surface
        // The shell says which theme it resolved; without that, follow the system.
        let dark = call.getBool("dark") ?? (presenter.traitCollection.userInterfaceStyle == .dark)
        let history = call.getObject("history")
        let sheet = BrowserMenuSheet(call: call, navigation: .init(
            canBack: history?["back"] as? Bool ?? (surface?.canGoBack == true),
            canForward: history?["forward"] as? Bool ?? (surface?.canGoForward == true),
            canReload: surface != nil,
            // With Reader-mode entries the shell owns the steps, not WebKit.
            back: { [weak self] in
                if history != nil { self?.pageEvent("historyRequested", data: ["direction": "back"]) } else { surface?.goBack() }
            },
            forward: { [weak self] in
                if history != nil { self?.pageEvent("historyRequested", data: ["direction": "forward"]) } else { surface?.goForward() }
            },
            reload: { [weak self] in
                if let surface { self?.navigationState.reload(surface) }
            }
        ), keepsMedia: PlaybackAudioSession.shared.keepsPageMedia, dark: dark) {
            PlaybackAudioSession.shared.keepsPageMedia = $0
        }
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
        if let controller { installMediaObserver(controller) }
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
        // While still routed, so the shell hears it before the tab goes.
        resetMedia()
        // Routed tabs run here on the main queue: retire the identity now so
        // calls already queued behind this close cannot revive the tab.
        if let owner {
            if owner.tabs[tabId] === self { owner.tabs.removeValue(forKey: tabId) }
            owner.retiredTabs.insert(tabId + ":" + tabGeneration)
            if owner.selectedTab == tabId { owner.selectedTab = nil }
        }
        retire()
        call.resolve()
    }

    /// Shared by close() and a superseded generation. Work already holding this
    /// instance (an open awaiting extensions, a reclaim probe) finds nothing to revive.
    private func retire() {
        if owner != nil { retired = true }
        closeGeneration += 1
        reclaimedURL = nil
        adoptedWindow = false
        dropSurface()
        contentRuleList = nil
        installedRuleJSON = nil
    }

    /// Removes the page but keeps the tab identity; a reclaim may recreate it.
    private func dropSurface() {
        resetMedia()
        if let view = surface {
            extensions.detach(view)
            view.stopLoading()
            view.navigationDelegate = nil
            view.uiDelegate = nil
            view.removeFromSuperview()
        }
        urlObservation = nil
        surface = nil
        refreshControl = nil
        navigationState.reset()
    }

    public func webViewDidClose(_ webView: WKWebView) {
        extensions.closePage(requestedBy: webView)
        // The shell owns the tab list, so it decides how the tab goes away.
        if webView === surface, openedByPage { pageEvent("closeRequested", data: [:]) }
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
        tab.openedByPage = true
        root.tabs[tab.tabId] = tab
        // Not selected and not asked to be visible, so it starts hidden.
        guard let view = tab.ensureSurface(configuration: configuration) else { root.tabs.removeValue(forKey: tab.tabId); return nil }
        root.notifyListeners("newTabRequested", data: ["tabId": tab.tabId, "generation": tab.tabGeneration,
                                                     "url": url.absoluteString, "navigationId": 0])
        return view
    }
}

