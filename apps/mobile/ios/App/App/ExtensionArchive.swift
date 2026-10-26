import Foundation
import Compression

/// Reads and unpacks an XPI (ZIP) archive with the same acceptance rules the
/// Electron runtime applies in packages/webext-runtime/src/ExtensionPackage.ts.
enum ExtensionArchive {
    // Mozilla AMO: decimal 200 MB upload, <250 MiB expanded, <=100 MiB per file.
    static let maxArchiveBytes = 200_000_000
    static let maxExpandedBytes = 250 * 1024 * 1024
    static let maxFileBytes = 100 * 1024 * 1024
    static let maxEntries = 10_000

    struct Entry: Equatable {
        /// `/`-separated path inside the archive; directories end with `/`.
        let name: String
        let isDirectory: Bool
        /// Declared uncompressed size.
        let size: Int
    }

    struct Failure: LocalizedError, Equatable {
        let message: String
        var errorDescription: String? { message }
    }

    /// Every entry from the central directory. Throws Failure("Invalid XPI archive") when the data is not a ZIP.
    static func entries(of data: Data) throws -> [Entry] {
        try data.withUnsafeBytes { bytes in
            try records(of: bytes).map { Entry(name: $0.name, isDirectory: $0.isDirectory, size: $0.size) }
        }
    }

    /// Validates every path and size as a whole (see rules), then writes the
    /// files below `directory`, creating it (it must not exist beforehand).
    /// On any failure the partially written directory is removed before rethrowing.
    static func extract(_ data: Data, to directory: URL) throws {
        try data.withUnsafeBytes { bytes in
            let records = try records(of: bytes)
            try validate(byteCount: bytes.count, records: records)
            let manager = FileManager.default
            if manager.fileExists(atPath: directory.path) { throw Failure(message: "Extension directory already exists") }
            try manager.createDirectory(at: directory, withIntermediateDirectories: true)
            do {
                for record in records { try autoreleasepool { try write(record, from: bytes, below: directory) } }
            } catch {
                try? manager.removeItem(at: directory)
                throw error
            }
        }
    }

    /// The picker supplies a private copy. Check its size before mapping it, off the main actor.
    static func read(_ file: URL) throws -> Data {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        guard try handle.seekToEnd() <= UInt64(maxArchiveBytes) else { throw Failure(message: "XPI exceeds the 200 MB limit") }
        let data = try Data(contentsOf: file, options: .alwaysMapped)
        guard data.count <= maxArchiveBytes else { throw Failure(message: "XPI exceeds the 200 MB limit") }
        return data
    }

    // MARK: - Parsing

    private struct Record {
        let name: String
        let isDirectory: Bool
        let size: Int
        let compressedSize: Int
        let crc: UInt32
        let method: Int
        let localOffset: Int
    }

    private struct Reader {
        let bytes: UnsafeRawBufferPointer

        func u16(_ offset: Int) throws -> Int {
            guard offset >= 0, offset + 2 <= bytes.count else { throw invalid }
            return Int(bytes[offset]) | Int(bytes[offset + 1]) << 8
        }

        func u32(_ offset: Int) throws -> Int {
            guard offset >= 0, offset + 4 <= bytes.count else { throw invalid }
            return Int(bytes[offset]) | Int(bytes[offset + 1]) << 8 | Int(bytes[offset + 2]) << 16 | Int(bytes[offset + 3]) << 24
        }

        func slice(_ offset: Int, _ length: Int) throws -> UnsafeRawBufferPointer {
            guard offset >= 0, length >= 0, offset + length <= bytes.count else { throw invalid }
            return UnsafeRawBufferPointer(rebasing: bytes[offset..<(offset + length)])
        }
    }

    private static let invalid = Failure(message: "Invalid XPI archive")
    private static let unsafePath = Failure(message: "XPI contains an unsafe or duplicate file path")
    private static let zip64Marker = 0xFFFF_FFFF

    /// Offset of the end-of-central-directory record, searched backwards past any comment.
    private static func endRecordOffset(_ reader: Reader) throws -> Int {
        let bytes = reader.bytes
        guard bytes.count >= 22 else { throw invalid }
        var offset = bytes.count - 22
        let floor = max(0, offset - 0xFFFF)
        while offset >= floor {
            if bytes[offset] == 0x50, bytes[offset + 1] == 0x4b, bytes[offset + 2] == 0x05, bytes[offset + 3] == 0x06,
               try reader.u16(offset + 20) == bytes.count - offset - 22 {
                return offset
            }
            offset -= 1
        }
        throw invalid
    }

    private static func records(of bytes: UnsafeRawBufferPointer) throws -> [Record] {
        let reader = Reader(bytes: bytes)
        let end = try endRecordOffset(reader)
        let count = try reader.u16(end + 10)
        let directorySize = try reader.u32(end + 12)
        var offset = try reader.u32(end + 16)
        guard count != 0xFFFF, directorySize != zip64Marker, offset != zip64Marker,
              try reader.u16(end + 8) == count, offset + directorySize <= end else { throw invalid }
        let directoryEnd = offset + directorySize
        var records: [Record] = []
        records.reserveCapacity(count)
        for _ in 0..<count {
            guard try reader.u32(offset) == 0x0201_4b50 else { throw invalid }
            let flags = try reader.u16(offset + 8)
            let method = try reader.u16(offset + 10)
            let crc = UInt32(try reader.u32(offset + 16))
            let compressedSize = try reader.u32(offset + 20)
            let size = try reader.u32(offset + 24)
            let nameLength = try reader.u16(offset + 28)
            let extraLength = try reader.u16(offset + 30)
            let commentLength = try reader.u16(offset + 32)
            let localOffset = try reader.u32(offset + 42)
            guard flags & 1 == 0, method == 0 || method == 8,
                  compressedSize != zip64Marker, size != zip64Marker, localOffset != zip64Marker else { throw invalid }
            let name = String(decoding: try reader.slice(offset + 46, nameLength), as: UTF8.self)
            records.append(Record(name: name, isDirectory: name.hasSuffix("/"), size: size,
                                  compressedSize: compressedSize, crc: crc, method: method, localOffset: localOffset))
            offset += 46 + nameLength + extraLength + commentLength
            guard offset <= directoryEnd else { throw invalid }
        }
        return records
    }

    // MARK: - Validation

    private static let reservedNames: Set<String> = {
        var names: Set<String> = ["con", "prn", "aux", "nul"]
        for digit in 1...9 { names.insert("com\(digit)"); names.insert("lpt\(digit)") }
        return names
    }()

    private static func unsafeSegment(_ part: Substring) -> Bool {
        if part.isEmpty || part == "." || part == ".." { return true }
        if part.unicodeScalars.contains(where: { $0 == "\\" || $0 == ":" || $0.value < 32 }) { return true }
        if let last = part.last, last == "." || last == " " { return true }
        let stem = part.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)[0]
        return reservedNames.contains(stem.lowercased())
    }

    private static func validate(byteCount: Int, records: [Record]) throws {
        if byteCount > maxArchiveBytes { throw Failure(message: "XPI exceeds the 200 MB limit") }
        if records.count > maxEntries { throw Failure(message: "XPI has too many files") }
        var seen = Set<String>()
        var expanded = 0
        for record in records {
            var name = record.name
            if name.hasSuffix("/") { name.removeLast() }
            let lowered = name.lowercased()
            if name.isEmpty || seen.contains(lowered)
                || name.split(separator: "/", omittingEmptySubsequences: false).contains(where: unsafeSegment) {
                throw unsafePath
            }
            seen.insert(lowered)
            if record.size > maxFileBytes { throw Failure(message: "XPI file exceeds the 100 MiB limit") }
            expanded += record.size
            if expanded >= maxExpandedBytes { throw Failure(message: "Expanded XPI must be smaller than 250 MiB") }
        }
    }

    // MARK: - Extraction

    private static func write(_ record: Record, from bytes: UnsafeRawBufferPointer, below directory: URL) throws {
        let target = directory.appendingPathComponent(record.name)
        let manager = FileManager.default
        if record.isDirectory {
            try manager.createDirectory(at: target, withIntermediateDirectories: true)
            return
        }
        let body = try contents(of: record, from: bytes)
        guard crc32(body) == record.crc else { throw Failure(message: "XPI file is corrupt") }
        try manager.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try body.write(to: target, options: .withoutOverwriting)
    }

    /// The decompressed file body, located through the local header the central record points at.
    private static func contents(of record: Record, from bytes: UnsafeRawBufferPointer) throws -> Data {
        let reader = Reader(bytes: bytes)
        let local = record.localOffset
        guard try reader.u32(local) == 0x0403_4b50 else { throw invalid }
        let start = local + 30 + (try reader.u16(local + 26)) + (try reader.u16(local + 28))
        let compressed = try reader.slice(start, record.compressedSize)
        if record.method == 0 {
            guard compressed.count == record.size else { throw Failure(message: "XPI file size mismatch") }
            return Data(compressed)
        }
        // One spare byte lets an over-long stream show up as a size mismatch instead of a silent truncation.
        var output = Data(count: record.size + 1)
        let written = output.withUnsafeMutableBytes { (destination: UnsafeMutableRawBufferPointer) -> Int in
            guard let base = compressed.baseAddress else { return 0 }
            return compression_decode_buffer(destination.baseAddress!.assumingMemoryBound(to: UInt8.self), destination.count,
                                             base.assumingMemoryBound(to: UInt8.self), compressed.count, nil, COMPRESSION_ZLIB)
        }
        guard written == record.size else { throw Failure(message: "XPI file size mismatch") }
        output.removeLast()
        return output
    }

    private static let crcTable: [UInt32] = (0..<256).map { index -> UInt32 in
        var value = UInt32(index)
        for _ in 0..<8 { value = value & 1 == 1 ? 0xEDB8_8320 ^ (value >> 1) : value >> 1 }
        return value
    }

    private static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        data.withUnsafeBytes { buffer in
            for byte in buffer { crc = crcTable[Int((crc ^ UInt32(byte)) & 0xFF)] ^ (crc >> 8) }
        }
        return crc ^ 0xFFFF_FFFF
    }
}
