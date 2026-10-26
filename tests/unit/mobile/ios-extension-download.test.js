const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const { execFileSync, spawnSync } = require("node:child_process")

const available = process.platform === "darwin" && spawnSync("xcrun", ["-f", "swiftc"], { stdio: "ignore" }).status === 0

test("iOS downloads spool 200 MB to disk and reject both declared and streamed overflow", { skip: !available }, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "once-xpi-download-test-"))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const source = fs.readFileSync(path.resolve(__dirname, "../../../apps/mobile/ios/App/App/WebExtensionInstaller.swift"), "utf8")
  // Compile the production implementation in the same file so its private delegate can receive deterministic callbacks.
  const driver = `
func transferFixture(_ count: Int, limit: Int, declared: Int?) async throws -> Data {
    let transfer = try BoundedTransfer(limit: limit)
    let url = URL(string: "https://addons.mozilla.org/test.xpi")!
    let task = URLSession.shared.dataTask(with: url) // callbacks are supplied below; no network request is started
    return try await withCheckedThrowingContinuation { continuation in
        transfer.continuation = continuation
        let headers = declared.map { ["Content-Length": String($0)] } ?? [:]
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: headers)!
        var allowed = false
        transfer.urlSession(.shared, dataTask: task, didReceive: response) { allowed = $0 == .allow }
        guard allowed else { return }
        let chunk = Data(repeating: 42, count: 65536)
        var remaining = count
        while remaining > 0 && transfer.continuation != nil {
            let size = min(remaining, chunk.count)
            transfer.urlSession(.shared, dataTask: task, didReceive: chunk.prefix(size))
            remaining -= size
        }
        transfer.urlSession(.shared, task: task, didCompleteWithError: nil)
    }
}
@main struct DownloadTest {
    static func main() async throws {
        let mapped = try await transferFixture(200_000_000, limit: 200_000_000, declared: 200_000_000)
        // Access after the transfer and its temporary pathname are gone: the mapping must remain valid.
        var result: [String: Any] = ["bytes": mapped.count, "first": Int(mapped.first!), "last": Int(mapped.last!)]
        for (key, declared) in [("declaredOverflow", Optional(200_000_001)), ("streamedOverflow", nil)] {
            do { _ = try await transferFixture(200_000_001, limit: 200_000_000, declared: declared); result[key] = "accepted" }
            catch { result[key] = error.localizedDescription }
        }
        print(String(data: try JSONSerialization.data(withJSONObject: result), encoding: .utf8)!)
    }
}
`
  const swift = path.join(directory, "main.swift")
  const binary = path.join(directory, "download-test")
  fs.writeFileSync(swift, source + driver)
  execFileSync("xcrun", ["--sdk", "macosx", "swiftc", "-O", "-parse-as-library", "-target",
    `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos15.4`, swift, "-o", binary], { stdio: "pipe" })
  const result = JSON.parse(execFileSync(binary, { encoding: "utf8" }))
  assert.deepEqual(result, {
    bytes: 200_000_000, first: 42, last: 42,
    declaredOverflow: "Extension download exceeds the size limit",
    streamedOverflow: "Extension download exceeds the size limit"
  })
})
