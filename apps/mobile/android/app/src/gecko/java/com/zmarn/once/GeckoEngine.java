package com.zmarn.once;

import android.content.Context;
import android.app.ActivityManager;
import android.os.Process;
import android.util.Log;
import java.util.ArrayList;
import java.util.List;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.WebExtension;

/** Process-owned engine; activity-owned delegates are attached by the current host. */
final class GeckoEngine {
    static final String BRIDGE_ID = "once-surface@zmarn.com";
    static final String VIOLENTMONKEY_ID = "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}";
    private static GeckoEngine instance;
    final GeckoRuntime runtime;
    private final Context context;
    private GeckoResult<List<WebExtension>> ready;
    private boolean prepared;

    static synchronized GeckoEngine get(Context context) {
        if (instance == null) instance = new GeckoEngine(context.getApplicationContext());
        return instance;
    }

    /** The engine if a page already started it; null otherwise. */
    static synchronized GeckoEngine started() {
        return instance;
    }

    /** Whether a running engine has delivered its startup catalog; false while it starts or before it exists. */
    static synchronized boolean isPrepared() {
        return instance != null && instance.prepared;
    }

    private GeckoEngine(Context context) {
        this.context = context;
        GeckoRuntimeSettings.Builder settings = new GeckoRuntimeSettings.Builder()
            .remoteDebuggingEnabled(WebInspectorPlugin.allowed(context))
            // Avoid per-site subframe process fan-out on memory-constrained
            // devices. Content processes can still be shared between sessions.
            .fissionEnabled(false)
            // Gecko's default keeps extensions in the parent process. The built-in
            // ones hold <all_urls>, webRequestBlocking and native messaging, so
            // they run in their own process, as Firefox for Android runs them.
            .extensionsProcessEnabled(true);
        String config = writeConfig(context);
        if (config != null) settings.configFilePath(config);
        runtime = GeckoRuntime.create(context, settings.build());
    }

    /**
     * Prefs GeckoView has no setting for, written where Gecko reads them at startup:
     * a spare content process kept warm costs about 60 MB, and the language
     * detector behind Translations, which the app never offers, about 17 MB.
     */
    private static final String CONFIG = "prefs:\n" +
        "  dom.ipc.processPrelaunch.enabled: false\n" +
        "  browser.translations.enable: false\n";

    /**
     * A debuggable build, or the current debug app, otherwise reads
     * /data/local/tmp/<package>-geckoview-config.yaml; when one is present it keeps
     * precedence, whole, so debugging setups behave as before.
     */
    private static String writeConfig(Context context) {
        boolean debuggable = (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0 ||
            context.getPackageName().equals(android.provider.Settings.Global.getString(context.getContentResolver(), android.provider.Settings.Global.DEBUG_APP));
        if (debuggable && new java.io.File("/data/local/tmp/" + context.getPackageName() + "-geckoview-config.yaml").exists()) return null;
        java.io.File file = new java.io.File(context.getFilesDir(), "geckoview-config.yaml");
        try (java.io.FileOutputStream out = new java.io.FileOutputStream(file)) {
            out.write(CONFIG.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            return file.getAbsolutePath();
        } catch (java.io.IOException error) {
            Log.w("OnceSurface", "Unable to write the Gecko configuration", error);
            return null;
        }
    }

    GeckoResult<List<WebExtension>> ready() {
        if (ready != null) return ready;
        List<GeckoResult<WebExtension>> installs = new ArrayList<>();
        String[][] bundles = {
            { "once-surface", BRIDGE_ID },
            { "android/ublock-origin", "uBlock0@raymondhill.net" },
            // The Android copy, which carries the relay for synced userscripts.
            { "android/violentmonkey", VIOLENTMONKEY_ID }
        };
        for (String[] bundle : bundles) {
            installs.add(runtime.getWebExtensionController().ensureBuiltIn(
                "resource://android/assets/" + bundle[0] + "/", bundle[1]));
        }
        ready = GeckoResult.allOf(installs).then(ignored -> runtime.getWebExtensionController().list());
        ready.accept(installed -> { prepared = true; ViolentmonkeyRelayPlugin.attach(installed); }, error -> ready = null);
        return ready;
    }

    /** Share the startup catalog; later queries observe installs and toggles. */
    GeckoResult<List<WebExtension>> catalog() {
        return prepared ? runtime.getWebExtensionController().list() : ready();
    }

    static boolean bundled(String id) {
        return BRIDGE_ID.equals(id) || "uBlock0@raymondhill.net".equals(id) ||
            VIOLENTMONKEY_ID.equals(id);
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
        for (ActivityManager.RunningAppProcessInfo process : processes) {
            if (process.uid != Process.myUid() || process.pid == Process.myPid() ||
                !isContentProcess(context, process.processName)) continue;
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

    /**
     * Gecko's numbered tab services, including ART-image suffixes: `:tab_N` up to
     * GeckoView 158, `:sandboxed_tab_N` from 159 (a name OEM memory cleaners skip).
     */
    static boolean isContentProcess(Context context, String processName) {
        if (processName == null) return false;
        String prefix = context.getPackageName() + ":";
        if (!processName.startsWith(prefix)) return false;
        return processName.substring(prefix.length()).matches("(?:sandboxed_)?tab(?:_disable_art_image_)?[0-9]+");
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
