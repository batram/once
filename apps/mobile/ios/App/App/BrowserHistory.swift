import Foundation
import Capacitor
import SQLite3

/** App-owned history outside WKWebsiteDataStore, with serialized background SQL. */
@objc(BrowserHistoryPlugin)
public class BrowserHistoryPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BrowserHistoryPlugin"
    public let jsName = "BrowserHistory"
    public let pluginMethods: [CAPPluginMethod] = [CAPPluginMethod(name: "execute", returnType: CAPPluginReturnPromise)]
    private let worker = DispatchQueue(label: "once.browser-history", qos: .utility)
    private var database: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private func open() throws {
        if database != nil { return }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        var directory = support.appendingPathComponent("BrowserHistory", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        // Exclude the directory so the database's WAL and shared-memory files
        // inherit the same backup policy as the main database.
        try directory.setResourceValues(values)
        let file = directory.appendingPathComponent("browser-history.sqlite")
        guard sqlite3_open_v2(file.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
            sqlite3_close(database)
            database = nil
            throw failure()
        }
        try sql("PRAGMA journal_mode=WAL")
        try sql("PRAGMA synchronous=FULL")
        try sql("PRAGMA busy_timeout=5000")
        try sql("PRAGMA secure_delete=ON")
    }

    deinit { sqlite3_close(database) }

    private func failure() -> NSError { NSError(domain: "OnceHistory", code: 1, userInfo: [NSLocalizedDescriptionKey: "History storage failed"]) }
    private func sql(_ sql: String) throws {
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw failure() }
    }

    @objc public func execute(_ call: CAPPluginCall) {
        worker.async {
            do {
                try self.open()
                if let statements = call.getArray("statements") as? [[String: Any]] {
                    try self.sql("BEGIN IMMEDIATE")
                    do {
                        for statement in statements { _ = try self.run(statement) }
                        try self.sql("COMMIT")
                    } catch { try? self.sql("ROLLBACK"); throw error }
                    if statements.contains(where: { ($0["sql"] as? String)?.hasPrefix("DELETE") == true }) {
                        try self.sql("PRAGMA wal_checkpoint(TRUNCATE)")
                    }
                    call.resolve()
                } else if let statement = call.getObject("statement") {
                    call.resolve(["rows": try self.run(statement)])
                } else { throw self.failure() }
            } catch { call.reject("History storage failed", nil, error) }
        }
    }

    private func run(_ request: [String: Any]) throws -> [[String: Any]] {
        guard let sql = request["sql"] as? String else { throw failure() }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else { throw failure() }
        defer { sqlite3_finalize(statement) }
        for (index, value) in (request["params"] as? [Any] ?? []).enumerated() {
            let result: Int32
            if let text = value as? String { result = sqlite3_bind_text(statement, Int32(index + 1), text, -1, transient) }
            else if let number = value as? NSNumber { result = sqlite3_bind_int64(statement, Int32(index + 1), number.int64Value) }
            else { throw failure() }
            guard result == SQLITE_OK else { throw failure() }
        }
        var rows = [[String: Any]]()
        var result = sqlite3_step(statement)
        while result == SQLITE_ROW {
            var row = [String: Any]()
            for column in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, column))
                if sqlite3_column_type(statement, column) == SQLITE_INTEGER { row[name] = sqlite3_column_int64(statement, column) }
                else if let text = sqlite3_column_text(statement, column) { row[name] = String(cString: text) }
            }
            rows.append(row)
            result = sqlite3_step(statement)
        }
        guard result == SQLITE_DONE else { throw failure() }
        return rows
    }
}
