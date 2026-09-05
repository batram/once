import Foundation
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
    static func export(_ list: String) throws -> String {
        var rules: [[String: Any]] = []
        var exceptions: [[String: Any]] = []
        var skipped = 0
        var unsafeException = false
        let cosmeticException = list.contains("#@#")
        for raw in list.split(whereSeparator: { $0.isNewline }) {
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
            if line.isEmpty || line.contains("$") || line.contains("#") || line.hasPrefix("/") {
                skipped += 1
                if exception || line.contains("$badfilter") { unsafeException = true }
                continue
            }
            let trigger: [String: Any] = ["url-filter": urlFilter(line)]
            let action = ["type": exception ? "ignore-previous-rules" : "block"]
            if exception { exceptions.append(["trigger": trigger, "action": action]) }
            else { rules.append(["trigger": trigger, "action": action]) }
        }
        if unsafeException {
            rules.removeAll { ($0["action"] as? [String: Any])?["type"] as? String == "block" }
        }
        rules.append(contentsOf: exceptions)
        print("Once filter lists: \(rules.count) supported rules; \(skipped) unsupported rules skipped")
        let data = try JSONSerialization.data(withJSONObject: rules)
        return String(decoding: data, as: UTF8.self)
    }

    private static func urlFilter(_ pattern: String) -> String {
        var value = pattern
        var prefix = ""
        if value.hasPrefix("||") {
            value.removeFirst(2)
            prefix = "^https?://(?:[^/]+\\.)?"
        } else if value.hasPrefix("|") {
            value.removeFirst(); prefix = "^"
        }
        let anchored = value.hasSuffix("|")
        if anchored { value.removeLast() }
        let escaped = NSRegularExpression.escapedPattern(for: value)
            .replacingOccurrences(of: "\\*", with: ".*")
            .replacingOccurrences(of: "\\^", with: "(?:[^A-Za-z0-9_.%-]|$)")
        return prefix + escaped + (anchored ? "$" : "")
    }

}
