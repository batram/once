package com.zmarn.once.devtools;

import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.os.Process;
import android.util.Log;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Chrome DevTools Protocol client for the app's own WebViews. Chromium serves
 * the protocol on the abstract Unix socket {@code webview_devtools_remote_<pid>}
 * once {@code WebView.setWebContentsDebuggingEnabled(true)} is set, and admits
 * the same uid, so the app attaches to its pages without adb: the privilege
 * boundary Once Lite's extension runtime builds on (docs/plans/once-lite-plan.md).
 *
 * One browser-level connection ({@code /devtools/browser}) with
 * {@code Target.setAutoAttach(flatten)} covers every WebView; commands name a
 * session. Events and command answers are delivered on the client's own
 * thread, never the UI thread. A dropped socket reconnects with backoff;
 * pending commands fail, attached sessions start over.
 */
public final class DevToolsClient {
    private static final String TAG = "OnceDevTools";
    private static final long CONNECT_TIMEOUT_MS = 5000;
    private static volatile DevToolsClient current;

    /** A protocol event: {@code sessionId} is null for browser-level events. */
    public interface Listener { void onEvent(String sessionId, String method, JSONObject params); }

    /** A target the browser attached for us, with its last known info. */
    public static final class Target {
        public final String targetId;
        public final String sessionId;
        public volatile String type;
        public volatile String url;
        public volatile String title;

        Target(String targetId, String sessionId, JSONObject info) {
            this.targetId = targetId;
            this.sessionId = sessionId;
            update(info);
        }

        void update(JSONObject info) {
            type = info.optString("type");
            url = info.optString("url");
            title = info.optString("title");
        }
    }

    private final String socketName;
    private final Object writeLock = new Object();
    private final AtomicLong ids = new AtomicLong();
    private final Map<Long, CompletableFuture<JSONObject>> pending = new ConcurrentHashMap<>();
    private final Map<String, Target> targets = new ConcurrentHashMap<>();
    private final List<Listener> listeners = new CopyOnWriteArrayList<>();
    private volatile WebSocket socket;
    private volatile boolean closed;
    private volatile boolean connected;
    private volatile String failure;
    /** Null until probed on the first page target; false when Fetch.enable is refused. */
    private volatile Boolean fetchSupported;
    private volatile CompletableFuture<Void> ready = new CompletableFuture<>();
    private final Thread thread;

    /** The client already connected (or connecting) for this process, else null. */
    public static DevToolsClient current() { return current; }

    /** Connects to this process's WebView socket; one client serves the process. */
    public static synchronized DevToolsClient connect() {
        if (current == null || current.closed) current = new DevToolsClient("webview_devtools_remote_" + Process.myPid());
        return current;
    }

    DevToolsClient(String socketName) {
        this.socketName = socketName;
        thread = new Thread(this::run, "once-devtools");
        thread.setDaemon(true);
        thread.start();
    }

    /** A client that never connects: Tier 2 forced for testing (see LiteExtensionEngine.devtoolsForcedOff). */
    private DevToolsClient(String socketName, String reason) {
        this.socketName = socketName;
        thread = new Thread(() -> {}, "once-devtools-off");
        closed = true;
        failure = reason;
        ready.completeExceptionally(new IOException(reason));
    }

    /** Not the process's client: {@link #current()} keeps answering the real one, if any. */
    public static DevToolsClient disabled(String reason) {
        return new DevToolsClient("webview_devtools_remote_" + Process.myPid(), reason);
    }

    /** Resolves once the browser connection is up and auto-attach is on; fails when the handshake does. */
    public CompletableFuture<Void> whenConnected() { return ready; }

    public boolean isConnected() { return connected; }

    /** Why the last connection attempt failed, for Settings' "extensions limited" explanation. */
    public String failure() { return failure; }

    /**
     * True while the protocol is usable for the runtime: connected, and the
     * {@code Fetch} domain accepted on a page target. False with no socket, a
     * failed handshake, or a WebView too old for request interception (Tier 2).
     */
    public boolean available() { return connected && !Boolean.FALSE.equals(fetchSupported); }

    public Boolean fetchSupported() { return fetchSupported; }

    public void addListener(Listener listener) { listeners.add(listener); }
    public void removeListener(Listener listener) { listeners.remove(listener); }

    /** Attached targets, in attachment order. */
    public List<Target> targets() { return new ArrayList<>(targets.values()); }

    /** Sends a command; {@code sessionId} null addresses the browser itself. */
    public CompletableFuture<JSONObject> send(String sessionId, String method, JSONObject params) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        WebSocket out = socket;
        if (!connected || out == null) {
            result.completeExceptionally(new IOException("DevTools is not connected" + (failure == null ? "" : ": " + failure)));
            return result;
        }
        long id = ids.incrementAndGet();
        pending.put(id, result);
        try {
            JSONObject message = new JSONObject().put("id", id).put("method", method);
            if (params != null) message.put("params", params);
            if (sessionId != null) message.put("sessionId", sessionId);
            synchronized (writeLock) { out.sendText(message.toString()); }
        } catch (Exception error) {
            pending.remove(id);
            result.completeExceptionally(error);
        }
        return result;
    }

    /** {@link #send} with the answer awaited; a protocol error becomes an exception naming it. */
    public JSONObject call(String sessionId, String method, JSONObject params, long timeoutMs) throws Exception {
        JSONObject reply = send(sessionId, method, params).get(timeoutMs, TimeUnit.MILLISECONDS);
        if (reply.has("error")) throw new IOException(method + " failed: " + reply.getJSONObject("error").optString("message"));
        return reply.optJSONObject("result") == null ? new JSONObject() : reply.getJSONObject("result");
    }

    /**
     * The page target of the WebView carrying {@code marker}: by the fragment of
     * its initial {@code about:blank#<marker>} load, or by the global the
     * document-start script sets ({@code window.__onceLiteTab}). Waits for the
     * target to attach, bounded.
     */
    public Target targetFor(String marker, long timeoutMs) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs);
        Map<String, Boolean> checked = new LinkedHashMap<>();
        while (System.nanoTime() < deadline) {
            for (Target target : targets.values()) {
                if (!"page".equals(target.type)) continue;
                if (target.url != null && target.url.endsWith("#" + marker)) return target;
                if (checked.containsKey(target.sessionId + target.url)) continue;
                checked.put(target.sessionId + target.url, true);
                try {
                    JSONObject result = call(target.sessionId, "Runtime.evaluate",
                        new JSONObject().put("expression", "window.__onceLiteTab").put("returnByValue", true), 2000);
                    if (marker.equals(result.optJSONObject("result") == null ? null : result.getJSONObject("result").optString("value"))) return target;
                } catch (Exception ignored) { /* no document yet; asked again when its url changes */ }
            }
            Thread.sleep(50);
        }
        throw new java.util.concurrent.TimeoutException("No DevTools target carries " + marker);
    }

    public void close() {
        closed = true;
        synchronized (DevToolsClient.class) { if (current == this) current = null; }
        WebSocket out = socket;
        if (out != null) out.close();
        thread.interrupt();
    }

    private void run() {
        long backoff = 1000;
        while (!closed) {
            try {
                WebSocket ws = open();
                socket = ws;
                connected = true;
                failure = null;
                backoff = 1000;
                Log.i(TAG, "connected to " + socketName);
                send(null, "Target.setAutoAttach", new JSONObject().put("autoAttach", true)
                    .put("waitForDebuggerOnStart", false).put("flatten", true))
                    .whenComplete((reply, error) -> {
                        if (error != null || reply.has("error")) { ready.completeExceptionally(new IOException("Target.setAutoAttach refused")); return; }
                        // Pages that existed before, and any the browser does not auto-attach, are attached by hand.
                        try { send(null, "Target.setDiscoverTargets", new JSONObject().put("discover", true)); }
                        catch (Exception ignored) { /* a constant document */ }
                        ready.complete(null);
                    });
                ws.read(this::dispatch);
                throw new IOException("socket closed");
            } catch (Exception error) {
                connected = false;
                socket = null;
                failure = error.getMessage();
                if (!closed) Log.w(TAG, "DevTools connection lost: " + failure);
                CompletableFuture<Void> was = ready;
                if (!was.isDone()) was.completeExceptionally(error);
                for (CompletableFuture<JSONObject> future : pending.values()) future.completeExceptionally(error);
                pending.clear();
                targets.clear();
                if (closed) return;
                ready = new CompletableFuture<>();
                try { Thread.sleep(backoff); } catch (InterruptedException interrupted) { return; }
                backoff = Math.min(backoff * 2, 15000);
            }
        }
    }

    private WebSocket open() throws IOException {
        // The version document names the browser endpoint; the path is all that matters on a Unix socket.
        String url;
        try { url = new JSONObject(httpGet("/json/version")).optString("webSocketDebuggerUrl", ""); }
        catch (org.json.JSONException error) { throw new IOException("Malformed /json/version", error); }
        int path = url.indexOf("/devtools/");
        if (path < 0) throw new IOException("No webSocketDebuggerUrl in /json/version");
        LocalSocket connection = connectSocket();
        return WebSocket.upgrade(connection, url.substring(path));
    }

    private LocalSocket connectSocket() throws IOException {
        LocalSocket connection = new LocalSocket();
        connection.connect(new LocalSocketAddress(socketName, LocalSocketAddress.Namespace.ABSTRACT));
        connection.setSoTimeout((int) CONNECT_TIMEOUT_MS);
        return connection;
    }

    /** Chromium keeps the connection open after answering, so the body is read by its Content-Length. */
    private String httpGet(String path) throws IOException {
        try (LocalSocket connection = connectSocket()) {
            connection.getOutputStream().write(("GET " + path + " HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
                .getBytes(java.nio.charset.StandardCharsets.US_ASCII));
            connection.getOutputStream().flush();
            java.io.InputStream in = connection.getInputStream();
            String status = readLine(in);
            if (!status.startsWith("HTTP/1.1 200")) throw new IOException("GET " + path + ": " + status);
            int length = -1;
            for (String header = readLine(in); !header.isEmpty(); header = readLine(in)) {
                int colon = header.indexOf(':');
                if (colon > 0 && header.substring(0, colon).trim().equalsIgnoreCase("Content-Length"))
                    length = Integer.parseInt(header.substring(colon + 1).trim());
            }
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            while (length < 0 || bytes.size() < length) {
                int read = in.read(buffer, 0, length < 0 ? buffer.length : Math.min(buffer.length, length - bytes.size()));
                if (read == -1) break;
                bytes.write(buffer, 0, read);
            }
            return bytes.toString("UTF-8");
        }
    }

    private static String readLine(java.io.InputStream in) throws IOException {
        java.io.ByteArrayOutputStream line = new java.io.ByteArrayOutputStream();
        for (int c; (c = in.read()) != -1; ) {
            if (c == '\n') break;
            if (c != '\r') line.write(c);
        }
        return line.toString("US-ASCII");
    }

    /** Runs on the client thread. */
    private void dispatch(String text) {
        JSONObject message;
        try { message = new JSONObject(text); } catch (Exception error) { return; }
        if (message.has("id")) {
            CompletableFuture<JSONObject> future = pending.remove(message.optLong("id"));
            if (future != null) future.complete(message);
            return;
        }
        String method = message.optString("method");
        JSONObject params = message.optJSONObject("params") == null ? new JSONObject() : message.optJSONObject("params");
        String sessionId = message.has("sessionId") ? message.optString("sessionId") : null;
        track(method, params);
        for (Listener listener : listeners) {
            try { listener.onEvent(sessionId, method, params); }
            catch (RuntimeException error) { Log.w(TAG, "DevTools listener failed on " + method, error); }
        }
    }

    private void track(String method, JSONObject params) {
        JSONObject info = params.optJSONObject("targetInfo");
        switch (method) {
            case "Target.attachedToTarget": {
                Target target = new Target(info.optString("targetId"), params.optString("sessionId"), info);
                targets.put(target.targetId, target);
                Log.d(TAG, "attached " + target.type + " target " + target.targetId + " " + target.url);
                if ("page".equals(target.type) && fetchSupported == null) probeFetch(target);
                break;
            }
            case "Target.targetCreated":
                if ("page".equals(info.optString("type")) && !info.optBoolean("attached") && !targets.containsKey(info.optString("targetId"))) {
                    try { send(null, "Target.attachToTarget", new JSONObject().put("targetId", info.optString("targetId")).put("flatten", true)); }
                    catch (Exception ignored) { /* reported by the attach itself */ }
                }
                break;
            case "Target.targetDestroyed":
                targets.remove(params.optString("targetId"));
                break;
            case "Target.detachedFromTarget":
                targets.remove(params.optString("targetId"));
                break;
            case "Target.targetInfoChanged": {
                Target target = targets.get(info.optString("targetId"));
                if (target != null) target.update(info);
                break;
            }
            default: break;
        }
    }

    /** Enables interception for a pattern no request matches, to learn whether the domain exists. */
    private void probeFetch(Target target) {
        try {
            JSONObject patterns = new JSONObject().put("patterns", new JSONArray().put(new JSONObject().put("urlPattern", "once-probe://*")));
            send(target.sessionId, "Fetch.enable", patterns).whenComplete((reply, error) -> {
                if (fetchSupported != null) return;
                fetchSupported = error == null && !reply.has("error");
                if (!fetchSupported) Log.w(TAG, "Fetch domain unavailable; extensions run in Tier 2");
                send(target.sessionId, "Fetch.disable", null);
            });
        } catch (Exception ignored) { /* the probe runs again on the next target */ }
    }
}
