import Foundation
import WebKit
import CryptoKit
import Capacitor

enum UserscriptInjection {
    private static func json(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value),
              let result = String(data: data, encoding: .utf8) else { return "[]" }
        return result
    }

    static func source(id: String, body: String, metadata: JSObject) -> String {
        let matches = metadata["matches"] as? [String] ?? []
        let includes = metadata["includes"] as? [String] ?? []
        let excludes = metadata["excludes"] as? [String] ?? []
        return """
        (() => {
          const matchPattern = (pattern, url) => {
            if (pattern === '<all_urls>') return /^(https?|file|ftp):/.test(url.protocol);
            const found = /^(\\*|http|https|file|ftp):\\/\\/([^/]*)(\\/.*)$/.exec(pattern);
            if (!found || (found[1] !== '*' && found[1] !== url.protocol.slice(0, -1))) return false;
            const host = found[2];
            if (host !== '*' && !(host.startsWith('*.')
              ? (url.hostname === host.slice(2) || url.hostname.endsWith('.' + host.slice(2)))
              : url.hostname === host)) return false;
            const escaped = found[3].replace(/[.+?^${}()|[\\]\\\\]/g, '\\$&').replace(/\\*/g, '.*');
            return new RegExp('^' + escaped + '$').test(url.pathname + url.search);
          };
          const glob = (pattern, value) => {
            if (pattern.length > 2 && pattern[0] === '/' && pattern.at(-1) === '/') {
              try { return new RegExp(pattern.slice(1, -1)).test(value); } catch { return false; }
            }
            const escaped = pattern.replace(/[.+?^${}()|[\\]\\\\]/g, '\\$&').replace(/\\*/g, '.*');
            return new RegExp('^' + escaped + '$').test(value);
          };
          const url = new URL(location.href);
          const matches = \(json(matches));
          const includes = \(json(includes));
          const excludes = \(json(excludes));
          if (excludes.some(value => glob(value, url.href))) return;
          if (matches.length || includes.length) {
            if (!matches.some(value => matchPattern(value, url)) &&
                !includes.some(value => glob(value, url.href))) return;
          }
          const prefix = 'once.userscript.\(id).';
          const GM_addStyle = css => {
            const style = document.createElement('style');
            style.textContent = String(css);
            (document.head || document.documentElement).append(style);
            return style;
          };
          const GM_getValue = (key, fallback) => {
            const stored = localStorage.getItem(prefix + key);
            if (stored === null) return fallback;
            try { return JSON.parse(stored); } catch { return fallback; }
          };
          const GM_setValue = (key, value) => {
            localStorage.setItem(prefix + key, JSON.stringify(value));
          };
          try { \(body) } catch (error) { console.error('Once userscript \(id) failed', error); }
        })();
        """
    }
}

/// Converts the ABP/uBlock subset accepted by WebKit to Safari content-blocker JSON.
/// The rule shapes and ordering mirror adblock-rust's `content-blocking` export: ordinary
/// rules first and `ignore-previous-rules` exceptions last. Unsupported scriptlets and
/// procedural cosmetics are intentionally omitted because WKContentRuleList cannot run them.
enum IOSContentBlockerExporter {
    static func fetchLists(_ urls: [URL]) async throws -> [String] {
        try await withThrowingTaskGroup(of: (Int, String).self) { group in
            for (index, url) in urls.enumerated() {
                group.addTask {
                    let cacheKey = "once.filter-list." + Data(url.absoluteString.utf8).base64EncodedString()
                    try Task.checkCancellation()
                    if let date = UserDefaults.standard.object(forKey: cacheKey + ".updated") as? Date,
                       Date().timeIntervalSince(date) < 3600,
                       let cached = UserDefaults.standard.string(forKey: cacheKey) { return (index, cached) }
                    do {
                        var request = URLRequest(url: url)
                        request.timeoutInterval = 30
                        request.setValue("Once iOS content blocker", forHTTPHeaderField: "User-Agent")
                        let (data, response) = try await URLSession.shared.data(for: request)
                        guard let http = response as? HTTPURLResponse,
                              (200..<300).contains(http.statusCode),
                              let text = String(data: data, encoding: .utf8) else {
                            throw NSError(domain: "OnceContentBlocker", code: 1,
                                          userInfo: [NSLocalizedDescriptionKey: "Unable to download \(url.absoluteString)"])
                        }
                        try Task.checkCancellation()
                        UserDefaults.standard.set(text, forKey: cacheKey)
                        UserDefaults.standard.set(Date(), forKey: cacheKey + ".updated")
                        return (index, text)
                    } catch {
                        try Task.checkCancellation()
                        if let cached = UserDefaults.standard.string(forKey: cacheKey) { return (index, cached) }
                        throw error
                    }
                }
            }
            var result: [(Int, String)] = []
            for try await entry in group { result.append(entry) }
            return result.sorted { $0.0 < $1.0 }.map { $0.1 }
        }
    }

    static func export(_ list: String) throws -> String {
        var rules: [[String: Any]] = []
        var exceptions: [[String: Any]] = []
        var skipped = 0
        var unsafeException = false
        let cosmeticException = list.contains("#@#")
        for (index, raw) in list.split(whereSeparator: { $0.isNewline }).enumerated() {
            if index % 256 == 0 { try Task.checkCancellation() }
            var line = String(raw).trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty || line.hasPrefix("!") || line.hasPrefix("[") { continue }
            let exception = line.hasPrefix("@@")
            if exception { line.removeFirst(2) }
            if let marker = line.range(of: "##") {
                let domains = String(line[..<marker.lowerBound])
                let selector = String(line[marker.upperBound...])
                if !domains.isEmpty || selector.isEmpty || selector.contains("+") || selector.contains(":") || cosmeticException {
                    skipped += 1; continue
                }
                let trigger: [String: Any] = ["url-filter": ".*"]
                let action: [String: Any] = ["type": "css-display-none", "selector": selector]
                rules.append(["trigger": trigger, "action": action])
                continue
            }
            if line.isEmpty || line.contains("$") || line.contains("#") || line.hasPrefix("/") || !line.unicodeScalars.allSatisfy({ $0.isASCII }) {
                skipped += 1
                if exception || line.contains("$badfilter") { unsafeException = true }
                continue
            }
            for filter in urlFilters(line) {
                let trigger: [String: Any] = ["url-filter": filter]
                let action = ["type": exception ? "ignore-previous-rules" : "block"]
                if exception { exceptions.append(["trigger": trigger, "action": action]) }
                else { rules.append(["trigger": trigger, "action": action]) }
            }
        }
        if unsafeException {
            rules.removeAll { ($0["action"] as? [String: Any])?["type"] as? String == "block" }
        }
        rules.append(contentsOf: exceptions)
        print("Once filter lists: \(rules.count) supported rules; \(skipped) unsupported rules skipped")
        let data = try JSONSerialization.data(withJSONObject: rules, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    private static func urlFilters(_ pattern: String) -> [String] {
        var value = pattern
        var prefix = ""
        if value.hasPrefix("||") {
            value.removeFirst(2)
            prefix = "^https?://([^/]+\\.)?"
        } else if value.hasPrefix("|") {
            value.removeFirst(); prefix = "^"
        }
        let anchored = value.hasSuffix("|")
        if anchored { value.removeLast() }
        // WebKit does not accept alternation or an end anchor inside a group.
        // Split ABP's separator-or-end into separate rules. End-of-URL is only
        // possible when the remaining pattern can also match an empty suffix.
        let fragments = value.components(separatedBy: "^")
        var expression = prefix
        var endVariants: [String] = []
        for (index, fragment) in fragments.enumerated() {
            if index > 0 {
                // An http(s) URL always has a path after the host, so a bare
                // ||host^ can never end at the separator; skip that variant.
                let hostOnly = index == 1 && !prefix.isEmpty && prefix != "^"
                    && !fragments[0].contains(where: { "/*?".contains($0) })
                if !hostOnly, fragments[index...].allSatisfy({ $0.allSatisfy { $0 == "*" } }) {
                    endVariants.append(expression + "$")
                }
                expression += "[^A-Za-z0-9_.%-]"
            }
            expression += NSRegularExpression.escapedPattern(for: fragment)
                .replacingOccurrences(of: "\\*", with: ".*")
        }
        return [expression + (anchored ? "$" : "")] + endVariants
    }
}

/// All conversion and I/O run outside the main actor. Equal in-flight settings
/// reuse the same task; a changed list selection cancels obsolete downloads/work.
@MainActor
final class IOSFilterPreparation {
    private var urls: [URL] = []
    private var task: Task<String, Error>?
    private var expires = Date.distantPast

    func prepare(_ requested: [URL]) -> Task<String, Error> {
        let next = Array(Set(requested)).sorted { $0.absoluteString < $1.absoluteString }
        if next == urls, Date() < expires, let task { return task }
        task?.cancel()
        urls = next
        expires = Date().addingTimeInterval(3600)
        let work = Task.detached(priority: .utility) {
            let texts = try await IOSContentBlockerExporter.fetchLists(next)
            try Task.checkCancellation()
            return try IOSContentBlockerExporter.export(texts.joined(separator: "\n"))
        }
        task = work
        return work
    }

    func retryAfterFailure() { expires = .distantPast }
}

/// Compiled content hashes survive app restarts. Keep only the most recent four
/// on disk; pruning disk entries does not remove already installed rule objects.
@MainActor
final class IOSContentRuleCompiler {
    private var pending: [String: Task<WKContentRuleList, Error>] = [:]
    private let store = WKContentRuleListStore.default()!

    func compile(_ json: String) async throws -> WKContentRuleList? {
        if json == "[]" { return nil }
        let digest = await Task.detached(priority: .utility) {
            SHA256.hash(data: Data(json.utf8)).map { String(format: "%02x", $0) }.joined()
        }.value
        let id = "once-synced-v2-" + digest
        if let task = pending[id] { return try await task.value }
        let task = Task { @MainActor in
            let cached: WKContentRuleList? = await withCheckedContinuation { continuation in
                store.lookUpContentRuleList(forIdentifier: id) { list, _ in continuation.resume(returning: list) }
            }
            if let cached { return cached }
            return try await withCheckedThrowingContinuation { continuation in
                store.compileContentRuleList(forIdentifier: id, encodedContentRuleList: json) { list, error in
                    if let list { continuation.resume(returning: list) }
                    else { continuation.resume(throwing: error ?? NSError(domain: "OnceContentBlocker", code: 2)) }
                }
            }
        }
        pending[id] = task
        defer { pending[id] = nil }
        let list = try await task.value
        let key = "once.content-rules.cache"
        var recent = UserDefaults.standard.stringArray(forKey: key) ?? []
        recent.removeAll { $0 == id }; recent.insert(id, at: 0)
        UserDefaults.standard.set(Array(recent.prefix(4)), forKey: key)
        for old in recent.dropFirst(4) { store.removeContentRuleList(forIdentifier: old) { _ in } }
        // Drop the pre-hash identifier left by earlier builds.
        store.removeContentRuleList(forIdentifier: "once-synced-filter-lists") { _ in }
        return list
    }
}
