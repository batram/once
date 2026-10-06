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
        if webView === surface { resetMedia() }
        webView.reload()
    }
}
