// Deterministic installer regressions against the production host; see run-ios-extension-management.js.
import UIKit
import WebKit

enum WebInspector { static func track(_ view: WKWebView) {} }

/// The production URLSession uses this configured protocol instead of contacting Mozilla.
final class MozillaFixture: URLProtocol {
    static var requests: [String] = []
    static var wrongIdentity = false
    static let id = "review@once.invalid"
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        Self.requests.append(url.path)
        do {
            let archive = try Data(contentsOf: Bundle.main.bundleURL.appendingPathComponent("2.0.xpi"))
            let body: Data
            if url.path == "/api/v5/addons/addon/\(Self.id)" {
                body = try JSONSerialization.data(withJSONObject: ["type": "extension", "guid": Self.wrongIdentity ? "wrong@once.invalid" : Self.id,
                    "current_version": ["file": ["hash": "sha256:" + ExtensionSource.sha256(archive),
                        "url": "https://addons.mozilla.org/firefox/downloads/file/2/current.xpi"]]])
            } else if url.path == "/firefox/downloads/file/2/current.xpi" { body = archive }
            else { throw installError("Unexpected request: \(url.path)") }
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch { client?.urlProtocol(self, didFailWithError: error) }
    }
    override func stopLoading() {}
}

@MainActor final class Presenter: ExtensionInstallPresenter {
    var file: URL!
    func confirm(_ candidate: ExtensionCandidate?, removal: InstalledExtension?) async -> Bool { true }
    func pickArchive() async -> URL? { file }
}

@main @MainActor final class ManagementTest: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    var results: [String: Any] = [:]
    let manager = FileManager.default
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UIViewController()
        window.makeKeyAndVisible()
        self.window = window
        Task {
            do { try await exercise() } catch { results["failure"] = error.localizedDescription }
            results["done"] = true
            let destination = manager.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("results.json")
            try? JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys]).write(to: destination)
        }
        return true
    }

    func exercise() async throws {
        let root = manager.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("packages-test")
        let store = ExtensionPackageStore(root: root)
        let network = URLSessionConfiguration.ephemeral
        network.protocolClasses = [MozillaFixture.self]
        let host = WebExtensionHost(configuration: WKWebExtensionController.Configuration(identifier: UUID()), store: store,
                                    packageNetworkConfiguration: network)
        await host.prepare()
        let presenter = Presenter()
        host.presenter = presenter
        func installFile(_ name: String) async throws {
            presenter.file = manager.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".xpi")
            try manager.copyItem(at: Bundle.main.bundleURL.appendingPathComponent(name), to: presenter.file)
            _ = try await host.perform("chooseFile", id: "", source: nil, enabled: true)
        }
        try await installFile("1.0.xpi")
        let original = host.installed
        let originallyPersisted = store.load()
        let oldContext = host.context(for: MozillaFixture.id)!
        let catalog = root.appendingPathComponent("installed.json")
        let saved = try Data(contentsOf: catalog)

        // Force an atomic catalog write to fail after WebKit loads the candidate.
        for enabled in [true, false] {
            _ = try host.command("enable", id: MozillaFixture.id, enabled: enabled)
            try manager.removeItem(at: catalog)
            try manager.createDirectory(at: catalog, withIntermediateDirectories: false)
            do { try await installFile("2.0.xpi"); throw installError("Expected catalog write to fail") }
            catch {
                guard error.localizedDescription.contains("installed.json") else { throw error }
                guard host.installed == original, host.context(for: MozillaFixture.id) === oldContext,
                      oldContext.isLoaded == enabled, host.isEnabled(MozillaFixture.id) == enabled else {
                    throw installError("Failed update did not restore its previous state")
                }
            }
            let directories = try manager.contentsOfDirectory(atPath: store.packages.path)
            guard directories == [original[0].directory] else { throw installError("Failed update left a candidate or lost the old package") }
            try manager.removeItem(at: catalog)
            try saved.write(to: catalog)
        }
        results["rollbackLoadedAndDisabled"] = true
        // A subsequent successful save must not persist the discarded update.
        try await installFile("other.xpi")
        guard store.load().first(where: { $0.id == MozillaFixture.id }) == originallyPersisted[0] else { throw installError("Later save persisted the failed update") }
        results["laterSavePreservesOldVersion"] = true

        // First-time installs must roll back too, including a stale disabled preference.
        let newId = "fresh@once.invalid"
        UserDefaults.standard.set(true, forKey: "once.extension.disabled.\(newId)")
        let beforeFresh = host.installed
        let beforeFreshCatalog = try Data(contentsOf: catalog)
        try manager.removeItem(at: catalog)
        try manager.createDirectory(at: catalog, withIntermediateDirectories: false)
        do { try await installFile("fresh.xpi"); throw installError("Expected first-install save failure") }
        catch {
            guard error.localizedDescription.contains("installed.json") else { throw error }
            guard host.context(for: newId) == nil, host.installed == beforeFresh, !host.isEnabled(newId) else {
                throw installError("Failed first install leaked catalog, context, or enabled state")
            }
        }
        try manager.removeItem(at: catalog)
        try beforeFreshCatalog.write(to: catalog)
        results["firstInstallRollback"] = true

        let index = host.installed.firstIndex { $0.id == MozillaFixture.id }!
        let oldURL = "https://addons.mozilla.org/firefox/downloads/file/1/old.xpi"
        host.installed[index].source = oldURL
        try store.save(host.installed)
        _ = try await host.perform("update", id: MozillaFixture.id, source: nil, enabled: true)
        guard host.context(for: MozillaFixture.id)?.webExtension.version == "2.0",
              host.installed[index].source == oldURL, !host.isEnabled(MozillaFixture.id),
              MozillaFixture.requests == ["/api/v5/addons/addon/\(MozillaFixture.id)", "/firefox/downloads/file/2/current.xpi"] else {
            throw installError("Update did not resolve the latest release by GUID or lost its disabled state/provenance")
        }
        results["directURLUpdate"] = true
        MozillaFixture.wrongIdentity = true
        let updated = host.installed
        do { _ = try await host.perform("update", id: MozillaFixture.id, source: nil, enabled: true); throw installError("Expected identity mismatch") }
        catch {
            guard error.localizedDescription.contains("no longer matches"), host.installed == updated else { throw error }
        }
        results["rejectsChangedIdentity"] = true
    }
}
