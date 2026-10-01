import UIKit
import Capacitor
import WebKit

@objc(InAppBrowserSurfacePlugin)
public class InAppBrowserSurfacePlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate, WKUIDelegate, UIGestureRecognizerDelegate {
    public let identifier = "InAppBrowserSurfacePlugin"
    public let jsName = "InAppBrowserSurface"
    public let pluginMethods: [CAPPluginMethod] = [
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
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private var surface: WKWebView?
    private var refreshControl: UIRefreshControl?
    private var navigationSequence = 0
    private var activeNavigation = 0
    private var extensionSettingsGeneration = 0
    private var contentRuleList: WKContentRuleList?
    private var extensionUserScripts: [WKUserScript] = []

    /// The find engine the reader frame uses, bundled as public/page-find.js
    /// (apps/mobile/src/pageFindRuntime.ts). WebKit's own finder reports no
    /// count and highlights only the current match, so the page runs this
    /// instead; it installs `window.__onceFind` once and is cheap afterwards.
    private lazy var pageFindSource: String? = {
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

    private func ensureSurface() -> WKWebView? {
        if let surface { return surface }
        guard let shell = bridge?.webView, let parent = shell.superview else { return nil }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        if let contentRuleList { configuration.userContentController.add(contentRuleList) }
        for script in extensionUserScripts { configuration.userContentController.addUserScript(script) }
        let view = WKWebView(frame: .zero, configuration: configuration)
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
        notifyListeners("edgeSwipe", data: ["direction": back ? "back" : "forward"])
    }

    @objc private func refreshBrowser(_ sender: UIRefreshControl) {
        guard let surface else {
            sender.endRefreshing()
            return
        }
        surface.reload()
    }

    private func finishRefresh() {
        refreshControl?.endRefreshing()
    }

    private func applyBounds(_ object: JSObject) {
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
        guard let url = embeddable(call.getString("url")) else {
            call.reject("Embedded browsing only supports http and https URLs")
            return
        }
        DispatchQueue.main.async {
            guard let view = self.ensureSurface() else {
                call.reject("Unable to create the embedded browser surface")
                return
            }
            self.applyBounds(call.getObject("bounds") ?? [:])
            view.isHidden = !(call.getBool("visible") ?? true)
            view.load(URLRequest(url: url))
            call.resolve()
        }
    }

    @objc func navigate(_ call: CAPPluginCall) {
        guard let url = embeddable(call.getString("url")) else {
            call.reject("Embedded browsing only supports http and https URLs")
            return
        }
        DispatchQueue.main.async {
            guard let view = self.ensureSurface() else {
                call.reject("Unable to create the embedded browser surface")
                return
            }
            view.load(URLRequest(url: url))
            call.resolve()
        }
    }

    @objc func reload(_ call: CAPPluginCall) {
        DispatchQueue.main.async { self.surface?.reload(); call.resolve() }
    }

    @objc func goBack(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.surface?.canGoBack == true { self.surface?.goBack() }
            call.resolve()
        }
    }

    @objc func goForward(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if self.surface?.canGoForward == true { self.surface?.goForward() }
            call.resolve()
        }
    }

    @objc func setBounds(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.applyBounds(call.jsObjectRepresentation)
            call.resolve()
        }
    }

    @objc func setVisible(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.surface?.isHidden = !(call.getBool("visible") ?? false)
            call.resolve()
        }
    }

    private func presenter() -> UIViewController? {
        var current = bridge?.viewController
        while let presented = current?.presentedViewController {
            current = presented
        }
        return current
    }

    @objc func showMenu(_ call: CAPPluginCall) {
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
            reload: { surface?.reload() }
        ), dark: dark)
        sheet.configureSheet()
        presenter.present(sheet, animated: true)
    }

    @objc func showPrompt(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.presenter() else {
                call.reject("Unable to present the native prompt")
                return
            }
            let alert = UIAlertController(
                title: call.getString("title"),
                message: call.getString("message"),
                preferredStyle: .alert
            )
            alert.addTextField { field in
                field.text = call.getString("value") ?? ""
                field.clearButtonMode = .whileEditing
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
                field.keyboardType = .URL
            }
            alert.addAction(UIAlertAction(
                title: call.getString("cancelLabel") ?? "Cancel",
                style: .cancel
            ) { _ in call.resolve() })
            alert.addAction(UIAlertAction(
                title: call.getString("confirmLabel") ?? "OK",
                style: .default
            ) { _ in
                call.resolve(["value": alert.textFields?.first?.text ?? ""])
            })
            presenter.present(alert, animated: true)
        }
    }

    @objc func applyExtensionSettings(_ call: CAPPluginCall) {
        guard let filterLists = call.getObject("filterLists"),
              let userscripts = call.getObject("userscripts") else {
            call.reject("filterLists and userscripts are required")
            return
        }
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
        Task {
            do {
                let texts = try await fetchFilterLists(entries)
                let encodedRules = try IOSContentBlockerExporter.export(texts.joined(separator: "\n"))
                try await compileAndInstallRules(encodedRules, generation: generation)
                if generation == extensionSettingsGeneration { call.resolve() }
                else { call.resolve() }
            } catch {
                if generation == extensionSettingsGeneration { call.reject(error.localizedDescription) }
                else { call.resolve() }
            }
        }
    }

    @objc func evaluateJavaScript(_ call: CAPPluginCall) {
        guard let script = call.getString("script"), !script.isEmpty else {
            call.reject("JavaScript source is required")
            return
        }
        DispatchQueue.main.async {
            guard let surface = self.surface else {
                call.reject("There is no open page")
                return
            }
            surface.evaluateJavaScript(script) { value, error in
                if let error {
                    call.reject("The script failed: \(error.localizedDescription)")
                    return
                }
                if value == nil || value is NSNull {
                    call.resolve(["value": "null"])
                } else if JSONSerialization.isValidJSONObject([value!]),
                          let data = try? JSONSerialization.data(withJSONObject: value!, options: [.fragmentsAllowed]) {
                    call.resolve(["value": String(decoding: data, as: UTF8.self)])
                } else {
                    call.resolve(["value": "null"])
                }
            }
        }
    }

    @objc func findInPage(_ call: CAPPluginCall) {
        guard let query = call.getString("query"), !query.isEmpty else {
            call.reject("Search text is required")
            return
        }
        let forward = call.getBool("forward") ?? true
        DispatchQueue.main.async {
            guard let surface = self.surface else {
                call.reject("There is no open page")
                return
            }
            guard let runtime = self.pageFindSource,
                  let encodedQuery = try? JSONSerialization.data(withJSONObject: [query], options: [.fragmentsAllowed]),
                  let queryLiteral = String(data: encodedQuery, encoding: .utf8) else {
                call.reject("The page could not be searched")
                return
            }
            // The literal is a one-element JSON array, so [0] reads the string
            // back. The runtime may end in a line comment, so the brace that
            // closes the block gets a line of its own.
            let script = """
            if (!window.__onceFind) {
            \(runtime)
            }
            JSON.stringify(window.__onceFind.find(\(queryLiteral)[0], \(forward ? "true" : "false")))
            """
            surface.evaluateJavaScript(script) { value, error in
                if let error {
                    call.reject("The page could not be searched: \(error.localizedDescription)")
                    return
                }
                guard let text = value as? String,
                      let data = text.data(using: .utf8),
                      let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    call.reject("The page could not be searched")
                    return
                }
                let current = result["current"] as? Int ?? 0
                let total = result["total"] as? Int ?? 0
                call.resolve([
                    "found": total > 0,
                    "wrapped": false,
                    "current": current,
                    "total": total
                ])
            }
        }
    }

    @objc func clearFind(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.surface?.evaluateJavaScript("window.__onceFind && window.__onceFind.clear()") { _, _ in }
            call.resolve()
        }
    }

    /// The system find panel (iOS 16 and later). WebKit searches the whole
    /// document itself, including PDFs in its native viewer, which the
    /// injected engine above cannot see because they have no DOM text.
    @objc func presentFind(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let surface = self.surface else {
                call.reject("There is no open page")
                return
            }
            if #available(iOS 16.0, *) {
                surface.isFindInteractionEnabled = true
                surface.findInteraction?.presentFindNavigator(showingReplace: false)
                call.resolve(["presented": true])
            } else {
                call.resolve(["presented": false])
            }
        }
    }

    private func fetchFilterLists(_ urls: [URL]) async throws -> [String] {
        try await withThrowingTaskGroup(of: String.self) { group in
            for url in urls {
                group.addTask {
                    let cacheKey = "once.filter-list." + Data(url.absoluteString.utf8).base64EncodedString()
                    do {
                        var request = URLRequest(url: url)
                        request.timeoutInterval = 30
                        request.setValue("Once iOS content blocker", forHTTPHeaderField: "User-Agent")
                        let (data, response) = try await URLSession.shared.data(for: request)
                        guard let http = response as? HTTPURLResponse,
                              (200..<300).contains(http.statusCode),
                              let text = String(data: data, encoding: .utf8) else {
                            throw NSError(domain: "OnceContentBlocker", code: 1,
                                          userInfo: [NSLocalizedDescriptionKey: "Unable to download \(url.absoluteString)"])
                        }
                        UserDefaults.standard.set(text, forKey: cacheKey)
                        return text
                    } catch {
                        if let cached = UserDefaults.standard.string(forKey: cacheKey) { return cached }
                        throw error
                    }
                }
            }
            var result: [String] = []
            for try await text in group { result.append(text) }
            return result
        }
    }

    @MainActor
    private func compileAndInstallRules(_ encodedRules: String, generation: Int) async throws {
        guard generation == extensionSettingsGeneration else { return }
        let identifier = "once-synced-filter-lists"
        let list = try await withCheckedThrowingContinuation {
                (continuation: CheckedContinuation<WKContentRuleList, Error>) in
                WKContentRuleListStore.default().compileContentRuleList(
                    forIdentifier: identifier,
                    encodedContentRuleList: encodedRules
                ) { list, error in
                    if let list { continuation.resume(returning: list) }
                    else { continuation.resume(throwing: error ?? NSError(
                        domain: "OnceContentBlocker", code: 2,
                        userInfo: [NSLocalizedDescriptionKey: "WebKit did not compile the content rules"]
                    )) }
                }
            }
        guard generation == extensionSettingsGeneration else { return }
        if let previous = contentRuleList {
            surface?.configuration.userContentController.remove(previous)
        }
        surface?.configuration.userContentController.add(list)
        contentRuleList = list
    }

    private func installUserscripts(_ document: JSObject) {
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
        DispatchQueue.main.async {
            self.surface?.stopLoading()
            self.surface?.navigationDelegate = nil
            self.surface?.uiDelegate = nil
            self.surface?.removeFromSuperview()
            self.surface = nil
            self.refreshControl = nil
            self.contentRuleList = nil
            call.resolve()
        }
    }

    private func payload(_ url: URL?) -> JSObject {
        ["navigationId": activeNavigation, "url": url?.absoluteString ?? ""]
    }

    private func history(_ view: WKWebView) {
        var value = payload(view.url)
        value["canGoBack"] = view.canGoBack
        value["canGoForward"] = view.canGoForward
        notifyListeners("historyChanged", data: value)
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        navigationSequence += 1
        activeNavigation = navigationSequence
        notifyListeners("navigationStarted", data: payload(webView.url))
    }

    public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        notifyListeners("navigationCommitted", data: payload(webView.url))
        history(webView)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finishRefresh()
        notifyListeners("navigationFinished", data: payload(webView.url))
        history(webView)
    }

    public func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        navigationFailed(webView, error: error)
    }

    public func webView(
        _ webView: WKWebView,
        didFail navigation: WKNavigation!,
        withError error: Error
    ) {
        navigationFailed(webView, error: error)
    }

    private func navigationFailed(_ webView: WKWebView, error: Error) {
        finishRefresh()
        var value = payload(webView.url)
        value["code"] = (error as NSError).code
        value["message"] = error.localizedDescription
        notifyListeners("navigationFailed", data: value)
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
        if embeddable(url.absoluteString) != nil, navigationAction.targetFrame != nil {
            decisionHandler(.allow)
        } else {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void
    ) {
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

    public func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { UIApplication.shared.open(url) }
        return nil
    }
}

class ViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(SecureSettingsPlugin())
        bridge?.registerPluginInstance(InAppBrowserSurfacePlugin())
    }
}

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
