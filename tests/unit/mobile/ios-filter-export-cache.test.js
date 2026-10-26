const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync } = require("node:child_process")

test("native filter export cache survives restart and safely handles invalidation, corruption, cancellation and unavailable storage", { skip: process.platform !== "darwin" }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-filter-cache-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const support = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/ios/App/App/ExtensionSupport.swift"), "utf8")
    .replace("import Capacitor", "typealias JSObject = [String: Any]")
  fs.writeFileSync(path.join(directory, "Support.swift"), support)
  fs.writeFileSync(path.join(directory, "Driver.swift"), `
import Foundation
@main struct Driver {
    static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let cache = root.appendingPathComponent("export.plist")
        let original = "||ads.example^\\n@@||ads.example^allowed\\n##.advert"
        let expected = try IOSContentBlockerExporter.export(original)
        if CommandLine.arguments[2] == "seed" {
            try check(IOSContentBlockerExporter.cachedExport(original, cacheURL: cache) == expected)
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: cache.path)
            return
        }
        let hit = try IOSContentBlockerExporter.cachedExport(original, cacheURL: cache)
        precondition(hit == expected)
        let modified = try cache.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate!
        precondition(modified == Date(timeIntervalSince1970: 1), "Fresh process must use disk cache without rewriting")
        let changed = "||other.example^"
        let changedExpected = try IOSContentBlockerExporter.export(changed)
        try check(IOSContentBlockerExporter.cachedExport(changed, cacheURL: cache) == changedExpected)
        var plist = try PropertyListSerialization.propertyList(from: Data(contentsOf: cache), format: nil) as! [String: String]
        plist["rules"] = "[]" // Valid plist, incorrect cached payload/checksum.
        try PropertyListSerialization.data(fromPropertyList: plist, format: .binary, options: 0).write(to: cache)
        try check(IOSContentBlockerExporter.cachedExport(changed, cacheURL: cache) == changedExpected)
        try Data("corrupt".utf8).write(to: cache)
        try check(IOSContentBlockerExporter.cachedExport(original, cacheURL: cache) == expected)
        let saved = try Data(contentsOf: cache)
        try check(IOSContentBlockerExporter.cachedExport("", cacheURL: cache) == "[]")
        try check(Data(contentsOf: cache) == saved, "Clearing filters must not replace the last useful cache")
        let unavailable = root.appendingPathComponent("file-not-directory")
        try Data().write(to: unavailable)
        try check(IOSContentBlockerExporter.cachedExport(original, cacheURL: unavailable.appendingPathComponent("cache")) == expected)
        let cancelled = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try IOSContentBlockerExporter.cachedExport(changed, cacheURL: cache)
        }
        do { _ = try await cancelled.value; preconditionFailure("Expected cancellation") }
        catch is CancellationError {}
        try check(Data(contentsOf: cache) == saved, "Cancelled work must not replace the cache")
        print("Native cache regression passed")
    }
}
`)
  fs.appendFileSync(path.join(directory, "Driver.swift"), "\nfunc check(_ value: Bool, _ message: String = \"\") { precondition(value, message) }\n")
  const binary = path.join(directory, "cache-test")
  execFileSync("xcrun", ["--sdk", "macosx", "swiftc", "-O", "-parse-as-library", path.join(directory, "Support.swift"), path.join(directory, "Driver.swift"), "-o", binary], { stdio: "pipe" })
  execFileSync(binary, [directory, "seed"], { stdio: "pipe" })
  assert.match(execFileSync(binary, [directory, "check"], { encoding: "utf8" }), /Native cache regression passed/)
})
