package com.zmarn.once.lite;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.webkit.JavaScriptReplyProxy;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * The `onceLite` WebMessage channel between Java and the broker page, one
 * JSON envelope per message: requests answered by id in both directions, and
 * events (docs/plans/once-lite-broker-protocol.md). Every handler runs on the
 * main thread; sending from any thread is hopped there, since the reply proxy
 * accepts posts on the UI thread only.
 */
public final class BrokerChannel {
    static final String TAG = "OnceLite";
    /** Set by the engine: whether the build is debuggable, so logs may name full URLs. */
    static volatile boolean verboseLogs;
    private static final java.util.regex.Pattern URL_REST = java.util.regex.Pattern.compile("(\\b[a-z][a-z0-9+.-]*://[^/\\s\"'?#]+)[^\\s\"')]*");

    /**
     * Text bound for logcat, which a USB debugger or a bug report can read: a
     * release build keeps URLs to their origin, so what the user reads and the
     * requests pages make stay out of the log.
     */
    public static String forLog(String text) {
        if (text == null || verboseLogs) return text;
        return URL_REST.matcher(text).replaceAll("$1/…");
    }

    /** Answers a request from the broker, now or later; exactly once. */
    public interface Reply {
        void resolve(Object result);
        void reject(String message, String code);
        default void reject(String message) { reject(message, null); }
    }

    public interface RequestHandler { void handle(JSONObject params, Reply reply) throws Exception; }
    public interface EventHandler { void handle(JSONObject params) throws Exception; }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, RequestHandler> requestHandlers = new HashMap<>();
    private final Map<String, List<EventHandler>> eventHandlers = new HashMap<>();
    private final Map<Long, CompletableFuture<JSONObject>> pending = new HashMap<>();
    private final AtomicLong ids = new AtomicLong();
    private final List<String> queued = new ArrayList<>();
    private JavaScriptReplyProxy proxy;

    public void onRequest(String method, RequestHandler handler) { requestHandlers.put(method, handler); }

    public void onEvent(String event, EventHandler handler) {
        List<EventHandler> handlers = eventHandlers.get(event);
        if (handlers == null) eventHandlers.put(event, handlers = new ArrayList<>());
        handlers.add(handler);
    }

    /** The broker page spoke first; its proxy carries everything Java sends from now on. */
    void connect(JavaScriptReplyProxy reply) {
        proxy = reply;
        List<String> backlog = new ArrayList<>(queued);
        queued.clear();
        for (String text : backlog) post(text);
    }

    /** The broker page went away: nothing awaits an answer any more. */
    void disconnect(String reason) {
        proxy = null;
        generation++;
        queued.clear();
        for (CompletableFuture<JSONObject> future : new ArrayList<>(pending.values())) {
            future.completeExceptionally(new IllegalStateException(reason));
        }
        pending.clear();
    }

    boolean isConnected() { return proxy != null; }

    /** Sends a request; the future settles on the main thread with the result object, or exceptionally with the error message. */
    public CompletableFuture<JSONObject> request(String method, JSONObject params) {
        CompletableFuture<JSONObject> result = new CompletableFuture<>();
        onMain(() -> {
            long id = ids.incrementAndGet();
            pending.put(id, result);
            try {
                JSONObject envelope = new JSONObject().put("type", "request").put("id", id).put("method", method);
                if (params != null) envelope.put("params", params);
                post(envelope.toString());
            } catch (JSONException error) {
                pending.remove(id);
                result.completeExceptionally(error);
            }
        });
        return result;
    }

    public void event(String event, JSONObject params) {
        onMain(() -> {
            try {
                JSONObject envelope = new JSONObject().put("type", "event").put("event", event);
                if (params != null) envelope.put("params", params);
                post(envelope.toString());
            } catch (JSONException error) { Log.w(TAG, "Unencodable event " + event, error); }
        });
    }

    private void onMain(Runnable work) {
        if (Looper.myLooper() == Looper.getMainLooper()) work.run(); else main.post(work);
    }

    private void post(String text) {
        if (proxy == null) {
            // Before broker.hello (or while the page restarts) messages wait, bounded.
            if (queued.size() < 256) queued.add(text);
            return;
        }
        try { proxy.postMessage(text); }
        catch (RuntimeException error) { Log.w(TAG, "Broker channel post failed", error); }
    }

    /** Messages beyond this many characters are logged by their head: the broker should not send them. */
    private static final int LARGE_MESSAGE_CHARS = 4 * 1024 * 1024;

    /** Messages beyond this many characters are parsed off the main thread. */
    private static final int PARSE_OFF_MAIN_CHARS = 64 * 1024;
    private final java.util.concurrent.ExecutorService parser = java.util.concurrent.Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "once-lite-channel");
        thread.setDaemon(true);
        return thread;
    });
    /** Messages handed to the parser and not handled yet; while any are, later ones queue behind them. */
    private int parsing;
    /** Changes when the page goes away, so messages of the old page parsed late are dropped. */
    private int generation;

    /**
     * A message from the broker page; on the main thread. A large one (a
     * fulfilled document body, a store value) is parsed on the parser
     * thread, and messages after it wait their turn, so order holds.
     */
    void receive(String text) {
        if (text.length() < PARSE_OFF_MAIN_CHARS && parsing == 0) {
            handle(parse(text));
            return;
        }
        parsing++;
        int page = generation;
        parser.execute(() -> {
            JSONObject envelope = parse(text);
            main.post(() -> {
                parsing--;
                if (page == generation) handle(envelope);
            });
        });
    }

    private static JSONObject parse(String text) {
        if (text.length() > LARGE_MESSAGE_CHARS) Log.w(TAG, "Large broker message (" + text.length() / (1024 * 1024) + " MB): " + text.substring(0, Math.min(160, text.length())));
        try { return new JSONObject(text); } catch (JSONException error) { Log.w(TAG, "Unparseable broker message"); return null; }
    }

    private void handle(JSONObject envelope) {
        if (envelope == null) return;
        String type = envelope.optString("type");
        if ("response".equals(type)) settle(envelope);
        else if ("request".equals(type)) answer(envelope);
        else if ("event".equals(type)) dispatch(envelope.optString("event"), params(envelope));
    }

    private static JSONObject params(JSONObject envelope) {
        JSONObject params = envelope.optJSONObject("params");
        return params == null ? new JSONObject() : params;
    }

    private void settle(JSONObject envelope) {
        CompletableFuture<JSONObject> future = pending.remove(envelope.optLong("id", -1));
        if (future == null) return;
        if (envelope.has("error") && !envelope.isNull("error")) {
            future.completeExceptionally(new BrokerError(envelope.optString("error"), envelope.optString("code", null)));
            return;
        }
        JSONObject result = envelope.optJSONObject("result");
        future.complete(result == null ? new JSONObject() : result);
    }

    private void answer(JSONObject envelope) {
        long id = envelope.optLong("id", -1);
        String method = envelope.optString("method");
        RequestHandler handler = requestHandlers.get(method);
        Reply reply = new Reply() {
            private boolean done;
            @Override public void resolve(Object result) {
                onMain(() -> {
                    if (done) return;
                    done = true;
                    try {
                        JSONObject response = new JSONObject().put("type", "response").put("id", id);
                        response.put("result", result == null ? JSONObject.NULL : result);
                        post(response.toString());
                    } catch (JSONException error) { reject("Unencodable result: " + error.getMessage(), null); }
                });
            }
            @Override public void reject(String message, String code) {
                onMain(() -> {
                    if (done) return;
                    done = true;
                    try {
                        JSONObject response = new JSONObject().put("type", "response").put("id", id).put("error", message == null ? "failed" : message);
                        if (code != null) response.put("code", code);
                        post(response.toString());
                    } catch (JSONException ignored) { /* a constant document */ }
                });
            }
        };
        if (handler == null) { reply.reject("Unknown method " + method, "UNKNOWN_METHOD"); return; }
        try { handler.handle(params(envelope), reply); }
        catch (Exception error) {
            Log.w(TAG, method + " failed", error);
            reply.reject(error.getMessage() == null ? error.toString() : error.getMessage(), null);
        }
    }

    private void dispatch(String event, JSONObject params) {
        List<EventHandler> handlers = eventHandlers.get(event);
        if (handlers == null) return;
        for (EventHandler handler : new ArrayList<>(handlers)) {
            try { handler.handle(params); }
            catch (Exception error) { Log.w(TAG, "Handler for " + event + " failed", error); }
        }
    }

    /** A request the broker answered with an error. */
    public static final class BrokerError extends Exception {
        public final String code;
        BrokerError(String message, String code) { super(message); this.code = code; }
    }
}
