package com.zmarn.once;

import androidx.sqlite.SQLiteConnection;
import androidx.sqlite.SQLiteStatement;
import androidx.sqlite.driver.bundled.BundledSQLiteDriver;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** App-owned SQLite, outside WebView's quota/eviction domain. No SQL crosses the bridge. */
@CapacitorPlugin(name = "NativeDatabase")
public class NativeDatabasePlugin extends Plugin {
    private static final int MAX_SNAPSHOTS = 64;
    // Measured on-device: about 23 MiB for 64 scanned readers instead of 155 MiB
    // with the default 2000 KiB cache. The writer keeps its default cache.
    private static final int SNAPSHOT_CACHE_KIB = 256;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<String, SQLiteConnection> databases = new HashMap<>();
    private final Map<String, Snapshot> snapshots = new HashMap<>();
    private int peakSnapshots;

    private static class Snapshot {
        SQLiteConnection db;
        String name;
        String where;
        ArrayList<String> parameters;
        String last;
        boolean reverse;
        boolean values;
        long remaining;
        long openedAtMs;
    }

    @PluginMethod
    public void execute(PluginCall call) {
        long queued = android.os.SystemClock.elapsedRealtimeNanos();
        worker.execute(() -> {
            long started = android.os.SystemClock.elapsedRealtimeNanos();
            try {
                call.resolve(dispatch(call.getData()));
            } catch (Exception failure) {
                // Neither document bodies nor credentials belong in the error log.
                call.reject("Native database operation failed: " + failure.getClass().getSimpleName()
                        + (failure instanceof IllegalStateException ? " (" + failure.getMessage() + ")" : ""), failure);
            } finally {
                if (android.util.Log.isLoggable("OnceDatabasePerf", android.util.Log.DEBUG)) {
                    android.util.Log.d("OnceDatabasePerf", call.getData().optString("operation")
                        + " queueMs=" + (started - queued) / 1_000_000.0
                        + " executeMs=" + (android.os.SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0);
                }
            }
        });
    }

    private File path(String name) throws Exception {
        if (name.isEmpty() || name.length() > 1024) throw new IllegalArgumentException("Invalid database name");
        File directory = new File(getContext().getNoBackupFilesDir(), "once-databases");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IllegalStateException("Cannot create database directory");
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(name.getBytes(StandardCharsets.UTF_8));
        StringBuilder encoded = new StringBuilder();
        for (byte value : digest) encoded.append(String.format("%02x", value & 255));
        return new File(directory, encoded + ".sqlite");
    }

    private SQLiteConnection database(String name) {
        SQLiteConnection db = databases.get(name);
        if (db == null) throw new IllegalStateException("Database is not open");
        return db;
    }

    private static String key(String value) {
        if (!value.matches("(?:[0-9a-f]{2})*")) throw new IllegalArgumentException("Invalid byte key");
        return value;
    }

    private static void sql(SQLiteConnection db, String sql) {
        try (SQLiteStatement statement = db.prepare(sql)) { statement.step(); }
    }

    private static String readValue(SQLiteConnection db, String itemKey) {
        // The bundled driver returns bytes directly, without Android CursorWindow's row-size limit.
        try (SQLiteStatement statement = db.prepare("SELECT v FROM kv WHERE k=?")) {
            statement.bindText(1, itemKey);
            return statement.step() ? Base64.encodeToString(statement.getBlob(0), Base64.NO_WRAP) : null;
        }
    }

    private JSObject dispatch(JSONObject request) throws Exception {
        String operation = request.getString("operation");
        JSObject result = new JSObject();
        if (operation.equals("readPointer")) {
            result.put("value", getContext().getSharedPreferences("once_native_database", 0).getString("pointer", ""));
            return result;
        }
        if (operation.equals("writePointer")) {
            if (!getContext().getSharedPreferences("once_native_database", 0).edit()
                    .putString("pointer", request.getString("value")).commit()) {
                throw new IllegalStateException("Pointer commit failed");
            }
            return result;
        }
        String name = request.getString("name");
        if (operation.equals("diagnostics")) {
            return diagnostics(name);
        } else if (operation.equals("open")) {
            if (databases.containsKey(name)) throw new IllegalStateException("Database already open");
            File file = path(name);
            if (file.exists() && request.optBoolean("errorIfExists")) throw new IllegalStateException("Database exists");
            if (!file.exists() && !request.optBoolean("createIfMissing", true)) throw new IllegalStateException("Database missing");
            SQLiteConnection db = new BundledSQLiteDriver().open(file.getAbsolutePath());
            try {
                sql(db, "PRAGMA journal_mode=WAL");
                sql(db, "PRAGMA synchronous=FULL");
                sql(db, "PRAGMA busy_timeout=5000");
                sql(db, "CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY COLLATE BINARY, v BLOB NOT NULL) WITHOUT ROWID");
                databases.put(name, db);
            } catch (Exception failure) {
                db.close();
                throw failure;
            }
            result.put("path", file.getAbsolutePath());
        } else if (operation.equals("close") || operation.equals("destroy")) {
            for (String id : new ArrayList<>(snapshots.keySet())) {
                if (snapshots.get(id).name.equals(name)) endSnapshot(id);
            }
            SQLiteConnection db = databases.remove(name);
            if (db != null) db.close();
            if (operation.equals("destroy")) {
                for (String suffix : new String[]{"", "-wal", "-shm", "-journal"}) {
                    File file = new File(path(name).getAbsolutePath() + suffix);
                    if (file.exists() && !file.delete()) throw new IllegalStateException("Database deletion failed");
                }
            }
        } else if (operation.equals("getMany")) {
            SQLiteConnection db = database(name);
            JSONArray keys = request.getJSONArray("keys");
            JSONArray values = new JSONArray();
            for (int index = 0; index < keys.length(); index++) {
                String value = readValue(db, key(keys.getString(index)));
                values.put(value == null ? JSONObject.NULL : value);
            }
            result.put("values", values);
        } else if (operation.equals("batch")) {
            SQLiteConnection db = database(name);
            JSONArray operations = request.getJSONArray("operations");
            sql(db, "BEGIN IMMEDIATE");
            boolean committed = false;
            try {
                for (int index = 0; index < operations.length(); index++) {
                    JSONObject item = operations.getJSONObject(index);
                    String itemKey = key(item.getString("key"));
                    if (item.getString("type").equals("del")) {
                        try (SQLiteStatement statement = db.prepare("DELETE FROM kv WHERE k=?")) {
                            statement.bindText(1, itemKey);
                            statement.step();
                        }
                    } else if (item.getString("type").equals("put")) {
                        try (SQLiteStatement statement = db.prepare("INSERT OR REPLACE INTO kv(k,v) VALUES(?,?)")) {
                            statement.bindText(1, itemKey);
                            statement.bindBlob(2, Base64.decode(item.getString("value"), Base64.NO_WRAP));
                            statement.step();
                        }
                    } else throw new IllegalArgumentException("Invalid batch operation");
                }
                sql(db, "COMMIT");
                committed = true;
            } finally {
                // Acknowledge only after the complete batch commits, including attachments and metadata.
                if (!committed) sql(db, "ROLLBACK");
            }
        } else if (operation.equals("iteratorOpen")) {
            database(name);
            // PouchDB allDocs(keys) creates one exact-key iterator per key. A
            // point read is already an atomic snapshot: materialize that one row
            // instead of opening hundreds of persistent SQLite connections.
            if (request.has("gte") && request.has("lte")
                    && request.getString("gte").equals(request.getString("lte"))
                    && !request.has("gt") && !request.has("lt")) {
                String itemKey = key(request.getString("gte"));
                String value = readValue(database(name), itemKey);
                JSONArray rows = new JSONArray();
                if (value != null && request.optLong("limit", -1) != 0) {
                    JSONObject row = new JSONObject();
                    row.put("key", itemKey);
                    if (request.optBoolean("values", true)) row.put("value", value);
                    rows.put(row);
                }
                result.put("iterator", JSONObject.NULL);
                result.put("rows", rows);
                result.put("done", true);
                return result;
            }
            Snapshot snapshot = new Snapshot();
            snapshot.name = name;
            snapshot.reverse = request.optBoolean("reverse");
            snapshot.values = request.optBoolean("values", true);
            snapshot.remaining = request.optLong("limit", -1);
            snapshot.openedAtMs = android.os.SystemClock.elapsedRealtime();
            snapshot.parameters = new ArrayList<>();
            ArrayList<String> conditions = new ArrayList<>();
            String[] bounds = {"gt", "gte", "lt", "lte"};
            String[] operators = {">", ">=", "<", "<="};
            for (int index = 0; index < bounds.length; index++) {
                if (request.has(bounds[index])) {
                    conditions.add("k" + operators[index] + "?");
                    snapshot.parameters.add(key(request.getString(bounds[index])));
                }
            }
            snapshot.where = conditions.isEmpty() ? "1" : String.join(" AND ", conditions);
            snapshot.db = new BundledSQLiteDriver().open(path(name).getAbsolutePath());
            try {
                sql(snapshot.db, "PRAGMA cache_size=-" + SNAPSHOT_CACHE_KIB);
                sql(snapshot.db, "PRAGMA query_only=ON");
                sql(snapshot.db, "BEGIN DEFERRED");
                // Pin the WAL snapshot now. Later pages cannot see concurrent writes.
                sql(snapshot.db, "SELECT k FROM kv LIMIT 1");
                String id = UUID.randomUUID().toString();
                if (request.optBoolean("initialPage")) readPage(snapshot, result);
                // Story observation queries fan out many short prefix ranges.
                // Once their rows are materialized, no transaction is needed
                // while JavaScript consumes them or waits to end its iterator.
                if (result.optBoolean("done")) {
                    sql(snapshot.db, "ROLLBACK");
                    snapshot.db.close();
                    result.put("iterator", JSONObject.NULL);
                    return result;
                }
                if (snapshots.size() >= MAX_SNAPSHOTS) {
                    android.util.Log.w("OnceDatabase", "Snapshot capacity reached: " + diagnostics(name));
                    throw new IllegalStateException("Too many open range snapshots");
                }
                snapshots.put(id, snapshot);
                peakSnapshots = Math.max(peakSnapshots, snapshots.size());
                result.put("iterator", id);
            } catch (Exception failure) {
                snapshot.db.close();
                throw failure;
            }
        } else if (operation.equals("iteratorNext")) {
            String id = request.getString("iterator");
            Snapshot snapshot = snapshots.get(id);
            if (snapshot == null || !snapshot.name.equals(name)) throw new IllegalStateException("Unknown snapshot");
            try {
                readPage(snapshot, result);
            } catch (Exception failure) {
                endSnapshot(id);
                throw failure;
            }
            if (result.optBoolean("done")) endSnapshot(id);
        } else if (operation.equals("iteratorEnd")) {
            endSnapshot(request.getString("iterator"));
        } else throw new IllegalArgumentException("Unknown operation");
        return result;
    }

    /** Aggregate resource telemetry only: never returns keys, bodies, names or credentials. */
    private JSObject diagnostics(String name) throws Exception {
        JSObject result = new JSObject();
        long now = android.os.SystemClock.elapsedRealtime();
        long oldest = 0;
        for (Snapshot snapshot : snapshots.values()) oldest = Math.max(oldest, now - snapshot.openedAtMs);
        result.put("activeSnapshots", snapshots.size());
        result.put("peakSnapshots", peakSnapshots);
        result.put("snapshotLimit", MAX_SNAPSHOTS);
        result.put("snapshotCacheKiB", SNAPSHOT_CACHE_KIB);
        result.put("oldestSnapshotMs", oldest);
        result.put("databaseWalBytes", new File(path(name) + "-wal").length());
        try (SQLiteStatement statement = database(name).prepare("PRAGMA cache_size")) {
            if (statement.step()) result.put("writerCacheSize", statement.getLong(0));
        }
        result.put("readerCacheSize", JSONObject.NULL);
        if (!snapshots.isEmpty()) {
            try (SQLiteStatement statement = snapshots.values().iterator().next().db.prepare("PRAGMA cache_size")) {
                if (statement.step()) result.put("readerCacheSize", statement.getLong(0));
            }
        }
        return result;
    }

    private void readPage(Snapshot snapshot, JSObject result) throws Exception {
        ArrayList<String> parameters = new ArrayList<>(snapshot.parameters);
        String where = snapshot.where;
        if (snapshot.last != null) {
            where += snapshot.reverse ? " AND k<?" : " AND k>?";
            parameters.add(snapshot.last);
        }
        int limit = (int) (snapshot.remaining < 0 ? 128 : Math.min(128, snapshot.remaining));
        JSONArray rows = new JSONArray();
        int bytes = 0;
        boolean exhausted = false;
        try (SQLiteStatement cursor = snapshot.db.prepare("SELECT k" + (snapshot.values ? ",v" : "") + " FROM kv WHERE " + where
                + " ORDER BY k " + (snapshot.reverse ? "DESC" : "ASC") + " LIMIT " + (limit + 1))) {
            for (int index = 0; index < parameters.size(); index++) cursor.bindText(index + 1, parameters.get(index));
            while (true) {
                if (!cursor.step()) { exhausted = true; break; }
                // Look ahead without consuming the next page's first row.
                // A full page alone cannot tell us whether the range ended.
                if (rows.length() >= limit) break;
                JSONObject row = new JSONObject();
                snapshot.last = cursor.getText(0);
                row.put("key", snapshot.last);
                if (snapshot.values) {
                    String value = Base64.encodeToString(cursor.getBlob(1), Base64.NO_WRAP);
                    bytes += value.length();
                    row.put("value", value);
                }
                rows.put(row);
                if (snapshot.remaining > 0) snapshot.remaining--;
                if (bytes >= 1024 * 1024) break;
            }
        }
        result.put("rows", rows);
        result.put("done", exhausted || snapshot.remaining == 0);
    }

    private void endSnapshot(String id) {
        Snapshot snapshot = snapshots.remove(id);
        if (snapshot != null) {
            try { sql(snapshot.db, "ROLLBACK"); } finally { snapshot.db.close(); }
        }
    }

    /**
     * The shell page restarted in a new renderer (ShellRenderRecovery). What the
     * dead page opened is closed, queued ahead of anything the new page sends,
     * so its own open does not find the database already open.
     */
    void shellRestarted() {
        worker.execute(this::closeAll);
    }

    private void closeAll() {
        for (String id : new ArrayList<>(snapshots.keySet())) endSnapshot(id);
        for (SQLiteConnection db : databases.values()) db.close();
        databases.clear();
    }

    @Override
    protected void handleOnDestroy() {
        worker.execute(this::closeAll);
        worker.shutdown();
    }
}
