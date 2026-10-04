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
        host?.navigationChanged(); self.navigation?.resume(); self.navigation = nil
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.navigation?.resume(throwing: error); self.navigation = nil
    }
    func run() async throws {
        let mode = CommandLine.arguments.dropFirst().first ?? "all"
        let enabled: Set<String> = mode == "all" ? Set(ids) : mode == "blocker" ? [ids[0]] : mode == "dark" ? [ids[1]] : mode == "sponsor" ? [ids[2]] : mode == "vm" ? [ids[3]] : []
        result = ["mode": mode, "os": UIDevice.current.systemVersion, "thermalStart": clock.thermalState.rawValue, "lowPower": clock.isLowPowerModeEnabled, "started": Date().description]
        if mode == "rules" { try await rules(); return }
        if mode == "filter-regression" { try await filterRegression(); return }
        for id in ids { UserDefaults.standard.set(!enabled.contains(id), forKey: "once.extension.disabled.\(id)") }
        let start = now()
        let config = WKWebViewConfiguration()
        if mode != "bare" && !mode.hasPrefix("scripts") {
            let host = WebExtensionHost(); self.host = host
            await host.prepare()
            config.webExtensionController = host.controller
            result["catalog"] = host.catalog()
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
        web = WKWebView(frame: window!.bounds, configuration: config)
        web.navigationDelegate = self
        window!.rootViewController!.view.addSubview(web)
        host?.attach(web, parent: window!.rootViewController!.view)
        result["surfaceMs"] = now() - start
        let html = try String(contentsOf: Bundle.main.url(forResource: "fixture", withExtension: "html")!, encoding: .utf8)
        var pages: [[String: Any]] = []
        for index in 0..<4 {
            let load = now()
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                navigation = continuation
                web.loadHTMLString(html, baseURL: URL(string: "https://example.com/once-benchmark/\(index)"))
            }
            var page: [String: Any] = ["navigationMs": now() - load, "index": index]
            // Fixed settling interval is excluded from the navigation measurement.
            try await Task.sleep(for: .seconds(1))
            page["work"] = try await web.callAsyncJavaScript("return await window.benchmark()", arguments: [:], in: nil, contentWorld: .page)
            page["unexpectedScript"] = try await web.evaluateJavaScript("document.body.dataset.unexpectedScript || false")
            pages.append(page)
        }
        result["pages"] = pages
        result["thermalEnd"] = clock.thermalState.rawValue
        result["elapsedMs"] = now() - start
    }
    func rules() async throws {
        let compiler = IOSContentRuleCompiler()
        var samples: [[String: Any]] = []
        for count in [0, 1000, 10000, 50000] {
            let text = (0..<count).map { "||never-match-\($0).example^" }.joined(separator: "\n")
            for repeatIndex in 0..<3 {
                var sample: [String: Any] = ["count": count, "repeat": repeatIndex]
                let start = now()
                let encoded = try IOSContentBlockerExporter.export(text)
                sample["exportMs"] = now() - start
                sample["jsonBytes"] = encoded.utf8.count
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
