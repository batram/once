import Network
import Darwin

// Production inspector lives in a Capacitor plugin, outside this isolated app.
enum WebInspector { static func track(_ view: WKWebView) {} }

// CPU and RSS are for the harness UI process ONLY, including its loopback server.
// WebKit content/network/extension processes are explicitly excluded.
func appCPU() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000
        + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000
}

func appResidentMiB() -> Double {
    var info = mach_task_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<mach_task_basic_info>.size / MemoryLayout<natural_t>.size)
    let status = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(MACH_TASK_BASIC_INFO), $0, &count)
        }
    }
    return status == KERN_SUCCESS ? Double(info.resident_size) / 1048576 : -1
}

func appFootprintMiB(peak: Bool = false) -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
    let status = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    return status == KERN_SUCCESS ? (peak ? Double(info.ledger_phys_footprint_peak) : Double(info.phys_footprint)) / 1048576 : -1
}

// Real same-origin HTTP navigation exercises location-based matching. A private
// in-app loopback server avoids Internet/USB/Wi-Fi variability in the page fixture.
final class BenchmarkServer {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "once.benchmark.http")
    func start() async throws -> String {
        let html = try Data(contentsOf: Bundle.main.url(forResource: "fixture", withExtension: "html")!)
        let listener = try NWListener(using: .tcp, on: .any)
        self.listener = listener
        listener.newConnectionHandler = { connection in
            connection.start(queue: self.queue)
            Self.receive(connection, accumulated: Data(), html: html)
        }
        let port: UInt16 = try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { state in
                if case .ready = state { listener.stateUpdateHandler = nil; continuation.resume(returning: listener.port!.rawValue) }
                if case .failed(let error) = state { listener.stateUpdateHandler = nil; continuation.resume(throwing: error) }
            }
            listener.start(queue: queue)
        }
        return "http://127.0.0.1:\(port)"
    }
    private static func receive(_ connection: NWConnection, accumulated: Data, html: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 8192) { data, _, complete, error in
            let request = accumulated + (data ?? Data())
            guard let text = String(data: request, encoding: .utf8), text.contains("\r\n\r\n") else {
                if complete || error != nil || request.count > 32768 { connection.cancel() }
                else { receive(connection, accumulated: request, html: html) }
                return
            }
            let isPage = text.hasPrefix("GET /fixture/")
            let body = isPage ? html : Data(repeating: 65, count: 16384)
            let type = isPage ? "text/html; charset=utf-8" : "application/octet-stream"
            let headers = "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n"
            connection.send(content: Data(headers.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
        }
    }
    func stop() { listener?.cancel(); listener = nil }
}

extension ExtensionBenchmark {
    func exportCacheBenchmark() async throws {
        var samples: [[String: Any]] = []
        for count in [1000, 10000, 50000] {
            let source = (0..<count).map { "||cache-rule-\($0).example^" }.joined(separator: "\n")
            let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("benchmark-export-\(count).plist")
            let existed = FileManager.default.fileExists(atPath: url.path)
            let firstStart = now()
            let cached = try await Task.detached(priority: .utility) {
                try IOSContentBlockerExporter.cachedExport(source, cacheURL: url)
            }.value
            let firstMs = now() - firstStart
            let plainStart = now()
            let plain = try await Task.detached(priority: .utility) { try IOSContentBlockerExporter.export(source) }.value
            let plainMs = now() - plainStart
            let repeatStart = now()
            let repeated = try await Task.detached(priority: .utility) {
                try IOSContentBlockerExporter.cachedExport(source, cacheURL: url)
            }.value
            let repeatMs = now() - repeatStart
            guard cached == plain, repeated == plain else { throw hostError("Cached export differs") }
            let compiled = try await IOSContentRuleCompiler().compile(cached)
            samples.append(["count": count, "cacheExisted": existed, "firstCachedExportMs": firstMs,
                            "uncachedExportMs": plainMs, "repeatCachedExportMs": repeatMs,
                            "jsonBytes": cached.utf8.count, "equal": true, "compiled": compiled != nil])
        }
        result["cacheSamples"] = samples
        result["thermalEnd"] = clock.thermalState.rawValue
    }

    func memorySnapshot(_ phase: String) {
        var samples = result["memorySnapshots"] as? [[String: Any]] ?? []
        samples.append(["phase": phase, "uptimeMs": now(), "appCPUms": appCPU(),
                        "appResidentMiB": appResidentMiB(), "appPhysicalFootprintMiB": appFootprintMiB(),
                        "appPeakPhysicalFootprintMiB": appFootprintMiB(peak: true)])
        result["memorySnapshots"] = samples
    }

    func memoryLifecycle() async throws {
        try await Task.sleep(for: .seconds(35))
        memorySnapshot("idle35s"); save()
        host?.detach(web)
        web.removeFromSuperview(); web = nil
        try await Task.sleep(for: .seconds(15))
        memorySnapshot("detached15s"); save()
        if let host {
            for context in host.contexts.values where context.isLoaded { try host.controller.unload(context) }
        }
        host = nil
        try await Task.sleep(for: .seconds(15))
        memorySnapshot("unloaded15s"); save()
    }

    func installBenchmark() async throws {
        for id in ids { UserDefaults.standard.set(true, forKey: "once.extension.disabled.\(id)") }
        let store = try seedPackages("install")
        let host = WebExtensionHost(store: store)
        self.host = host
        await host.prepare()
        let directory = Bundle.main.bundleURL.appendingPathComponent("public/benchmark-packages")
        let archives = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil).filter { $0.pathExtension == "xpi" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        var samples: [[String: Any]] = []
        for archive in archives {
            for iteration in 0..<3 {
                let cpu = appCPU(), resident = appResidentMiB()
                let start = now()
                var sample: [String: Any] = ["archive": archive.lastPathComponent, "iteration": iteration,
                    "archiveBytes": try archive.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0,
                    "appResidentBeforeMiB": resident]
                do {
                    let candidate = try await host.review(.file(archive))
                    sample["reviewMs"] = now() - start
                    sample["id"] = candidate.id; sample["version"] = candidate.version
                    sample["sha256"] = candidate.sha256; sample["warnings"] = candidate.warnings
                    sample["appResidentAfterReviewMiB"] = appResidentMiB()
                    let install = now()
                    try await host.install(candidate)
                    sample["installMs"] = now() - install
                    sample["loaded"] = host.contexts[candidate.id]?.isLoaded == true
                    sample["appResidentAfterInstallMiB"] = appResidentMiB()
                    sample["appCPUms"] = appCPU() - cpu
                    let catalog = now()
                    _ = host.catalog()
                    sample["firstCatalogMs"] = now() - catalog
                    let removal = now()
                    if let entry = host.installed.first(where: { $0.id == candidate.id }) { try await host.remove(entry) }
                    sample["removeMs"] = now() - removal
                } catch { sample["error"] = String(describing: error) }
                samples.append(sample); result["installations"] = samples; save()
            }
        }
        result["thermalEnd"] = clock.thermalState.rawValue
    }

    // Synthetic already-installed packages isolate the catalog/startup cost of
    // the new installer support. Archive download/adaptation is not timed here.
    func seedPackages(_ mode: String) throws -> ExtensionPackageStore {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("BenchmarkPackages-v2-\(mode)")
        let store = ExtensionPackageStore(root: root)
        let count = Int(mode.filter(\.isNumber)) ?? 0
        if mode.hasPrefix("dnr") {
            let id = "benchmark-\(mode)@once.invalid"
            let package = store.directory("rules")
            if !FileManager.default.fileExists(atPath: package.path) {
                try FileManager.default.createDirectory(at: store.packages, withIntermediateDirectories: true)
                try FileManager.default.copyItem(at: Bundle.main.bundleURL.appendingPathComponent("public/benchmark-dnr/\(mode)"), to: package)
                try store.save([InstalledExtension(id: id, directory: "rules", name: mode, version: "1.0", source: "benchmark",
                    sha256: "", warnings: [], adaptations: [], installedAt: Date(timeIntervalSince1970: 0))])
            }
            UserDefaults.standard.set(false, forKey: "once.extension.disabled.\(id)")
            return store
        }
        let installedMode = mode.hasPrefix("installed") || mode.hasPrefix("matched")
        let matches = mode.hasPrefix("matched")
        var entries: [InstalledExtension] = []
        for index in 0..<(installedMode ? count : 0) {
            let id = "benchmark-\(mode)-\(index)@once.invalid"
            let directory = "package-\(index)"
            let url = store.directory(directory)
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
            let manifest: [String: Any] = ["manifest_version": 2, "name": "Benchmark \(index)", "description": "Deterministic content-script benchmark", "version": "1.0",
                "browser_specific_settings": ["gecko": ["id": id]],
                "content_scripts": [["matches": [matches ? "http://127.0.0.1/*" : "https://never-match.example/*"],
                                     "js": ["content.js"], "run_at": "document_end"]]]
            if !FileManager.default.fileExists(atPath: url.appendingPathComponent("manifest.json").path) {
                try JSONSerialization.data(withJSONObject: manifest).write(to: url.appendingPathComponent("manifest.json"))
                let script = "document.body.dataset.benchmarkMatches = String(Number(document.body.dataset.benchmarkMatches || 0) + 1)"
                try script.write(to: url.appendingPathComponent("content.js"), atomically: true, encoding: .utf8)
            }
            UserDefaults.standard.set(mode.contains("disabled"), forKey: "once.extension.disabled.\(id)")
            entries.append(InstalledExtension(id: id, directory: directory, name: "Benchmark \(index)", version: "1.0",
                source: "benchmark", sha256: "", warnings: [], adaptations: [], installedAt: Date(timeIntervalSince1970: 0)))
        }
        if store.load() != entries || !FileManager.default.fileExists(atPath: root.path) { try store.save(entries) }
        return store
    }
}
