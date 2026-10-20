package com.zmarn.once;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.zmarn.once.lite.LiteBridge;
import com.zmarn.once.lite.LiteExtensionEngine;
import com.zmarn.once.lite.LitePage;
import com.zmarn.once.lite.LiteTargets;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Assume;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/**
 * Drives the real Lite extension runtime on the emulator with the bundled
 * extensions: the broker starts and lists uBlock Origin and Violentmonkey, a
 * synced filter list blocks a request and hides an element in a tab, the
 * bridge world answers a script, uBlock's popup opens on the tab, and
 * Violentmonkey's relay records survive an in-process engine restart.
 *
 *   ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedLiteDevelopmentDebugAndroidTest -PonceDeployAbis=arm64-v8a
 */
@RunWith(AndroidJUnit4.class)
public class LiteExtensionEngineTest {
    private static final String TAG = "LiteExtensionEngineTest";
    private static final String UBLOCK_ID = "uBlock0@raymondhill.net";
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    final JSONObject results = new JSONObject();
    MainActivity activity;
    Fixture fixture;
    LiteExtensionEngine engine;
    WebView tab;
    private final List<LitePage> openedPages = Collections.synchronizedList(new ArrayList<>());

    @Before
    public void start() throws Exception {
        String pkg = instrumentation.getTargetContext().getPackageName();
        assertTrue("Only the Once Lite dev package may be driven: " + pkg, pkg.endsWith(".lite.dev"));
        boolean emulator = Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish") || Build.HARDWARE.contains("cutf")
            || Build.PRODUCT.contains("sdk") || Build.FINGERPRINT.contains("emulator");
        Assume.assumeTrue("Physical-device probes require explicit allowPhysicalDevice=true", emulator ||
            "true".equals(InstrumentationRegistry.getArguments().getString("allowPhysicalDevice")));
        shell("input keyevent KEYCODE_WAKEUP");
        shell("wm dismiss-keyguard");
        activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        until("The test activity must have a laid-out window", () -> activity.getWindow().getDecorView().getWidth() > 0, 15);
        fixture = new Fixture();
        engine = bindEngine();
    }

    @After
    public void stop() throws Exception {
        JSONArray catalogue = results.optJSONArray("catalogue");
        if (catalogue != null) for (int index = 0; index < catalogue.length(); index++) catalogue.optJSONObject(index).remove("iconDataUrl");
        Log.i(TAG, "RESULTS " + results.toString());
        if (fixture != null) fixture.close();
        ui(() -> { if (tab != null) { ((ViewGroup) tab.getParent()).removeView(tab); tab.destroy(); } });
    }

    private LiteExtensionEngine bindEngine() throws Exception {
        AtomicReference<LiteExtensionEngine> created = new AtomicReference<>();
        ui(() -> {
            LiteExtensionEngine next = LiteExtensionEngine.get(activity);
            ViewGroup content = activity.findViewById(android.R.id.content);
            next.bind(activity, content, new LiteExtensionEngine.TabShell() {
                @Override public int createTab(String url, boolean active) { return -1; }
                @Override public void updateTab(int tabId, JSONObject params) {}
                @Override public void removeTab(int tabId) {}
                @Override public void reloadTab(int tabId) {}
            }, new LiteExtensionEngine.PagePresenter() {
                @Override public void opened(LitePage page) {
                    openedPages.add(page);
                    content.addView(page.view, new ViewGroup.LayoutParams(600, 800));
                }
                @Override public void closed(LitePage page) { openedPages.remove(page); }
                @Override public void statusChanged(LitePage page) {}
                @Override public void resized(LitePage page, int width, int height) {}
            }, new LiteExtensionEngine.Listener() {
                @Override public void extensionsChanged() {}
                @Override public void violentmonkeyConnected() {}
                @Override public void violentmonkeyDashboardChanged() {}
            });
            created.set(next);
        });
        LiteExtensionEngine next = created.get();
        until("The broker must start", next::isStarted, 60);
        return next;
    }

    @Test
    public void bundledExtensionsRunOnTheWebView() throws Exception {
        assertTrue("DevTools must be available on the emulator", engine.devtoolsAvailable());
        results.put("devtools", true);

        // 1. The catalogue: uBlock Origin and Violentmonkey, enabled and bundled.
        JSONArray extensions = await(engine.command(new JSONObject().put("action", "list"))).getJSONArray("extensions");
        results.put("catalogue", extensions);
        assertEquals(2, extensions.length());
        for (int index = 0; index < extensions.length(); index++) {
            JSONObject entry = extensions.getJSONObject(index);
            assertTrue(entry.optString("name"), entry.optString("name").contains("uBlock") || entry.optString("name").contains("Violentmonkey"));
            assertTrue(entry.optString("name") + " enabled", entry.optBoolean("enabled"));
            assertTrue(entry.optString("name") + " bundled", entry.optBoolean("bundled"));
            assertEquals("", entry.optString("disabledReason"));
        }

        // 2. The synced filter list is handed to uBlock, and a tab registers with its target before loading.
        // The shell in the activity applies its own (empty) synced documents at startup and again when
        // Violentmonkey connects, whenever that happens to be; ours is applied again until it is the last.
        long applyStarted = System.currentTimeMillis();
        JSONObject synced = new JSONObject()
            .put("filterLists", new JSONObject().put("version", 1).put("lists", new JSONArray().put(new JSONObject().put("url", fixture.url("/list.txt")).put("enabled", true))))
            .put("userscripts", new JSONObject().put("version", 1).put("scripts", new JSONArray()));
        for (int attempt = 0; ; attempt++) {
            int before = engine.settingsApplications();
            await(engine.applySettings(synced));
            long quiet = System.nanoTime() + TimeUnit.SECONDS.toNanos(4);
            while (System.nanoTime() < quiet && engine.settingsApplications() == before + 1) Thread.sleep(200);
            until("settings applications must settle", () -> engine.settingsInFlight() == 0, 60);
            if (engine.settingsApplications() == before + 1 || attempt >= 4) break;
            Log.i(TAG, "the shell applied its settings beside ours; applying again");
        }
        results.put("settingsApplied", true);
        results.put("settingsApplyMs", System.currentTimeMillis() - applyStarted);
        results.put("filterRecordAtOnce", filterRecord());
        results.put("listRequests", fixture.listRequests.get());
        LiteBridge bridge = new LiteBridge(new android.os.Handler(android.os.Looper.getMainLooper()), new LiteBridge.Listener() {
            @Override public void documentChanged(Object token) {}
            @Override public void documentGone(Object token) {}
            @Override public void message(JSONObject message, Object token) {}
        });
        int tabId = engine.nextTabId();
        String marker = "once-tab-" + java.util.UUID.randomUUID();
        AtomicReference<LiteTargets.Attachment> attachment = new AtomicReference<>();
        ui(() -> {
            tab = new WebView(activity);
            tab.getSettings().setJavaScriptEnabled(true);
            tab.getSettings().setDomStorageEnabled(true);
            activity.addContentView(tab, new ViewGroup.LayoutParams(600, 600));
            attachment.set(engine.targets().register(tab, marker, "tab", tabId, null, bridge, true));
            bridge.attach(attachment.get());
        });
        String pageUrl = fixture.url("/page.html");
        reportTab(tabId, pageUrl, attachment.get());
        CountDownLatch loading = new CountDownLatch(1);
        attachment.get().whenReady(10000, () -> { tab.loadUrl(pageUrl); loading.countDown(); });
        assertTrue(loading.await(15, TimeUnit.SECONDS));
        assertNotNull("the tab must have a target", attachment.get().targetId());
        reportTab(tabId, pageUrl, attachment.get());
        Thread.sleep(3000);
        results.put("ublockState", ublockState());
        results.put("filterRecord", filterRecord());
        results.put("listRequestsLater", fixture.listRequests.get());
        // The list blocks the image request and hides the element on the first load.
        untilEvaluates("document.getElementById('i').dataset.r", "\"error\"", 20);
        Thread.sleep(3000);
        results.put("worlds", worldState(attachment.get().targetId()));
        untilEvaluates("getComputedStyle(document.querySelector('.once-hide')).display", "\"none\"", 20);
        results.put("firstLoadFiltered", true);
        // 3. The bridge world answers a script through its binding (once the fixture document, not the marker, is up).
        untilEvaluates("document.title", "\"filter probe\"", 20);
        CompletableFuture<String> answered = new CompletableFuture<>();
        until("the bridge must connect", bridge::isConnected, 15);
        ui(() -> bridge.evaluate("document.title + ':' + (1 + 1)", new LiteBridge.Reply() {
            @Override public void resolve(String value) { answered.complete(value); }
            @Override public void reject(String message) { answered.completeExceptionally(new AssertionError(message)); }
        }));
        assertEquals("\"filter probe:2\"", answered.get(15, TimeUnit.SECONDS));
        results.put("bridgeRoundTrip", true);

        // 4. uBlock's popup opens for the tab and names its host.
        JSONObject action = await(engine.command(new JSONObject().put("action", "action").put("id", UBLOCK_ID)));
        assertFalse("uBlock has a popup", action.optBoolean("noPage"));
        until("the popup page must open", () -> openedPages.stream().anyMatch(LitePage::isPopup), 15);
        LitePage popup = openedPages.stream().filter(LitePage::isPopup).findFirst().orElseThrow(AssertionError::new);
        assertTrue(popup.url, popup.url.contains("popup"));
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        String text;
        do {
            text = evaluateIn(popup.view, "document.body ? document.body.innerText : ''");
            if (text != null && text.contains("127.0.0.1")) break;
            Thread.sleep(300);
        } while (System.nanoTime() < end);
        results.put("popupText", text == null ? null : text.substring(0, Math.min(200, text.length())));
        assertTrue("the popup shows the fixture host: " + text, text != null && text.contains("127.0.0.1"));
        ui(() -> engine.closePage(popup));

        // 5. Storage persists across an in-process engine restart.
        await(engine.violentmonkey("send", new JSONObject().put("cmd", "OnceWriteRecords").put("data", new JSONObject().put("probe", marker))));
        ui(() -> { engine.targets().unregister(attachment.get()); engine.destroy(); });
        engine = bindEngine();
        await(engine.applySettings(new JSONObject()
            .put("filterLists", new JSONObject().put("version", 1).put("lists", new JSONArray().put(new JSONObject().put("url", fixture.url("/list.txt")).put("enabled", true))))
            .put("userscripts", new JSONObject().put("version", 1).put("scripts", new JSONArray()))));
        JSONObject records = await(engine.violentmonkey("send", new JSONObject().put("cmd", "OnceReadRecords")));
        results.put("recordsAfterRestart", records);
        assertEquals(marker, records.getJSONObject("value").optString("probe"));
        JSONArray again = await(engine.command(new JSONObject().put("action", "list"))).getJSONArray("extensions");
        assertEquals(2, again.length());
        results.put("restarted", true);

        // uBlock may restore unchanged lists from its cache after a restart;
        // readiness and filtering matter, not a second network download.
        long reloadEnd = System.nanoTime() + TimeUnit.SECONDS.toNanos(60);
        while (System.nanoTime() < reloadEnd && !ublockState().contains("\"loading\":false")) Thread.sleep(500);
        Thread.sleep(2000);
        results.put("ublockStateAfterRestart", ublockState());
        // 6. The restarted engine filters the tab again: uBlock's own engine blocks the request and hides the element.
        int tabAgain = engine.nextTabId();
        String markerAgain = "once-tab-" + java.util.UUID.randomUUID();
        ui(() -> attachment.set(engine.targets().register(tab, markerAgain, "tab", tabAgain, null, bridge, true)));
        reportTab(tabAgain, pageUrl, attachment.get());
        CountDownLatch loadingAgain = new CountDownLatch(1);
        attachment.get().whenReady(10000, () -> { tab.loadUrl(pageUrl); loadingAgain.countDown(); });
        assertTrue(loadingAgain.await(15, TimeUnit.SECONDS));
        reportTab(tabAgain, pageUrl, attachment.get());
        results.put("historyEntries", historySize());
        Thread.sleep(4000);
        results.put("ublockStateAtEnd", ublockState());
        untilEvaluates("document.getElementById('i').dataset.r", "\"error\"", 20);
        untilEvaluates("getComputedStyle(document.querySelector('.once-hide')).display", "\"none\"", 20);
        results.put("requestBlocked", true);
        results.put("elementHidden", true);
        results.put("ublockAfterFirstBlock", ublockState());

    }

    /**
     * A page's synchronous XMLHttpRequest blocks the renderer main thread
     * every WebView shares, the broker's too, so the broker cannot answer the
     * paused request it waits for: Java continues it (FetchWatchdog) and the
     * runtime goes on.
     */
    @Test
    public void aSynchronousRequestInATabDoesNotFreezeTheRuntime() throws Exception {
        assertTrue("DevTools must be available on the emulator", engine.devtoolsAvailable());
        AtomicReference<LiteTargets.Attachment> attachment = new AtomicReference<>();
        int tabId = engine.nextTabId();
        CountDownLatch finished = new CountDownLatch(1);
        ui(() -> {
            tab = new WebView(activity);
            tab.getSettings().setJavaScriptEnabled(true);
            tab.setWebViewClient(new android.webkit.WebViewClient() {
                @Override public void onPageFinished(WebView view, String url) {
                    if (url.endsWith("/sync.html")) finished.countDown();
                }
            });
            activity.addContentView(tab, new ViewGroup.LayoutParams(600, 600));
            attachment.set(engine.targets().register(tab, "once-tab-" + java.util.UUID.randomUUID(), "tab", tabId, null, null, true));
        });
        String pageUrl = fixture.url("/sync.html");
        reportTab(tabId, pageUrl, attachment.get());
        CountDownLatch loading = new CountDownLatch(1);
        attachment.get().whenReady(10000, () -> { tab.loadUrl(pageUrl); loading.countDown(); });
        assertTrue(loading.await(15, TimeUnit.SECONDS));
        long started = System.nanoTime();
        assertTrue("the synchronous XHR document finishes", finished.await(30, TimeUnit.SECONDS));
        long elapsed = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started);
        untilEvaluates("document.title", "\"sync:ok\"", 10);
        results.put("syncRequestMs", elapsed);
        results.put("syncXhrMs", Long.parseLong(evaluate("Math.round(window.__syncXhrMs)")));
        // The broker answers again once the renderer is free.
        JSONArray extensions = await(engine.command(new JSONObject().put("action", "list"))).getJSONArray("extensions");
        assertEquals(2, extensions.length());
        ui(() -> engine.targets().unregister(attachment.get()));
    }

    /**
     * A dropped DevTools connection: the tab's target is bound again on the
     * new connection, Once's bridge world answers again and the extensions'
     * worlds in the live document are known to the broker again.
     */
    @Test
    public void aDroppedDevToolsConnectionRebindsTheTabs() throws Exception {
        assertTrue("DevTools must be available on the emulator", engine.devtoolsAvailable());
        LiteBridge bridge = new LiteBridge(new android.os.Handler(android.os.Looper.getMainLooper()), new LiteBridge.Listener() {
            @Override public void documentChanged(Object token) {}
            @Override public void documentGone(Object token) {}
            @Override public void message(JSONObject message, Object token) {}
        });
        AtomicReference<LiteTargets.Attachment> attachment = new AtomicReference<>();
        int tabId = engine.nextTabId();
        ui(() -> {
            // A reading tab's view, with the marker script its target is found by again after the drop.
            LiteWebView view = new LiteWebView(activity);
            LiteNavigation.configure(view, false);
            tab = view;
            activity.addContentView(tab, new ViewGroup.LayoutParams(600, 600));
            attachment.set(engine.targets().register(tab, ((LiteWebView) tab).marker, "tab", tabId, null, bridge, true));
            bridge.attach(attachment.get());
        });
        String pageUrl = fixture.url("/page.html");
        reportTab(tabId, pageUrl, attachment.get());
        CountDownLatch loading = new CountDownLatch(1);
        attachment.get().whenReady(10000, () -> { tab.loadUrl(pageUrl); loading.countDown(); });
        assertTrue(loading.await(15, TimeUnit.SECONDS));
        untilEvaluates("document.title", "\"filter probe\"", 20);
        until("the bridge must connect", bridge::isConnected, 15);
        untilOffMain("the extension worlds must greet the broker", () -> worldCount(attachment.get().targetId()) > 0, 20);
        String before = attachment.get().targetId();

        com.zmarn.once.devtools.DevToolsClient.current().dropConnection();
        until("the connection must drop", () -> !attachment.get().isReady(), 10);
        until("the tab must be bound again", () -> attachment.get().isReady(), 30);
        assertEquals("the same page target", before, attachment.get().targetId());
        untilOffMain("the extension worlds must greet the broker again", () -> worldCount(attachment.get().targetId()) > 0, 20);
        CompletableFuture<String> answered = new CompletableFuture<>();
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        while (!answered.isDone() && System.nanoTime() < end) {
            CompletableFuture<String> attempt = new CompletableFuture<>();
            ui(() -> bridge.evaluate("document.title", new LiteBridge.Reply() {
                @Override public void resolve(String value) { attempt.complete(value); }
                @Override public void reject(String message) { attempt.complete(null); }
            }));
            String value = attempt.get(15, TimeUnit.SECONDS);
            if (value != null) answered.complete(value); else Thread.sleep(500);
        }
        assertEquals("\"filter probe\"", answered.getNow(null));
        ui(() -> engine.targets().unregister(attachment.get()));
    }

    @Test
    public void extensionPageReloadCreatesANewWorkingReplyChannel() throws Exception {
        await(engine.command(new JSONObject().put("action", "options").put("id", UBLOCK_ID)));
        until("options page opens", () -> !openedPages.isEmpty(), 15);
        LitePage page = openedPages.get(openedPages.size() - 1);
        for (int attempt = 0; attempt < 2; attempt++) {
            if (attempt > 0) ui(() -> engine.reloadPage(page));
            long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            boolean answered = false;
            while (System.nanoTime() < end) {
                evaluateIn(page.view, "if (typeof browser !== 'undefined') browser.storage.local.get('once-review-probe').then(() => window.__replyWorks = true)");
                if ("true".equals(evaluateIn(page.view, "window.__replyWorks === true"))) { answered = true; break; }
                Thread.sleep(100);
            }
            assertTrue("storage API replies after load/reload " + attempt, answered);
            if (attempt == 0) evaluateIn(page.view, "delete window.__replyWorks");
        }
    }

    @Test
    public void rendererTerminationRecreatesTheBroker() throws Exception {
        Assume.assumeTrue(androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.WEB_VIEW_RENDERER_TERMINATE));
        java.lang.reflect.Field brokerField = LiteExtensionEngine.class.getDeclaredField("broker");
        brokerField.setAccessible(true);
        Object oldBroker = brokerField.get(engine);
        java.lang.reflect.Field viewField = oldBroker.getClass().getDeclaredField("view");
        viewField.setAccessible(true);
        WebView oldView = (WebView) viewField.get(oldBroker);
        ui(() -> {
            androidx.webkit.WebViewRenderProcess renderer = androidx.webkit.WebViewCompat.getWebViewRenderProcess(oldView);
            assertNotNull(renderer);
            assertTrue(renderer.terminate());
        });
        until("the engine observes renderer termination", () -> !engine.isStarted(), 15);
        until("a fresh broker starts", engine::isStarted, 90);
        assertNotSame(oldBroker, brokerField.get(engine));
        assertEquals(2, await(engine.command(new JSONObject().put("action", "list"))).getJSONArray("extensions").length());
        AtomicReference<LiteTargets.Attachment> attachment = new AtomicReference<>();
        int tabId = engine.nextTabId();
        ui(() -> {
            tab = new WebView(activity);
            tab.getSettings().setJavaScriptEnabled(true);
            activity.addContentView(tab, new ViewGroup.LayoutParams(600, 600));
            attachment.set(engine.targets().register(tab, "once-tab-" + java.util.UUID.randomUUID(), "tab", tabId, null, null, true));
        });
        reportTab(tabId, fixture.url("/page.html"), attachment.get());
        CountDownLatch ready = new CountDownLatch(1);
        attachment.get().whenReady(10000, () -> { tab.loadUrl(fixture.url("/page.html")); ready.countDown(); });
        assertTrue(ready.await(15, TimeUnit.SECONDS));
        untilEvaluates("document.title", "\"filter probe\"", 30);
        untilOffMain("new tabs have extension worlds after renderer recovery", () -> worldCount(attachment.get().targetId()) >= 2, 20);
        ui(() -> engine.targets().unregister(attachment.get()));
    }

    /** uBlock Origin's host on this install (random per install, see liteHostNames.ts), through the broker. */
    private String ublockHost() {
        try {
            com.zmarn.once.devtools.DevToolsClient client = com.zmarn.once.devtools.DevToolsClient.current();
            for (com.zmarn.once.devtools.DevToolsClient.Target target : client.targets()) {
                if (target.url == null || !(target.url.contains("/lite-runtime.html") || target.url.contains("#once-broker-"))) continue;
                JSONObject result = client.call(target.sessionId, "Runtime.evaluate", new JSONObject().put("returnByValue", true).put("expression",
                    "(window.onceLiteBroker.hostsLoaded().find(h => h.extension.id === " + JSONObject.quote(UBLOCK_ID) + ") || {extension: {host: 'none'}}).extension.host"), 5000);
                return result.getJSONObject("result").optString("value", "none");
            }
        } catch (Exception ignored) { /* diagnostics only */ }
        return "none";
    }

    /** `until` for conditions that make DevTools calls, which must not block the main thread WebView's DevTools needs. */
    private void untilOffMain(String message, BooleanSupplier condition, int seconds) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        do { if (condition.getAsBoolean()) return; Thread.sleep(200); } while (System.nanoTime() < end);
        fail(message);
    }

    /** How many extension world contexts the broker knows in the target. */
    private int worldCount(String targetId) {
        try {
            com.zmarn.once.devtools.DevToolsClient client = com.zmarn.once.devtools.DevToolsClient.current();
            String brokerSession = null;
            for (com.zmarn.once.devtools.DevToolsClient.Target target : client.targets()) {
                if (target.url != null && (target.url.contains("/lite-runtime.html") || target.url.contains("#once-broker-"))) brokerSession = target.sessionId;
            }
            if (brokerSession == null || targetId == null) {
                StringBuilder seen = new StringBuilder();
                for (com.zmarn.once.devtools.DevToolsClient.Target target : client.targets()) seen.append(target.type).append(' ').append(target.url).append("; ");
                Log.i(TAG, "no broker session (target " + targetId + "): " + seen);
                return 0;
            }
            JSONObject known = client.call(brokerSession, "Runtime.evaluate", new JSONObject().put("returnByValue", true)
                .put("expression", "JSON.stringify(window.onceLiteBroker.worldContexts(" + JSONObject.quote(targetId) + "))"), 5000);
            JSONArray worlds = new JSONArray(known.getJSONObject("result").optString("value", "[]"));
            int count = 0;
            for (int index = 0; index < worlds.length(); index++) if (worlds.getJSONObject(index).optString("name").startsWith("once-ext:")) count++;
            if (count == 0) Log.i(TAG, "worlds of " + targetId + ": " + worlds);
            return count;
        } catch (Exception error) { Log.i(TAG, "worlds unknown: " + error); return 0; }
    }

    /** What the extension worlds of the tab hold (diagnostics only): the live contexts, asked by name. */
    private String worldState(String targetId) {
        try {
            com.zmarn.once.devtools.DevToolsClient client = com.zmarn.once.devtools.DevToolsClient.current();
            String session = null;
            for (com.zmarn.once.devtools.DevToolsClient.Target target : client.targets()) if (target.targetId.equals(targetId)) session = target.sessionId;
            if (session == null) return "no session";
            // The broker knows the target's world contexts; asking the session to replay them
            // (Runtime.disable + enable) would drop the bindings the worlds talk through.
            String brokerSession = null;
            for (com.zmarn.once.devtools.DevToolsClient.Target target : client.targets()) {
                if (target.url != null && (target.url.contains("/lite-runtime.html") || target.url.contains("#once-broker-"))) brokerSession = target.sessionId;
            }
            if (brokerSession == null) return "no broker session";
            JSONObject known = client.call(brokerSession, "Runtime.evaluate", new JSONObject().put("returnByValue", true)
                .put("expression", "JSON.stringify(window.onceLiteBroker.worldContexts(" + JSONObject.quote(targetId) + "))"), 5000);
            JSONArray worlds = new JSONArray(known.getJSONObject("result").getString("value"));
            java.util.Map<String, Integer> contexts = new java.util.LinkedHashMap<>();
            for (int index = 0; index < worlds.length(); index++) {
                JSONObject world = worlds.getJSONObject(index);
                contexts.put(world.getString("name") + "@" + world.getString("frameId"), world.getInt("contextId"));
            }
            JSONObject report = new JSONObject().put("contexts", new JSONObject(contexts));
            for (java.util.Map.Entry<String, Integer> context : contexts.entrySet()) {
                if (!context.getKey().startsWith("once-ext:" + ublockHost())) continue;
                JSONObject result = client.call(session, "Runtime.evaluate", new JSONObject().put("contextId", context.getValue()).put("returnByValue", true).put("expression",
                    "JSON.stringify({vapi: typeof vAPI, filterer: typeof vAPI !== 'undefined' && !!vAPI.domFilterer, styles: [...document.querySelectorAll('style')].map(s => s.textContent.slice(0, 160)), "
                    + "sheets: vAPI.userStylesheet && vAPI.userStylesheet.added ? [...vAPI.userStylesheet.added].map(c => c.slice(0, 160)) : null, "
                    + "specific: vAPI.domFilterer && vAPI.domFilterer.specificSelectors ? vAPI.domFilterer.specificSelectors.length : null, "
                    + "ready: document.readyState, deliver: typeof __onceLiteDeliver, boot: typeof __onceLiteWorldBoot, browser: typeof browser, "
                    + "surveyor: !!vAPI.domSurveyor, pending: vAPI.messaging && vAPI.messaging.pending ? vAPI.messaging.pending.size : null, "
                    + "noGen: vAPI.noGenericCosmeticFiltering, noSpec: vAPI.noSpecificCosmeticFiltering, "
                    + "hidden: getComputedStyle(document.querySelector('.once-hide')).display})"), 5000);
                report.put("ublockWorld", result.optJSONObject("result") == null ? result.toString() : result.getJSONObject("result").opt("value"));
            }
            return report.toString();
        } catch (Exception error) { return "error: " + error.getMessage(); }
    }

    private String filterRecord() {
        try {
            return new String(com.zmarn.once.lite.LiteFiles.readAll(new java.io.File(activity.getFilesDir(),
                "lite-extensions/" + ublockHost() + "/once-filter-lists.json")), StandardCharsets.UTF_8);
        } catch (Exception error) { return "missing: " + error.getMessage(); }
    }

    /** What uBlock's background holds, through its DevTools target (diagnostics only). */
    private String ublockState() {
        try {
            com.zmarn.once.devtools.DevToolsClient client = com.zmarn.once.devtools.DevToolsClient.current();
            for (com.zmarn.once.devtools.DevToolsClient.Target target : client.targets()) {
                if (target.url == null || !target.url.contains(ublockHost()) || !target.url.contains("background")) continue;
                JSONObject result = client.call(target.sessionId, "Runtime.evaluate", new JSONObject().put("returnByValue", true).put("expression",
                    "JSON.stringify({ready: typeof µBlock !== 'undefined' && µBlock.readyToFilter, loading: µBlock.loadingFilterLists, "
                    + "selected: µBlock.selectedFilterLists, imported: µBlock.userSettings && µBlock.userSettings.importedLists, "
                    + "pageStores: [...µBlock.pageStores.keys()], suspend: µBlock.userSettings.suspendUntilListsAreLoaded, "
                    + "stores: [...µBlock.pageStores.entries()].map(([id, p]) => ({id, host: p.tabHostname, url: p.rawURL, "
                    + "blocked: p.counts && p.counts.blocked && p.counts.blocked.any, allowed: p.counts && p.counts.allowed && p.counts.allowed.any, "
                    + "net: p.getNetFilteringSwitch ? p.getNetFilteringSwitch() : null}))})"), 5000);
                return String.valueOf(result.optJSONObject("result") == null ? result : result.getJSONObject("result").opt("value"));
            }
            return "no background target";
        } catch (Exception error) { return "error: " + error.getMessage(); }
    }

    void reportTab(int tabId, String url, LiteTargets.Attachment attachment) throws Exception {
        JSONObject state = new JSONObject().put("tabId", tabId).put("generation", 1).put("url", url).put("title", "")
            .put("active", true).put("index", 0).put("status", "loading").put("audible", false).put("muted", false);
        if (attachment.targetId() != null) state.put("targetId", attachment.targetId());
        ui(() -> engine.reportTab(tabId, state));
    }

    private static JSONObject await(CompletableFuture<?> future) throws Exception {
        Object value = future.get(60, TimeUnit.SECONDS);
        return value instanceof JSONObject ? (JSONObject) value : new JSONObject();
    }

    private int historySize() {
        AtomicReference<Integer> size = new AtomicReference<>(0);
        ui(() -> size.set(tab.copyBackForwardList().getSize()));
        return size.get();
    }

    String evaluate(String code) throws Exception { return evaluateIn(tab, code); }

    private String evaluateIn(WebView view, String code) throws Exception {
        // Longer than a page's synchronous request holds the shared renderer before Java releases
        // it; sent again when WebView drops the callback of a document a navigation replaced.
        for (int attempt = 0; attempt < 3; attempt++) {
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<String> value = new AtomicReference<>();
            ui(() -> view.evaluateJavascript(code, result -> { value.set(result); latch.countDown(); }));
            if (latch.await(15, TimeUnit.SECONDS)) return value.get();
        }
        throw new AssertionError("evaluateJavascript never answered " + code);
    }

    void untilEvaluates(String code, String expected, int seconds) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        String last;
        do {
            last = evaluate(code);
            if (expected.equals(last)) return;
            Thread.sleep(200);
        } while (System.nanoTime() < end);
        fail(code + " was " + last + ", expected " + expected);
    }

    void ui(Runnable work) { instrumentation.runOnMainSync(work); }

    private void until(String message, BooleanSupplier condition, int seconds) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        AtomicReference<Boolean> done = new AtomicReference<>(false);
        do { ui(() -> done.set(condition.getAsBoolean())); if (done.get()) return; Thread.sleep(100); } while (System.nanoTime() < end);
        fail(message);
    }

    private void shell(String command) {
        try (java.io.InputStream output = new android.os.ParcelFileDescriptor.AutoCloseInputStream(
                instrumentation.getUiAutomation().executeShellCommand(command))) {
            byte[] buffer = new byte[256];
            while (output.read(buffer) != -1) { /* Wait for the command to complete. */ }
        } catch (IOException error) { throw new AssertionError(error); }
    }

    /** A loopback HTTP fixture: the probe page, the image a filter blocks, and the list itself. */
    static final class Fixture implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0);
        final ExecutorService workers = Executors.newCachedThreadPool();
        final java.util.concurrent.atomic.AtomicInteger listRequests = new java.util.concurrent.atomic.AtomicInteger();

        Fixture() throws IOException {
            workers.submit(() -> { while (!server.isClosed()) {
                try { Socket socket = server.accept(); workers.submit(() -> serve(socket)); }
                catch (IOException e) { if (!server.isClosed()) throw new UncheckedIOException(e); }
            }});
        }

        String url(String path) { return "http://127.0.0.1:" + server.getLocalPort() + path; }

        void serve(Socket socket) {
            try (Socket connection = socket) {
                BufferedReader reader = new BufferedReader(new InputStreamReader(connection.getInputStream()));
                String request = reader.readLine();
                String line; while ((line = reader.readLine()) != null && !line.isEmpty()) { /* headers */ }
                String path = request.split(" ")[1];
                String type = "text/html";
                byte[] body;
                if (path.startsWith("/large/")) {
                    int bytes = Integer.parseInt(path.substring(7, path.indexOf('?')));
                    String prefix = "<!doctype html><title>" + path + "</title><div hidden>";
                    body = (prefix + new String(new char[bytes]).replace('\0', 'x') + "</div>").getBytes(StandardCharsets.UTF_8);
                } else if (path.equals("/page.html")) {
                    body = ("<!doctype html><title>filter probe</title>"
                        + "<img id='i' src='/blocked.png' onload=\"this.dataset.r='load'\" onerror=\"this.dataset.r='error'\">"
                        + "<div class='once-hide'>hidden by the list</div><p>visible</p>").getBytes(StandardCharsets.UTF_8);
                } else if (path.equals("/sync.html")) {
                    body = ("<!doctype html><title>sync</title><script>var request = new XMLHttpRequest();"
                        + "request.open('GET', '/ok', false); var started = performance.now(); request.send(); window.__syncXhrMs = performance.now()-started; document.title = 'sync:' + request.responseText;</script>")
                        .getBytes(StandardCharsets.UTF_8);
                } else if (path.startsWith("/list.txt")) {
                    listRequests.incrementAndGet();
                    type = "text/plain";
                    // Specific to the fixture host: EasyList excepts generic hiding on 127.0.0.1
                    // (`@@://127.0.0.1$generichide`); the e2e suites cover generic rules on 10.0.2.2.
                    body = "! Title: Once Lite test list\n/blocked.png$image\n127.0.0.1##.once-hide\n".getBytes(StandardCharsets.UTF_8);
                } else if (path.startsWith("/blocked")) {
                    type = "image/png";
                    body = android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", android.util.Base64.DEFAULT);
                } else {
                    type = "text/plain";
                    body = "ok".getBytes(StandardCharsets.UTF_8);
                }
                connection.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                    + (path.startsWith("/large/") ? "\r\nContent-Security-Policy: script-src 'none'; connect-src 'none'" : "")
                    + "\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                connection.getOutputStream().write(body);
            } catch (Exception ignored) { /* the client went away */ }
        }

        @Override public void close() throws Exception { server.close(); workers.shutdownNow(); }
    }
}
