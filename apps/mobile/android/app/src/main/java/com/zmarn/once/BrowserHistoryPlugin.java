package com.zmarn.once;

import androidx.sqlite.SQLiteConnection;
import androidx.sqlite.SQLiteStatement;
import androidx.sqlite.driver.bundled.BundledSQLiteDriver;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Dedicated, device-local history; serial worker keeps SQL off the browser UI. */
@CapacitorPlugin(name = "BrowserHistory")
public class BrowserHistoryPlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private SQLiteConnection database;

    private SQLiteConnection database() {
        if (database == null) {
            File file = new File(getContext().getNoBackupFilesDir(), "browser-history.sqlite");
            database = new BundledSQLiteDriver().open(file.getAbsolutePath());
            sql("PRAGMA journal_mode=WAL");
            sql("PRAGMA synchronous=FULL");
            sql("PRAGMA busy_timeout=5000");
            sql("PRAGMA secure_delete=ON");
        }
        return database;
    }

    private void sql(String sql) {
        try (SQLiteStatement statement = database.prepare(sql)) { statement.step(); }
    }

    @PluginMethod
    public void execute(PluginCall call) {
        worker.execute(() -> {
            try {
                SQLiteConnection db = database();
                JSObject result = new JSObject();
                JSONArray batch = call.getData().optJSONArray("statements");
                if (batch != null) {
                    sql("BEGIN IMMEDIATE");
                    boolean deleted = false;
                    try {
                        for (int index = 0; index < batch.length(); index++) {
                            JSONObject statement = batch.getJSONObject(index);
                            deleted |= statement.getString("sql").startsWith("DELETE");
                            run(db, statement);
                        }
                        sql("COMMIT");
                    } catch (Exception failure) { sql("ROLLBACK"); throw failure; }
                    // Release deleted content from the WAL after a clear or removal.
                    if (deleted) sql("PRAGMA wal_checkpoint(TRUNCATE)");
                } else {
                    result.put("rows", run(db, call.getData().getJSONObject("statement")));
                }
                call.resolve(result);
            } catch (Exception failure) { call.reject("History storage failed", failure); }
        });
    }

    @Override
    protected void handleOnDestroy() {
        worker.execute(() -> { if (database != null) database.close(); database = null; });
        worker.shutdown();
    }

    private JSONArray run(SQLiteConnection db, JSONObject request) throws Exception {
        JSONArray rows = new JSONArray();
        try (SQLiteStatement statement = db.prepare(request.getString("sql"))) {
            JSONArray params = request.optJSONArray("params");
            if (params != null) for (int index = 0; index < params.length(); index++) {
                Object value = params.get(index);
                if (value instanceof Number) statement.bindLong(index + 1, ((Number) value).longValue());
                else statement.bindText(index + 1, value.toString());
            }
            while (statement.step()) {
                JSONObject row = new JSONObject();
                for (int column = 0; column < statement.getColumnCount(); column++) {
                    String name = statement.getColumnName(column);
                    row.put(name, name.equals("visitedAt") ? statement.getLong(column) : statement.getText(column));
                }
                rows.put(row);
            }
        }
        return rows;
    }
}
