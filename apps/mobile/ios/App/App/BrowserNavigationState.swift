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
    private var finishedAt: Date?
    private(set) var failure: JSObject?
    /// The app link the page sent the reader to instead of a document, held
    /// for the shell's "open in app" offer (see navigationFailed's externalUrl).
    private(set) var offeredExternalURL: URL?

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
        offeredExternalURL = nil
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
        finishedAt = Date()
    }

    /// Still arriving, or a redirect stub: WebKit finishes a document that
    /// only scripts `location = …` before it decides that navigation.
    var isSettling: Bool {
        switch phase {
        case .started, .committed: return true
        case .finished: return finishedAt.map { Date().timeIntervalSince($0) < 3 } ?? false
        case .idle, .failed: return false
        }
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

    /// The loading page sent the reader on to an app link instead of a
    /// document; the shell shows that as a failed page it can offer to open.
    func failed(externalURL: URL, message: String) -> JSObject {
        offeredExternalURL = externalURL
        failedURL = sourceURL ?? documentURL
        var value = payload(failedURL)
        value["code"] = -1
        value["message"] = message
        value["externalUrl"] = externalURL.absoluteString
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
        finishedAt = nil
        failure = nil
        offeredExternalURL = nil
        requestedURLs.removeAll()
    }
}
