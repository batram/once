import Capacitor
import WebKit

/// Owns the current document's identity across redirects, failures and retries.
final class BrowserNavigationState {
    private var sequence = 0
    private var active: WKNavigation?
    private var requestedURLs: [ObjectIdentifier: URL] = [:]
    private var failedURL: URL?
    private var documentURL: URL?
    private(set) var sourceURL: URL?
    var statusCode: Int?
    /// How far the current navigation got, so a late listener can be caught up.
    enum Phase { case idle, started, committed, finished, failed }
    private(set) var phase = Phase.idle
    private(set) var failure: JSObject?

    func load(_ url: URL, in view: WKWebView) {
        if let navigation = view.load(URLRequest(url: url)) {
            requestedURLs[ObjectIdentifier(navigation)] = url
        }
    }

    func reload(_ view: WKWebView) {
        if let failedURL { load(failedURL, in: view) }
        else { view.reload() }
    }

    func started(_ navigation: WKNavigation?, url: URL?) {
        sequence += 1
        active = navigation
        phase = .started
        failure = nil
        statusCode = nil
        failedURL = nil
        let requested = navigation.flatMap { requestedURLs.removeValue(forKey: ObjectIdentifier($0)) } ?? url
        if documentKey(requested) != documentKey(documentURL) || sourceURL == nil { sourceURL = requested }
    }

    private func documentKey(_ url: URL?) -> String? {
        guard let url else { return nil }
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        parts?.fragment = nil
        return parts?.string
    }

    func committed() { phase = .committed }

    func finished(_ url: URL?) {
        documentURL = url
        phase = .finished
    }

    func isCurrent(_ navigation: WKNavigation?) -> Bool { navigation === active }

    func payload(_ url: URL?) -> JSObject {
        var value: JSObject = ["navigationId": sequence, "url": url?.absoluteString ?? ""]
        if let sourceURL { value["sourceUrl"] = sourceURL.absoluteString }
        if let statusCode { value["statusCode"] = statusCode }
        return value
    }

    func failed(_ navigation: WKNavigation?, url: URL?, error: Error) -> JSObject? {
        if let navigation { requestedURLs.removeValue(forKey: ObjectIdentifier(navigation)) }
        guard isCurrent(navigation) else { return nil }
        // WebKit may still expose the previous document after a provisional failure.
        failedURL = sourceURL ?? url
        var value = payload(failedURL)
        value["code"] = (error as NSError).code
        value["message"] = error.localizedDescription
        phase = .failed
        failure = value
        return value
    }

    func reset() {
        active = nil
        documentURL = nil
        sourceURL = nil
        failedURL = nil
        statusCode = nil
        phase = .idle
        failure = nil
        requestedURLs.removeAll()
    }
}
