package com.zmarn.once;

import android.content.Context;
import android.app.ActivityManager;
import android.os.Process;
import android.util.Log;
import android.content.pm.ApplicationInfo;
import java.util.ArrayList;
import java.util.List;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.WebExtension;

/** Process-owned engine; activity-owned delegates are attached by the current host. */
final class GeckoEngine {
    static final String BRIDGE_ID = "once-surface@zmarn.com";
    private static GeckoEngine instance;
    final GeckoRuntime runtime;
    private final Context context;
    private GeckoResult<List<WebExtension>> ready;

    static synchronized GeckoEngine get(Context context) {
        if (instance == null) instance = new GeckoEngine(context.getApplicationContext());
        return instance;
    }

    private GeckoEngine(Context context) {
        this.context = context;
        runtime = GeckoRuntime.create(context, new GeckoRuntimeSettings.Builder()
            .remoteDebuggingEnabled((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0)
            // Avoid per-site subframe process fan-out on memory-constrained
            // devices. Content processes can still be shared between sessions.
            .fissionEnabled(false)
            .build());
    }

    GeckoResult<List<WebExtension>> ready() {
        if (ready != null) return ready;
        List<GeckoResult<WebExtension>> installs = new ArrayList<>();
        String[][] bundles = {
            { "once-surface", BRIDGE_ID },
            { "ublock-origin", "uBlock0@raymondhill.net" },
            { "violentmonkey", "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}" }
        };
        for (String[] bundle : bundles) {
            installs.add(runtime.getWebExtensionController().ensureBuiltIn(
                "resource://android/assets/" + bundle[0] + "/", bundle[1]));
        }
        ready = GeckoResult.allOf(installs).then(ignored -> runtime.getWebExtensionController().list());
        ready.accept(ignored -> {}, error -> ready = null);
        return ready;
    }

    static boolean bundled(String id) {
        return BRIDGE_ID.equals(id) || "uBlock0@raymondhill.net".equals(id) ||
            "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}".equals(id);
    }

    /**
     * Last resort for an unresponsive content pool. GeckoView exposes no public
     * session-to-PID API. Content processes may be shared, so this deliberately
     * resets this app's entire tab pool; GPU, parent and crash helper stay alive.
     * Call before creating replacement sessions, on the UI thread.
     */
    private List<Integer> terminateContentProcesses() {
        ActivityManager manager = (ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        List<ActivityManager.RunningAppProcessInfo> processes = manager.getRunningAppProcesses();
        List<Integer> killed = new ArrayList<>();
        if (processes == null) return killed;
        String prefix = context.getPackageName() + ":tab";
        for (ActivityManager.RunningAppProcessInfo process : processes) {
            if (process.uid != Process.myUid() || process.pid == Process.myPid() ||
                process.processName == null || !process.processName.startsWith(prefix)) continue;
            // Only Gecko's numbered tab services, including ART-image suffixes.
            String suffix = process.processName.substring(prefix.length());
            if (!suffix.matches("(?:_disable_art_image_)?[0-9]+")) continue;
            // Do not interrupt a service while Gecko is still binding/starting
            // its preallocated process. It has no page event loop to be hung.
            if (!hasContentThread(process.pid)) continue;
            Log.w("OnceSurface", "Resetting unresponsive content process " + process.pid);
            Process.killProcess(process.pid);
            killed.add(process.pid);
        }
        return killed;
    }

    private final android.os.Handler recoveryHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final List<java.util.function.Consumer<Boolean>> resetWaiters = new ArrayList<>();

    void resetContentPool(java.util.function.Consumer<Boolean> complete) {
        resetWaiters.add(complete);
        if (resetWaiters.size() > 1) return;
        List<Integer> killed = terminateContentProcesses();
        awaitContentExit(killed, android.os.SystemClock.elapsedRealtime() + 3000);
    }

    private void awaitContentExit(List<Integer> killed, long deadline) {
        boolean alive = false;
        for (int pid : killed) if (new java.io.File("/proc/" + pid).exists()) alive = true;
        if (alive && android.os.SystemClock.elapsedRealtime() < deadline) {
            recoveryHandler.postDelayed(() -> awaitContentExit(killed, deadline), 100);
            return;
        }
        final boolean stopped = !alive;
        // OS death and Gecko's child-disconnection notification are asynchronous.
        // Allow its queued teardown to run before a new session can reuse the pool.
        recoveryHandler.postDelayed(() -> {
            List<java.util.function.Consumer<Boolean>> callbacks = new ArrayList<>(resetWaiters);
            resetWaiters.clear();
            for (java.util.function.Consumer<Boolean> callback : callbacks) callback.accept(stopped);
        }, 500);
    }

    static boolean hasContentThread(int pid) {
        java.io.File[] threads = new java.io.File("/proc/" + pid + "/task").listFiles();
        if (threads == null) return false;
        for (java.io.File thread : threads) {
            try (java.io.BufferedReader name = new java.io.BufferedReader(new java.io.FileReader(new java.io.File(thread, "comm")))) {
                if ("Web Content".equals(name.readLine())) return true;
            } catch (java.io.IOException ignored) { /* A thread exited during the snapshot. */ }
        }
        return false;
    }
}
