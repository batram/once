package com.zmarn.once.lite;

import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import com.zmarn.once.devtools.DevToolsClient;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Supplier;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * `browser.cookies` for the broker. The jar is one profile shared by every
 * WebView, so reads go through DevTools on the browser target
 * (`Storage.getCookies`, or `Network.getCookies` with a URL on the broker's
 * own session), writes through `CookieManager`, removals through
 * `Network.deleteCookies`. Changes are found by comparing the jar after each
 * write and after a response carried `set-cookie` (`cookies.changed`).
 */
final class LiteCookies {
    private static final long COMMAND_TIMEOUT_MS = 5000;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Supplier<DevToolsClient> devtools;
    /** The broker page's session, which has the Network domain for URL-scoped reads. */
    private final Supplier<String> session;
    private BrokerChannel channel;
    /** The jar as last compared; only the worker touches it. */
    private Map<String, JSONObject> known;
    private final Runnable diff = this::diffJar;
    /**
     * One thread for every DevTools call and jar comparison: comparisons run
     * one after another (never two racing over `known`), and a burst of
     * `set-cookie` responses queues at most one more.
     */
    private final java.util.concurrent.ExecutorService worker = java.util.concurrent.Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "once-lite-cookies");
        thread.setDaemon(true);
        return thread;
    });
    private final java.util.concurrent.atomic.AtomicBoolean diffQueued = new java.util.concurrent.atomic.AtomicBoolean();

    LiteCookies(Supplier<DevToolsClient> devtools, Supplier<String> session) {
        this.devtools = devtools;
        this.session = session;
    }

    void register(BrokerChannel channel) {
        this.channel = channel;
        channel.onRequest("cookies.get", (params, reply) -> run(reply, () -> {
            JSONArray cookies = params.has("url") && !params.isNull("url")
                ? call(session.get(), "Network.getCookies", new JSONObject().put("urls", new JSONArray().put(params.getString("url")))).optJSONArray("cookies")
                : all();
            JSONArray matching = new JSONArray();
            if (cookies != null) for (int index = 0; index < cookies.length(); index++) {
                JSONObject cookie = cookies.getJSONObject(index);
                if (matches(cookie, params)) matching.put(cookie);
            }
            return new JSONObject().put("cookies", matching);
        }));
        channel.onRequest("cookies.set", (params, reply) -> run(reply, () -> {
            CookieManager manager = CookieManager.getInstance();
            manager.setCookie(params.getString("url"), setCookieLine(params));
            manager.flush();
            scheduleDiff();
            return null;
        }));
        channel.onRequest("cookies.remove", (params, reply) -> run(reply, () -> {
            call(session.get(), "Network.deleteCookies", new JSONObject().put("name", params.getString("name")).put("url", params.getString("url")));
            scheduleDiff();
            return null;
        }));
    }

    /** A response set cookies: compare the jar soon. */
    void responseSetCookie() { scheduleDiff(); }

    private interface Work { Object run() throws Exception; }

    private void run(BrokerChannel.Reply reply, Work work) {
        worker.execute(() -> {
            try { reply.resolve(work.run()); }
            catch (Exception error) { reply.reject(error.getMessage() == null ? error.toString() : error.getMessage()); }
        });
    }

    private JSONObject call(String sessionId, String method, JSONObject params) throws Exception {
        DevToolsClient client = devtools.get();
        if (client == null || !client.isConnected()) throw new IllegalStateException("DevTools is not connected");
        return client.call(sessionId, method, params, COMMAND_TIMEOUT_MS);
    }

    private JSONArray all() throws Exception {
        JSONArray cookies = call(null, "Storage.getCookies", new JSONObject()).optJSONArray("cookies");
        return cookies == null ? new JSONArray() : cookies;
    }

    static boolean matches(JSONObject cookie, JSONObject query) {
        if (query.has("name") && !query.isNull("name") && !cookie.optString("name").equals(query.optString("name"))) return false;
        if (query.has("domain") && !query.isNull("domain")) {
            String wanted = query.optString("domain").toLowerCase(java.util.Locale.ROOT).replaceFirst("^\\.", "");
            String domain = cookie.optString("domain").toLowerCase(java.util.Locale.ROOT).replaceFirst("^\\.", "");
            if (!domain.equals(wanted) && !domain.endsWith("." + wanted)) return false;
        }
        if (query.has("path") && !query.isNull("path") && !cookie.optString("path").equals(query.optString("path"))) return false;
        if (query.has("secure") && !query.isNull("secure") && cookie.optBoolean("secure") != query.optBoolean("secure")) return false;
        if (query.has("session") && !query.isNull("session") && cookie.optBoolean("session") != query.optBoolean("session")) return false;
        return true;
    }

    static String setCookieLine(JSONObject details) {
        StringBuilder line = new StringBuilder();
        line.append(details.optString("name", "")).append('=').append(details.optString("value", ""));
        if (details.has("domain") && !details.isNull("domain")) line.append("; Domain=").append(details.optString("domain"));
        line.append("; Path=").append(details.has("path") && !details.isNull("path") ? details.optString("path") : "/");
        if (details.optBoolean("secure")) line.append("; Secure");
        if (details.optBoolean("httpOnly")) line.append("; HttpOnly");
        if (details.has("expirationDate") && !details.isNull("expirationDate")) {
            long seconds = (long) details.optDouble("expirationDate");
            line.append("; Max-Age=").append(Math.max(0, seconds - System.currentTimeMillis() / 1000));
        }
        String sameSite = details.optString("sameSite", "");
        if ("strict".equals(sameSite)) line.append("; SameSite=Strict");
        else if ("lax".equals(sameSite)) line.append("; SameSite=Lax");
        else if ("no_restriction".equals(sameSite)) line.append("; SameSite=None");
        return line.toString();
    }

    private void scheduleDiff() {
        main.removeCallbacks(diff);
        main.postDelayed(diff, 250);
    }

    private void diffJar() {
        if (!diffQueued.compareAndSet(false, true)) return;
        worker.execute(() -> {
            diffQueued.set(false);
            try {
                JSONArray cookies = all();
                Map<String, JSONObject> current = new HashMap<>();
                for (int index = 0; index < cookies.length(); index++) {
                    JSONObject cookie = cookies.getJSONObject(index);
                    current.put(cookie.optString("domain") + "|" + cookie.optString("path") + "|" + cookie.optString("name"), cookie);
                }
                Map<String, JSONObject> previous = known;
                known = current;
                if (previous == null || channel == null) return;
                for (Map.Entry<String, JSONObject> entry : previous.entrySet()) {
                    JSONObject now = current.get(entry.getKey());
                    if (now == null) channel.event("cookies.changed", new JSONObject().put("removed", true).put("cookie", entry.getValue()).put("cause", "explicit"));
                    else if (!now.toString().equals(entry.getValue().toString())) {
                        channel.event("cookies.changed", new JSONObject().put("removed", true).put("cookie", entry.getValue()).put("cause", "overwrite"));
                        channel.event("cookies.changed", new JSONObject().put("removed", false).put("cookie", now).put("cause", "explicit"));
                    }
                }
                for (Map.Entry<String, JSONObject> entry : current.entrySet()) {
                    if (!previous.containsKey(entry.getKey()))
                        channel.event("cookies.changed", new JSONObject().put("removed", false).put("cookie", entry.getValue()).put("cause", "explicit"));
                }
            } catch (Exception ignored) { /* no DevTools: no change events either */ }
        });
    }

    /** Takes the first snapshot once DevTools is up, so later diffs have a baseline. */
    void prime() { scheduleDiff(); }
}
