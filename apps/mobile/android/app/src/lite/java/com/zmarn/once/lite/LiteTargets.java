package com.zmarn.once.lite;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.WebView;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.zmarn.once.devtools.DevToolsClient;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * The DevTools fan-out: every WebView the app registers is found among the
 * browser's page targets by its marker (the `about:blank#<marker>` it loads
 * first, or the `window.__onceLiteTab` global its document-start script sets),
 * gets the `Page`, `Runtime`, `Network` and `Fetch` domains enabled on its
 * session (per target, as LiteDevToolsTest proved; workers are not covered),
 * and has the listed events forwarded to the broker as `cdp.event`. The
 * broker's `cdp.command` runs on the named target's session. Tab targets also
 * carry the content-world registrations (`worlds.set`) and Once's own bridge
 * world, whose binding Java answers itself.
 */
public final class LiteTargets implements DevToolsClient.Listener {
    private static final String TAG = BrokerChannel.TAG;
    static final String MARKER_PREFIX = "about:blank#once-";
    static final String BRIDGE_BINDING = "onceLiteBridge";
    static final String BRIDGE_WORLD = "once-bridge";
    private static final long COMMAND_TIMEOUT_MS = 10000;
    private static final Set<String> FORWARDED = new HashSet<>(Arrays.asList(
        "Page.frameAttached", "Page.frameNavigated", "Page.frameDetached", "Page.navigatedWithinDocument",
        "Page.domContentEventFired", "Page.loadEventFired",
        "Runtime.executionContextCreated", "Runtime.executionContextDestroyed", "Runtime.executionContextsCleared", "Runtime.bindingCalled",
        "Network.requestWillBeSent", "Network.loadingFinished", "Network.loadingFailed", "Fetch.requestPaused"));

    /** What a tab's owner hears about its bridge world. */
    public interface BridgeListener {
        void bridgeCalled(int contextId, String payload);
        void contextDestroyed(int contextId);
        void contextsCleared();
    }

    /** A registered WebView's place among the targets. */
    public final class Attachment {
        final String marker;
        final String kind;
        final int tabId;
        final String pageId;
        final WebView view;
        final BridgeListener bridge;
        volatile DevToolsClient.Target target;
        volatile boolean ready;
        private final List<Runnable> waiting = new ArrayList<>();
        /** World scripts installed on this target: registration id → script identifier, with the source they carry. */
        final Map<String, String[]> worlds = new HashMap<>();
        /** Worlds whose binding this target already has. */
        final Set<String> bindings = new HashSet<>();
        final List<ScriptHandler> pageScripts = new ArrayList<>();
        /** The bridge world's and main helper's script identifiers on this target. */
        final List<String> bridgeScripts = new ArrayList<>();

        Attachment(String marker, String kind, int tabId, String pageId, WebView view, BridgeListener bridge) {
            this.marker = marker;
            this.kind = kind;
            this.tabId = tabId;
            this.pageId = pageId;
            this.view = view;
            this.bridge = bridge;
        }

        public String targetId() { DevToolsClient.Target current = target; return current == null ? null : current.targetId; }
        public boolean isReady() { return ready; }

        /** Runs `work` on the main thread once the target is enabled, or after `timeoutMs` without it. */
        public void whenReady(long timeoutMs, Runnable work) {
            main.post(() -> {
                if (ready || !available()) { work.run(); return; }
                Runnable once = new Runnable() {
                    private boolean done;
                    @Override public void run() { if (done) return; done = true; waiting.remove(this); work.run(); }
                };
                waiting.add(once);
                main.postDelayed(() -> {
                    if (waiting.contains(once)) Log.w(TAG, "Target for " + kind + " did not attach in time; proceeding without it");
                    once.run();
                }, timeoutMs);
            });
        }

        void becameReady() {
            ready = true;
            main.post(() -> { for (Runnable work : new ArrayList<>(waiting)) work.run(); });
        }

        /** Issues a command on this target's session, answer ignored. */
        void send(String method, JSONObject params) {
            DevToolsClient.Target current = target;
            if (current != null) devtools.get().send(current.sessionId, method, params);
        }
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Supplier<DevToolsClient> devtools;
    private final BrokerChannel channel;
    private final LiteCookies cookies;
    private final LiteFiles files;
    /** The bridge world and main helper sources, wrapped with the token; null until the bundles are read. */
    private final Supplier<String[]> bridgeSources;
    /**
     * Blocking DevTools calls, one task per target: a slow target (a renderer
     * busy with a heavy page) must not hold another tab's binding past its
     * load timeout. Each attachment's own work is serialised by its monitor.
     */
    private final ExecutorService worker = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "once-lite-targets");
        thread.setDaemon(true);
        return thread;
    });
    private final ExecutorService assetWorker = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "once-lite-assets");
        thread.setDaemon(true);
        return thread;
    });
    private final Map<String, Attachment> byMarker = new ConcurrentHashMap<>();
    private final Map<String, Attachment> byTarget = new ConcurrentHashMap<>();
    private final Map<String, Attachment> bySession = new ConcurrentHashMap<>();
    /** Events of a target whose `target.attached` is not out yet. */
    private final Map<String, List<JSONObject>> queued = new ConcurrentHashMap<>();
    private final Set<String> probing = ConcurrentHashMap.newKeySet();
    private volatile JSONArray registrations = new JSONArray();
    /**
     * Answers served from memory to content worlds' synchronous requests
     * (`sync.set`). Every WebView shares one renderer main thread, so a
     * request that blocks a tab can never be answered by the broker; it
     * prepares these before the document continues.
     */
    private final SyncAnswers syncAnswers = new SyncAnswers();
    private volatile JSONArray pageRegistrations = new JSONArray();
    /** Continues paused requests while the shared renderer cannot (a page's synchronous XHR, a JS dialog). */
    private final FetchWatchdog watchdog;

    LiteTargets(Supplier<DevToolsClient> devtools, BrokerChannel channel, LiteCookies cookies, LiteFiles files, Supplier<String[]> bridgeSources) {
        this.devtools = devtools;
        this.channel = channel;
        this.cookies = cookies;
        this.files = files;
        this.bridgeSources = bridgeSources;
        watchdog = new FetchWatchdog(new FetchWatchdog.Host() {
            @Override public long now() { return android.os.SystemClock.elapsedRealtime(); }
            @Override public void schedule(Runnable task, long delayMs) { main.postDelayed(task, delayMs); }
            @Override public void ping(long timeoutMs, java.util.function.Consumer<Boolean> answered) {
                java.util.concurrent.atomic.AtomicBoolean done = new java.util.concurrent.atomic.AtomicBoolean();
                Runnable late = () -> { if (done.compareAndSet(false, true)) answered.accept(false); };
                main.postDelayed(late, timeoutMs);
                channel.request("broker.ping", null).whenComplete((result, error) -> main.post(() -> {
                    main.removeCallbacks(late);
                    if (done.compareAndSet(false, true)) answered.accept(error == null);
                }));
            }
            @Override public void release(String targetId, String requestId, boolean responseStage) {
                Attachment attachment = byTarget.get(targetId);
                Log.w(TAG, "The broker did not answer a paused request in time (its renderer is blocked); continuing it");
                try {
                    JSONObject command = new JSONObject().put("requestId", requestId);
                    // A synchronous XHR blocks the shared renderer through its response too.
                    // Once released unchanged, do not pause it a second time for another watchdog cycle.
                    if (!responseStage) command.put("interceptResponse", false);
                    if (attachment != null) attachment.send("Fetch.continueRequest", command);
                }
                catch (Exception ignored) { /* a constant document */ }
            }
        });
        channel.onRequest("cdp.command", (params, reply) -> {
            Attachment attachment = byTarget.get(params.optString("targetId"));
            if (attachment == null || attachment.target == null) { reply.reject("Unknown target " + params.optString("targetId")); return; }
            JSONObject command = params.optJSONObject("params");
            String method = params.getString("method");
            if (method.startsWith("Fetch.") && command != null && command.has("requestId")
                && command.has("oncePause") && !watchdog.answered(params.optString("targetId"), command.optString("requestId"), command.optLong("oncePause"), !"Fetch.getResponseBody".equals(method) && !"Fetch.fulfillWithBody".equals(method))) {
                reply.reject("The request was released while the broker was blocked", "RELEASED");
                return;
            }
            if ("Fetch.fulfillExtensionAsset".equals(method)) {
                fulfillExtensionAsset(attachment, command, reply);
                return;
            }
            if ("Fetch.fulfillWithBody".equals(method)) {
                fulfillWithBody(attachment, command, reply);
                return;
            }
            if (command != null) command.remove("oncePause");
            if (Log.isLoggable("OnceLiteFetch", Log.DEBUG) && params.getString("method").startsWith("Fetch.") && command != null) {
                String text = command.toString();
                Log.d("OnceLiteFetch", params.getString("method") + " " + text.substring(0, Math.min(200, text.length())));
            }
            devtools.get().send(attachment.target.sessionId, params.getString("method"), command).whenComplete((answer, error) -> {
                if (error != null) { reply.reject(error.getMessage()); return; }
                JSONObject failure = answer.optJSONObject("error");
                if (failure != null) { reply.reject(failure.optString("message", "DevTools error")); return; }
                JSONObject result = answer.optJSONObject("result");
                reply.resolve(result == null ? new JSONObject() : result);
            });
        });
        channel.onRequest("sync.set", (params, reply) -> {
            String url = "https://" + params.optString("host") + LitePage.PAGE_HOST_SUFFIX + params.optString("path");
            syncAnswers.set(url, params.isNull("body") ? null : params.optString("body"), params.getString("targetId"), params.getString("frameId"));
            reply.resolve(null);
        });
        channel.onRequest("worlds.set", (params, reply) -> {
            JSONArray next = params.optJSONArray("registrations");
            registrations = next == null ? new JSONArray() : next;
            JSONArray pages = params.optJSONArray("pages");
            pageRegistrations = pages == null ? new JSONArray() : pages;
            List<java.util.concurrent.CompletableFuture<Void>> applied = new ArrayList<>();
            for (Attachment attachment : byTarget.values()) {
                if ("tab".equals(attachment.kind)) applied.add(java.util.concurrent.CompletableFuture.runAsync(() -> applyWorlds(attachment, false), worker));
            }
            java.util.concurrent.CompletableFuture.allOf(applied.toArray(new java.util.concurrent.CompletableFuture[0]))
                .whenComplete((ignored, error) -> reply.resolve(null));
            main.post(() -> { for (Attachment attachment : byMarker.values()) if ("tab".equals(attachment.kind)) applyPageScripts(attachment); });
        });
    }

    /** The trusted broker has authorized this exact request; read bytes off the UI thread. */
    private void fulfillExtensionAsset(Attachment attachment, JSONObject command, BrokerChannel.Reply reply) throws Exception {
        DevToolsClient.Target target = attachment.target;
        String directory = command.getString("directory");
        String path = command.getString("path");
        assetWorker.execute(() -> {
            try {
                byte[] body = files.bytes(directory, path);
                JSONObject response = ExtensionAssetResponse.create(command, body);
                if (attachment.target != target || byTarget.get(target.targetId) != attachment) {
                    reply.reject("The asset target was detached", "RELEASED");
                    return;
                }
                devtools.get().send(target.sessionId, "Fetch.fulfillRequest", response).whenComplete((answer, error) -> {
                    if (error != null) reply.reject(error.getMessage());
                    else if (answer.has("error")) reply.reject(answer.optJSONObject("error").optString("message"));
                    else reply.resolve(null);
                });
            } catch (Exception error) { reply.reject(error.getMessage()); }
        });
    }

    /** Keep unchanged CSP document bodies on the native CDP transport, out of the broker renderer. */
    private void fulfillWithBody(Attachment attachment, JSONObject command, BrokerChannel.Reply reply) throws Exception {
        DevToolsClient.Target target = attachment.target;
        String requestId = command.getString("requestId");
        long generation = command.optLong("oncePause");
        JSONObject read = new JSONObject().put("requestId", requestId);
        devtools.get().send(target.sessionId, "Fetch.getResponseBody", read).whenCompleteAsync((answer, error) -> {
            if (error != null) { reply.reject(error.getMessage()); return; }
            if (answer.has("error")) { reply.reject(answer.optJSONObject("error").optString("message")); return; }
            try {
                JSONObject result = answer.getJSONObject("result");
                String body = result.getString("body");
                if (!result.optBoolean("base64Encoded")) body = android.util.Base64.encodeToString(
                    body.getBytes(java.nio.charset.StandardCharsets.UTF_8), android.util.Base64.NO_WRAP);
                if (attachment.target != target || !watchdog.answered(target.targetId, requestId, generation, true)) {
                    reply.reject("The document pause was released", "RELEASED"); return;
                }
                command.remove("oncePause");
                command.put("body", body);
                devtools.get().send(target.sessionId, "Fetch.fulfillRequest", command).whenComplete((fulfilled, failure) -> {
                    if (failure != null) reply.reject(failure.getMessage());
                    else if (fulfilled.has("error")) reply.reject(fulfilled.optJSONObject("error").optString("message"));
                    else reply.resolve(null);
                });
            } catch (Exception failure) { reply.reject(failure.getMessage()); }
        }, worker);
    }

    /** Set in Tier 2: targets are left alone, so nothing pauses requests Java enforces itself. */
    private volatile boolean passive;
    private volatile boolean recoveringBroker;

    void resetBroker() {
        recoveringBroker = true;
        syncAnswers.clear();
        for (Attachment attachment : new ArrayList<>(byTarget.values())) {
            DevToolsClient.Target target = attachment.target;
            if (target == null || !"tab".equals(attachment.kind)) continue;
            removeInstalled(attachment, target);
            detached(target.targetId);
        }
    }

    void brokerReady() {
        recoveringBroker = false;
        for (DevToolsClient.Target target : devtools.get().targets()) consider(target);
    }

    boolean available() { DevToolsClient client = devtools.get(); return !passive && client != null && client.available(); }

    void setPassive(boolean passive) {
        this.passive = passive;
        if (!passive) return;
        for (Attachment attachment : new ArrayList<>(byTarget.values())) {
            if (attachment.target == null || "broker".equals(attachment.kind)) continue;
            attachment.send("Fetch.disable", null);
            detached(attachment.target.targetId);
        }
    }

    public static boolean isMarkerUrl(String url) { return url != null && url.startsWith(MARKER_PREFIX); }

    /**
     * Registers a WebView. `loadMarker` loads `about:blank#<marker>` so the
     * target is found before the first real document (and its requests pass
     * through Fetch); a window Chromium opened itself is found by its global.
     */
    public Attachment register(WebView view, String marker, String kind, int tabId, String pageId, BridgeListener bridge, boolean loadMarker) {
        Attachment attachment = new Attachment(marker, kind, tabId, pageId, view, bridge);
        byMarker.put(marker, attachment);
        if (loadMarker) view.loadUrl("about:blank#" + marker);
        if ("tab".equals(kind)) applyPageScripts(attachment);
        DevToolsClient client = devtools.get();
        if (client != null) for (DevToolsClient.Target target : client.targets()) consider(target);
        return attachment;
    }

    public void unregister(Attachment attachment) {
        byMarker.remove(attachment.marker);
        DevToolsClient.Target target = attachment.target;
        if (target != null) { removeInstalled(attachment, target); detached(target.targetId); }
        main.post(() -> { for (ScriptHandler handler : attachment.pageScripts) handler.remove(); attachment.pageScripts.clear(); });
    }

    /** Takes the world and bridge scripts off a target this engine installed them on, so a later engine starts clean. */
    private void removeInstalled(Attachment attachment, DevToolsClient.Target target) {
        List<String> identifiers;
        synchronized (attachment) {
            identifiers = new ArrayList<>(attachment.bridgeScripts);
            for (String[] world : attachment.worlds.values()) identifiers.add(world[0]);
            attachment.bridgeScripts.clear();
            attachment.worlds.clear();
        }
        if (identifiers.isEmpty()) return;
        worker.execute(() -> {
            for (String identifier : identifiers) {
                try { devtools.get().call(target.sessionId, "Page.removeScriptToEvaluateOnNewDocument", new JSONObject().put("identifier", identifier), COMMAND_TIMEOUT_MS); }
                catch (Exception ignored) { /* the target is gone with its scripts */ }
            }
        });
    }

    void onDevToolsConnected() {
        DevToolsClient client = devtools.get();
        if (client != null) client.addListener(this);
    }

    /**
     * The connection dropped: every attachment starts over when its target is
     * attached again (auto-attach brings them back with new sessions), its
     * worlds and bridge re-installed in the live document, where they greet
     * the broker again rather than boot twice.
     */
    @Override
    public void onDisconnected() {
        for (Attachment attachment : new ArrayList<>(byTarget.values())) {
            DevToolsClient.Target target = attachment.target;
            if (target != null) detached(target.targetId);
        }
        byTarget.clear();
        bySession.clear();
        probing.clear();
    }

    @Override
    public void onEvent(String sessionId, String method, JSONObject params) {
        switch (method) {
            case "Target.attachedToTarget": {
                DevToolsClient.Target target = devtools.get().targets().stream()
                    .filter(candidate -> candidate.sessionId.equals(params.optString("sessionId"))).findFirst().orElse(null);
                if (target != null) consider(target);
                return;
            }
            case "Target.targetInfoChanged": {
                JSONObject info = params.optJSONObject("targetInfo");
                if (info == null) return;
                for (DevToolsClient.Target target : devtools.get().targets()) if (target.targetId.equals(info.optString("targetId"))) consider(target);
                return;
            }
            case "Target.detachedFromTarget": case "Target.targetDestroyed":
                detached(params.optString("targetId"));
                return;
            default: break;
        }
        if (sessionId == null) return;
        Attachment attachment = bySession.get(sessionId);
        if (attachment == null) return;
        if ("Network.responseReceivedExtraInfo".equals(method)) {
            JSONObject headers = params.optJSONObject("headers");
            if (headers != null && (headers.has("set-cookie") || headers.has("Set-Cookie"))) cookies.responseSetCookie();
            return;
        }
        if ("Runtime.bindingCalled".equals(method) && BRIDGE_BINDING.equals(params.optString("name"))) {
            if (attachment.bridge != null) attachment.bridge.bridgeCalled(params.optInt("executionContextId"), params.optString("payload"));
            return;
        }
        if (attachment.bridge != null) {
            if ("Runtime.executionContextDestroyed".equals(method)) attachment.bridge.contextDestroyed(params.optInt("executionContextId"));
            else if ("Runtime.executionContextsCleared".equals(method)) attachment.bridge.contextsCleared();
        }
        if ("Page.frameDetached".equals(method)) syncAnswers.forgetFrame(attachment.target.targetId, params.optString("frameId"));
        if (!FORWARDED.contains(method)) return;
        // The broker reads requestWillBeSent for redirects only; the rest (with initiator stacks) stays here.
        if ("Network.requestWillBeSent".equals(method) && !params.has("redirectResponse")) return;
        if ("Fetch.requestPaused".equals(method)) {
            if (answerSynchronously(attachment, params)) return;
            // An extension's own URL only the broker can serve (from its package): continuing it would send it to the network.
            JSONObject paused = params.optJSONObject("request");
            if ("Document".equals(params.optString("resourceType")) && !params.has("responseStatusCode") && !params.has("responseErrorReason")) {
                syncAnswers.forgetFrame(attachment.target.targetId, params.optString("frameId"));
            }
            if (paused == null || !LitePage.isExtensionUrl(paused.optString("url"))) {
                try { params.put("oncePause", watchdog.paused(attachment.target.targetId, params.optString("requestId"), params.has("responseStatusCode") || params.has("responseErrorReason"))); }
                catch (org.json.JSONException error) { throw new IllegalStateException(error); }
            }
        }
        if ("Fetch.requestPaused".equals(method) && Log.isLoggable("OnceLiteFetch", Log.DEBUG)) {
            JSONObject request = params.optJSONObject("request");
            Log.d("OnceLiteFetch", "paused " + (request == null ? "" : request.optString("url")) + " " + params.optString("resourceType")
                + (params.has("responseStatusCode") ? " response " + params.optInt("responseStatusCode") : ""));
        }
        forward(attachment, method, params);
    }

    /**
     * A world's synchronous request for a prepared answer, fulfilled here;
     * true when it was one. Only the document named in `u` may read it, so a
     * request from another origin is refused without taking the answer.
     */
    private boolean answerSynchronously(Attachment attachment, JSONObject params) {
        JSONObject request = params.optJSONObject("request");
        String url = request == null ? "" : request.optString("url");
        if (!SyncAnswers.isSyncRequest(url) || params.has("responseStatusCode") || params.has("responseErrorReason")) return false;
        String origin = SyncAnswers.allowedOrigin(url, header(request.optJSONObject("headers"), "Origin"));
        String body = origin == null ? null : syncAnswers.take(url, attachment.target.targetId, params.optString("frameId"));
        try {
            JSONObject command = new JSONObject().put("requestId", params.optString("requestId"));
            JSONArray headers = new JSONArray().put(new JSONObject().put("name", "Cache-Control").put("value", "no-store"));
            if (origin != null) headers.put(new JSONObject().put("name", "Access-Control-Allow-Origin").put("value", origin));
            if (body == null) {
                command.put("responseCode", 404).put("responseHeaders", headers);
            } else {
                headers.put(new JSONObject().put("name", "Content-Type").put("value", "application/json; charset=utf-8"));
                command.put("responseCode", 200).put("responseHeaders", headers)
                    .put("body", android.util.Base64.encodeToString(body.getBytes(java.nio.charset.StandardCharsets.UTF_8), android.util.Base64.NO_WRAP));
            }
            attachment.send("Fetch.fulfillRequest", command);
            if (Log.isLoggable("OnceLiteFetch", Log.DEBUG)) Log.d("OnceLiteFetch", "answered a synchronous request" + (body == null ? " (none)" : " " + body.length() + " chars"));
        } catch (Exception error) { Log.w(TAG, "Could not answer a synchronous request", error); }
        return true;
    }

    /** A request header by name, whatever its case. */
    static String header(JSONObject headers, String name) {
        if (headers == null) return null;
        for (java.util.Iterator<String> keys = headers.keys(); keys.hasNext(); ) {
            String key = keys.next();
            if (key.equalsIgnoreCase(name)) return headers.optString(key);
        }
        return null;
    }

    private void forward(Attachment attachment, String method, JSONObject params) {
        try {
            JSONObject event = new JSONObject().put("targetId", attachment.target.targetId).put("method", method).put("params", params);
            List<JSONObject> backlog = queued.get(attachment.target.targetId);
            if (backlog != null) { synchronized (backlog) { backlog.add(event); } return; }
            channel.event("cdp.event", event);
        } catch (Exception error) { Log.w(TAG, "Could not forward " + method, error); }
    }

    /** A page target whose marker is known, by its URL fragment, else by asking the document. */
    private void consider(DevToolsClient.Target target) {
        if (passive || !"page".equals(target.type) || byTarget.containsKey(target.targetId)) return;
        String url = target.url == null ? "" : target.url;
        int hash = url.indexOf('#');
        if (hash >= 0) {
            Attachment attachment = byMarker.get(url.substring(hash + 1));
            if (attachment != null) { bind(target, attachment); return; }
        }
        if (url.isEmpty() || url.startsWith("about:blank") || !probing.add(target.targetId + "|" + url)) return;
        worker.execute(() -> {
            try {
                JSONObject result = devtools.get().call(target.sessionId, "Runtime.evaluate",
                    new JSONObject().put("expression", "window.__onceLiteTab").put("returnByValue", true), 2000);
                JSONObject value = result.optJSONObject("result");
                Attachment attachment = value == null ? null : byMarker.get(value.optString("value"));
                if (attachment != null && !byTarget.containsKey(target.targetId)) bind(target, attachment);
            } catch (Exception ignored) { /* not one of ours, or no document yet */ }
        });
    }

    private void bind(DevToolsClient.Target target, Attachment attachment) {
        if (recoveringBroker && "tab".equals(attachment.kind)) return;
        if (byTarget.putIfAbsent(target.targetId, attachment) != null) return;
        if (attachment.target != null && !attachment.target.targetId.equals(target.targetId)) detached(attachment.target.targetId);
        attachment.target = target;
        bySession.put(target.sessionId, attachment);
        synchronized (attachment) {
            attachment.worlds.clear();
            attachment.bindings.clear();
        }
        queued.put(target.targetId, new ArrayList<>());
        worker.execute(() -> { synchronized (attachment) {
            JSONObject frameTree = null;
            boolean enabled = false;
            if (!"broker".equals(attachment.kind)) {
                try {
                    DevToolsClient client = devtools.get();
                    client.call(target.sessionId, "Page.enable", null, COMMAND_TIMEOUT_MS);
                    client.call(target.sessionId, "Runtime.enable", null, COMMAND_TIMEOUT_MS);
                    // Bodies are read through Fetch; Network keeps little of them in the renderer.
                    client.call(target.sessionId, "Network.enable", new JSONObject().put("maxTotalBufferSize", 1024 * 1024)
                        .put("maxResourceBufferSize", 256 * 1024), COMMAND_TIMEOUT_MS);
                    client.call(target.sessionId, "Fetch.enable", new JSONObject().put("handleAuthRequests", false).put("patterns", new JSONArray()
                        .put(new JSONObject().put("urlPattern", "*").put("requestStage", "Request"))
                        .put(new JSONObject().put("urlPattern", "*").put("requestStage", "Response"))), COMMAND_TIMEOUT_MS);
                    frameTree = client.call(target.sessionId, "Page.getFrameTree", null, COMMAND_TIMEOUT_MS).optJSONObject("frameTree");
                    enabled = true;
                } catch (Exception error) {
                    Log.w(TAG, "Could not enable DevTools domains on " + attachment.kind + " target: " + error.getMessage());
                }
            }
            if (attachment.target != target) return;
            // The broker hears the target and its queued events before the
            // world scripts go in: a script run immediately may ask the
            // broker something synchronously (a world's registered scripts),
            // which the broker can answer only once it knows the target.
            try {
                JSONObject params = new JSONObject().put("targetId", target.targetId).put("kind", attachment.kind);
                if ("tab".equals(attachment.kind)) params.put("tabId", attachment.tabId);
                if (attachment.pageId != null) params.put("pageId", attachment.pageId);
                if (frameTree != null) params.put("frameTree", frameTree);
                channel.event("target.attached", params);
            } catch (Exception ignored) { /* a constant document */ }
            List<JSONObject> backlog = queued.remove(target.targetId);
            if (backlog != null) synchronized (backlog) { for (JSONObject event : backlog) channel.event("cdp.event", event); }
            if (enabled && "tab".equals(attachment.kind)) {
                try { installBridge(attachment); } catch (Exception error) { Log.w(TAG, "Could not install the bridge world: " + error.getMessage()); }
                applyWorlds(attachment, true);
            }
            if (attachment.target != target) return;
            Log.i(TAG, "target " + target.targetId + " bound to " + attachment.kind + (attachment.pageId == null ? "" : " " + attachment.pageId)
                + (attachment.tabId >= 0 ? " tab " + attachment.tabId : "") + " worlds=" + attachment.worlds.size());
            attachment.becameReady();
        } });
    }

    private void detached(String targetId) {
        Attachment attachment = byTarget.remove(targetId);
        queued.remove(targetId);
        watchdog.forgetTarget(targetId);
        syncAnswers.forgetTarget(targetId);
        if (attachment == null) return;
        if (attachment.target != null) bySession.remove(attachment.target.sessionId, attachment);
        if (attachment.target != null && attachment.target.targetId.equals(targetId)) { attachment.target = null; attachment.ready = false; }
        if (attachment.bridge != null) attachment.bridge.contextsCleared();
        try { channel.event("target.detached", new JSONObject().put("targetId", targetId)); }
        catch (Exception ignored) { /* a constant document */ }
    }

    /** Once's bridge world and main-world helper, before any world of an extension. */
    private void installBridge(Attachment attachment) throws Exception {
        String[] sources = bridgeSources.get();
        if (sources == null) return;
        DevToolsClient client = devtools.get();
        String session = attachment.target.sessionId;
        client.call(session, "Runtime.addBinding", new JSONObject().put("name", BRIDGE_BINDING).put("executionContextName", BRIDGE_WORLD), COMMAND_TIMEOUT_MS);
        if (sources[0] != null) attachment.bridgeScripts.add(client.call(session, "Page.addScriptToEvaluateOnNewDocument",
            new JSONObject().put("source", sources[0]).put("worldName", BRIDGE_WORLD).put("runImmediately", true), COMMAND_TIMEOUT_MS).optString("identifier"));
        if (sources[1] != null) attachment.bridgeScripts.add(client.call(session, "Page.addScriptToEvaluateOnNewDocument",
            new JSONObject().put("source", sources[1]).put("runImmediately", true), COMMAND_TIMEOUT_MS).optString("identifier"));
    }

    /**
     * Installs the current registrations on a tab target, replacing changed
     * ones and removing unlisted ones. On the worker. Only a freshly bound
     * target runs the scripts in its current document (`runImmediately`): a
     * change reaches the next document, as on Electron, and never boots a
     * world twice.
     */
    private void applyWorlds(Attachment attachment, boolean fresh) {
        synchronized (attachment) { applyWorldsLocked(attachment, fresh); }
    }

    private void applyWorldsLocked(Attachment attachment, boolean fresh) {
        DevToolsClient.Target target = attachment.target;
        if (target == null) return;
        DevToolsClient client = devtools.get();
        JSONArray wanted = registrations;
        Map<String, JSONObject> listed = new LinkedHashMap<>();
        for (int index = 0; index < wanted.length(); index++) {
            JSONObject registration = wanted.optJSONObject(index);
            if (registration != null) listed.put(registration.optString("id", registration.optString("worldName")), registration);
        }
        try {
            for (Map.Entry<String, String[]> installed : new ArrayList<>(attachment.worlds.entrySet())) {
                JSONObject registration = listed.get(installed.getKey());
                if (registration != null && registration.optString("source").equals(installed.getValue()[1])) continue;
                client.call(target.sessionId, "Page.removeScriptToEvaluateOnNewDocument", new JSONObject().put("identifier", installed.getValue()[0]), COMMAND_TIMEOUT_MS);
                attachment.worlds.remove(installed.getKey());
            }
            for (Map.Entry<String, JSONObject> entry : listed.entrySet()) {
                if (attachment.worlds.containsKey(entry.getKey())) continue;
                JSONObject registration = entry.getValue();
                String world = registration.optString("worldName");
                if (attachment.bindings.add(world)) {
                    client.call(target.sessionId, "Runtime.addBinding",
                        new JSONObject().put("name", registration.optString("binding")).put("executionContextName", world), COMMAND_TIMEOUT_MS);
                }
                JSONObject added = client.call(target.sessionId, "Page.addScriptToEvaluateOnNewDocument",
                    new JSONObject().put("source", registration.optString("source")).put("worldName", world).put("runImmediately", fresh), COMMAND_TIMEOUT_MS);
                attachment.worlds.put(entry.getKey(), new String[] { added.optString("identifier"), registration.optString("source") });
            }
        } catch (Exception error) {
            if (attachment.target == target) Log.w(TAG, "World registration failed on tab target: " + error.getMessage());
        }
    }

    /** The page bootstrap for extension frames inside tab WebViews (`pages` of `worlds.set`), on the main thread. */
    private void applyPageScripts(Attachment attachment) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return;
        for (ScriptHandler handler : attachment.pageScripts) handler.remove();
        attachment.pageScripts.clear();
        JSONArray pages = pageRegistrations;
        for (int index = 0; index < pages.length(); index++) {
            JSONObject page = pages.optJSONObject(index);
            if (page == null || page.optString("origin").isEmpty()) continue;
            try {
                attachment.pageScripts.add(WebViewCompat.addDocumentStartJavaScript(attachment.view,
                    page.optString("documentStartSource"), Collections.singleton(page.optString("origin"))));
            } catch (RuntimeException error) { Log.w(TAG, "Could not install the page bootstrap on a tab", error); }
        }
    }

    void close() {
        for (Attachment attachment : new ArrayList<>(byTarget.values())) if (attachment.target != null) removeInstalled(attachment, attachment.target);
        byTarget.clear();
        bySession.clear();
        worker.shutdown();
        assetWorker.shutdown();
    }
}
