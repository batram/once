import Photos
import UIKit
import UniformTypeIdentifiers
import WebKit

// The page's long-press menu. WebKit hit-tests the press and draws the system
// menu; Once supplies the actions, since WebKit's own "Open" replaces the page
// in place and its image actions cannot be extended.
extension InAppBrowserSurfacePlugin {
    /// WKContextMenuElementInfo carries only the link, so the page side records
    /// where the press landed and names the image under it. Runs in its own
    /// content world, out of the page's reach.
    static let contextMenuWorld = WKContentWorld.world(name: "OnceContextMenu")
    static let contextMenuScript = WKUserScript(source: """
        (() => {
          let point = null
          addEventListener("touchstart", (event) => {
            const touch = event.touches[0]
            if (touch) point = [touch.clientX, touch.clientY]
          }, { capture: true, passive: true })
          window.__onceImageAtTouch = () => {
            if (!point) return null
            for (const element of document.elementsFromPoint(point[0], point[1])) {
              if (element instanceof HTMLImageElement) return element.currentSrc || element.src || null
            }
            return null
          }
        })()
        """, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: contextMenuWorld)

    func installContextMenuTracker(_ controller: WKUserContentController) {
        let script = Self.contextMenuScript
        if !controller.userScripts.contains(where: { $0 === script }) { controller.addUserScript(script) }
    }

    public func webView(
        _ webView: WKWebView,
        contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
        completionHandler: @escaping (UIContextMenuConfiguration?) -> Void
    ) {
        let link = elementInfo.linkURL
        webView.evaluateJavaScript("window.__onceImageAtTouch?.() ?? null", in: nil, in: Self.contextMenuWorld) { [weak self, weak webView] result in
            let image = ((try? result.get()) as? String).flatMap(URL.init(string:))
                .flatMap { ["http", "https", "data"].contains($0.scheme?.lowercased() ?? "") ? $0 : nil }
            guard let self, let webView, link != nil || image != nil else { completionHandler(nil); return }
            completionHandler(UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self, weak webView] _ in
                guard let self, let webView else { return nil }
                var sections: [UIMenuElement] = []
                if let link { sections.append(self.linkActions(link, in: webView)) }
                if let image { sections.append(self.imageActions(image, in: webView)) }
                return UIMenu(title: String((link ?? image)?.absoluteString.prefix(300) ?? ""), children: sections)
            })
        }
    }

    /// Tapping the lifted preview follows the link in this tab, as in Safari.
    public func webView(
        _ webView: WKWebView,
        contextMenuForElement elementInfo: WKContextMenuElementInfo,
        willCommitWithAnimator animator: UIContextMenuInteractionCommitAnimating
    ) {
        guard let url = elementInfo.linkURL else { return }
        animator.addCompletion { [weak webView] in webView?.load(URLRequest(url: url)) }
    }

    private func linkActions(_ url: URL, in webView: WKWebView) -> UIMenu {
        var actions: [UIMenuElement] = []
        if ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            actions.append(UIAction(title: "Open in New Tab", image: UIImage(systemName: "plus.square.on.square")) { [weak self] _ in
                self?.pageEvent("openLinkRequested", data: ["url": url.absoluteString, "background": false])
            })
            actions.append(UIAction(title: "Open in Background", image: UIImage(systemName: "square.on.square")) { [weak self] _ in
                self?.pageEvent("openLinkRequested", data: ["url": url.absoluteString, "background": true])
            })
        }
        actions.append(UIAction(title: "Copy Link", image: UIImage(systemName: "link")) { _ in
            UIPasteboard.general.url = url
        })
        actions.append(UIAction(title: "Share Link…", image: UIImage(systemName: "square.and.arrow.up")) { [weak self, weak webView] _ in
            guard let self, let webView else { return }
            self.share([url], from: webView)
        })
        return UIMenu(options: .displayInline, children: actions)
    }

    private func imageActions(_ url: URL, in webView: WKWebView) -> UIMenu {
        var actions: [UIMenuElement] = []
        if ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            actions.append(UIAction(title: "Open Image in New Tab", image: UIImage(systemName: "photo.on.rectangle")) { [weak self] _ in
                self?.pageEvent("openLinkRequested", data: ["url": url.absoluteString, "background": false])
            })
        }
        actions.append(UIAction(title: "Copy Image", image: UIImage(systemName: "doc.on.doc")) { [weak self, weak webView] _ in
            guard let self, let webView else { return }
            self.withImage(url, in: webView) { image in
                let type = UTType(mimeType: image.mime) ?? .image
                guard let data = try? Data(contentsOf: image.file) else { return }
                UIPasteboard.general.setData(data, forPasteboardType: type.identifier)
            }
        })
        actions.append(UIAction(title: "Share Image…", image: UIImage(systemName: "square.and.arrow.up")) { [weak self, weak webView] _ in
            guard let self, let webView else { return }
            self.withImage(url, in: webView) { [weak self, weak webView] image in
                guard let self, let webView else { return }
                self.share([image.file], from: webView)
            }
        })
        actions.append(UIAction(title: "Save to Photos", image: UIImage(systemName: "square.and.arrow.down")) { [weak self, weak webView] _ in
            guard let self, let webView else { return }
            self.withImage(url, in: webView) { [weak self] image in self?.saveToPhotos(image) }
        })
        actions.append(UIAction(title: "Copy Image Address", image: UIImage(systemName: "link")) { _ in
            UIPasteboard.general.url = url
        })
        return UIMenu(options: .displayInline, children: actions)
    }

    private func withImage(_ url: URL, in webView: WKWebView, _ use: @escaping (PageImage) -> Void) {
        PageImageDownload.load(url, in: webView) { [weak self] result in
            switch result {
            case .success(let image): use(image)
            case .failure: self?.imageFailed("Couldn't load the image")
            }
        }
    }

    private func saveToPhotos(_ image: PageImage) {
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async { self.imageFailed("Allow Once to add photos in Settings to save images") }
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetCreationRequest.forAsset().addResource(with: .photo, fileURL: image.file, options: nil)
            }) { saved, _ in
                DispatchQueue.main.async {
                    if saved { UINotificationFeedbackGenerator().notificationOccurred(.success) }
                    else { self.imageFailed("Couldn't save the image to Photos") }
                }
            }
        }
    }

    private func imageFailed(_ message: String) {
        guard let presenter = presenter() else { return }
        let alert = UIAlertController(title: message, message: nil, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default))
        presenter.present(alert, animated: true)
    }

    private func share(_ items: [Any], from view: UIView) {
        guard let presenter = presenter() else { return }
        let sheet = UIActivityViewController(activityItems: items, applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        presenter.present(sheet, animated: true)
    }
}

struct PageImage {
    let file: URL
    let mime: String
}

/// Fetches an image through the page's own web view, so its cookies and
/// network settings apply, into a temporary file for copy, share and save.
final class PageImageDownload: NSObject, WKDownloadDelegate {
    private static var active = Set<PageImageDownload>()
    private static let directory = FileManager.default.temporaryDirectory.appendingPathComponent("shared-images")
    private let completion: (Result<PageImage, Error>) -> Void
    private var image: PageImage?
    private var finished = false

    private init(completion: @escaping (Result<PageImage, Error>) -> Void) {
        self.completion = completion
    }

    static func load(_ url: URL, in webView: WKWebView, completion: @escaping (Result<PageImage, Error>) -> Void) {
        // One image at a time is kept: a receiving app reads it right away.
        try? FileManager.default.removeItem(at: directory)
        let task = PageImageDownload(completion: completion)
        if url.scheme?.lowercased() == "data" {
            task.decode(url)
            return
        }
        active.insert(task)
        var request = URLRequest(url: url)
        if let page = webView.url { request.setValue(page.absoluteString, forHTTPHeaderField: "Referer") }
        webView.startDownload(using: request) { download in download.delegate = task }
    }

    private func decode(_ url: URL) {
        do {
            let data = try Data(contentsOf: url)
            let header = url.absoluteString.dropFirst(5).prefix { $0 != "," && $0 != ";" }
            let mime = String(header).lowercased()
            guard mime.hasPrefix("image/") else { throw URLError(.cannotDecodeContentData) }
            let file = try destination(named: "image")
                .appendingPathExtension(UTType(mimeType: mime)?.preferredFilenameExtension ?? "img")
            try data.write(to: file)
            finish(.success(PageImage(file: file, mime: mime)))
        } catch {
            finish(.failure(error))
        }
    }

    private func destination(named name: String) throws -> URL {
        let folder = Self.directory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent(name)
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 200
        guard (200..<300).contains(status), let mime = response.mimeType?.lowercased(), mime.hasPrefix("image/"),
              let file = try? destination(named: suggestedFilename) else {
            completionHandler(nil)
            finish(.failure(URLError(.cannotDecodeContentData)))
            return
        }
        image = PageImage(file: file, mime: mime)
        completionHandler(file)
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let image { finish(.success(image)) } else { finish(.failure(URLError(.unknown))) }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        finish(.failure(error))
    }

    private func finish(_ result: Result<PageImage, Error>) {
        guard !finished else { return }
        finished = true
        DispatchQueue.main.async {
            Self.active.remove(self)
            self.completion(result)
        }
    }
}
