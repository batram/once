import UIKit
import Capacitor
import Security
import WebKit

@objc(SecureSettingsPlugin)
public class SecureSettingsPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "SecureSettingsPlugin"
    public let jsName = "SecureSettings"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getSyncUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSyncUrl", returnType: CAPPluginReturnPromise)
    ]

    private let account = "sync_url"
    private var service: String { Bundle.main.bundleIdentifier ?? "com.zmarn.once" }

    @objc func getSyncUrl(_ call: CAPPluginCall) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            call.resolve(["value": ""])
            return
        }
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8) else {
            call.reject("Unable to read secure sync settings")
            return
        }
        call.resolve(["value": value])
    }

    @objc func setSyncUrl(_ call: CAPPluginCall) {
        let value = call.getString("value") ?? ""
        let match: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(match as CFDictionary)
        if value.isEmpty {
            call.resolve()
            return
        }
        var item = match
        item[kSecValueData as String] = Data(value.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
            call.reject("Unable to save secure sync settings")
            return
        }
        call.resolve()
    }
}

@objc(InAppBrowserSurfacePlugin)
public class InAppBrowserSurfacePlugin: CAPPlugin, CAPBridgedPlugin, WKNavigationDelegate, WKUIDelegate {
    public let identifier = "InAppBrowserSurfacePlugin"
    public let jsName = "InAppBrowserSurface"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "open", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "navigate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "reload", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "goBack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVisible", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise)
    ]

    private var surface: WKWebView?
    private var refreshControl: UIRefreshControl?
    private var navigationSequence = 0
    private var activeNavigation = 0

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
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.uiDelegate = self
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

    @objc func close(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.surface?.stopLoading()
            self.surface?.navigationDelegate = nil
            self.surface?.uiDelegate = nil
            self.surface?.removeFromSuperview()
            self.surface = nil
            self.refreshControl = nil
            call.resolve()
        }
    }

    private func payload(_ url: URL?) -> JSObject {
        ["navigationId": activeNavigation, "url": url?.absoluteString ?? ""]
    }

    private func history(_ view: WKWebView) {
        var value = payload(view.url)
        value["canGoBack"] = view.canGoBack
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
