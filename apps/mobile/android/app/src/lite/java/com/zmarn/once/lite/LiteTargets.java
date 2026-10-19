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
        /** World scripts installed on this target: world name → script identifier, with the source they carry. */
        final Map<String, String[]> worlds = new HashMap<>();
        final List<ScriptHandler> pageScripts = new ArrayList<>();
        /** The bridge world's and main helper's script identifiers on this target. */
        final List<String> bridgeScripts = new ArrayList<>();
        /** Paused requests by id, for the own-origin grant below. */
        final Map<String, String> paused = new ConcurrentHashMap<>();

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
    /** The bridge world and main helper sources, wrapped with the token; null until the bundles are read. */
    private final Supplier<String[]> bridgeSources;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "once-lite-targets");
        thread.setDaemon(true);
        return thread;
    });
    private final Map<String, Attachment> byMarker = new ConcurrentHashMap<>();
    private final Map<String, Attachment> byTarget = new ConcurrentHashMap<>();
    /** Events of a target whose `target.attached` is not out yet. */
    private final Map<String, List<JSONObject>> queued = new ConcurrentHashMap<>();
    private final Set<String> probing = ConcurrentHashMap.newKeySet();
    private volatile JSONArray registrations = new JSONArray();
    private volatile JSONArray pageRegistrations = new JSONArray();

    LiteTargets(Supplier<DevToolsClient> devtools, BrokerChannel channel, LiteCookies cookies, Supplier<String[]> bridgeSources) {
        this.devtools = devtools;
        this.channel = channel;
        this.cookies = cookies;
        this.bridgeSources = bridgeSources;
        channel.onRequest("cdp.command", (params, reply) -> {
            Attachment attachment = byTarget.get(params.optString("targetId"));
            if (attachment == null || attachment.target == null) { reply.reject("Unknown target " + params.optString("targetId")); return; }
            JSONObject command = params.optJSONObject("params");
            if (params.getString("method").startsWith("Fetch.") && command != null) command = grantOwnOrigin(attachment, params.getString("method"), command);
            devtools.get().send(attachment.target.sessionId, params.getString("method"), command).whenComplete((answer, error) -> {
                if (error != null) { reply.reject(error.getMessage()); return; }
                JSONObject failure = answer.optJSONObject("error");
                if (failure != null) { reply.reject(failure.optString("message", "DevTools error")); return; }
                JSONObject result = answer.optJSONObject("result");
                reply.resolve(result == null ? new JSONObject() : result);
            });
        });
        channel.onRequest("worlds.set", (params, reply) -> {
            JSONArray next = params.optJSONArray("registrations");
            registrations = next == null ? new JSONArray() : next;
            JSONArray pages = params.optJSONArray("pages");
            pageRegistrations = pages == null ? new JSONArray() : pages;
            worker.execute(() -> {
                for (Attachment attachment : byTarget.values()) if ("tab".equals(attachment.kind)) applyWorlds(attachment);
                reply.resolve(null);
            });
            main.post(() -> { for (Attachment attachment : byMarker.values()) if ("tab".equals(attachment.kind)) applyPageScripts(attachment); });
        });
    }

    boolean available() { DevToolsClient client = devtools.get(); return client != null && client.available(); }

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
        List<String> identifiers = new ArrayList<>(attachment.bridgeScripts);
        for (String[] world : attachment.worlds.values()) identifiers.add(world[0]);
        attachment.bridgeScripts.clear();
        attachment.worlds.clear();
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

    /** The connection dropped: every attachment starts over when its target is attached again. */
    void onDevToolsLost() {
        for (Attachment attachment : new ArrayList<>(byTarget.values())) detached(attachment.target == null ? "" : attachment.target.targetId);
        byTarget.clear();
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
        Attachment attachment = null;
        for (Attachment candidate : byTarget.values()) {
            if (candidate.target != null && sessionId.equals(candidate.target.sessionId)) { attachment = candidate; break; }
        }
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
        if (!FORWARDED.contains(method)) return;
        if ("Fetch.requestPaused".equals(method)) {
            JSONObject request = params.optJSONObject("request");
            if (attachment.paused.size() < 512) attachment.paused.put(params.optString("requestId"), request == null ? "" : request.optString("url"));
        }
        forward(attachment, method, params);
    }

    /**
     * Chromium sees `https://<host>.moz-extension.localhost` and `moz-extension://<host>`
     * as different origins, so an extension page's own XHR to a `moz-extension://`
     * URL the broker fulfils needs the page origin allowed; the broker grants
     * only `*` to other origins. Added here until the broker grants its own pages.
     */
    private JSONObject grantOwnOrigin(Attachment attachment, String method, JSONObject command) {
        String requestId = command.optString("requestId");
        String url = attachment.paused.remove(requestId);
        if (url != null && Log.isLoggable("OnceLiteFetch", Log.DEBUG)) Log.d("OnceLiteFetch", method + " " + url + " " + command.toString().substring(0, Math.min(160, command.toString().length())));
        if (!"Fetch.fulfillRequest".equals(method) || url == null || !url.startsWith("moz-extension://")) return command;
        try {
            String host = android.net.Uri.parse(url).getHost();
            JSONArray headers = command.optJSONArray("responseHeaders");
            if (host == null) return command;
            if (headers == null) command.put("responseHeaders", headers = new JSONArray());
            for (int index = 0; index < headers.length(); index++) {
                if ("access-control-allow-origin".equalsIgnoreCase(headers.getJSONObject(index).optString("name"))) return command;
            }
            headers.put(new JSONObject().put("name", "Access-Control-Allow-Origin").put("value", "https://" + host + LitePage.PAGE_HOST_SUFFIX));
        } catch (Exception ignored) { /* the command goes out as the broker wrote it */ }
        return command;
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
        if (!"page".equals(target.type) || byTarget.containsKey(target.targetId)) return;
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
        if (byTarget.putIfAbsent(target.targetId, attachment) != null) return;
        if (attachment.target != null && !attachment.target.targetId.equals(target.targetId)) detached(attachment.target.targetId);
        attachment.target = target;
        attachment.worlds.clear();
        queued.put(target.targetId, new ArrayList<>());
        worker.execute(() -> {
            JSONObject frameTree = null;
            if (!"broker".equals(attachment.kind)) {
                try {
                    DevToolsClient client = devtools.get();
                    client.call(target.sessionId, "Page.enable", null, COMMAND_TIMEOUT_MS);
                    client.call(target.sessionId, "Runtime.enable", null, COMMAND_TIMEOUT_MS);
                    client.call(target.sessionId, "Network.enable", null, COMMAND_TIMEOUT_MS);
                    client.call(target.sessionId, "Fetch.enable", new JSONObject().put("handleAuthRequests", false).put("patterns", new JSONArray()
                        .put(new JSONObject().put("urlPattern", "*").put("requestStage", "Request"))
                        .put(new JSONObject().put("urlPattern", "*").put("requestStage", "Response"))), COMMAND_TIMEOUT_MS);
                    if ("tab".equals(attachment.kind)) { installBridge(attachment); applyWorlds(attachment); }
                    frameTree = client.call(target.sessionId, "Page.getFrameTree", null, COMMAND_TIMEOUT_MS).optJSONObject("frameTree");
                } catch (Exception error) {
                    Log.w(TAG, "Could not enable DevTools domains on " + attachment.kind + " target: " + error.getMessage());
                }
            }
            if (attachment.target != target) return;
            Log.i(TAG, "target " + target.targetId + " bound to " + attachment.kind + (attachment.pageId == null ? "" : " " + attachment.pageId)
                + (attachment.tabId >= 0 ? " tab " + attachment.tabId : "") + " worlds=" + attachment.worlds.size());
            try {
                JSONObject params = new JSONObject().put("targetId", target.targetId).put("kind", attachment.kind);
                if ("tab".equals(attachment.kind)) params.put("tabId", attachment.tabId);
                if (attachment.pageId != null) params.put("pageId", attachment.pageId);
                if (frameTree != null) params.put("frameTree", frameTree);
                channel.event("target.attached", params);
            } catch (Exception ignored) { /* a constant document */ }
            List<JSONObject> backlog = queued.remove(target.targetId);
            if (backlog != null) synchronized (backlog) { for (JSONObject event : backlog) channel.event("cdp.event", event); }
            attachment.becameReady();
        });
    }

    private void detached(String targetId) {
        Attachment attachment = byTarget.remove(targetId);
        queued.remove(targetId);
        if (attachment == null) return;
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

    /** Installs the current registrations on a tab target, replacing changed ones and removing unlisted ones. On the worker. */
    private void applyWorlds(Attachment attachment) {
        DevToolsClient.Target target = attachment.target;
        if (target == null) return;
        DevToolsClient client = devtools.get();
        JSONArray wanted = registrations;
        Map<String, JSONObject> listed = new LinkedHashMap<>();
        for (int index = 0; index < wanted.length(); index++) {
            JSONObject registration = wanted.optJSONObject(index);
            if (registration != null) listed.put(registration.optString("worldName"), registration);
        }
        try {
            for (Map.Entry<String, String[]> installed : new ArrayList<>(attachment.worlds.entrySet())) {
                JSONObject registration = listed.get(installed.getKey());
                if (registration != null && registration.optString("source").equals(installed.getValue()[1])) continue;
                client.call(target.sessionId, "Page.removeScriptToEvaluateOnNewDocument", new JSONObject().put("identifier", installed.getValue()[0]), COMMAND_TIMEOUT_MS);
                attachment.worlds.remove(installed.getKey());
            }
            for (JSONObject registration : listed.values()) {
                String world = registration.optString("worldName");
                if (attachment.worlds.containsKey(world)) continue;
                client.call(target.sessionId, "Runtime.addBinding",
                    new JSONObject().put("name", registration.optString("binding")).put("executionContextName", world), COMMAND_TIMEOUT_MS);
                JSONObject added = client.call(target.sessionId, "Page.addScriptToEvaluateOnNewDocument",
                    new JSONObject().put("source", registration.optString("source")).put("worldName", world).put("runImmediately", true), COMMAND_TIMEOUT_MS);
                attachment.worlds.put(world, new String[] { added.optString("identifier"), registration.optString("source") });
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
        worker.shutdown();
    }
}
