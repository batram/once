import Foundation
import CryptoKit
import WebKit

/// Where a user-installed extension package came from, as the catalog and the
/// Electron runtime (packages/webext-runtime/src/ExtensionPackage.ts) describe it.
enum ExtensionSource {
    enum Kind: Equatable { case page(slug: String), download, none }
    static let hosts = ["addons.mozilla.org", "addons.cdn.mozilla.net"]
    static let localFile = "Local XPI (signature not verified)"
    private static let pagePath = try! NSRegularExpression(pattern: "^/(?:[a-zA-Z-]+/)?(?:firefox|android)/addon/([^/]+)/?$")
    private static let downloadPath = try! NSRegularExpression(pattern: "^/(?:[a-zA-Z-]+/)?firefox/downloads/file/\\d+/[^/]+\\.xpi$", options: .caseInsensitive)

    /// An add-on's listing page, one of its XPI download links, or neither.
    static func kind(of source: String) -> Kind {
        guard let url = URL(string: source.trimmingCharacters(in: .whitespacesAndNewlines)), url.scheme?.lowercased() == "https",
              url.user == nil, url.password == nil, let host = url.host?.lowercased() else { return .none }
        let path = url.path
        let range = NSRange(path.startIndex..., in: path)
        if host == "addons.mozilla.org", let match = pagePath.firstMatch(in: path, range: range),
           let slug = Range(match.range(at: 1), in: path) {
            return .page(slug: String(path[slug]).removingPercentEncoding ?? String(path[slug]))
        }
        if hosts.contains(host), downloadPath.firstMatch(in: path, range: range) != nil { return .download }
        return .none
    }

    struct Listing { let guid: String; let sha256: String; let url: String }

    /// Mozilla's current file for an add-on, by listing slug or by Gecko id.
    static func listing(for key: String) async throws -> Listing {
        let encoded = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? key
        let body = try await download("https://addons.mozilla.org/api/v5/addons/addon/\(encoded)/", limit: 2 * 1024 * 1024)
        let metadata = try JSONSerialization.jsonObject(with: body) as? [String: Any] ?? [:]
        let file = (metadata["current_version"] as? [String: Any])?["file"] as? [String: Any]
        guard metadata["type"] as? String == "extension", let guid = metadata["guid"] as? String,
              let url = file?["url"] as? String, let hash = file?["hash"] as? String,
              hash.range(of: "^sha256:[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw installError("Mozilla did not return a downloadable extension with a SHA-256 hash")
        }
        return Listing(guid: guid, sha256: String(hash.dropFirst(7)), url: url)
    }

    /// Downloads from Mozilla Add-ons only, following redirects that stay there.
    static func download(_ source: String, limit: Int) async throws -> Data {
        guard let url = URL(string: source), isTrusted(url) else { throw installError("The download must come from Mozilla Add-ons.") }
        var request = URLRequest(url: url)
        request.timeoutInterval = 60
        request.httpShouldHandleCookies = false
        let transfer = BoundedTransfer(limit: limit)
        let session = URLSession(configuration: .ephemeral, delegate: transfer, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        return try await withCheckedThrowingContinuation { continuation in
            transfer.continuation = continuation
            session.dataTask(with: request).resume()
        }
    }

    static func isTrusted(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.user == nil && url.password == nil && hosts.contains(url.host?.lowercased() ?? "")
    }

    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}

/// Accumulates a response up to a byte limit; redirects leaving Mozilla fail.
private final class BoundedTransfer: NSObject, URLSessionDataDelegate {
    let limit: Int
    var continuation: CheckedContinuation<Data, Error>?
    private var received = Data()
    private var redirects = 0
    init(limit: Int) { self.limit = limit }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        redirects += 1
        guard redirects <= 5, let url = request.url, ExtensionSource.isTrusted(url) else {
            finish(.failure(installError("Extension download left Mozilla Add-ons")))
            task.cancel()
            completionHandler(nil)
            return
        }
        var next = request
        next.httpShouldHandleCookies = false
        completionHandler(next)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            finish(.failure(installError("Extension download failed: HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)")))
            completionHandler(.cancel)
            return
        }
        if response.expectedContentLength > Int64(limit) {
            finish(.failure(installError("Extension download exceeds the size limit")))
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        received.append(data)
        if received.count > limit {
            finish(.failure(installError("Extension download exceeds the size limit")))
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { finish(.failure(error)) } else { finish(.success(received)) }
    }

    private func finish(_ result: Result<Data, Error>) {
        continuation?.resume(with: result)
        continuation = nil
    }
}

/// A user-installed package on disk, as the catalog file records it.
struct InstalledExtension: Codable, Equatable {
    var id: String
    /// Directory name below the packages root; a new install gets a new one.
    var directory: String
    var name: String
    var version: String
    var source: String
    var sha256: String
    var warnings: [String]
    var adaptations: [String]
    var installedAt: Date
}

/// The packages root and catalog under Application Support. Removal of a
/// directory that is gone already is fine; the catalog is replaced whole.
struct ExtensionPackageStore {
    let root: URL
    static let `default` = ExtensionPackageStore(root: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("BrowserExtensions", isDirectory: true))
    var packages: URL { root.appendingPathComponent("packages", isDirectory: true) }
    private var catalog: URL { root.appendingPathComponent("installed.json") }

    func directory(_ name: String) -> URL { packages.appendingPathComponent(name, isDirectory: true) }

    func load() -> [InstalledExtension] {
        guard let data = try? Data(contentsOf: catalog) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([InstalledExtension].self, from: data)) ?? []
    }

    func save(_ entries: [InstalledExtension]) throws {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try encoder.encode(entries).write(to: catalog, options: .atomic)
    }

    func remove(_ name: String) {
        try? FileManager.default.removeItem(at: directory(name))
    }

    /// Directories no catalog entry names, left by interrupted installs.
    func prune(keeping entries: [InstalledExtension]) {
        let kept = Set(entries.map(\.directory))
        let names = (try? FileManager.default.contentsOfDirectory(atPath: packages.path)) ?? []
        for name in names where !kept.contains(name) { remove(name) }
    }
}

/// The manifest changes a Firefox package needs before WebKit loads it. The
/// upstream code is untouched; only the manifest is rewritten in place.
enum WebKitManifestAdapter {
    struct Result { let id: String; let requestedPermissions: [String]; let adaptations: [String] }

    /// `listedId` is the id Mozilla's listing names; older add-ons signed
    /// without one in their manifest take it from there, as Firefox does.
    static func adapt(at directory: URL, listedId: String? = nil) throws -> Result {
        let file = directory.appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: file) else { throw installError("The package has no manifest.json") }
        guard var manifest = try JSONSerialization.jsonObject(with: data, options: [.json5Allowed]) as? [String: Any] else {
            throw installError("The package manifest is not a JSON object")
        }
        var adaptations: [String] = []
        let settingsKey = manifest["browser_specific_settings"] != nil ? "browser_specific_settings" : "applications"
        var settings = manifest[settingsKey] as? [String: Any] ?? [:]
        var gecko = settings["gecko"] as? [String: Any] ?? [:]
        var id = gecko["id"] as? String ?? ""
        if id.isEmpty {
            guard let listedId, !listedId.isEmpty else {
                throw installError("The package names no Firefox extension id; install it from its Firefox Add-ons page, which carries the id")
            }
            id = listedId
            gecko["id"] = id
            settings["gecko"] = gecko
            manifest[settingsKey] = settings
            adaptations.append("Extension id taken from Mozilla's listing")
        }
        if var background = manifest["background"] as? [String: Any] {
            if let worker = background["service_worker"] as? String {
                if background["scripts"] == nil { background["scripts"] = [worker] }
                background.removeValue(forKey: "service_worker")
                adaptations.append("Background service worker runs as an event page")
            }
            if (background["scripts"] != nil || background["page"] != nil), background["persistent"] as? Bool != false {
                background["persistent"] = false
                adaptations.append("Background page runs as a non-persistent event page; iOS has no persistent background pages")
            }
            manifest["background"] = background
        }
        let permissions = (manifest["permissions"] as? [Any] ?? []).compactMap { $0 as? String }
        if !adaptations.isEmpty {
            try JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted, .sortedKeys]).write(to: file, options: .atomic)
        }
        return Result(id: id, requestedPermissions: permissions, adaptations: adaptations)
    }

    /// What WebKit did not take from the manifest, worded for the review and the detail page.
    @available(iOS 18.4, *)
    static func warnings(for webExtension: WKWebExtension, requested: [String]) -> [String] {
        var warnings: [String] = []
        let known = Set(webExtension.requestedPermissions.map(\.rawValue)).union(webExtension.optionalPermissions.map(\.rawValue))
        let missing = requested.filter { permission in
            !known.contains(permission) && !permission.contains("://") && permission != "<all_urls>" && !permission.hasPrefix("*")
        }
        if missing.contains("webRequestBlocking") {
            warnings.append("Blocking web requests are not available on iOS, so this extension cannot filter or redirect network requests")
        }
        let other = missing.filter { $0 != "webRequestBlocking" }
        if !other.isEmpty { warnings.append("Not available on iOS WebKit: " + other.sorted().joined(separator: ", ")) }
        for error in webExtension.errors { warnings.append(error.localizedDescription) }
        return warnings
    }
}

/// A reviewed package: unpacked, adapted and parsed, not yet in the catalog.
@available(iOS 18.4, *)
struct ExtensionCandidate {
    let token: String
    let id: String
    let name: String
    let version: String
    let description: String
    let source: String
    let sha256: String
    let permissions: [String]
    let warnings: [String]
    let adaptations: [String]
    let update: Bool
    let webExtension: WKWebExtension

    func summary() -> [String: Any] {
        ["id": id, "name": name, "version": version, "description": description, "source": source,
         "permissions": permissions, "warnings": warnings, "adaptations": adaptations, "update": update]
    }
}

func installError(_ message: String) -> NSError {
    NSError(domain: "OnceWebExtensions", code: 2, userInfo: [NSLocalizedDescriptionKey: message])
}
