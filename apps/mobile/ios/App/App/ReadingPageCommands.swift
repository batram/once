import UIKit
import Capacitor
import WebKit

// Page commands capture the scoped plugin before crossing the main queue.
extension InAppBrowserSurfacePlugin {
    @objc func capturePreview(_ call: CAPPluginCall) {
        guard route(call, { $0.capturePreview(call) }) else { return }
        DispatchQueue.main.async {
            let reader = call.getBool("reader") ?? false
            guard let view = reader ? self.webView : self.surface,
                  !view.isHidden, view.bounds.width > 0 else { call.resolve(); return }
            let configuration = WKSnapshotConfiguration()
            var rect = view.bounds
            if reader, let bounds = call.getObject("bounds") {
                rect = CGRect(x: bounds["x"] as? Double ?? 0, y: bounds["y"] as? Double ?? 0,
                              width: bounds["width"] as? Double ?? 0, height: bounds["height"] as? Double ?? 0)
                rect = rect.intersection(view.bounds)
            }
            guard !rect.isEmpty, !rect.isNull else { call.resolve(); return }
            rect.size.height = min(rect.height, rect.width * 1.2)
            configuration.rect = rect
            configuration.snapshotWidth = 240
            configuration.afterScreenUpdates = false
            view.takeSnapshot(with: configuration) { image, _ in
                guard let image else { call.resolve(); return }
                let format = UIGraphicsImageRendererFormat()
                format.scale = 1
                format.opaque = true
                let size = CGSize(width: 240, height: 240 * rect.height / rect.width)
                let thumbnail = UIGraphicsImageRenderer(size: size, format: format).image { _ in
                    image.draw(in: CGRect(origin: .zero, size: size))
                }
                guard let data = thumbnail.jpegData(compressionQuality: 0.65) else { call.resolve(); return }
                call.resolve(["dataUrl": "data:image/jpeg;base64," + data.base64EncodedString()])
            }
        }
    }

    @objc func evaluateJavaScript(_ call: CAPPluginCall) {
        guard route(call, { $0.evaluateJavaScript(call) }) else { return }
        guard let script = call.getString("script"), !script.isEmpty else {
            call.reject("JavaScript source is required")
            return
        }
        DispatchQueue.main.async {
            guard let surface = self.surface else {
                call.reject("There is no open page")
                return
            }
            surface.evaluateJavaScript(script) { value, error in
                if let error {
                    call.reject("The script failed: \(error.localizedDescription)")
                    return
                }
                if value == nil || value is NSNull {
                    call.resolve(["value": "null"])
                } else if JSONSerialization.isValidJSONObject([value!]),
                          let data = try? JSONSerialization.data(withJSONObject: value!, options: [.fragmentsAllowed]) {
                    call.resolve(["value": String(decoding: data, as: UTF8.self)])
                } else {
                    call.resolve(["value": "null"])
                }
            }
        }
    }

    @objc func findInPage(_ call: CAPPluginCall) {
        guard route(call, { $0.findInPage(call) }) else { return }
        guard let query = call.getString("query"), !query.isEmpty else {
            call.reject("Search text is required")
            return
        }
        let forward = call.getBool("forward") ?? true
        DispatchQueue.main.async {
            guard let surface = self.surface else {
                call.reject("There is no open page")
                return
            }
            guard let runtime = self.pageFindSource,
                  let encodedQuery = try? JSONSerialization.data(withJSONObject: [query], options: [.fragmentsAllowed]),
                  let queryLiteral = String(data: encodedQuery, encoding: .utf8) else {
                call.reject("The page could not be searched")
                return
            }
            // The literal is a one-element JSON array, so [0] reads the string
            // back. The runtime may end in a line comment, so the brace that
            // closes the block gets a line of its own.
            let script = """
            if (!window.__onceFind) {
            \(runtime)
            }
            JSON.stringify(window.__onceFind.find(\(queryLiteral)[0], \(forward ? "true" : "false")))
            """
            surface.evaluateJavaScript(script) { value, error in
                if let error {
                    call.reject("The page could not be searched: \(error.localizedDescription)")
                    return
                }
                guard let text = value as? String,
                      let data = text.data(using: .utf8),
                      let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    call.reject("The page could not be searched")
                    return
                }
                let current = result["current"] as? Int ?? 0
                let total = result["total"] as? Int ?? 0
                call.resolve([
                    "found": total > 0,
                    "wrapped": false,
                    "current": current,
                    "total": total
                ])
            }
        }
    }

    @objc func clearFind(_ call: CAPPluginCall) {
        guard route(call, { $0.clearFind(call) }) else { return }
        DispatchQueue.main.async {
            self.surface?.evaluateJavaScript("window.__onceFind && window.__onceFind.clear()") { _, _ in }
            call.resolve()
        }
    }

    /// The system find panel (iOS 16 and later). WebKit searches the whole
    /// document itself, including PDFs in its native viewer, which the
    /// injected engine above cannot see because they have no DOM text.
    @objc func presentFind(_ call: CAPPluginCall) {
        guard route(call, { $0.presentFind(call) }) else { return }
        DispatchQueue.main.async {
            guard let surface = self.surface else {
                call.reject("There is no open page")
                return
            }
            if #available(iOS 16.0, *) {
                surface.isFindInteractionEnabled = true
                surface.findInteraction?.presentFindNavigator(showingReplace: false)
                call.resolve(["presented": true])
            } else {
                call.resolve(["presented": false])
            }
        }
    }

    func presenter() -> UIViewController? {
        var current = bridge?.viewController
        while let presented = current?.presentedViewController {
            current = presented
        }
        return current
    }

    @objc func showPrompt(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let presenter = self.presenter() else {
                call.reject("Unable to present the native prompt")
                return
            }
            let alert = UIAlertController(
                title: call.getString("title"),
                message: call.getString("message"),
                preferredStyle: .alert
            )
            alert.addTextField { field in
                field.text = call.getString("value") ?? ""
                field.clearButtonMode = .whileEditing
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
                field.keyboardType = .URL
            }
            alert.addAction(UIAlertAction(
                title: call.getString("cancelLabel") ?? "Cancel",
                style: .cancel
            ) { _ in call.resolve() })
            alert.addAction(UIAlertAction(
                title: call.getString("confirmLabel") ?? "OK",
                style: .default
            ) { _ in
                call.resolve(["value": alert.textFields?.first?.text ?? ""])
            })
            presenter.present(alert, animated: true)
        }
    }

}
