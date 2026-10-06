import Capacitor
import Photos
import UIKit
import UniformTypeIdentifiers
import WebKit

// The page's long-press menu. WebKit hit-tests the press and draws the system
// menu; Once supplies the actions, since WebKit's own "Open" replaces the page
// in place and its image actions cannot be extended.
extension InAppBrowserSurfacePlugin {
    /// WKContextMenuElementInfo carries only the link, so the page side records
    /// where the press landed and names the image and link text under it. Runs
    /// in its own content world, out of the page's reach.
    static let contextMenuWorld = WKContentWorld.world(name: "OnceContextMenu")
    static let contextMenuScript = WKUserScript(source: """
        (() => {
          let point = null
          addEventListener("touchstart", (event) => {
            const touch = event.touches[0]
            if (touch) point = [touch.clientX, touch.clientY]
          }, { capture: true, passive: true })
          window.__onceTouchTarget = () => {
            if (!point) return null
            const found = {}
            for (const element of document.elementsFromPoint(point[0], point[1])) {
              if (!found.image && element instanceof HTMLImageElement) found.image = element.currentSrc || element.src || ""
              const link = element.closest?.("a[href]")
              if (!found.linkText && link) found.linkText = (link.textContent || "").trim().slice(0, 300)
            }
            return found
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
        webView.evaluateJavaScript("window.__onceTouchTarget?.() ?? null", in: nil, in: Self.contextMenuWorld) { [weak self, weak webView] result in
            let target = (try? result.get()) as? [String: Any]
            let image = (target?["image"] as? String).flatMap(URL.init(string:))
                .flatMap { ["http", "https", "data"].contains($0.scheme?.lowercased() ?? "") ? $0 : nil }
            let linkText = target?["linkText"] as? String
            guard let self, link != nil || image != nil else { completionHandler(nil); return }
            self.shellItems(for: link, linkText: linkText) { [weak self, weak webView] items in
                guard let self, let webView else { completionHandler(nil); return }
                completionHandler(self.menuConfiguration(link: link, linkText: linkText, image: image, items: items, in: webView))
            }
        }
    }

    /**
     * The shell's web view, which holds the Reader frame: Capacitor is its UI
     * delegate, and ShellUIDelegate hands long-presses on its web links here.
     */
    func shellContextMenu(_ webView: WKWebView, link: URL?, completionHandler: @escaping (UIContextMenuConfiguration?) -> Void) {
        // The shell's own pages are no web links to open or hand to add-ons.
        guard let link, ["http", "https"].contains(link.scheme?.lowercased() ?? ""),
              link.host != bridge?.config.serverURL.host else { completionHandler(nil); return }
        shellItems(for: link, linkText: nil) { [weak self, weak webView] items in
            guard let self, let webView else { completionHandler(nil); return }
            completionHandler(self.menuConfiguration(link: link, linkText: nil, image: nil, items: items, in: webView))
        }
    }

    /// Tapping a Reader link's lifted preview opens it in the reading view, as a tap would.
    func shellContextMenuCommitted(_ link: URL?, animator: UIContextMenuInteractionCommitAnimating) {
        animator.preferredCommitStyle = .dismiss
        guard let link else { return }
        animator.addCompletion { [weak self] in
            self?.pageEvent("openLinkRequested", data: ["url": link.absoluteString, "background": false, "current": true])
        }
    }

    private func menuConfiguration(link: URL?, linkText: String?, image: URL?, items: [ShellMenuItem], in webView: WKWebView) -> UIContextMenuConfiguration {
        UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self, weak webView] _ in
            guard let self, let webView else { return nil }
            var sections: [UIMenuElement] = []
            if let link { sections.append(self.linkActions(link, in: webView)) }
            if let link, !items.isEmpty { sections.append(self.shellActions(items, link: link, linkText: linkText)) }
            if let image { sections.append(self.imageActions(image, in: webView)) }
            return UIMenu(title: String((link ?? image)?.absoluteString.prefix(300) ?? ""), children: sections)
        }
    }

    /// The shell's items for a link, such as add-ons' page actions; none after a short wait.
    private func shellItems(for link: URL?, linkText: String?, _ done: @escaping ([ShellMenuItem]) -> Void) {
        guard let link, ["http", "https"].contains(link.scheme?.lowercased() ?? "") else { done([]); return }
        let root = owner ?? self
        let requestId = UUID().uuidString
        var finished = false
        let finish: ([ShellMenuItem]) -> Void = { items in
            guard !finished else { return }
            finished = true
            done(items)
        }
        root.pendingMenus[requestId] = finish
        var data: [String: Any] = ["requestId": requestId, "link": link.absoluteString]
        if let linkText { data["linkText"] = linkText }
        pageEvent("contextMenuRequested", data: data)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            root.pendingMenus.removeValue(forKey: requestId)?([])
        }
    }

    private func shellActions(_ items: [ShellMenuItem], link: URL, linkText: String?) -> UIMenu {
        UIMenu(options: .displayInline, children: items.map { item in
            UIAction(title: item.label, image: UIImage(systemName: "puzzlepiece.extension")) { [weak self] _ in
                var data: [String: Any] = ["id": item.id, "link": link.absoluteString]
                if let linkText { data["linkText"] = linkText }
                self?.pageEvent("contextMenuAction", data: data)
            }
        })
    }

    /// The shell's answer to contextMenuRequested; the root plugin holds the waiting menus.
    @objc func setContextMenuItems(_ call: CAPPluginCall) {
        let requestId = call.getString("requestId") ?? ""
        let items = (call.getArray("items", JSObject.self) ?? []).compactMap { item -> ShellMenuItem? in
            guard let id = item["id"] as? String, let label = item["label"] as? String, !id.isEmpty, !label.isEmpty else { return nil }
            return ShellMenuItem(id: id, label: label)
        }
        DispatchQueue.main.async {
            self.pendingMenus.removeValue(forKey: requestId)?(items)
            call.resolve()
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

struct ShellMenuItem {
    let id: String
    let label: String
}

/**
 * Capacitor is the shell web view's UI delegate and draws no menu of its own
 * for links, so WebKit's default one showed over the Reader frame. This one
 * gives those links the page surface's menu and forwards everything else.
 */
final class ShellUIDelegate: NSObject, WKUIDelegate {
    private weak var base: WKUIDelegate?
    private weak var plugin: InAppBrowserSurfacePlugin?

    init(base: WKUIDelegate?, plugin: InAppBrowserSurfacePlugin) {
        self.base = base
        self.plugin = plugin
    }

    override func responds(to selector: Selector!) -> Bool {
        super.responds(to: selector) || base?.responds(to: selector) == true
    }

    override func forwardingTarget(for selector: Selector!) -> Any? {
        base?.responds(to: selector) == true ? base : nil
    }

    func webView(
        _ webView: WKWebView,
        contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
        completionHandler: @escaping (UIContextMenuConfiguration?) -> Void
    ) {
        guard let plugin else { completionHandler(nil); return }
        plugin.shellContextMenu(webView, link: elementInfo.linkURL, completionHandler: completionHandler)
    }

    func webView(
        _ webView: WKWebView,
        contextMenuForElement elementInfo: WKContextMenuElementInfo,
        willCommitWithAnimator animator: UIContextMenuInteractionCommitAnimating
    ) {
        plugin?.shellContextMenuCommitted(elementInfo.linkURL, animator: animator)
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
