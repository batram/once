package com.zmarn.once;

import android.app.Instrumentation;
import android.content.Intent;
import android.os.Build;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.zmarn.once.lite.LiteExtensionEngine;
import com.zmarn.once.lite.LitePage;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
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
 * Tier 2 (docs/plans/once-lite-plan.md) on the emulator: DevTools forced off
 * with the debug switch, the runtime restarted in-process, then the
 * catalogue lists uBlock Origin Lite as the running extension and the full
 * ones as limited; uBO Lite's default rulesets are loaded; a synced list
 * blocks an image and hides an element; a session rule set through the
 * broker blocks, another redirects to a web-accessible resource and a third
 * to a URL; uBO Lite's generic cosmetics hide a well-known ad slot; a
 * userscript runs at document start with a GM value round trip. The switch
 * is cleared and the runtime restarted afterwards, so the other suites keep
 * Tier 1.
 *
 *   ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedLiteDevelopmentDebugAndroidTest -PonceDeployAbis=arm64-v8a \
 *     -Pandroid.testInstrumentationRunnerArguments.class=com.zmarn.once.LiteTier2Test
 */
@RunWith(AndroidJUnit4.class)
public class LiteTier2Test {
    private static final String TAG = "LiteTier2Test";
    private static final String UBLOCK_ID = "uBlock0@raymondhill.net";
    private static final String VIOLENTMONKEY_ID = "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}";
    private static final String UBOLITE_ID = "uBOLite@raymondhill.net";
    private static final String USERSCRIPT = "// ==UserScript==\n// @name Tier 2 probe\n// @namespace once-test\n// @match <all_urls>\n"
        + "// @run-at document-start\n// @grant GM_setValue\n// @grant GM_getValue\n// ==/UserScript==\n"
        + "document.documentElement.dataset.start = document.readyState;\n"
        + "GM_setValue('ran', {n: 2});\n"
        + "document.documentElement.dataset.gm = JSON.stringify(GM_getValue('ran', null));\n"
        + "document.documentElement.dataset.pageSees = String(typeof GM_setValue === typeof window.GM_setValue);";
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final JSONObject results = new JSONObject();
    private MainActivity activity;
    private Fixture fixture;
    private LiteExtensionEngine engine;
    private WebView tab;

    @Before
    public void start() throws Exception {
        String pkg = instrumentation.getTargetContext().getPackageName();
        assertTrue("Only the Once Lite dev package may be driven: " + pkg, pkg.endsWith(".lite.dev"));
        boolean emulator = Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish") || Build.HARDWARE.contains("cutf")
            || Build.PRODUCT.contains("sdk") || Build.FINGERPRINT.contains("emulator");
        Assume.assumeTrue("LiteTier2Test runs on an emulator only", emulator);
        shell("input keyevent KEYCODE_WAKEUP");
        shell("wm dismiss-keyguard");
        activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        until("The test activity must have a laid-out window", () -> activity.getWindow().getDecorView().getWidth() > 0, 15);
        fixture = new Fixture();
        shell("setprop " + LiteExtensionEngine.DEVTOOLS_PROPERTY + " off");
        restartEngine();
    }

    @After
    public void stop() throws Exception {
        JSONArray catalogue = results.optJSONArray("catalogue");
        if (catalogue != null) for (int index = 0; index < catalogue.length(); index++) catalogue.optJSONObject(index).remove("iconDataUrl");
        Log.i(TAG, "RESULTS " + results.toString());
        ui(() -> {
            if (tab != null) {
                if (engine != null) engine.tier2().removeTab(tab);
                ((ViewGroup) tab.getParent()).removeView(tab);
                tab.destroy();
            }
        });
        shell("setprop " + LiteExtensionEngine.DEVTOOLS_PROPERTY + " on");
        // Back to Tier 1 for whatever runs next in this process.
        restartEngine();
        if (fixture != null) fixture.close();
    }

    private void restartEngine() throws Exception {
        AtomicReference<LiteExtensionEngine> created = new AtomicReference<>();
        ui(() -> {
            LiteExtensionEngine current = LiteExtensionEngine.current();
            if (current != null) current.destroy();
            LiteExtensionEngine next = LiteExtensionEngine.get(activity);
            ViewGroup content = activity.findViewById(android.R.id.content);
            next.bind(activity, content, new LiteExtensionEngine.TabShell() {
                @Override public int createTab(String url, boolean active) { return -1; }
                @Override public void updateTab(int tabId, JSONObject params) {}
                @Override public void removeTab(int tabId) {}
                @Override public void reloadTab(int tabId) {}
            }, new LiteExtensionEngine.PagePresenter() {
                @Override public void opened(LitePage page) {}
                @Override public void closed(LitePage page) {}
                @Override public void statusChanged(LitePage page) {}
                @Override public void resized(LitePage page, int width, int height) {}
            }, new LiteExtensionEngine.Listener() {
                @Override public void extensionsChanged() {}
                @Override public void violentmonkeyConnected() {}
                @Override public void violentmonkeyDashboardChanged() {}
            });
            created.set(next);
        });
        engine = created.get();
        until("The broker must start", engine::isStarted, 90);
    }

    @Test
    public void tier2EnforcesListsUboLiteAndUserscriptsWithoutDevTools() throws Exception {
        assertFalse("DevTools is switched off", engine.devtoolsAvailable());
        assertTrue("the runtime runs in Tier 2", engine.tier2Active());

        // 1. The catalogue: uBO Lite runs, the full extensions are listed as limited.
        JSONArray extensions = await(engine.command(new JSONObject().put("action", "list"))).getJSONArray("extensions");
        results.put("catalogue", extensions);
        assertEquals(3, extensions.length());
        JSONObject ubolite = extensions.getJSONObject(0);
        assertEquals(UBOLITE_ID, ubolite.getString("id"));
        assertEquals("uBlock Origin Lite", ubolite.getString("name"));
        assertTrue(ubolite.getBoolean("enabled"));
        assertTrue(ubolite.getBoolean("bundled"));
        assertFalse(ubolite.getBoolean("hasOptions"));
        assertFalse(ubolite.getBoolean("hasAction"));
        assertEquals("", ubolite.getString("disabledReason"));
        for (int index = 1; index < 3; index++) {
            JSONObject entry = extensions.getJSONObject(index);
            assertEquals(index == 1 ? UBLOCK_ID : VIOLENTMONKEY_ID, entry.getString("id"));
            assertFalse(entry.getString("id") + " is not running", entry.getBoolean("enabled"));
            assertEquals(LiteExtensionEngine.DEVTOOLS_UNAVAILABLE, entry.getString("disabledReason"));
        }

        // 2. uBO Lite's default rulesets are in force, counted by Java.
        Integer statics = engine.tier2().counts().get("ubolite");
        results.put("uboliteRules", statics);
        results.put("skippedRules", engine.tier2().skippedRules());
        assertNotNull("uBO Lite's rules are loaded", statics);
        assertTrue("uBO Lite's default rulesets hold more than 100k rules: " + statics, statics > 100000);

        // 3. Session rules through the broker's DNR API: a block, a redirect to a
        // web-accessible resource, a redirect to another URL.
        JSONObject session = await(engine.sessionRules(new JSONObject().put("addRules", new JSONArray()
            .put(new JSONObject("{\"id\":1,\"priority\":1,\"action\":{\"type\":\"block\"},\"condition\":{\"urlFilter\":\"/tier2-session.png\",\"resourceTypes\":[\"image\"]}}"))
            .put(new JSONObject("{\"id\":2,\"priority\":1,\"action\":{\"type\":\"redirect\",\"redirect\":{\"extensionPath\":\"/web_accessible_resources/2x2.png\"}},\"condition\":{\"urlFilter\":\"/tier2-war.png\"}}"))
            .put(new JSONObject("{\"id\":3,\"priority\":1,\"action\":{\"type\":\"redirect\",\"redirect\":{\"url\":\"" + fixture.url("/moved-target.png") + "\"}},\"condition\":{\"urlFilter\":\"/tier2-moved.png\"}}")))));
        results.put("sessionCounts", session.optJSONObject("counts"));
        assertEquals(statics + 3, session.getJSONObject("counts").getInt("ubolite"));

        // 4. The synced list and the userscript, acknowledged once Java has them.
        JSONObject synced = new JSONObject()
            .put("filterLists", new JSONObject().put("version", 1).put("lists", new JSONArray().put(new JSONObject().put("url", fixture.url("/list.txt")).put("enabled", true))))
            .put("userscripts", new JSONObject().put("version", 1).put("scripts", new JSONArray()
                .put(new JSONObject().put("id", "tier2-probe").put("name", "Tier 2 probe").put("source", USERSCRIPT).put("enabled", true))));
        long applyStarted = System.currentTimeMillis();
        // The shell in the activity may apply its own (empty) documents beside ours; ours must be the last.
        for (int attempt = 0; ; attempt++) {
            int before = engine.settingsApplications();
            await(engine.applySettings(synced));
            long quiet = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
            while (System.nanoTime() < quiet && engine.settingsApplications() == before + 1) Thread.sleep(200);
            until("settings applications must settle", () -> engine.settingsInFlight() == 0, 60);
            if (engine.settingsApplications() == before + 1 || attempt >= 4) break;
        }
        results.put("settingsApplyMs", System.currentTimeMillis() - applyStarted);
        assertEquals(Integer.valueOf(1), engine.tier2().counts().get("once-lists"));

        // 5. A tab: Java judges its requests and registers the page scripts.
        int tabId = engine.nextTabId();
        ui(() -> {
            tab = new WebView(activity);
            tab.getSettings().setJavaScriptEnabled(true);
            tab.getSettings().setDomStorageEnabled(true);
            tab.setWebViewClient(new WebViewClient() {
                // What LiteNavigation does in Tier 2.
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                    return engine.tier2().intercept(view, request);
                }
            });
            activity.addContentView(tab, new ViewGroup.LayoutParams(600, 600));
            engine.tier2().addTab(tab, tabId);
            tab.loadUrl(fixture.url("/tier2.html"));
        });
        untilEvaluates("document.title", "\"tier2 probe\"", 20);
        untilEvaluates("document.getElementById('list').dataset.r", "\"error\"", 20);
        untilEvaluates("document.getElementById('session').dataset.r", "\"error\"", 20);
        untilEvaluates("document.getElementById('war').dataset.r + ':' + document.getElementById('war').naturalWidth", "\"load:2\"", 20);
        untilEvaluates("document.getElementById('moved').dataset.r + ':' + document.getElementById('moved').naturalWidth", "\"load:1\"", 20);
        assertFalse("blocked requests never reach the server", fixture.paths.contains("/blocked.png") || fixture.paths.contains("/tier2-session.png"));
        assertTrue("the redirect target was fetched", fixture.paths.contains("/moved-target.png"));
        results.put("networkRules", true);
        untilEvaluates("getComputedStyle(document.querySelector('.once-hide')).display", "\"none\"", 20);
        untilEvaluates("getComputedStyle(document.getElementById('AD_160')).display", "\"none\"", 20);
        untilEvaluates("getComputedStyle(document.querySelector('.visible')).display", "\"block\"", 5);
        results.put("cosmetics", true);
        untilEvaluates("document.documentElement.dataset.start", "\"loading\"", 10);
        untilEvaluates("document.documentElement.dataset.gm", "\"{\\\"n\\\":2}\"", 10);
        // The GM functions are closure-scoped, not page globals.
        untilEvaluates("String(typeof window.GM_setValue)", "\"undefined\"", 5);
        untilEvaluates("localStorage.getItem('once.userscript.tier2-probe.ran')", "\"{\\\"n\\\":2}\"", 5);
        results.put("userscript", true);

        // 6. The full extensions' commands are refused with the reason.
        try {
            await(engine.command(new JSONObject().put("action", "enable").put("id", UBLOCK_ID).put("enabled", true)));
            fail("enable must be refused in Tier 2");
        } catch (Exception error) {
            assertTrue(String.valueOf(error.getMessage()), String.valueOf(error.getMessage()).contains("DevTools unavailable"));
        }
    }

    private static JSONObject await(CompletableFuture<?> future) throws Exception {
        Object value = future.get(90, TimeUnit.SECONDS);
        return value instanceof JSONObject ? (JSONObject) value : new JSONObject();
    }

    private String evaluate(String code) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        ui(() -> tab.evaluateJavascript(code, result -> { value.set(result); latch.countDown(); }));
        assertTrue("evaluateJavascript answered", latch.await(10, TimeUnit.SECONDS));
        return value.get();
    }

    private void untilEvaluates(String code, String expected, int seconds) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        String last;
        do {
            last = evaluate(code);
            if (expected.equals(last)) return;
            Thread.sleep(200);
        } while (System.nanoTime() < end);
        fail(code + " was " + last + ", expected " + expected);
    }

    private void ui(Runnable work) { instrumentation.runOnMainSync(work); }

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

    /** A loopback HTTP fixture: the probe page, its images, and the synced list; it records the paths asked for. */
    private static final class Fixture implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0);
        final ExecutorService workers = Executors.newCachedThreadPool();
        final Set<String> paths = Collections.newSetFromMap(new ConcurrentHashMap<>());

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
                paths.add(path);
                String type = "text/html";
                byte[] body;
                if (path.equals("/tier2.html")) {
                    String image = " onload=\"this.dataset.r='load'\" onerror=\"this.dataset.r='error'\">";
                    body = ("<!doctype html><title>tier2 probe</title>"
                        + "<img id='list' src='/blocked.png'" + image
                        + "<img id='session' src='/tier2-session.png'" + image
                        + "<img id='war' src='/tier2-war.png'" + image
                        + "<img id='moved' src='/tier2-moved.png'" + image
                        + "<div class='once-hide'>hidden by the list</div><div id='AD_160'>an ad slot</div>"
                        + "<div class='visible'>visible</div>").getBytes(StandardCharsets.UTF_8);
                } else if (path.startsWith("/list.txt")) {
                    type = "text/plain";
                    body = "! Title: Once Lite Tier 2 test list\n*/blocked.png|\n##.once-hide\n".getBytes(StandardCharsets.UTF_8);
                } else if (path.endsWith(".png")) {
                    type = "image/png";
                    body = android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", android.util.Base64.DEFAULT);
                } else {
                    type = "text/plain";
                    body = "ok".getBytes(StandardCharsets.UTF_8);
                }
                connection.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                    + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                connection.getOutputStream().write(body);
            } catch (Exception ignored) { /* the client went away */ }
        }

        @Override public void close() throws Exception { server.close(); workers.shutdownNow(); }
    }
}
