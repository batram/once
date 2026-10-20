package com.zmarn.once.lite;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import androidx.webkit.JavaScriptExecutionWorld;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Tier 2 of Once Lite (docs/plans/once-lite-plan.md): enforcement without
 * DevTools. The broker compiles the synced documents and uBlock Origin
 * Lite's rulesets and pushes them here; this class applies them per
 * request and per document, with no broker round trip on the request path:
 *
 * <ul>
 * <li>{@code net.rules {groups}}: compiled into a {@link DnrEvaluator}
 * (static rulesets read from the package and kept across pushes) that
 * {@link #intercept} consults from {@code shouldInterceptRequest}. A block is
 * an empty 403; a redirect to the package ({@code extensionPath}) is served
 * from it; a redirect or {@code upgradeScheme} to a URL navigates a
 * top-level document there and is fetched by Java for a subresource, since
 * WebView refuses 3xx responses from the callback.</li>
 * <li>{@code tier2.scripts {sources}}: each source registered on every
 * reading tab with {@code addDocumentStartJavaScript} (page world), or with
 * {@code addJavaScriptOnEvent} in an isolated world where the WebView reports
 * {@code JS_INJECTION_IN_FRAME_AND_WORLD}; replaced as a whole on change.</li>
 * <li>{@code tier2.fetchList {url}}: a synced filter list's text.</li>
 * </ul>
 *
 * Requests answer once the new state is in force, so the settings barrier
 * the first navigation waits on covers both.
 */
public final class LiteTier2 {
    private static final String TAG = BrokerChannel.TAG;
    private static final String WORLD = "once-tier2";
    private static final int LIST_LIMIT = 16 * 1024 * 1024;

    private final LiteFiles files;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "once-lite-tier2");
        thread.setDaemon(true);
        return thread;
    });
    private final ExecutorService network = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "once-lite-tier2-net");
        thread.setDaemon(true);
        return thread;
    });
    /** Compiled static rulesets by directory and path; uBO Lite's never change while the app runs. */
    private final Map<String, DnrEvaluator.Compiled> statics = new ConcurrentHashMap<>();
    private final java.util.Set<String> cacheNames = ConcurrentHashMap.newKeySet();
    private final Map<WebView, Tab> tabs = new LinkedHashMap<>();
    private volatile DnrEvaluator evaluator = DnrEvaluator.EMPTY;
    private List<String> sources = Collections.emptyList();
    private volatile int skipped;

    /** One reading tab: its scripts, and what its document's requests are judged against. */
    private static final class Tab {
        final int tabId;
        final List<ScriptHandler> scripts = new ArrayList<>();
        volatile String documentUrl;
        volatile Map<String, Integer> frameAllow = Collections.emptyMap();

        Tab(int tabId) { this.tabId = tabId; }
    }

    /** Names the compiled-rules cache of packaged rulesets: the APK they came from. */
    private final String packageStamp;
    private final java.io.File cacheDirectory;

    LiteTier2(LiteFiles files, String packageStamp) {
        this.files = files;
        this.packageStamp = packageStamp;
        cacheDirectory = new java.io.File(files.storageRoot, "tier2-rules");
    }

    void register(BrokerChannel channel) {
        channel.onRequest("net.rules", (params, reply) -> {
            JSONArray groups = params.optJSONArray("groups");
            worker.execute(() -> {
                try { reply.resolve(applyRules(groups == null ? new JSONArray() : groups)); }
                catch (Exception error) { Log.w(TAG, "Tier 2 rules were not applied", error); reply.reject(String.valueOf(error.getMessage())); }
            });
        });
        channel.onRequest("tier2.scripts", (params, reply) -> {
            JSONArray list = params.optJSONArray("sources");
            List<String> next = new ArrayList<>();
            if (list != null) for (int index = 0; index < list.length(); index++) next.add(list.optString(index));
            main.post(() -> {
                sources = Collections.unmodifiableList(next);
                for (Map.Entry<WebView, Tab> entry : tabs.entrySet()) install(entry.getKey(), entry.getValue());
                Log.i(TAG, "Tier 2 page scripts: " + next.size() + " sources on " + tabs.size() + " tabs");
                reply.resolve(null);
            });
        });
        channel.onRequest("tier2.fetchList", (params, reply) -> {
            String url = params.optString("url");
            network.execute(() -> {
                try { reply.resolve(fetchList(url)); }
                catch (Exception error) { reply.reject("The filter list could not be fetched: " + error.getMessage()); }
            });
        });
    }

    void close() {
        worker.shutdownNow();
        network.shutdownNow();
    }

    /** Rules compiled per group, from the last push. */
    public Map<String, Integer> counts() { return evaluator.counts(); }

    public int skippedRules() { return skipped; }

    // ------------------------------------------------------------------
    // Rules

    private JSONObject applyRules(JSONArray groups) throws Exception {
        long started = System.currentTimeMillis();
        List<DnrEvaluator.Group> compiled = new ArrayList<>();
        int skippedNow = 0;
        JSONObject counts = new JSONObject();
        for (int index = 0; index < groups.length(); index++) {
            JSONObject group = groups.getJSONObject(index);
            String id = group.optString("id");
            String directory = group.has("directory") && !group.isNull("directory") ? group.optString("directory") : null;
            List<DnrEvaluator.Compiled> parts = new ArrayList<>();
            JSONArray inline = group.optJSONArray("rules");
            if (inline != null && inline.length() > 0) {
                DnrEvaluator.Compiled rules = DnrEvaluator.compileList((List<?>) MiniJson.parse(inline.toString()));
                skippedNow += rules.skipped;
                parts.add(rules);
            }
            JSONArray rulesets = group.optJSONArray("rulesets");
            if (rulesets != null && directory != null) for (int file = 0; file < rulesets.length(); file++) {
                DnrEvaluator.Compiled ruleset = ruleset(directory, rulesets.getString(file));
                if (ruleset == null) continue;
                skippedNow += ruleset.skipped;
                parts.add(ruleset);
            }
            DnrEvaluator.Group built = DnrEvaluator.group(id, directory, parts);
            compiled.add(built);
            counts.put(id, built.size());
        }
        evaluator = new DnrEvaluator(compiled);
        skipped = skippedNow;
        pruneCache();
        Log.i(TAG, "Tier 2 rules " + counts + " (" + skippedNow + " skipped) in " + (System.currentTimeMillis() - started) + " ms");
        return new JSONObject().put("counts", counts).put("skipped", skippedNow);
    }

    /**
     * A static ruleset, compiled once per process and, for the APK's own
     * rulesets, cached in binary form per APK install (JSON compiling takes
     * seconds on a phone, the cache a fraction of that).
     */
    private DnrEvaluator.Compiled ruleset(String directory, String path) {
        String key = directory + "\n" + path;
        java.io.File cacheFile = directory.startsWith("asset:") ? new java.io.File(cacheDirectory, sha1(packageStamp + "\n" + key) + ".bin") : null;
        if (cacheFile != null) cacheNames.add(cacheFile.getName());
        DnrEvaluator.Compiled cached = statics.get(key);
        if (cached != null) return cached;
        if (cacheFile != null && cacheFile.isFile()) {
            long started = System.nanoTime();
            try (InputStream in = new java.io.FileInputStream(cacheFile)) {
                DnrEvaluator.Compiled read = DnrRuleCache.read(in);
                read.index();
                statics.put(key, read);
                Log.i(TAG, "Tier 2 ruleset " + path + ": " + read.rules.size() + " rules from the cache in " + (System.nanoTime() - started) / 1000000 + " ms");
                return read;
            } catch (Exception error) {
                Log.w(TAG, "The compiled rules cache of " + path + " was unreadable; compiling again", error);
                LiteFiles.delete(cacheFile);
            }
        }
        byte[] bytes;
        try { bytes = files.bytes(directory, path); }
        catch (IOException error) { bytes = null; }
        if (bytes == null) return null;
        DnrEvaluator.Compiled compiled;
        long started = System.nanoTime();
        try { compiled = DnrEvaluator.compileArray(new String(bytes, StandardCharsets.UTF_8)); }
        catch (IllegalArgumentException error) { Log.w(TAG, "Ruleset " + path + " is not valid JSON: " + error.getMessage()); return null; }
        compiled.index();
        Log.i(TAG, "Tier 2 ruleset " + path + ": " + compiled.rules.size() + " rules in " + (System.nanoTime() - started) / 1000000 + " ms");
        statics.put(key, compiled);
        if (cacheFile != null) writeCache(cacheFile, compiled);
        return compiled;
    }

    private void writeCache(java.io.File cacheFile, DnrEvaluator.Compiled compiled) {
        try {
            if (!cacheDirectory.isDirectory() && !cacheDirectory.mkdirs()) throw new IOException("No cache directory");
            // Leftovers of an interrupted write.
            java.io.File[] old = cacheDirectory.listFiles((dir, name) -> name.endsWith(".tmp"));
            if (old != null) for (java.io.File file : old) LiteFiles.delete(file);
            java.io.File temp = new java.io.File(cacheDirectory, cacheFile.getName() + ".tmp");
            try (java.io.OutputStream out = new java.io.FileOutputStream(temp)) { DnrRuleCache.write(compiled, out); }
            if (!temp.renameTo(cacheFile)) throw new IOException("Could not place " + cacheFile.getName());
        } catch (IOException error) {
            Log.w(TAG, "The compiled rules were not cached", error);
        }
    }

    /** Drops cache files no push of this process named: other installs' rulesets. */
    private void pruneCache() {
        java.io.File[] files = cacheDirectory.listFiles((dir, name) -> name.endsWith(".bin"));
        if (files != null) for (java.io.File file : files) if (!cacheNames.contains(file.getName())) LiteFiles.delete(file);
    }

    private static String sha1(String text) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-1").digest(text.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : digest) hex.append(String.format(Locale.ROOT, "%02x", b));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    // ------------------------------------------------------------------
    // Tabs and their page scripts

    /** A reading tab's WebView; it gets the current page scripts now and on every change. Main thread. */
    public void addTab(WebView view, int tabId) {
        Tab tab = new Tab(tabId);
        synchronized (tabs) { tabs.put(view, tab); }
        install(view, tab);
    }

    public void removeTab(WebView view) {
        Tab tab;
        synchronized (tabs) { tab = tabs.remove(view); }
        if (tab != null) for (ScriptHandler handler : tab.scripts) handler.remove();
    }

    private Tab tab(WebView view) {
        synchronized (tabs) { return tabs.get(view); }
    }

    private void install(WebView view, Tab tab) {
        for (ScriptHandler handler : tab.scripts) handler.remove();
        tab.scripts.clear();
        if (WebViewFeature.isFeatureSupported(WebViewFeature.JS_INJECTION_IN_FRAME_AND_WORLD)) {
            // An isolated world keeps the scripts' globals and GM values away from the page's own scripts.
            JavaScriptExecutionWorld world = WebViewCompat.getExecutionWorld(view, WORLD);
            for (String source : sources) {
                try { tab.scripts.add(WebViewCompat.addJavaScriptOnEvent(view, source, WebViewCompat.INJECTION_EVENT_DOCUMENT_START, Collections.singleton("*"), world)); }
                catch (RuntimeException error) { Log.w(TAG, "A Tier 2 page script was refused: " + error.getMessage()); }
            }
        } else if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            for (String source : sources) {
                try { tab.scripts.add(WebViewCompat.addDocumentStartJavaScript(view, source, Collections.singleton("*"))); }
                catch (RuntimeException error) { Log.w(TAG, "A Tier 2 page script was refused: " + error.getMessage()); }
            }
        }
    }

    // ------------------------------------------------------------------
    // Requests (IO threads)

    /**
     * The resource type from what the callback carries: API 36 sends no
     * {@code Sec-Fetch-Dest}, so {@code Accept}, the main-frame flag, a
     * {@code Range} header and the path's extension decide.
     */
    static String resourceType(boolean mainFrame, Map<String, String> headers, String url) {
        String dest = header(headers, "Sec-Fetch-Dest");
        if (dest != null) {
            switch (dest) {
                case "document": return mainFrame ? "main_frame" : "sub_frame";
                case "iframe": case "frame": case "fencedframe": return "sub_frame";
                case "image": return "image";
                case "script": case "worker": case "sharedworker": case "serviceworker": return "script";
                case "style": return "stylesheet";
                case "font": return "font";
                case "audio": case "video": case "track": return "media";
                case "object": case "embed": return "object";
                case "report": return "csp_report";
                case "empty": return "xmlhttprequest";
                default: return "other";
            }
        }
        if (mainFrame) return "main_frame";
        String accept = header(headers, "Accept");
        accept = accept == null ? "" : accept.toLowerCase(Locale.ROOT);
        if (accept.contains("text/html") || accept.contains("application/xhtml")) return "sub_frame";
        if (accept.startsWith("image/")) return "image";
        if (accept.startsWith("text/css")) return "stylesheet";
        if (header(headers, "Range") != null) return "media";
        String path = url;
        int end = path.length();
        for (char stop : new char[] { '?', '#' }) { int at = path.indexOf(stop); if (at >= 0) end = Math.min(end, at); }
        path = path.substring(0, end).toLowerCase(Locale.ROOT);
        String extension = path.lastIndexOf('.') > path.lastIndexOf('/') ? path.substring(path.lastIndexOf('.') + 1) : "";
        switch (extension) {
            case "js": case "mjs": return "script";
            case "css": return "stylesheet";
            case "png": case "jpg": case "jpeg": case "gif": case "webp": case "avif": case "svg": case "ico": case "bmp": return "image";
            case "woff": case "woff2": case "ttf": case "otf": case "eot": return "font";
            case "mp4": case "webm": case "m4a": case "mp3": case "ogg": case "m3u8": case "mpd": case "ts": return "media";
            case "html": case "htm": return "sub_frame";
            default: break;
        }
        if (accept.contains("application/json") || accept.contains("text/event-stream")) return "xmlhttprequest";
        return "other";
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> entry : headers.entrySet()) {
            if (entry.getKey() != null && entry.getKey().equalsIgnoreCase(name)) return entry.getValue();
        }
        return null;
    }

    /** The response for a reading tab's request, or null to let it through. IO thread. */
    public WebResourceResponse intercept(WebView view, WebResourceRequest request) {
        Tab tab = tab(view);
        String url = request.getUrl().toString();
        if (tab == null || !(url.startsWith("http://") || url.startsWith("https://") || url.startsWith("ws://") || url.startsWith("wss://"))) return null;
        boolean mainFrame = request.isForMainFrame();
        String type = resourceType(mainFrame, request.getRequestHeaders(), url);
        if (LitePage.isExtensionUrl(url)) return mainFrame ? null : empty(403, "Forbidden");
        DnrEvaluator.Request details = new DnrEvaluator.Request(url, type, request.getMethod(), mainFrame ? null : tab.documentUrl,
            tab.tabId, mainFrame ? null : tab.frameAllow);
        DnrEvaluator.Result result = evaluator.evaluate(details);
        if (mainFrame) {
            tab.documentUrl = url;
            tab.frameAllow = result.allowAllRequests.isEmpty() ? Collections.emptyMap() : new HashMap<>(result.allowAllRequests);
        }
        DnrEvaluator.Decision decision = result.decision;
        switch (decision.outcome) {
            case BLOCK:
                return empty(403, "Forbidden");
            case REDIRECT:
            case UPGRADE_SCHEME:
                if (decision.extensionPath != null) return packaged(decision);
                return redirect(view, request, decision.redirectUrl, mainFrame);
            default:
                return null;
        }
    }

    static WebResourceResponse empty(int status, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason, Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
    }

    /** A redirect to the extension's own file: served from the package, readable cross-origin as a web-accessible resource. */
    private WebResourceResponse packaged(DnrEvaluator.Decision decision) {
        DnrEvaluator.Group owner = null;
        for (DnrEvaluator.Group group : evaluator.groups()) if (group.id.equals(decision.group)) owner = group;
        byte[] bytes = null;
        if (owner != null && owner.directory != null) {
            try { bytes = files.bytes(owner.directory, decision.extensionPath.substring(1)); } catch (IOException ignored) { bytes = null; }
        }
        if (bytes == null) return empty(403, "Forbidden");
        Map<String, String> headers = new HashMap<>();
        headers.put("Access-Control-Allow-Origin", "*");
        headers.put("Cache-Control", "no-cache");
        return new WebResourceResponse(BrokerView.mime(decision.extensionPath), "utf-8", 200, "OK", headers, new ByteArrayInputStream(bytes));
    }

    /**
     * WebView takes no 3xx from this callback: a top-level document is
     * navigated to the target instead, a subresource GET is fetched from it.
     */
    private WebResourceResponse redirect(WebView view, WebResourceRequest request, String target, boolean mainFrame) {
        if (target == null) return null;
        if (mainFrame) {
            main.post(() -> view.loadUrl(target));
            return empty(204, "No Content");
        }
        if (!"GET".equalsIgnoreCase(request.getMethod()) || target.startsWith("ws")) return empty(403, "Forbidden");
        try { return proxied(target, request.getRequestHeaders()); }
        catch (IOException error) { return empty(502, "Bad Gateway"); }
    }

    private static WebResourceResponse proxied(String target, Map<String, String> requestHeaders) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(target).openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        if (requestHeaders != null) for (Map.Entry<String, String> entry : requestHeaders.entrySet()) {
            if (entry.getKey() != null && !entry.getKey().equalsIgnoreCase("Accept-Encoding")) connection.setRequestProperty(entry.getKey(), entry.getValue());
        }
        String cookies = CookieManager.getInstance().getCookie(target);
        if (cookies != null) connection.setRequestProperty("Cookie", cookies);
        int status = connection.getResponseCode();
        InputStream body = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
        Map<String, String> headers = new HashMap<>();
        for (Map.Entry<String, List<String>> entry : connection.getHeaderFields().entrySet()) {
            if (entry.getKey() == null || entry.getValue().isEmpty()) continue;
            headers.put(entry.getKey(), String.join(", ", entry.getValue()));
        }
        String contentType = connection.getContentType();
        String mime = contentType == null ? "application/octet-stream" : contentType.split(";")[0].trim();
        String charset = contentType != null && contentType.toLowerCase(Locale.ROOT).contains("charset=")
            ? contentType.substring(contentType.toLowerCase(Locale.ROOT).indexOf("charset=") + 8).trim() : "utf-8";
        String reason = connection.getResponseMessage();
        return new WebResourceResponse(mime, charset, status, reason == null || reason.isEmpty() ? "OK" : reason, headers,
            body == null ? new ByteArrayInputStream(new byte[0]) : body);
    }

    // ------------------------------------------------------------------
    // Filter lists

    static JSONObject fetchList(String url) throws Exception {
        URL target = new URL(url);
        String protocol = target.getProtocol().toLowerCase(Locale.ROOT);
        if (!protocol.equals("https") && !protocol.equals("http")) throw new IOException("Only http(s) filter lists can be fetched");
        HttpURLConnection connection = (HttpURLConnection) target.openConnection();
        connection.setInstanceFollowRedirects(true);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setRequestProperty("User-Agent", "Once Lite filter lists");
        try {
            int status = connection.getResponseCode();
            JSONObject result = new JSONObject().put("status", status);
            if (status < 200 || status >= 300) return result;
            try (InputStream in = connection.getInputStream()) {
                result.put("text", new String(LiteFiles.readAll(in, LIST_LIMIT), StandardCharsets.UTF_8));
            }
            return result;
        } finally {
            connection.disconnect();
        }
    }
}
