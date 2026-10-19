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
 * state. Without a usable DevTools connection the runtime still starts, but
 * reports its extensions as limited (Tier 2 of docs/plans/once-lite-plan.md).
 */
public final class LiteExtensionEngine {
    private static final String TAG = BrokerChannel.TAG;
    public static final String DEVTOOLS_UNAVAILABLE = "Extensions limited: DevTools unavailable";
    static final String UBLOCK_ID = "uBlock0@raymondhill.net";
    static final String VIOLENTMONKEY_ID = "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}";
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
    private final LiteTargets targets;
    private final BrokerView broker;
    private final DevToolsClient devtools;
    private final LiteTargets.Attachment brokerAttachment;
    public final String token;
    private final String[] bridgeSources = new String[2];
    private final Map<String, LitePage> pages = new LinkedHashMap<>();
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

    /** The process's engine, created on first use (main thread). */
    public static synchronized LiteExtensionEngine get(Context context) {
        if (current == null || current.destroyed) current = new LiteExtensionEngine(context);
        return current;
    }

    public static LiteExtensionEngine current() { return current; }

    private LiteExtensionEngine(Context context) {
        this.context = context.getApplicationContext();
        token = newToken();
        files = new LiteFiles(this.context);
        hidden = new FrameLayout(this.context);
        devtools = DevToolsClient.connect();
        cookies = new LiteCookies(() -> devtools, this::brokerSession);
        targets = new LiteTargets(() -> devtools, channel, cookies, () -> bridgeSources[0] == null && bridgeSources[1] == null ? null : bridgeSources);
        targets.onDevToolsConnected();
        files.register(channel);
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

    private String wrap(String bundle) { return "(function (ONCE_LITE_TOKEN) {\n" + bundle + "\n})(" + JSONObject.quote(token) + ");"; }

    private String brokerSession() {
        for (DevToolsClient.Target target : devtools.targets()) {
            if (target.url != null && target.url.startsWith(BrokerView.RUNTIME_URL)) return target.sessionId;
        }
        return null;
    }

    public LiteTargets targets() { return targets; }
    public boolean devtoolsAvailable() { return devtools.available(); }
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
        channel.onEvent("violentmonkey.connected", params -> { if (listener != null) listener.violentmonkeyConnected(); });
        channel.onEvent("violentmonkey.dashboardChanged", params -> { if (listener != null) listener.violentmonkeyDashboardChanged(); });
        channel.onEvent("log", params -> {
            String level = params.optString("level");
            Log.println("error".equals(level) ? Log.ERROR : "warn".equals(level) ? Log.WARN : Log.INFO, "OnceLiteBroker", params.optString("message"));
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
            LitePage page = pages.get(params.optString("pageId"));
            if (page != null) page.post(params.optInt("frameId"), params.opt("message"));
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
        long deadline = System.currentTimeMillis() + DEVTOOLS_WAIT_MS;
        Runnable[] poll = new Runnable[1];
        poll[0] = () -> {
            boolean settled = devtools.whenConnected().isDone() && (!devtools.isConnected() || devtools.fetchSupported() != null);
            if (settled || System.currentTimeMillis() >= deadline) start(); else main.postDelayed(poll[0], 100);
        };
        poll[0].run();
    }

    private void start() {
        JSONObject params = new JSONObject();
        try {
            JSONArray bundled = new JSONArray();
            for (String[] bundle : new String[][] { { UBLOCK_ID, "asset:extensions/ublock-origin" }, { VIOLENTMONKEY_ID, "asset:extensions/violentmonkey" } }) {
                bundled.put(new JSONObject().put("id", bundle[0]).put("directory", bundle[1]).put("present", files.assetExists(bundle[1], "manifest.json")));
            }
            params.put("bundled", bundled).put("locale", Locale.getDefault().toLanguageTag()).put("arch", arch())
                .put("token", token).put("storageRoot", files.storageRoot.getAbsolutePath()).put("devtools", devtools.available());
        } catch (Exception error) { Log.e(TAG, "Could not describe the start", error); return; }
        Log.i(TAG, "starting the broker (devtools=" + devtools.available() + ")");
        channel.request("lite.start", params).whenComplete((result, error) -> main.post(() -> {
            if (error != null) { Log.e(TAG, "The broker did not start: " + error.getMessage()); releaseStartWaiters(); return; }
            started = true;
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
        for (LitePage page : new ArrayList<>(pages.values())) closePage(page);
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

    /** The shell's `extensionCommand`; `list` carries the Tier 2 reason when DevTools is unavailable. */
    public CompletableFuture<JSONObject> command(JSONObject params) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        channel.request("extension.command", params).whenComplete((answer, error) -> {
            if (error != null) { result.completeExceptionally(error); return; }
            JSONArray extensions = answer.optJSONArray("extensions");
            if (extensions != null) { catalogue = extensions; markLimited(extensions); }
            result.complete(answer);
        });
        return result;
    }

    private void markLimited(JSONArray extensions) {
        if (devtools.available()) return;
        for (int index = 0; index < extensions.length(); index++) {
            JSONObject entry = extensions.optJSONObject(index);
            try { if (entry != null && entry.optString("disabledReason", "").isEmpty()) entry.put("disabledReason", DEVTOOLS_UNAVAILABLE); }
            catch (Exception ignored) { /* a constant document */ }
        }
    }

    /** The shell's synced documents; pages opening now wait for the broker's acknowledgement. */
    public CompletableFuture<Void> applySettings(JSONObject settings) {
        lastSettings = settings;
        long revision = ++settingsRevision;
        return sendSettings(settings, revision);
    }

    private CompletableFuture<Void> sendSettings(JSONObject settings, long revision) {
        CompletableFuture<Void> result = new CompletableFuture<>();
        channel.request("settings.apply", settings).whenComplete((answer, error) -> main.post(() -> {
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

    public void tabRemoved(int tabId) {
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
        files.close();
        synchronized (LiteExtensionEngine.class) { if (current == this) current = null; }
    }
}
