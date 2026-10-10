import Foundation
import Capacitor
import Vision
import ImageIO

// Recognition is independent of the visible tab; only the trusted shell bridge
// can supply image bytes. Remote pages never receive this native capability.
extension InAppBrowserSurfacePlugin {
    @objc func recognizeImage(_ call: CAPPluginCall) {
        guard let encoded = call.getString("base64"), encoded.count <= 45_000_000,
              let data = Data(base64Encoded: encoded), !data.isEmpty,
              data.count <= 32 * 1024 * 1024 else {
            call.reject("Invalid image size")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                guard let source = CGImageSourceCreateWithData(data as CFData, nil),
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let width = properties[kCGImagePropertyPixelWidth] as? Int,
                      let height = properties[kCGImagePropertyPixelHeight] as? Int,
                      width > 0, height > 0, Double(width) * Double(height) <= 80_000_000,
                      let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                        kCGImageSourceCreateThumbnailFromImageAlways: true,
                        kCGImageSourceCreateThumbnailWithTransform: true,
                        kCGImageSourceThumbnailMaxPixelSize: 4096
                      ] as CFDictionary) else {
                    call.reject("Invalid image")
                    return
                }
                let request = VNRecognizeTextRequest()
                request.recognitionLevel = .accurate
                request.usesLanguageCorrection = true
                if #available(iOS 16, *) { request.automaticallyDetectsLanguage = true }
                try VNImageRequestHandler(cgImage: image).perform([request])
                let observations = (request.results ?? []).filter { $0.topCandidates(1).first != nil }
                let bounds = observations.map { observation -> [String: Double] in
                    let box = observation.boundingBox
                    return ["x": box.minX * Double(image.width), "y": (1 - box.maxY) * Double(image.height),
                            "width": box.width * Double(image.width), "height": box.height * Double(image.height)]
                }
                call.resolve(["lines": observations.compactMap { $0.topCandidates(1).first?.string }, "lineBounds": bounds])
            } catch {
                call.reject("Image text recognition failed", nil, error)
            }
        }
    }
}
