// Isolated performance harness compiled with the unmodified production host.
import UIKit
import WebKit

@main @MainActor
final class ExtensionBenchmark: UIResponder, UIApplicationDelegate, WKNavigationDelegate {
    var window: UIWindow?
    var web: WKWebView!
    var host: WebExtensionHost?
    var navigation: CheckedContinuation<Void, Error>?
    var result: [String: Any] = [:]
    let clock = ProcessInfo.processInfo
    let ids = ["ublock-origin-lite", "addon@darkreader.org", "sponsorBlocker@ajay.app", "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}"]
    func now() -> Double { clock.systemUptime * 1000 }
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        application.isIdleTimerDisabled = true
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = UIViewController(); w.makeKeyAndVisible(); window = w
        w.overrideUserInterfaceStyle = .light
        Task {
            do { try await run() } catch { result["error"] = String(describing: error) }
            result["done"] = true; save()
            application.isIdleTimerDisabled = false
        }
        return true
    }
    func save() {
        let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("benchmark.json")
        try? JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        host?.navigationChanged(webView); self.navigation?.resume(); self.navigation = nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.navigation?.resume(throwing: error); self.navigation = nil
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        self.navigation?.resume(throwing: error); self.navigation = nil
    }
    func run() async throws {
        let mode = CommandLine.arguments.dropFirst().first ?? "all"
        let enabled: Set<String> = mode == "all" ? Set(ids) : mode == "blocker" ? [ids[0]] : mode == "dark" ? [ids[1]] : mode == "sponsor" ? [ids[2]] : mode == "vm" ? [ids[3]] : []
        result = ["mode": mode, "schema": 2, "runToken": CommandLine.arguments.dropFirst(2).first ?? UUID().uuidString,
                  "os": UIDevice.current.systemVersion, "thermalStart": clock.thermalState.rawValue,
                  "lowPower": clock.isLowPowerModeEnabled, "started": Date().description]
        save()
        if mode == "rules" { try await rules(); return }
        if mode == "filter-regression" { try await filterRegression(); return }
        if mode == "install" { try await installBenchmark(); return }
        if mode == "export-cache" { try await exportCacheBenchmark(); return }
        let store = try seedPackages(mode)
        let server = BenchmarkServer()
        let base = try await server.start()
        defer { server.stop() }
        for id in ids { UserDefaults.standard.set(!enabled.contains(id), forKey: "once.extension.disabled.\(id)") }
        let cpuStart = appCPU()
        memorySnapshot("beforePrepare")
        let start = now()
        let config = WKWebViewConfiguration()
        if mode != "bare" && mode != "amo" && !mode.hasPrefix("scripts") {
            let host = WebExtensionHost(store: store); self.host = host
            await host.prepare()
            config.webExtensionController = host.controller
        }
        if mode != "bare" && !mode.hasPrefix("scripts") {
            let source = try String(contentsOf: Bundle.main.url(forResource: "amo-page-shim", withExtension: "js", subdirectory: "public")!, encoding: .utf8)
            config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
            result["amoScriptBytes"] = source.utf8.count
        }
        if mode.hasPrefix("scripts"), let count = Int(mode.dropFirst(7)) {
            let scriptStart = now()
            for index in 0..<count {
                let source = UserscriptInjection.source(id: "benchmark-\(index)", body: "document.body.dataset.unexpectedScript = 'yes'", metadata: ["matches": ["https://never-match.example/*"]])
                config.userContentController.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentEnd, forMainFrameOnly: false))
            }
            result["scriptRegistrationMs"] = now() - scriptStart
        }
        result["prepareMs"] = now() - start
        memorySnapshot("afterPrepare")
        if let host {
            let catalogStart = now()
            result["catalog"] = host.catalog().map { $0.filter { $0.key != "iconDataUrl" } }
            result["firstCatalogMs"] = now() - catalogStart
            let cachedStart = now()
            for _ in 0..<20 { _ = host.catalog() }
            result["cachedCatalogMs"] = (now() - cachedStart) / 20
            let readyStart = now()
            for _ in 0..<20 { await host.prepare() }
            result["cachedPrepareMs"] = (now() - readyStart) / 20
        }
        memorySnapshot("afterCatalog")
        let surfaceStart = now()
        web = WKWebView(frame: window!.bounds, configuration: config)
        web.navigationDelegate = self
        window!.rootViewController!.view.addSubview(web)
        host?.attach(web, parent: window!.rootViewController!.view)
        host?.select(web)
        result["surfaceCreationMs"] = now() - surfaceStart
        result["surfaceMs"] = now() - start
        memorySnapshot("afterSurface")
        var pages: [[String: Any]] = []
        for index in 0..<4 {
            let load = now()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                navigation = continuation
                web.load(URLRequest(url: URL(string: base + "/fixture/\(index)")!))
            }
            var page: [String: Any] = ["navigationMs": now() - load, "index": index]
            // Fixed settling interval is excluded from the navigation measurement.
            try await Task.sleep(for: .seconds(1))
            page["work"] = try await web.callAsyncJavaScript("return await window.benchmark()", arguments: [:], in: nil, contentWorld: .page)
            page["unexpectedScript"] = try await web.evaluateJavaScript("document.body.dataset.unexpectedScript || false")
            page["matchedScripts"] = try await web.evaluateJavaScript("Number(document.body.dataset.benchmarkMatches || 0)")
            page["network"] = try await web.callAsyncJavaScript("""
                const start = performance.now();
                const sizes = await Promise.all(Array.from({length:100}, async (_, i) => {
                    const response = await fetch('/asset/' + i, {cache:'no-store'});
                    if (!response.ok) throw Error('HTTP ' + response.status);
                    return (await response.arrayBuffer()).byteLength;
                }));
                return {elapsedMs:performance.now()-start, bytes:sizes.reduce((a,b)=>a+b,0)};
                """, arguments: [:], in: nil, contentWorld: .page)
            if mode.hasPrefix("dnr") {
                page["dnrProbeBlocked"] = try await web.callAsyncJavaScript("try { await fetch('/benchmark-blocked'); return false } catch { return true }", arguments: [:], in: nil, contentWorld: .page)
            }
            pages.append(page)
            result["pages"] = pages; save()
        }
        result["pages"] = pages
        result["thermalEnd"] = clock.thermalState.rawValue
        result["elapsedMs"] = now() - start
        result["appCPUms"] = appCPU() - cpuStart
        result["appResidentMiB"] = appResidentMiB()
        result["appPhysicalFootprintMiB"] = appFootprintMiB()
        result["appPeakPhysicalFootprintMiB"] = appFootprintMiB(peak: true)
        result["contextErrors"] = host?.contexts.mapValues { $0.errors.map(\.localizedDescription) } ?? [:]
        memorySnapshot("afterWork")
        if CommandLine.arguments.contains("--memory") { try await memoryLifecycle() }
    }
    func rules() async throws {
        let compiler = IOSContentRuleCompiler()
        var samples: [[String: Any]] = []
        for count in [0, 1000, 10000, 50000] {
            // A new salt guarantees the first call really misses the persistent cache.
            let salt = UUID().uuidString.lowercased()
            let text = (0..<count).map { "||never-match-\(salt)-\($0).example^" }.joined(separator: "\n")
            for repeatIndex in 0..<3 {
                var sample: [String: Any] = ["count": count, "repeat": repeatIndex]
                let start = now()
                let encoded = try await Task.detached(priority: .utility) { try IOSContentBlockerExporter.export(text) }.value
                sample["exportMs"] = now() - start
                sample["jsonBytes"] = encoded.utf8.count
                sample["nativeRules"] = (try JSONSerialization.jsonObject(with: Data(encoded.utf8)) as? [Any])?.count
                let compile = now()
                do {
                    let list = try await compiler.compile(encoded)
                    sample["empty"] = list == nil
                    sample["compileMs"] = now() - compile
                } catch { sample["error"] = String(describing: error); sample["failureReason"] = (error as NSError).localizedFailureReason ?? "" }
                samples.append(sample); result["rules"] = samples; save()
            }
        }
        var controls: [[String: Any]] = []
        for source in ["ads.example", "||ads.example^", "|https://ads.example/banner|", "##.advert"] {
            let encoded = try IOSContentBlockerExporter.export(source)
            var control: [String: Any] = ["source": source, "json": encoded]
            do {
                let _: WKContentRuleList = try await withCheckedThrowingContinuation { continuation in
                    WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "once-bench-control", encodedContentRuleList: encoded) { list, error in
                        if let list { continuation.resume(returning: list) }
                        else { continuation.resume(throwing: error ?? NSError(domain: "Compile failed", code: 1)) }
                    }
                }
                control["compiled"] = true
            } catch { control["error"] = String(describing: error) }
            controls.append(control)
        }
        result["controls"] = controls
        result["thermalEnd"] = clock.thermalState.rawValue
    }
}
