import Capacitor
import UIKit
import WebKit

// Navigation reporting for a tab's surface: the WKNavigationDelegate callbacks
// and the history/replay events they send to the shell.
extension InAppBrowserSurfacePlugin {
    /// A popup's tab navigates before JS has created the tab and installed its
    /// listeners, so open() replays where that navigation has got to.
    func replayNavigation(_ view: WKWebView) {
        let state = navigationState
        guard state.phase != .idle else { return } // Its events are still to come.
        pageEvent("navigationStarted", data: state.payload(view.url))
        if state.phase == .committed || state.phase == .finished {
            pageEvent("navigationCommitted", data: state.payload(view.url))
        }
        if state.phase == .finished { pageEvent("navigationFinished", data: state.payload(view.url)) }
        if state.phase == .failed, let failure = state.failure { pageEvent("navigationFailed", data: failure) }
        history(view)
    }

    func history(_ view: WKWebView) {
        extensions.navigationChanged(view)
        var value = navigationState.payload(view.url)
        value["canGoBack"] = view.canGoBack
        value["canGoForward"] = view.canGoForward
        // The whole list, so the shell can keep its Reader-mode entries in step.
        let list = view.backForwardList
        let pages = list.backList + [list.currentItem].compactMap { $0 } + list.forwardList
        value["historyUrls"] = pages.map { $0.url.absoluteString }
        value["historyIndex"] = list.backList.count
        pageEvent("historyChanged", data: value)
    }

    public func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        guard webView === surface else { return }
        navigationState.started(navigation, url: webView.url)
        pageEvent("navigationStarted", data: navigationState.payload(navigationState.sourceURL))
    }

    public func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        guard webView === surface, navigationState.isCurrent(navigation) else { return }
        navigationState.committed()
        // The previous document and its frames are gone, whatever they last said.
        resetMedia()
        pageEvent("navigationCommitted", data: navigationState.payload(webView.url))
        history(webView)
    }

    public func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView === surface, navigationState.isCurrent(navigation) else { return }
        finishRefresh()
        // A document that sent the reader on to an app link has nothing more
        // to show: the shell keeps its failed page and the offer to open the link.
        if navigationState.offeredExternalURL != nil { history(webView); return }
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
        if pluginHandledLoad(error) {
            mediaDocumentLoaded(webView, navigation: navigation)
            return
        }
        guard let value = navigationState.failed(navigation, url: webView.url, error: error) else { return }
        finishRefresh()
        pageEvent("navigationFailed", data: value)
    }

    /// A video or audio file opened on its own plays in WebKit's media
    /// document, and WebKit ends that navigation with "Plug-in handled load"
    /// while the player is up. The page is there, so it finished.
    private func pluginHandledLoad(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == "WebKitErrorDomain" && error.code == 204
    }

    private func mediaDocumentLoaded(_ webView: WKWebView, navigation: WKNavigation?) {
        guard navigationState.isCurrent(navigation) else { return }
        if navigationState.phase == .started {
            navigationState.committed()
            resetMedia()
            pageEvent("navigationCommitted", data: navigationState.payload(webView.url))
        }
        finishRefresh()
        navigationState.finished(webView.url)
        pageEvent("navigationFinished", data: navigationState.payload(webView.url))
        history(webView)
    }

    public func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        preferences: WKWebpagePreferences,
        decisionHandler: @escaping (WKNavigationActionPolicy, WKWebpagePreferences) -> Void
    ) {
        preferences.preferredContentMode = desktopSite ? .desktop : .mobile
        decidePolicy(for: navigationAction) { decisionHandler($0, preferences) }
    }

    /// Safari's own desktop user agent. WebKit's desktop mode alone leaves out
    /// Safari's Version token, and sites that look for Safari (Google Earth)
    /// then turn the page away as an unsupported browser.
    var desktopUserAgent: String? {
        guard desktopSite else { return nil }
        let os = ProcessInfo.processInfo.operatingSystemVersion
        return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) "
            + "Version/\(os.majorVersion).\(os.minorVersion) Safari/605.1.15"
    }

    /// An XPI link tapped in a page installs through the same review as the
    /// settings page; the result reaches the user as a sheet, not a download.
    func installExtension(from url: URL) {
        Task { @MainActor in
            await extensions.prepare()
            do { _ = try await extensions.perform("install", id: "", source: url.absoluteString, enabled: true) }
            catch {
                let alert = UIAlertController(title: "Extension not installed", message: error.localizedDescription, preferredStyle: .alert)
                alert.addAction(UIAlertAction(title: "OK", style: .default))
                bridge?.viewController?.present(alert, animated: true)
            }
        }
    }

    private func decidePolicy(
        for navigationAction: WKNavigationAction,
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
        // A Mozilla Add-ons package link is an install request, as on Electron.
        if navigationAction.targetFrame?.isMainFrame != false, ExtensionSource.kind(of: url.absoluteString) == .download {
            installExtension(from: url)
            decisionHandler(.cancel)
            return
        }
        switch extensions.navigationDisposition(for: url, targetIsMainFrame: navigationAction.targetFrame?.isMainFrame) {
        case .allow: decisionHandler(.allow)
        case .external:
            leaveForApp(url, navigationAction)
            decisionHandler(.cancel)
        case .cancel: decisionHandler(.cancel)
        }
    }

    /// A tapped link may leave for its app (tel:, mailto:, an installed app's
    /// scheme); a redirect, a script or a frame may not without asking, and
    /// must not leave a loading page blank. Safari asks before leaving too.
    /// WebKit reports no user gesture, so a link activation stands in for one.
    func leaveForApp(_ url: URL, _ navigationAction: WKNavigationAction) {
        guard navigationAction.targetFrame?.isMainFrame != false else { return }
        if navigationAction.navigationType == .linkActivated {
            UIApplication.shared.open(url)
        } else if navigationState.isSettling {
            offerExternal(url)
        }
    }

    /// Opens the app link the page redirected to (see navigationFailed's externalUrl).
    @objc func openExternalRedirect(_ call: CAPPluginCall) {
        guard route(call, { $0.openExternalRedirect(call) }) else { return }
        DispatchQueue.main.async {
            guard let url = self.navigationState.offeredExternalURL else { call.resolve(["opened": false]); return }
            UIApplication.shared.open(url) { call.resolve(["opened": $0]) }
        }
    }

    private func offerExternal(_ url: URL) {
        finishRefresh()
        let message = url.scheme.map { "The page tried to open a \($0): link, which the browser cannot show." }
            ?? "The page tried to open a link the browser cannot show."
        pageEvent("navigationFailed", data: navigationState.failed(externalURL: url, message: message))
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
        if !navigationResponse.canShowMIMEType {
            // Only the page itself may hand its document to another app; a
            // frame's response is dropped, as a frame may never leave the app.
            if navigationResponse.isForMainFrame, let url = navigationResponse.response.url {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    public func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView === surface { resetMedia() }
        webView.reload()
    }
}
