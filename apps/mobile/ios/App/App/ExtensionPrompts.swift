import UIKit
import UniformTypeIdentifiers

/// Native review sheets for installs and removals, and the document picker
/// for local packages, presented over the Capacitor shell.
@available(iOS 18.4, *)
@MainActor
final class ExtensionPrompts: NSObject, ExtensionInstallPresenter, UIDocumentPickerDelegate {
    private let presenterController: () -> UIViewController?
    private var picking: CheckedContinuation<URL?, Never>?

    init(controller: @escaping () -> UIViewController?) {
        presenterController = controller
    }

    private var top: UIViewController? {
        var controller = presenterController()
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }

    func confirm(_ candidate: ExtensionCandidate?, removal: InstalledExtension?) async -> Bool {
        guard let top else { return false }
        let title: String
        var lines: [String] = []
        let verb: String
        if let candidate {
            title = candidate.update ? "Update extension" : "Install extension"
            verb = candidate.update ? "Update" : "Install"
            lines.append("\(candidate.name) \(candidate.version)")
            if !candidate.description.isEmpty { lines.append(candidate.description) }
            lines.append("Source: \(candidate.source)")
            lines.append(candidate.permissions.isEmpty ? "No additional access requested" : "Requested access:\n" + candidate.permissions.joined(separator: "\n"))
            if !candidate.adaptations.isEmpty { lines.append("Adapted for iOS:\n" + candidate.adaptations.joined(separator: "\n")) }
            if !candidate.warnings.isEmpty { lines.append("Limitations:\n" + candidate.warnings.joined(separator: "\n")) }
            if candidate.source == ExtensionSource.localFile { lines.append("This file was not verified against Mozilla Add-ons. Install only packages you trust.") }
        } else if let removal {
            title = "Remove extension"
            verb = "Remove"
            lines.append("Remove \(removal.name) \(removal.version) and its extension data from this device?")
        } else { return false }
        return await withCheckedContinuation { continuation in
            let alert = UIAlertController(title: title, message: lines.joined(separator: "\n\n"), preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in continuation.resume(returning: false) })
            alert.addAction(UIAlertAction(title: verb, style: removal == nil ? .default : .destructive) { _ in continuation.resume(returning: true) })
            top.present(alert, animated: true)
        }
    }

    func pickArchive() async -> URL? {
        guard picking == nil, let top else { return nil }
        let xpi = UTType(filenameExtension: "xpi", conformingTo: .zip) ?? .zip
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [xpi, .zip, .data], asCopy: true)
        picker.delegate = self
        picker.allowsMultipleSelection = false
        return await withCheckedContinuation { continuation in
            picking = continuation
            top.present(picker, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        picking?.resume(returning: urls.first)
        picking = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        picking?.resume(returning: nil)
        picking = nil
    }
}
