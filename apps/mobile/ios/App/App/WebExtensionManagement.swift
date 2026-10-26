import Foundation
import WebKit

/// What the app supplies around an install: the confirmation and the file picker.
@available(iOS 18.4, *)
@MainActor
protocol ExtensionInstallPresenter: AnyObject {
    /// `removal` when the review is for an installed extension being removed.
    func confirm(_ candidate: ExtensionCandidate?, removal: InstalledExtension?) async -> Bool
    /// A local XPI or ZIP the user chose, copied to a temporary file; nil when cancelled.
    func pickArchive() async -> URL?
}

/// Installing, updating and removing user packages. Bundles stay as they are;
/// a package that names a bundled id is refused rather than shadowing it.
@available(iOS 18.4, *)
extension WebExtensionHost {
    enum PackageOrigin { case remote(String), file(URL) }

    /// The async commands the settings page sends; everything else is `command`.
    func perform(_ action: String, id: String, source: String?, enabled: Bool) async throws -> [String: Any] {
        switch action {
        case "install":
            guard let source, !source.isEmpty else { throw installError("Use a Firefox Add-ons page URL, or choose an XPI file.") }
            return try await install(from: .remote(source))
        case "chooseFile":
            guard let presenter, let file = await presenter.pickArchive() else { return ["cancelled": true] }
            defer { try? FileManager.default.removeItem(at: file) }
            return try await install(from: .file(file))
        case "remove":
            guard let entry = installed.first(where: { $0.id == id }) else { throw hostError("This extension cannot be removed") }
            if let presenter, !(await presenter.confirm(nil, removal: entry)) { return ["cancelled": true] }
            try await remove(entry)
            return ["extensions": catalog()]
        case "update":
            guard let entry = installed.first(where: { $0.id == id }) else { throw hostError("Bundled extensions are updated with Once") }
            guard ExtensionSource.kind(of: entry.source) != .none else {
                throw installError("This extension was installed from a file; choose the new file to update it")
            }
            return try await install(from: .remote(entry.source))
        default:
            return try command(action, id: id, enabled: enabled)
        }
    }

    private func install(from origin: PackageOrigin) async throws -> [String: Any] {
        let candidate = try await review(origin)
        do {
            if let presenter, !(await presenter.confirm(candidate, removal: nil)) {
                store.remove(candidate.token)
                return ["cancelled": true]
            }
            try await install(candidate)
        } catch {
            store.remove(candidate.token)
            throw error
        }
        return ["extensions": catalog(), "installed": candidate.summary()]
    }

    /// Downloads or copies, verifies, unpacks and adapts a package, and parses
    /// it with WebKit. The unpacked directory is the candidate's token; the
    /// caller installs it or removes it.
    func review(_ origin: PackageOrigin, listedId: String? = nil) async throws -> ExtensionCandidate {
        var archive: Data
        var listing: ExtensionSource.Listing?
        let source: String
        switch origin {
        case .file(let url):
            archive = try Data(contentsOf: url)
            if archive.count > ExtensionArchive.maxArchiveBytes { throw installError("XPI exceeds the 32 MB limit") }
            source = ExtensionSource.localFile
        case .remote(let text):
            source = text
            switch ExtensionSource.kind(of: text) {
            case .page(let slug):
                let current = try await ExtensionSource.listing(for: slug)
                listing = current
                archive = try await ExtensionSource.download(current.url, limit: ExtensionArchive.maxArchiveBytes)
            case .download:
                archive = try await ExtensionSource.download(text, limit: ExtensionArchive.maxArchiveBytes)
            case .none:
                throw installError("Use a Firefox Add-ons page URL, or choose an XPI file.")
            }
        }
        let data = archive
        let sha256 = await Task.detached(priority: .userInitiated) { ExtensionSource.sha256(data) }.value
        if let listing, sha256 != listing.sha256 { throw installError("XPI does not match Mozilla's published hash") }
        let token = UUID().uuidString
        let directory = store.directory(token)
        do {
            try FileManager.default.createDirectory(at: store.packages, withIntermediateDirectories: true)
            let knownId = listing?.guid ?? listedId
            let adapted = try await Task.detached(priority: .userInitiated) {
                try ExtensionArchive.extract(data, to: directory)
                return try WebKitManifestAdapter.adapt(at: directory, listedId: knownId)
            }.value
            if bundles.contains(where: { $0.id == adapted.id }) {
                throw installError("This extension is included with Once and is updated with it")
            }
            let ext = try await WKWebExtension(resourceBaseURL: directory)
            // A direct link carries no listing: Mozilla's listing for the id the
            // package declares must vouch for exactly this file.
            if case .remote(let text) = origin, ExtensionSource.kind(of: text) == .download {
                listing = try await ExtensionSource.listing(for: adapted.id)
                if sha256 != listing?.sha256 { throw installError("XPI is not the version Mozilla currently lists for this extension") }
            }
            if let listing, adapted.id != listing.guid { throw installError("XPI identity does not match Mozilla's listing") }
            return ExtensionCandidate(
                token: token, id: adapted.id, name: ext.displayName ?? adapted.id, version: ext.version ?? "",
                description: ext.displayDescription ?? "", source: source, sha256: sha256,
                permissions: (ext.requestedPermissions.map(\.rawValue) + ext.allRequestedMatchPatterns.map(\.string)).sorted(),
                warnings: WebKitManifestAdapter.warnings(for: ext, requested: adapted.requestedPermissions),
                adaptations: adapted.adaptations, update: installed.contains { $0.id == adapted.id }, webExtension: ext)
        } catch {
            store.remove(token)
            throw error
        }
    }

    /// Replaces any previous version, keeping its storage (same unique
    /// identifier and origin) and enabled state; a failed load restores it.
    func install(_ candidate: ExtensionCandidate) async throws {
        closePage()
        let previous = installed.first { $0.id == candidate.id }
        let previousContext = contexts[candidate.id]
        if let previousContext, previousContext.isLoaded { try controller.unload(previousContext) }
        let context = makeContext(for: candidate.webExtension, identifier: candidate.id, host: WebExtensionHost.hostName(for: candidate.id))
        contexts[candidate.id] = context
        failures[candidate.id] = nil
        do {
            if previous == nil { UserDefaults.standard.removeObject(forKey: "once.extension.disabled.\(candidate.id)") }
            if isEnabled(candidate.id) { try controller.load(context) }
        } catch {
            contexts[candidate.id] = previousContext
            if let previousContext, isEnabled(candidate.id) { try? controller.load(previousContext) }
            throw error
        }
        let entry = InstalledExtension(id: candidate.id, directory: candidate.token, name: candidate.name, version: candidate.version,
                                       source: candidate.source, sha256: candidate.sha256, warnings: candidate.warnings,
                                       adaptations: candidate.adaptations, installedAt: Date())
        if let index = installed.firstIndex(where: { $0.id == candidate.id }) { installed[index] = entry } else { installed.append(entry) }
        try store.save(installed)
        if let previous, previous.directory != candidate.token { store.remove(previous.directory) }
        changed()
    }

    /// Unloads, deletes the extension's WebKit data and its package.
    func remove(_ entry: InstalledExtension) async throws {
        closePage()
        if let context = contexts.removeValue(forKey: entry.id) {
            if context.isLoaded { try controller.unload(context) }
            if let record = await controller.dataRecord(ofTypes: WKWebExtensionController.allExtensionDataTypes, for: context) {
                await withCheckedContinuation { continuation in
                    controller.removeData(ofTypes: WKWebExtensionController.allExtensionDataTypes, from: [record]) { continuation.resume() }
                }
            }
        }
        failures[entry.id] = nil
        UserDefaults.standard.removeObject(forKey: "once.extension.disabled.\(entry.id)")
        installed.removeAll { $0.id == entry.id }
        try store.save(installed)
        store.remove(entry.directory)
        changed()
    }

    func context(for id: String) -> WKWebExtensionContext? { contexts[id] }
}
