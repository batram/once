package com.zmarn.once;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Debug;
import android.os.SystemClock;
import androidx.sqlite.SQLiteConnection;
import androidx.sqlite.SQLiteStatement;
import androidx.sqlite.driver.bundled.BundledSQLiteDriver;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Opt-in synthetic resource experiment; never opens the application's databases. */
@RunWith(AndroidJUnit4.class)
public class NativeSnapshotResourcesTest {
    private final Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
    private final BundledSQLiteDriver driver = new BundledSQLiteDriver();
    private final ArrayList<SQLiteConnection> readers = new ArrayList<>();
    private File file;
    private SQLiteConnection writer;
    private int cacheKiB;

    @Test public void measureSnapshotResources() throws Exception {
        assumeTrue("Opt-in resource measurement", "true".equals(InstrumentationRegistry.getArguments().getString("snapshotResources")));
        assertTrue("Use an isolated probe profile", context.getPackageName().endsWith(".nativeprobe"));
        file = new File(context.getNoBackupFilesDir(), "snapshot-resources-" + System.nanoTime() + ".sqlite");
        cacheKiB = Integer.parseInt(InstrumentationRegistry.getArguments().getString("readerCacheKiB", "0"));
        String scenario = InstrumentationRegistry.getArguments().getString("snapshotScenario", "both");
        JSONObject report = new JSONObject();
        try {
            writer = driver.open(file.getAbsolutePath());
            sql(writer, "PRAGMA journal_mode=WAL");
            sql(writer, "PRAGMA synchronous=FULL");
            sql(writer, "PRAGMA busy_timeout=5000");
            sql(writer, "CREATE TABLE kv(k TEXT PRIMARY KEY COLLATE BINARY,v BLOB NOT NULL) WITHOUT ROWID");
            sql(writer, "BEGIN IMMEDIATE");
            try (SQLiteStatement insert = writer.prepare("INSERT INTO kv VALUES(?,?)")) {
                for (int i = 0; i < 10000; i++) {
                    insert.bindText(1, String.format("%08d", i));
                    insert.bindBlob(2, new byte[1024]);
                    insert.step();
                    insert.reset();
                }
            }
            sql(writer, "COMMIT");
            sql(writer, "PRAGMA wal_checkpoint(TRUNCATE)");
            report.put("sqliteVersion", text(writer, "SELECT sqlite_version()"));
            report.put("cacheSize", number(writer, "PRAGMA cache_size"));
            report.put("pageSize", number(writer, "PRAGMA page_size"));
            report.put("mmapSize", number(writer, "PRAGMA mmap_size"));
            report.put("databaseBytes", file.length());
            report.put("memoryClassMiB", ((ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE)).getMemoryClass());
            report.put("readerCacheKiB", cacheKiB);
            report.put("limits", new String(Files.readAllBytes(new File("/proc/self/limits").toPath()), StandardCharsets.UTF_8));
            if (!scenario.equals("full")) report.put("firstPage", sweep(false, new int[]{0, 1, 8, 16, 32, 64, 128, 256, 512}));
            if (!scenario.equals("page")) report.put("fullScan", sweep(true, new int[]{0, 1, 8, 16, 32, 64, 128}));
            JSONArray wal = new JSONArray();
            for (int count : new int[]{0, 1, 64}) wal.put(walGrowth(count));
            report.put("walGrowth", wal);
        } finally {
            closeReaders();
            if (writer != null) writer.close();
            for (String suffix : new String[]{"", "-wal", "-shm"}) new File(file + suffix).delete();
            Files.write(new File(context.getFilesDir(), "snapshot-resources.json").toPath(), report.toString(2).getBytes(StandardCharsets.UTF_8));
        }
    }

    private JSONArray sweep(boolean fullScan, int[] counts) throws Exception {
        closeReaders();
        sql(writer, "PRAGMA wal_checkpoint(TRUNCATE)");
        settle();
        JSONObject baseline = resources();
        JSONArray results = new JSONArray();
        ArrayList<Double> opens = new ArrayList<>();
        try {
            for (int count : counts) {
                while (readers.size() < count) {
                    long started = SystemClock.elapsedRealtimeNanos();
                    SQLiteConnection reader = reader();
                    readers.add(reader);
                    if (fullScan) scanPages(reader);
                    else read(reader, 128);
                    opens.add((SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0);
                }
                settle();
                JSONObject state = resources();
                state.put("readers", readers.size());
                state.put("nativeDeltaBytes", state.getLong("nativeBytes") - baseline.getLong("nativeBytes"));
                state.put("pssDeltaKiB", state.getLong("pssKiB") - baseline.getLong("pssKiB"));
                state.put("fdDelta", state.getLong("fds") - baseline.getLong("fds"));
                state.put("openAndRead", timing(opens));
                state.put("pointRead", latency(false));
                state.put("commit", latency(true));
                results.put(state);
                // This is a measurement, not an OOM test on the user's phone.
                if (state.getLong("nativeDeltaBytes") > 192L * 1024 * 1024 || state.getLong("pssDeltaKiB") > 256L * 1024) {
                    state.put("stoppedForResourceBudget", true);
                    break;
                }
            }
        } finally { closeReaders(); }
        return results;
    }

    private JSONObject walGrowth(int count) throws Exception {
        sql(writer, "PRAGMA wal_checkpoint(TRUNCATE)");
        // Make the readers pin a WAL version, then repeatedly update the same
        // row. File growth is measured with automatic checkpoints enabled.
        write(1);
        for (int i = 0; i < count; i++) readers.add(reader());
        long before = new File(file + "-wal").length();
        for (int i = 0; i < 1200; i++) write(i + 2);
        JSONObject result = new JSONObject();
        result.put("readers", count);
        result.put("walBeforeBytes", before);
        result.put("walAfterBytes", new File(file + "-wal").length());
        result.put("checkpointWithReaders", checkpoint());
        closeReaders();
        result.put("checkpointAfterClose", checkpoint());
        sql(writer, "PRAGMA wal_checkpoint(TRUNCATE)");
        result.put("walAfterTruncateBytes", new File(file + "-wal").length());
        return result;
    }

    private SQLiteConnection reader() {
        SQLiteConnection db = driver.open(file.getAbsolutePath());
        try {
            if (cacheKiB > 0) sql(db, "PRAGMA cache_size=-" + cacheKiB);
            sql(db, "PRAGMA query_only=ON");
            sql(db, "BEGIN DEFERRED");
            sql(db, "SELECT k FROM kv LIMIT 1");
            return db;
        } catch (RuntimeException error) { db.close(); throw error; }
    }

    private static void read(SQLiteConnection db, int limit) {
        try (SQLiteStatement statement = db.prepare("SELECT k,v FROM kv ORDER BY k LIMIT " + limit)) {
            while (statement.step()) { statement.getText(0); statement.getBlob(1); }
        }
    }

    private static void scanPages(SQLiteConnection db) {
        String after = "";
        int rows = 0;
        while (true) {
            int pageRows = 0;
            try (SQLiteStatement statement = db.prepare("SELECT k,v FROM kv WHERE k>? ORDER BY k LIMIT 128")) {
                statement.bindText(1, after);
                while (statement.step()) {
                    after = statement.getText(0);
                    statement.getBlob(1);
                    pageRows++;
                }
            }
            rows += pageRows;
            if (pageRows < 128) break;
        }
        assertEquals(10000, rows);
    }

    private JSONObject latency(boolean writes) throws Exception {
        ArrayList<Double> samples = new ArrayList<>();
        for (int i = 0; i < 30; i++) {
            long started = SystemClock.elapsedRealtimeNanos();
            if (writes) write(i);
            else try (SQLiteStatement statement = writer.prepare("SELECT v FROM kv WHERE k='00005000'")) {
                assertTrue(statement.step());
                assertEquals(1024, statement.getBlob(0).length);
            }
            samples.add((SystemClock.elapsedRealtimeNanos() - started) / 1_000_000.0);
        }
        return timing(samples);
    }

    private void write(int value) {
        sql(writer, "BEGIN IMMEDIATE");
        try (SQLiteStatement statement = writer.prepare("UPDATE kv SET v=? WHERE k='00000000'")) {
            byte[] bytes = new byte[1024];
            bytes[0] = (byte) value;
            statement.bindBlob(1, bytes);
            statement.step();
        }
        sql(writer, "COMMIT");
    }

    private JSONArray checkpoint() {
        JSONArray result = new JSONArray();
        try (SQLiteStatement statement = writer.prepare("PRAGMA wal_checkpoint(PASSIVE)")) {
            assertTrue(statement.step());
            for (int i = 0; i < 3; i++) result.put(statement.getLong(i));
        }
        return result;
    }

    private void closeReaders() {
        for (SQLiteConnection reader : readers) {
            try { sql(reader, "ROLLBACK"); } finally { reader.close(); }
        }
        readers.clear();
    }

    private static JSONObject resources() throws Exception {
        JSONObject result = new JSONObject();
        result.put("nativeBytes", Debug.getNativeHeapAllocatedSize());
        Debug.MemoryInfo info = new Debug.MemoryInfo();
        Debug.getMemoryInfo(info);
        result.put("pssKiB", info.getTotalPss());
        result.put("fds", new File("/proc/self/fd").list().length);
        return result;
    }

    private static JSONObject timing(ArrayList<Double> values) throws Exception {
        ArrayList<Double> sorted = new ArrayList<>(values);
        Collections.sort(sorted);
        JSONObject result = new JSONObject();
        result.put("samples", sorted.size());
        if (!sorted.isEmpty()) {
            result.put("medianMs", sorted.get(sorted.size() / 2));
            result.put("p95Ms", sorted.get(Math.min(sorted.size() - 1, (int) (sorted.size() * .95))));
        }
        return result;
    }

    private static void settle() throws Exception { System.gc(); Thread.sleep(100); }
    private static void sql(SQLiteConnection db, String query) {
        try (SQLiteStatement statement = db.prepare(query)) { statement.step(); }
    }
    private static long number(SQLiteConnection db, String query) {
        try (SQLiteStatement statement = db.prepare(query)) { assertTrue(statement.step()); return statement.getLong(0); }
    }
    private static String text(SQLiteConnection db, String query) {
        try (SQLiteStatement statement = db.prepare(query)) { assertTrue(statement.step()); return statement.getText(0); }
    }
}
