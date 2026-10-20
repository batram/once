package com.zmarn.once.lite;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import com.zmarn.once.devtools.DevToolsClient;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Once Lite's extension runtime, process-scoped like GeckoEngine: the broker
 * page (BrokerView, BrokerChannel), its files and network (LiteFiles,
 * LitePackages, LiteCookies), the DevTools fan-out (LiteTargets) and the
 * extension pages (LitePage). The activity binds for dialogs, the page
 * presenter and the tab shell; tabs register their WebViews and report their
 * state. Without a usable DevTools connection the runtime still starts in
 * Tier 2 of docs/plans/once-lite-plan.md: no extension loads, and LiteTier2
 * enforces the rules and page scripts the broker compiles.
 */
public final class LiteExtensionEngine {
    private static final String TAG = BrokerChannel.TAG;
    public static final String DEVTOOLS_UNAVAILABLE = "Extensions limited: DevTools unavailable";
    static final String UBLOCK_ID = "uBlock0@raymondhill.net";
    static final String VIOLENTMONKEY_ID = "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}";
    static final String UBOLITE_ID = "uBOLite@raymondhill.net";
    static final String UBOLITE_DIRECTORY = "asset:extensions/ublock-origin-lite";
    /** `adb shell setprop debug.once.lite.devtools off` forces Tier 2 in debuggable builds (docs/DEVELOPMENT.md). */
    public static final String DEVTOOLS_PROPERTY = "debug.once.lite.devtools";
    private static final long DEVTOOLS_WAIT_MS = 4000;
    private static final long SETTINGS_TIMEOUT_MS = 15000;
    private static LiteExtensionEngine current;

    /** The reading tabs, as the broker's `tab.*` requests need them; the root surface plugin. */
    public interface TabShell {
        int createTab(String url, boolean active);
        void updateTab(int tabId, JSONObject params);
        void removeTab(int tabId);
        void reloadTab(int tabId);
    }

    /** Shows popups, options and other pages; background pages never reach it. */
    public interface PagePresenter {
        void opened(LitePage page);
        void closed(LitePage page);
        void statusChanged(LitePage page);
        void resized(LitePage page, int width, int height);
    }

    public interface Listener {
        void extensionsChanged();
        void violentmonkeyConnected();
        void violentmonkeyDashboardChanged();
    }

    public final BrokerChannel channel = new BrokerChannel();
    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final LiteFiles files;
    private final LitePackages packages = new LitePackages();
    private final LiteCookies cookies;
    private final LiteTier2 tier2;
    private final LiteTargets targets;
    private BrokerView broker;
    private final DevToolsClient devtools;
    private LiteTargets.Attachment brokerAttachment;
    /**
     * The broker's secret: document nonces and the keys of the synchronous
     * answers derive from it. Only the broker and the extension worlds hold
     * it; no page's main world ever does.
     */
    public final String token;
    /**
     * The event channel between Once's bridge world, the content worlds and
     * the main-world helper. A page can watch the helper's events, so this
     * is no secret: the bridge world relays nothing from it but PiP requests.
     */
    private final String channelToken;
    private final String[] bridgeSources = new String[2];
    private final Map<String, LitePage> pages = new LinkedHashMap<>();
    /** Extension frames inside reading tabs, by tab id. */
    private final Map<Integer, LitePage.TabFrames> tabFrames = new HashMap<>();
    private final Map<Long, Runnable> timers = new HashMap<>();
    private final AtomicInteger tabIds = new AtomicInteger();
    private final Map<Integer, String> reportedTabs = new HashMap<>();
    private final List<Runnable> startWaiters = new ArrayList<>();
    private final List<Runnable> settingsWaiters = new ArrayList<>();
    private final FrameLayout hidden;
    private Activity activity;
    private TabShell tabShell;
    private PagePresenter presenter;
    private Listener listener;
    private boolean started;
    private boolean destroyed;
    private JSONArray catalogue = new JSONArray();
    private JSONObject lastSettings;
    private long settingsRevision;
    private long appliedRevision;
    private int settingsInFlight;
    private int settingsApplications;
    private boolean violentmonkeyConnected;
    /** Whether the running broker started without DevTools (Tier 2); settled at `lite.start`. */
    private volatile boolean tier2Mode;
    /**
     * The tier, decided at the first `lite.start` and kept for the process: a
     * DevTools connection that comes up late does not start Tier 1's
     * interception beside Tier 2, and one that drops while the broker
     * restarts does not leave a Tier 1 session in Tier 2.
     */
    private Boolean decidedTier2;

    /** The process's engine, created on first use (main thread). */
    public static synchronized LiteExtensionEngine get(Context context) {
        if (current == null || current.destroyed) current = new LiteExtensionEngine(context);
        return current;
    }

    public static LiteExtensionEngine current() { return current; }

    private LiteExtensionEngine(Context context) {
        this.context = context.getApplicationContext();
        BrokerChannel.verboseLogs = (this.context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        token = newToken();
        channelToken = newToken();
        files = new LiteFiles(this.context);
        hidden = new FrameLayout(this.context);
        devtools = devtoolsForcedOff(this.context)
            ? DevToolsClient.disabled("DevTools switched off by " + DEVTOOLS_PROPERTY)
            : DevToolsClient.connect();
        tier2 = new LiteTier2(files, packageStamp(this.context));
        cookies = new LiteCookies(() -> devtools, this::brokerSession);
        targets = new LiteTargets(() -> devtools, channel, cookies, files, () -> bridgeSources[0] == null && bridgeSources[1] == null ? null : bridgeSources);
        targets.onDevToolsConnected();
        files.register(channel);
        tier2.register(channel);
        packages.register(channel);
        cookies.register(channel);
        registerHandlers();
        broker = new BrokerView(this.context, channel, files, () -> main.post(this::restartBroker));
        brokerAttachment = targets.register(broker.view, broker.marker, "broker", -1, null, null, false);
        broker.attachTo(hidden);
        readBridgeBundles();
        broker.load();
        devtools.whenConnected().whenComplete((ignored, error) -> {
            if (error != null) Log.w(TAG, "DevTools unavailable: " + error.getMessage());
            else cookies.prime();
        });
    }

    /**
     * The Tier 2 switch for testing: only a debuggable build reads it, so a
     * release build always uses DevTools when the WebView offers it.
     */
    static boolean devtoolsForcedOff(Context context) {
        if ((context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0) return false;
        try {
            Process process = new ProcessBuilder("getprop", DEVTOOLS_PROPERTY).redirectErrorStream(true).start();
            byte[] output = LiteFiles.readAll(process.getInputStream(), 256);
            process.waitFor();
            return "off".equals(new String(output, StandardCharsets.UTF_8).trim());
        } catch (Exception error) {
            return false;
        }
    }

    /** Changes with every install of the APK, so caches of its assets follow it. */
    private static String packageStamp(Context context) {
        try {
            android.content.pm.PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.lastUpdateTime + ":" + info.versionName;
        } catch (Exception error) {
            return "unknown";
        }
    }

    private static String newToken() {
        byte[] bytes = new byte[24];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format(Locale.ROOT, "%02x", b));
        return hex.toString();
    }

    private void readBridgeBundles() {
        byte[] bridge = files.asset("public/lite-bridge-world.js");
        byte[] pip = files.asset("public/lite-pip-main.js");
        bridgeSources[0] = bridge == null ? null : wrap(new String(bridge, StandardCharsets.UTF_8));
        bridgeSources[1] = pip == null ? null : wrap(new String(pip, StandardCharsets.UTF_8));
        if (bridge == null || pip == null) Log.w(TAG, "Bridge bundles missing from the web assets; page features are limited");
    }

    private String wrap(String bundle) { return "(function (ONCE_LITE_TOKEN) {\n" + bundle + "\n})(" + JSONObject.quote(channelToken) + ");"; }

    /** The broker page's DevTools session, for commands the browser target does not take (`Network.*`). */
    private String brokerSession() {
        LiteTargets.Attachment attachment = brokerAttachment;
        DevToolsClient.Target bound = attachment == null ? null : attachment.target;
        if (bound != null) return bound.sessionId;
        for (DevToolsClient.Target target : devtools.targets()) {
            if (target.url != null && target.url.startsWith(BrokerView.RUNTIME_URL)) return target.sessionId;
        }
        return null;
    }

    public LiteTargets targets() { return targets; }
    public boolean devtoolsAvailable() { return devtools.available(); }
    /** True once the broker started without DevTools: Java enforces the rules and page scripts it compiled. */
    public boolean tier2Active() { return tier2Mode; }
    public LiteTier2 tier2() { return tier2; }
    public boolean isStarted() { return started; }
    public int nextTabId() { return tabIds.incrementAndGet(); }

    /** The activity the runtime shows dialogs and pages in; the broker's dot joins its view tree. */
    public void bind(Activity activity, ViewGroup parent, TabShell tabShell, PagePresenter presenter, Listener listener) {
        this.activity = activity;
        this.tabShell = tabShell;
        this.presenter = presenter;
        this.listener = listener;
        if (hidden.getParent() != parent) {
            if (hidden.getParent() != null) ((ViewGroup) hidden.getParent()).removeView(hidden);
            parent.addView(hidden, 0, new ViewGroup.LayoutParams(1, 1));
        }
        for (LitePage page : pages.values()) if (!page.isBackground()) presenter.opened(page);
    }

    public void unbind(Activity activity) {
        if (this.activity != activity) return;
        this.activity = null;
        tabShell = null;
        presenter = null;
        listener = null;
        for (LitePage page : new ArrayList<>(pages.values())) if (!page.isBackground()) closePage(page);
        if (hidden.getParent() != null) ((ViewGroup) hidden.getParent()).removeView(hidden);
    }

    private void registerHandlers() {
        channel.onEvent("broker.hello", params -> onHello());
        channel.onEvent("extensions.changed", params -> { if (listener != null) listener.extensionsChanged(); });
        channel.onEvent("violentmonkey.connected", params -> { violentmonkeyConnected = true; if (listener != null) listener.violentmonkeyConnected(); });
        channel.onEvent("violentmonkey.dashboardChanged", params -> { if (listener != null) listener.violentmonkeyDashboardChanged(); });
        channel.onEvent("log", params -> {
            String level = params.optString("level");
            Log.println("error".equals(level) ? Log.ERROR : "warn".equals(level) ? Log.WARN : Log.INFO, "OnceLiteBroker", BrokerChannel.forLog(params.optString("message")));
        });
        channel.onEvent("timer.set", params -> {
            long id = params.optLong("timerId");
            Runnable fire = () -> {
                timers.remove(id);
                try { channel.event("timer.fired", new JSONObject().put("timerId", id)); } catch (Exception ignored) { /* a constant document */ }
            };
            Runnable previous = timers.put(id, fire);
            if (previous != null) main.removeCallbacks(previous);
            main.postDelayed(fire, Math.max(0, params.optLong("delayMs")));
        });
        channel.onEvent("timer.clear", params -> {
            Runnable fire = timers.remove(params.optLong("timerId"));
            if (fire != null) main.removeCallbacks(fire);
        });
        channel.onRequest("ui.confirm", (params, reply) -> confirm(params, reply));
        // The surface plugin runs the document picker itself and sends the file with the command.
        channel.onRequest("ui.pickFile", (params, reply) -> reply.resolve(new JSONObject()));
        channel.onRequest("page.open", (params, reply) -> { openPage(params); reply.resolve(null); });
        channel.onRequest("page.close", (params, reply) -> {
            LitePage page = pages.get(params.optString("pageId"));
            if (page != null) closePage(page);
            reply.resolve(null);
        });
        channel.onRequest("page.post", (params, reply) -> {
            String pageId = params.optString("pageId");
            LitePage page = pages.get(pageId);
            if (page != null) page.post(params.optInt("frameId"), params.opt("message"));
            else if (pageId.startsWith("tab:")) {
                LitePage.TabFrames frames;
                try { frames = tabFrames.get(Integer.parseInt(pageId.substring(4))); } catch (NumberFormatException error) { frames = null; }
                if (frames != null) frames.post(params.optInt("frameId"), params.opt("message"));
            }
            reply.resolve(null);
        });
        channel.onRequest("page.resize", (params, reply) -> {
            LitePage page = pages.get(params.optString("pageId"));
            if (page != null && presenter != null) presenter.resized(page, params.optInt("width"), params.optInt("height"));
            reply.resolve(null);
        });
        channel.onRequest("tab.create", (params, reply) -> {
            if (tabShell == null) { reply.reject("No browser surface"); return; }
            reply.resolve(new JSONObject().put("tabId", tabShell.createTab(params.optString("url", "about:blank"), params.optBoolean("active", true))));
        });
        channel.onRequest("tab.update", (params, reply) -> { if (tabShell != null) tabShell.updateTab(params.optInt("tabId"), params); reply.resolve(null); });
        channel.onRequest("tab.remove", (params, reply) -> { if (tabShell != null) tabShell.removeTab(params.optInt("tabId")); reply.resolve(null); });
        channel.onRequest("tab.reload", (params, reply) -> { if (tabShell != null) tabShell.reloadTab(params.optInt("tabId")); reply.resolve(null); });
    }

    private void confirm(JSONObject params, BrokerChannel.Reply reply) {
        if (activity == null || activity.isFinishing()) { reply.resolve(answer(false)); return; }
        String detail = params.optString("detail", "");
        new AlertDialog.Builder(activity)
            .setTitle(params.optString("title", "Once"))
            .setMessage(params.optString("message", "") + (detail.isEmpty() ? "" : "\n\n" + detail))
            .setPositiveButton(params.optString("confirmLabel", "OK"), (dialog, which) -> reply.resolve(answer(true)))
            .setNegativeButton(params.optString("cancelLabel", "Cancel"), (dialog, which) -> reply.resolve(answer(false)))
            .setOnCancelListener(dialog -> reply.resolve(answer(false)))
            .show();
    }

    private static JSONObject answer(boolean confirmed) {
        try { return new JSONObject().put("confirmed", confirmed); } catch (Exception error) { return new JSONObject(); }
    }

    /** The broker page is up: `lite.start` once DevTools has settled, bounded. */
    private void onHello() {
        started = false;
        files.forgetStreams();
        long deadline = System.currentTimeMillis() + DEVTOOLS_WAIT_MS;
        Runnable[] poll = new Runnable[1];
        poll[0] = () -> {
            boolean settled = devtools.whenConnected().isDone() && (!devtools.isConnected() || devtools.fetchSupported() != null);
            if (settled || System.currentTimeMillis() >= deadline) start(); else main.postDelayed(poll[0], 100);
        };
        poll[0].run();
    }

    private void start() {
        violentmonkeyConnected = false;
        if (decidedTier2 == null) decidedTier2 = !devtools.available();
        boolean useDevtools = !decidedTier2;
        JSONObject params = new JSONObject();
        try {
            JSONArray bundled = new JSONArray();
            for (String[] bundle : new String[][] { { UBLOCK_ID, "asset:extensions/ublock-origin" }, { VIOLENTMONKEY_ID, "asset:extensions/violentmonkey" } }) {
                bundled.put(new JSONObject().put("id", bundle[0]).put("directory", bundle[1]).put("present", files.assetExists(bundle[1], "manifest.json")));
            }
            params.put("bundled", bundled).put("locale", Locale.getDefault().toLanguageTag()).put("arch", arch())
                .put("token", token).put("channel", channelToken).put("storageRoot", files.storageRoot.getAbsolutePath()).put("devtools", useDevtools)
                .put("ubolite", new JSONObject().put("id", UBOLITE_ID).put("directory", UBOLITE_DIRECTORY)
                    .put("present", files.assetExists(UBOLITE_DIRECTORY, "manifest.json")));
        } catch (Exception error) { Log.e(TAG, "Could not describe the start", error); return; }
        tier2Mode = !useDevtools;
        // Nothing uses the DevTools socket in Tier 2 (the bridge world needs Tier 1's targets too):
        // a release build closes it again, so nothing on the device can attach to the app's pages.
        // (Unless the user turned the Web Inspector on in the error log: WebInspectorPlugin's own preference.)
        if (tier2Mode && (context.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) == 0
            && !context.getSharedPreferences("once_web_inspector", Context.MODE_PRIVATE).getBoolean("enabled", false)) {
            android.webkit.WebView.setWebContentsDebuggingEnabled(false);
        }
        // Tier 2 enforces in Java alone: no target is bound or intercepted, even if DevTools connects later.
        targets.setPassive(tier2Mode);
        Log.i(TAG, "starting the broker (devtools=" + useDevtools + ")");
        channel.request("lite.start", params).whenComplete((result, error) -> main.post(() -> {
            if (error != null) { Log.e(TAG, "The broker did not start: " + error.getMessage()); releaseStartWaiters(); return; }
            started = true;
            targets.brokerReady();
            JSONArray extensions = result.optJSONArray("extensions");
            catalogue = extensions == null ? new JSONArray() : extensions;
            Log.i(TAG, "broker started with " + catalogue.length() + " extensions");
            if (lastSettings != null) sendSettings(lastSettings, settingsRevision);
            releaseStartWaiters();
            if (listener != null) listener.extensionsChanged();
        }));
    }

    private void releaseStartWaiters() {
        for (Runnable waiter : new ArrayList<>(startWaiters)) { main.removeCallbacks(waiter); waiter.run(); }
    }

    private static String arch() {
        String abi = Build.SUPPORTED_ABIS.length == 0 ? "" : Build.SUPPORTED_ABIS[0];
        if (abi.startsWith("arm64")) return "arm64";
        if (abi.startsWith("arm")) return "arm";
        if (abi.contains("64")) return "x86-64";
        return "x86";
    }

    /** The broker renderer was lost: its page restarts and says hello again; open pages are stale. */
    private void restartBroker() {
        started = false;
        if (destroyed) return;
        for (LitePage page : new ArrayList<>(pages.values())) closePage(page);
        targets.unregister(brokerAttachment);
        broker.destroy();
        targets.resetBroker();
        for (Runnable fire : timers.values()) main.removeCallbacks(fire);
        timers.clear();
        broker = new BrokerView(context, channel, files, () -> main.post(this::restartBroker));
        brokerAttachment = targets.register(broker.view, broker.marker, "broker", -1, null, null, false);
        broker.attachTo(hidden);
        broker.load();
    }

    /** Runs `work` on the main thread once the broker answered `lite.start`, or after `timeoutMs`. */
    public void whenStarted(long timeoutMs, Runnable work) {
        main.post(() -> {
            if (started) { work.run(); return; }
            Runnable once = new Runnable() {
                private boolean done;
                @Override public void run() { if (done) return; done = true; startWaiters.remove(this); work.run(); }
            };
            startWaiters.add(once);
            main.postDelayed(once, timeoutMs);
        });
    }

    /** The shell's `extensionCommand`; in Tier 2 the broker lists the full extensions as limited. */
    public CompletableFuture<JSONObject> command(JSONObject params) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        channel.request("extension.command", params).whenComplete((answer, error) -> {
            if (error != null) { result.completeExceptionally(error); return; }
            JSONArray extensions = answer.optJSONArray("extensions");
            if (extensions != null) catalogue = extensions;
            result.complete(answer);
        });
        return result;
    }

    /** `declarativeNetRequest.updateSessionRules` for uBO Lite in Tier 2 (instrumentation tests). */
    public CompletableFuture<JSONObject> sessionRules(JSONObject params) {
        return channel.request("net.sessionRules", params);
    }

    /** The shell's synced documents; pages opening now wait for the broker's acknowledgement. */
    public CompletableFuture<Void> applySettings(JSONObject settings) {
        lastSettings = settings;
        long revision = ++settingsRevision;
        return sendSettings(settings, revision);
    }

    /** Whether Violentmonkey's background has started listening since the broker started. */
    public boolean isViolentmonkeyConnected() { return violentmonkeyConnected; }

    /** Settings applications the broker has not acknowledged yet (tests wait for the shell's own). */
    public int settingsInFlight() { return settingsInFlight; }

    /** How many settings applications were sent since the engine started. */
    public int settingsApplications() { return settingsApplications; }

    private CompletableFuture<Void> sendSettings(JSONObject settings, long revision) {
        CompletableFuture<Void> result = new CompletableFuture<>();
        settingsInFlight++;
        settingsApplications++;
        JSONObject lists = settings.optJSONObject("filterLists");
        Log.i(TAG, "applying extension settings #" + settingsApplications + ": " + (lists == null || lists.optJSONArray("lists") == null ? "?" : lists.optJSONArray("lists").length()) + " filter lists");
        long sentAt = System.currentTimeMillis();
        channel.request("settings.apply", settings).whenComplete((answer, error) -> main.post(() -> {
            settingsInFlight--;
            Log.i(TAG, "extension settings " + (error == null ? "applied" : "failed") + " after " + (System.currentTimeMillis() - sentAt) + " ms");
            if (error != null) { Log.w(TAG, "Extension settings were not applied: " + error.getMessage()); result.completeExceptionally(error); }
            else result.complete(null);
            appliedRevision = Math.max(appliedRevision, revision);
            for (Runnable waiter : new ArrayList<>(settingsWaiters)) { main.removeCallbacks(waiter); waiter.run(); }
        }));
        return result;
    }

    /** Bounded: an unreachable filter list host must not keep every page from opening. */
    public void whenSettingsApplied(Runnable work) {
        main.post(() -> {
            if (lastSettings == null || appliedRevision >= settingsRevision) { work.run(); return; }
            Runnable once = new Runnable() {
                private boolean done;
                @Override public void run() { if (done) return; done = true; settingsWaiters.remove(this); work.run(); }
            };
            settingsWaiters.add(once);
            main.postDelayed(once, SETTINGS_TIMEOUT_MS);
        });
    }

    public CompletableFuture<JSONObject> violentmonkey(String method, JSONObject params) {
        return channel.request("violentmonkey." + method, params);
    }

    // Tabs: the surface reports every reading WebView; identical states are not repeated.

    public void reportTab(int tabId, JSONObject state) {
        String text = state.toString();
        if (text.equals(reportedTabs.put(tabId, text))) return;
        channel.event("tab.changed", state);
    }

    /** The page channel for extension frames on a tab's (new) WebView; main thread. */
    public void listenInTab(android.webkit.WebView view, int tabId) {
        LitePage.TabFrames frames = tabFrames.get(tabId);
        if (frames == null) tabFrames.put(tabId, frames = new LitePage.TabFrames());
        LitePage.listenInTab(view, channel, tabId, frames);
    }

    /** The tab's WebView was replaced or closed: its extension frames are gone. */
    public void tabViewReleased(int tabId) {
        LitePage.TabFrames frames = tabFrames.get(tabId);
        if (frames == null) return;
        frames.clear();
        try { channel.event("page.closed", new JSONObject().put("pageId", "tab:" + tabId)); } catch (Exception ignored) { /* a constant document */ }
    }

    public void tabRemoved(int tabId) {
        tabFrames.remove(tabId);
        if (reportedTabs.remove(tabId) == null) return;
        try { channel.event("tab.removed", new JSONObject().put("tabId", tabId)); } catch (Exception ignored) { /* a constant document */ }
    }

    // Extension pages.

    public Collection<LitePage> pages() { return pages.values(); }

    private void openPage(JSONObject params) {
        LitePage page = new LitePage(context, channel, targets, params, new LitePage.Listener() {
            @Override public void loaded(LitePage loaded, String url) {}
            @Override public void statusChanged(LitePage changed) { if (presenter != null && !changed.isBackground()) presenter.statusChanged(changed); }
            @Override public void closeRequested(LitePage closing) { closePage(closing); }
        }, () -> activity);
        pages.put(page.pageId, page);
        if (page.isBackground()) hidden.addView(page.view, new FrameLayout.LayoutParams(1, 1));
        else if (presenter != null) presenter.opened(page);
        page.load();
    }

    public void closePage(LitePage page) {
        if (pages.remove(page.pageId) == null) return;
        if (!page.isBackground() && presenter != null) presenter.closed(page);
        targets.unregister(page.attachment);
        page.destroy();
        try { channel.event("page.closed", new JSONObject().put("pageId", page.pageId)); } catch (Exception ignored) { /* a constant document */ }
    }

    public void reloadPage(LitePage page) { page.reload(); }

    /** Ends the runtime for this process (tests restart it in-process). */
    public void destroy() {
        destroyed = true;
        for (LitePage page : new ArrayList<>(pages.values())) closePage(page);
        for (Runnable fire : timers.values()) main.removeCallbacks(fire);
        timers.clear();
        channel.disconnect("The runtime was closed");
        targets.unregister(brokerAttachment);
        broker.destroy();
        if (hidden.getParent() != null) ((ViewGroup) hidden.getParent()).removeView(hidden);
        devtools.removeListener(targets);
        targets.close();
        packages.close();
        tier2.close();
        files.close();
        synchronized (LiteExtensionEngine.class) { if (current == this) current = null; }
    }
}
