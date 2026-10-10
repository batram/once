import Foundation
import ImageIO
import Vision

// One image per invocation. Bytes arrive on stdin; no URLs, shell commands,
// user files, or network access are accepted by the native helper.
struct Point: Encodable {
    let x: CGFloat
    let y: CGFloat
    init(_ point: CGPoint) { x = point.x; y = 1 - point.y }
}
struct Word: Encodable {
    let text: String
    let topLeft: Point
    let topRight: Point
    let bottomLeft: Point
}
struct Recognition: Encodable { let lines: [[Word]] }

do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard data.count <= 32 * 1024 * 1024,
          let source = CGImageSourceCreateWithData(data as CFData, nil),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = properties[kCGImagePropertyPixelWidth] as? Int,
          let height = properties[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, Double(width) * Double(height) <= 80_000_000 else {
        throw NSError(domain: "ImageText", code: 1)
    }
    // ImageIO applies EXIF orientation before recognition and bounds output.
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 4096
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
        throw NSError(domain: "ImageText", code: 2)
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(macOS 13, *) { request.automaticallyDetectsLanguage = true }
    try VNImageRequestHandler(cgImage: image).perform([request])
    let tokens = try NSRegularExpression(pattern: "\\S+")
    let lines: [[Word]] = (request.results ?? []).compactMap { observation in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let text = candidate.string
        return tokens.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            guard let range = Range(match.range, in: text),
                  let box = try? candidate.boundingBox(for: range) else { return nil }
            return Word(text: String(text[range]), topLeft: Point(box.topLeft),
                        topRight: Point(box.topRight), bottomLeft: Point(box.bottomLeft))
        }
    }
    FileHandle.standardOutput.write(try JSONEncoder().encode(Recognition(lines: lines)))
} catch {
    FileHandle.standardError.write(Data("Image text recognition failed.\n".utf8))
    exit(1)
}
