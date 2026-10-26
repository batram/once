import UIKit

/// The extension catalog without the extension host: the bundled manifests,
/// the installed catalog on disk, the enabled switches and the load failures
/// the host last recorded. Rows have the shape of `WebExtensionHost.entry`, so
/// Settings lists extensions before any WebKit extension runs; the host's own
/// change event replaces them with the live catalog once it is prepared.
@available(iOS 18.4, *)
@MainActor
enum ExtensionDiskCatalog {
    /// Rendered icons by id and version, for the life of the process.
    private static var icons: [String: String] = [:]

    static func entries(store: ExtensionPackageStore) -> [[String: Any]] {
        var rows = WebExtensionHost.bundles.map { bundle in
            row(id: bundle.id, fallbackName: bundle.name, installed: nil,
                directory: Bundle.main.url(forResource: bundle.directory, withExtension: nil, subdirectory: "public/extensions"),
                unavailable: WebExtensionHost.unavailableReason(forBundle: bundle.directory)
                    ?? "Bundled \(bundle.name) resources are missing. Run the iOS asset build.")
        }
        for entry in store.load() {
            rows.append(row(id: entry.id, fallbackName: entry.name, installed: entry, directory: store.directory(entry.directory),
                            unavailable: "The extension package is missing"))
        }
        return rows
    }

    /// `unavailable` explains a bundle this iOS cannot run, or a package whose
    /// manifest cannot be read; a recorded load failure takes precedence.
    private static func row(id: String, fallbackName: String, installed: InstalledExtension?, directory: URL?, unavailable: String) -> [String: Any] {
        var row: [String: Any] = ["id": id, "name": installed?.name ?? fallbackName, "version": installed?.version ?? "",
                                  "bundled": installed == nil,
                                  "description": installed == nil ? "Bundled browser extension" : "Installed browser extension",
                                  "enabled": false, "hasOptions": false, "hasAction": false, "permissions": [String](),
                                  "warnings": installed?.warnings ?? [], "disabledReason": ExtensionLoadRecord.failure(for: id) ?? ""]
        if let installed { row["source"] = installed.source }
        let bundleBlocked = installed == nil && WebExtensionHost.unavailableReason(forBundle: directory?.lastPathComponent ?? "") != nil
        guard let directory, let manifest = ExtensionManifest(directory: directory) , !bundleBlocked else {
            if (row["disabledReason"] as? String)?.isEmpty != false { row["disabledReason"] = unavailable }
            return row
        }
        row["name"] = manifest.localized("name") ?? fallbackName
        row["description"] = manifest.localized("description") ?? ""
        row["version"] = manifest.string("version") ?? installed?.version ?? ""
        row["hasOptions"] = manifest.hasOptions
        row["hasAction"] = manifest.object["action"] != nil || manifest.object["browser_action"] != nil
        row["permissions"] = manifest.permissions
        row["enabled"] = ExtensionLoadRecord.failure(for: id) == nil && WebExtensionHost.enabled(id)
        if let icon = icon(for: manifest, key: "\(id)@\(row["version"] as? String ?? "")") { row["iconDataUrl"] = icon }
        return row
    }

    /// The manifest icon nearest the row's 40 points, as the host renders it from WebKit.
    private static func icon(for manifest: ExtensionManifest, key: String) -> String? {
        if let cached = icons[key] { return cached.isEmpty ? nil : cached }
        var value = ""
        if let path = manifest.iconPath(nearest: 40), let image = UIImage(contentsOfFile: manifest.directory.appendingPathComponent(path).path) {
            let size = CGSize(width: 40, height: 40)
            let png = UIGraphicsImageRenderer(size: size, format: .default()).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }.pngData()
            value = png.map { "data:image/png;base64," + $0.base64EncodedString() } ?? ""
        }
        icons[key] = value
        return value.isEmpty ? nil : value
    }
}

/// A package's manifest.json with its `_locales` messages, enough for a catalog row.
struct ExtensionManifest {
    let directory: URL
    let object: [String: Any]
    /// Message tables in preference order: the user's languages, then the package's default.
    private let messages: [[String: Any]]

    init?(directory: URL) {
        guard let data = try? Data(contentsOf: directory.appendingPathComponent("manifest.json")),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.json5Allowed]) as? [String: Any] else { return nil }
        self.directory = directory
        self.object = object
        var locales: [String] = []
        for language in Locale.preferredLanguages {
            let tag = language.replacingOccurrences(of: "-", with: "_")
            locales.append(tag)
            if let base = tag.split(separator: "_").first { locales.append(String(base)) }
        }
        if let fallback = object["default_locale"] as? String { locales.append(fallback) }
        var seen = Set<String>()
        messages = locales.filter { seen.insert($0).inserted }.compactMap { locale in
            let file = directory.appendingPathComponent("_locales/\(locale)/messages.json")
            guard let data = try? Data(contentsOf: file) else { return nil }
            return (try? JSONSerialization.jsonObject(with: data, options: [.json5Allowed])) as? [String: Any]
        }
    }

    func string(_ key: String) -> String? { object[key] as? String }

    /// `__MSG_name__` references resolved like WebKit resolves them; message names are case-insensitive.
    func localized(_ key: String) -> String? {
        guard let raw = string(key) else { return nil }
        guard let pattern = try? NSRegularExpression(pattern: "__MSG_([A-Za-z0-9_@]+)__") else { return raw }
        var result = raw
        for match in pattern.matches(in: raw, range: NSRange(raw.startIndex..., in: raw)).reversed() {
            guard let whole = Range(match.range, in: raw), let nameRange = Range(match.range(at: 1), in: raw),
                  let text = message(named: String(raw[nameRange])) else { continue }
            result.replaceSubrange(whole, with: text)
        }
        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func message(named name: String) -> String? {
        for table in messages {
            let entry = table[name] ?? table.first { $0.key.lowercased() == name.lowercased() }?.value
            if let text = (entry as? [String: Any])?["message"] as? String { return text }
        }
        return nil
    }

    var hasOptions: Bool { (object["options_ui"] as? [String: Any])?["page"] != nil || object["options_page"] != nil }

    /// The named permissions WebKit knows, as `WKWebExtension.requestedPermissions`
    /// lists them: host patterns are separate, and names WebKit has no API for
    /// (`fontSettings`, `webRequestBlocking`) are dropped as WebKit drops them.
    var permissions: [String] {
        (object["permissions"] as? [Any] ?? []).compactMap { $0 as? String }
            .filter { ExtensionManifest.webKitPermissions.contains($0) }.sorted()
    }

    /// The permission names WebKit's extension host accepts (its `WKWebExtension.Permission`
    /// values); Firefox-only names never reach the live catalog either.
    static let webKitPermissions: Set<String> = [
        "activeTab", "alarms", "clipboardWrite", "contextMenus", "cookies", "declarativeNetRequest", "declarativeNetRequestFeedback",
        "declarativeNetRequestWithHostAccess", "menus", "nativeMessaging", "notifications", "scripting", "sidePanel", "storage", "tabs",
        "unlimitedStorage", "webNavigation", "webRequest"
    ]

    /// The smallest declared icon at least `size` pixels, else the largest; a package-relative path.
    func iconPath(nearest size: Int) -> String? {
        let declared = (object["icons"] as? [String: Any] ?? [:]).compactMap { key, value -> (Int, String)? in
            guard let pixels = Int(key), let path = value as? String else { return nil }
            return (pixels, path)
        }.sorted { $0.0 < $1.0 }
        let chosen = declared.first { $0.0 >= size } ?? declared.last
        return chosen.map { $0.1.hasPrefix("/") ? String($0.1.dropFirst()) : $0.1 }
    }
}

/// Why an extension did not load, as the host last saw it, so the disk catalog
/// shows the same reason until the host runs again.
enum ExtensionLoadRecord {
    private static func key(_ id: String) -> String { "once.extension.failure.\(id)" }

    static func failure(for id: String) -> String? { UserDefaults.standard.string(forKey: key(id)) }

    static func record(_ failures: [String: String], for ids: [String]) {
        for id in ids {
            if let failure = failures[id] { UserDefaults.standard.set(failure, forKey: key(id)) }
            else { UserDefaults.standard.removeObject(forKey: key(id)) }
        }
    }

    static func forget(_ id: String) { UserDefaults.standard.removeObject(forKey: key(id)) }
}
