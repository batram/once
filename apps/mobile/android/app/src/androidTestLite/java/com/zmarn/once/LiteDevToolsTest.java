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
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.zmarn.once.devtools.DevToolsClient;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;
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
 * Proves, from inside the Once Lite Dev process on an emulator, the DevTools
 * primitives the Lite extension runtime builds on (docs/plans/once-lite-plan.md):
 * the same-uid attach, request interception with resource types, isolated
 * worlds with bindings, and the extension-page origin at
 * https://<host>.moz-extension.localhost served by shouldInterceptRequest.
 * Observations the plan leaves open are logged under the RESULTS tag.
 *
 *   ANDROID_SERIAL=emulator-5554 ./gradlew :app:connectedLiteDevelopmentDebugAndroidTest -PonceDeployAbis=arm64-v8a
 */
@RunWith(AndroidJUnit4.class)
public class LiteDevToolsTest {
    private static final String TAG = "LiteDevToolsTest";
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    private final JSONObject results = new JSONObject();
    private MainActivity activity;
    private WebView view;
    private Fixture fixture;
    private DevToolsClient devtools;
    /** Request header names shouldInterceptRequest saw, by path. */
    private final Map<String, String> interceptedHeaders = Collections.synchronizedMap(new HashMap<>());
    private volatile boolean mozExtensionIntercepted;

    @Before
    public void start() throws Exception {
        String pkg = instrumentation.getTargetContext().getPackageName();
        assertTrue("Only the Once Lite dev package may be driven: " + pkg, pkg.endsWith(".lite.dev"));
        boolean emulator = Build.HARDWARE.contains("ranchu") || Build.HARDWARE.contains("goldfish") || Build.HARDWARE.contains("cutf")
            || Build.PRODUCT.contains("sdk") || Build.FINGERPRINT.contains("emulator");
        Assume.assumeTrue("LiteDevToolsTest runs on an emulator only", emulator);
        shell("input keyevent KEYCODE_WAKEUP");
        shell("wm dismiss-keyguard");
        activity = (MainActivity) instrumentation.startActivitySync(
            new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
        until("The test activity must have a laid-out window", () -> activity.getWindow().getDecorView().getWidth() > 0, 15);
        fixture = new Fixture();
        ui(() -> WebView.setWebContentsDebuggingEnabled(true));
        devtools = DevToolsClient.connect();
    }

    @After
    public void stop() throws Exception {
        Log.i(TAG, "RESULTS " + results.toString());
        if (fixture != null) fixture.close();
        ui(() -> { if (view != null) { ((ViewGroup) view.getParent()).removeView(view); view.destroy(); } });
    }

    @Test
    public void devToolsPrimitivesWorkFromInsideTheProcess() throws Exception {
        // 1. The browser connection: same uid, no adb.
        devtools.whenConnected().get(15, TimeUnit.SECONDS);
        assertTrue(devtools.isConnected());
        results.put("connected", true);
        results.put("webViewPackage", String.valueOf(WebViewCompat.getCurrentWebViewPackage(activity) == null ? null
            : WebViewCompat.getCurrentWebViewPackage(activity).versionName));
        // androidx.webkit 1.17.1 names the feature; whether the installed WebView supports it is the question.
        results.put("JS_INJECTION_IN_FRAME_AND_WORLD", WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD));
        results.put("DOCUMENT_START_SCRIPT", WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT));
        results.put("WEB_MESSAGE_LISTENER", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER));

        // 2. A Lite WebView becomes an attached page target, found by its marker load.
        String marker = "once-tab-" + java.util.UUID.randomUUID();
        ui(() -> {
            view = new WebView(activity);
            view.getSettings().setJavaScriptEnabled(true);
            view.getSettings().setDomStorageEnabled(true);
            view.setWebViewClient(new Interceptor());
            activity.addContentView(view, new ViewGroup.LayoutParams(400, 400));
            view.loadUrl("about:blank#" + marker);
        });
        DevToolsClient.Target target;
        try { target = devtools.targetFor(marker, 15000); }
        catch (Exception missing) {
            StringBuilder seen = new StringBuilder();
            for (DevToolsClient.Target t : devtools.targets()) seen.append(t.type).append(' ').append(t.url).append("; ");
            throw new AssertionError("No target for " + marker + "; attached: " + seen, missing);
        }
        assertEquals("page", target.type);
        results.put("targetAttached", true);
        String session = target.sessionId;
        assertTrue(devtools.available());
        results.put("fetchSupported", devtools.fetchSupported());

        // 3. Fetch: an image is paused with its resource type and failed; the page's onerror fires.
        CompletableFuture<String> blockedType = new CompletableFuture<>();
        devtools.addListener((sid, method, params) -> {
            if (!session.equals(sid) || !"Fetch.requestPaused".equals(method)) return;
            String type = params.optString("resourceType");
            String id = params.optString("requestId");
            try {
                if ("Image".equals(type) && params.getJSONObject("request").optString("url").endsWith("/img.png")) {
                    devtools.send(sid, "Fetch.failRequest", new JSONObject().put("requestId", id).put("errorReason", "BlockedByClient"));
                    blockedType.complete(type);
                } else devtools.send(sid, "Fetch.continueRequest", new JSONObject().put("requestId", id));
            } catch (Exception error) { blockedType.completeExceptionally(error); }
        });
        devtools.call(session, "Fetch.enable", new JSONObject().put("patterns",
            new JSONArray().put(new JSONObject().put("urlPattern", "*").put("requestStage", "Request"))), 5000);
        load(fixture.url("/page.html"));
        assertEquals("Image", blockedType.get(15, TimeUnit.SECONDS));
        untilEvaluates("document.getElementById('i').dataset.r", "\"error\"", 15);
        untilEvaluates("document.documentElement.dataset.xhr", "\"ok\"", 15);
        results.put("imageBlockedByClient", true);
        results.put("historyAfterMarkerLoad", historySize());
        devtools.call(session, "Fetch.disable", null, 5000);
        results.put("interceptHeadersImage", interceptedHeaders.get("/img2.png"));
        results.put("interceptHeadersXhr", interceptedHeaders.get("/xhr.json"));

        // 4. An isolated world at document start with a binding only it can call.
        CompletableFuture<JSONObject> binding = new CompletableFuture<>();
        CompletableFuture<JSONObject> immediate = new CompletableFuture<>();
        devtools.addListener((sid, method, params) -> {
            if (session.equals(sid) && "Runtime.bindingCalled".equals(method) && "onceWorld".equals(params.optString("name"))) {
                try {
                    JSONObject payload = new JSONObject(params.optString("payload"));
                    // runImmediately also runs the script in the current document; the next navigation is the proof.
                    if (payload.optString("href").endsWith("/world.html")) binding.complete(payload); else immediate.complete(payload);
                } catch (Exception error) { binding.completeExceptionally(error); }
            }
        });
        java.util.List<String> seen = Collections.synchronizedList(new java.util.ArrayList<>());
        devtools.addListener((sid, method, params) -> { if (session.equals(sid)) seen.add(method + (method.startsWith("Runtime.") ? " " + params.toString() : "")); });
        devtools.call(session, "Page.enable", null, 5000);
        devtools.call(session, "Runtime.enable", null, 5000);
        devtools.call(session, "Runtime.addBinding", new JSONObject().put("name", "onceWorld").put("executionContextName", "once-test"), 5000);
        devtools.call(session, "Page.addScriptToEvaluateOnNewDocument", new JSONObject()
            .put("source", "onceWorld(JSON.stringify({ pageGlobal: typeof window.pageGlobal, bindingInMain: 'checked-later', href: location.href }))")
            .put("worldName", "once-test").put("runImmediately", true), 5000);
        load(fixture.url("/world.html"));
        JSONObject fromWorld;
        try { fromWorld = binding.get(15, TimeUnit.SECONDS); }
        catch (Exception missing) {
            results.put("worldEventsSeen", new JSONArray(seen));
            results.put("bindingImmediate", immediate.isDone() ? immediate.get() : null);
            throw new AssertionError("No bindingCalled from the world after navigating; events: " + seen, missing);
        }
        results.put("bindingFromWorld", fromWorld);
        results.put("bindingRanImmediatelyInCurrentDocument", immediate.isDone());
        assertEquals("the world must not see the page's globals", "undefined", fromWorld.optString("pageGlobal"));
        assertEquals("\"undefined\"", evaluate("typeof window.onceWorld"));
        results.put("isolatedWorldBinding", true);

        // 5. Extension pages at https://<host>.moz-extension.localhost, served by shouldInterceptRequest.
        load("https://abc.moz-extension.localhost/page.html");
        JSONObject abc = untilTitleJson("abc.moz-extension.localhost", 15);
        results.put("abcPage", abc);
        assertEquals("https://abc.moz-extension.localhost", abc.optString("origin"));
        assertTrue("isSecureContext on *.localhost", abc.optBoolean("secure"));
        assertEquals("abc", abc.optString("localStorage"));
        assertEquals("ok", abc.optString("indexedDB"));
        assertTrue("cross-host fetch without ACAO: " + abc.optString("fetchWithoutCors"), abc.optString("fetchWithoutCors").startsWith("blocked:"));
        assertTrue("cross-host fetch with ACAO: " + abc.optString("fetchWithCors"), abc.optString("fetchWithCors").startsWith("ok:"));
        load("https://def.moz-extension.localhost/page.html");
        JSONObject def = untilTitleJson("def.moz-extension.localhost", 15);
        results.put("defPage", def);
        assertEquals("https://def.moz-extension.localhost", def.optString("origin"));
        assertEquals("null", def.optString("foreignLocalStorage"));
        assertEquals("def", def.optString("localStorage"));

        // 6. An extension frame inside an ordinary https document.
        ui(() -> view.loadDataWithBaseURL("https://example.test/",
            "<!doctype html><title>pending</title><script>addEventListener('message', e => { document.title = e.data })</script>"
                + "<iframe src=\"https://abc.moz-extension.localhost/frame.html\"></iframe>", "text/html", "utf-8", null));
        untilEvaluates("document.title", "\"frame-loaded:https://abc.moz-extension.localhost\"", 15);
        results.put("extensionFrameInHttpsPage", true);

        // 7. Observation only: a custom moz-extension:// scheme (the plan explains why it is not used).
        String[] mozOrigins = new String[2];
        for (int index = 0; index < 2; index++) {
            String host = index == 0 ? "abc" : "def";
            ui(() -> view.loadUrl("moz-extension://" + host + "/page.html"));
            Thread.sleep(1500);
            try { mozOrigins[index] = evaluate("location.origin + ' ' + location.href"); }
            catch (Throwable error) { mozOrigins[index] = "unavailable: " + error.getMessage(); }
        }
        results.put("mozExtensionIntercepted", mozExtensionIntercepted);
        results.put("mozExtensionOrigins", new JSONArray().put(mozOrigins[0]).put(mozOrigins[1]));
    }

    private void load(String url) { ui(() -> view.loadUrl(url)); }

    private int historySize() {
        AtomicReference<Integer> size = new AtomicReference<>(0);
        ui(() -> size.set(view.copyBackForwardList().getSize()));
        return size.get();
    }

    private String evaluate(String code) throws Exception {
        // WebView 155 drops the callback of a script that reached the document a navigation was
        // replacing (a new document gets a new frame host), so a script that never answers is sent
        // again; the renderer is also shared with the app's extension runtime, busy at its first start.
        for (int attempt = 0; attempt < 6; attempt++) {
            CountDownLatch latch = new CountDownLatch(1);
            AtomicReference<String> value = new AtomicReference<>();
            ui(() -> view.evaluateJavascript(code, result -> { value.set(result); latch.countDown(); }));
            if (latch.await(10, TimeUnit.SECONDS)) return value.get();
        }
        throw new AssertionError("evaluateJavascript never answered " + code);
    }

    private void untilEvaluates(String code, String expected, int seconds) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        String last = null;
        do {
            last = evaluate(code);
            if (expected.equals(last)) return;
            Thread.sleep(200);
        } while (System.nanoTime() < end);
        fail(code + " was " + last + ", expected " + expected);
    }

    /** The probe pages publish their findings as a JSON document title. */
    private JSONObject untilTitleJson(String host, int seconds) throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(seconds);
        String title = null;
        do {
            title = evaluate("document.title");
            if (title != null && title.startsWith("\"{")) {
                JSONObject report = new JSONObject(new org.json.JSONTokener(title).nextValue().toString());
                // The previous page's title lingers until the next document has started.
                if (report.optString("href").contains(host)) return report;
            }
            Thread.sleep(200);
        } while (System.nanoTime() < end);
        throw new AssertionError("Probe page did not report: " + title);
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

    private static final String PROBE_PAGE = "<!doctype html><title>pending</title><script>(async () => {\n"
        + "const r = { origin: location.origin, secure: window.isSecureContext, href: location.href };\n"
        + "try { r.foreignLocalStorage = String(localStorage.getItem('k')); localStorage.setItem('k', location.host.split('.')[0]); r.localStorage = localStorage.getItem('k'); }\n"
        + "catch (e) { r.localStorage = 'error:' + e.name }\n"
        + "r.indexedDB = await new Promise(res => { try { const q = indexedDB.open('probe'); q.onsuccess = () => res('ok'); q.onerror = () => res('error:' + (q.error && q.error.name)); } catch (e) { res('error:' + e.name) } });\n"
        + "r.fetchWithoutCors = await fetch('https://def.moz-extension.localhost/x').then(x => 'ok:' + x.status).catch(e => 'blocked:' + e.name);\n"
        + "r.fetchWithCors = await fetch('https://def.moz-extension.localhost/cors').then(x => 'ok:' + x.status).catch(e => 'blocked:' + e.name);\n"
        + "r.serviceWorker = 'serviceWorker' in navigator;\n"
        + "document.title = JSON.stringify(r);\n"
        + "})()</script>";

    /** Serves the extension hosts and the moz-extension observation; records header names. */
    private final class Interceptor extends WebViewClient {
        @Override public WebResourceResponse shouldInterceptRequest(WebView ignored, WebResourceRequest request) {
            String url = request.getUrl().toString();
            String path = request.getUrl().getPath() == null ? "" : request.getUrl().getPath();
            interceptedHeaders.put(path, new java.util.TreeMap<>(request.getRequestHeaders()).toString());
            if ("moz-extension".equals(request.getUrl().getScheme())) {
                mozExtensionIntercepted = true;
                return html(PROBE_PAGE, null);
            }
            String host = request.getUrl().getHost();
            if (host == null || !host.endsWith(".moz-extension.localhost")) return null;
            if (path.equals("/page.html")) return html(PROBE_PAGE, null);
            if (path.equals("/frame.html")) return html("<!doctype html><script>parent.postMessage('frame-loaded:' + location.origin, '*')</script>", null);
            if (path.equals("/cors")) return html("ok", Collections.singletonMap("Access-Control-Allow-Origin", "*"));
            return html("ok", null);
        }

        private WebResourceResponse html(String body, Map<String, String> headers) {
            WebResourceResponse response = new WebResourceResponse("text/html", "utf-8",
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
            response.setStatusCodeAndReasonPhrase(200, "OK");
            if (headers != null) response.setResponseHeaders(headers);
            return response;
        }
    }

    /** A loopback HTTP fixture for the http pages Fetch is tested against. */
    private static final class Fixture implements AutoCloseable {
        final ServerSocket server = new ServerSocket(0);
        final ExecutorService workers = Executors.newCachedThreadPool();

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
                if (path.equals("/page.html")) {
                    body = ("<!doctype html><title>fetch probe</title>"
                        + "<img id='i' src='/img.png' onload=\"this.dataset.r='load'\" onerror=\"this.dataset.r='error'\">"
                        + "<img src='/img2.png'>"
                        + "<script>fetch('/xhr.json').then(() => { document.documentElement.dataset.xhr = 'ok' })</script>").getBytes(StandardCharsets.UTF_8);
                } else if (path.equals("/world.html")) {
                    body = "<!doctype html><title>world probe</title><script>window.pageGlobal = 1</script>".getBytes(StandardCharsets.UTF_8);
                } else if (path.startsWith("/img")) {
                    type = "image/png";
                    body = android.util.Base64.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", android.util.Base64.DEFAULT);
                } else {
                    type = "application/json";
                    body = "{}".getBytes(StandardCharsets.UTF_8);
                }
                connection.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: " + type + "\r\nContent-Length: " + body.length
                    + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                connection.getOutputStream().write(body);
            } catch (Exception ignored) { /* the client went away */ }
        }

        @Override public void close() throws Exception { server.close(); workers.shutdownNow(); }
    }
}
