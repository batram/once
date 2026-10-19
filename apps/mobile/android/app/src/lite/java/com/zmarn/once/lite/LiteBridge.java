package com.zmarn.once.lite;

import android.os.Handler;
import android.util.Log;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;
import org.json.JSONObject;

/**
 * One tab's Once-owned bridge world (`once-bridge`): the Gecko bridge content
 * script's messages over the `onceLiteBridge` DevTools binding instead of a
 * native-messaging port. Script calls (`{id, code}` → `{id, value|error}`)
 * are bounded as PageScriptCalls bounds them: 32 in flight, 10 s each,
 * all failed when the document goes away. Everything else (`health`,
 * `media-snapshot`, `pip-request`, `image-text`) reaches the listener with
 * the document's token, an object that changes with every document.
 */
public final class LiteBridge implements LiteTargets.BridgeListener {
    private static final String TAG = BrokerChannel.TAG;
    private static final int PENDING_LIMIT = 32;
    private static final long REPLY_TIMEOUT_MS = 10000;

    /** Who awaits a script's answer. */
    public interface Reply {
        void resolve(String value);
        void reject(String message);
    }

    public interface Listener {
        /** A new document's bridge spoke: the previous document is gone. */
        void documentChanged(Object token);
        /** The document's bridge went away. */
        void documentGone(Object token);
        /** Any message but a script answer: `health`, media, PiP, image text. */
        void message(JSONObject message, Object token);
    }

    private final Handler handler;
    private final Listener listener;
    private LiteTargets.Attachment attachment;
    private int contextId = -1;
    private Object token;
    private final Map<Long, Reply> pending = new HashMap<>();
    private final Map<Long, Runnable> timeouts = new HashMap<>();
    private long sequence;

    public LiteBridge(Handler handler, Listener listener) {
        this.handler = handler;
        this.listener = listener;
    }

    public void attach(LiteTargets.Attachment attachment) { this.attachment = attachment; }

    /** The current document's identity, or null before its bridge spoke. */
    public Object token() { return token; }
    public boolean isConnected() { return token != null && attachment != null; }

    /** Sends a message to the current document's bridge world. */
    public void send(JSONObject message) {
        if (attachment == null || contextId < 0) return;
        try {
            attachment.send("Runtime.evaluate", new JSONObject()
                .put("expression", "__onceLiteBridgeDeliver(" + JSONObject.quote(message.toString()) + ")")
                .put("contextId", contextId).put("returnByValue", true));
        } catch (Exception error) { Log.w(TAG, "Could not deliver to the bridge world", error); }
    }

    /** A script whose answer nobody awaits. */
    public void post(String script, Object documentToken) {
        if (documentToken != null && documentToken != token) return;
        try { send(new JSONObject().put("id", -1).put("code", script)); } catch (Exception ignored) { /* a constant document */ }
    }

    /** A script for the app's own use: `answer` gets its JSON-encoded value, or null when it failed. */
    public void request(String script, Object documentToken, Consumer<String> answer) {
        if (documentToken != null && documentToken != token) { answer.accept(null); return; }
        evaluate(script, new Reply() {
            @Override public void resolve(String value) { answer.accept(value); }
            @Override public void reject(String message) { answer.accept(null); }
        });
    }

    public void evaluate(String script, Reply reply) {
        if (!isConnected()) { reply.reject("The page is not ready to run scripts"); return; }
        if (pending.size() >= PENDING_LIMIT) { reply.reject("Too many pending page script requests"); return; }
        long id = ++sequence;
        pending.put(id, reply);
        Runnable timeout = () -> {
            timeouts.remove(id);
            Reply waiting = pending.remove(id);
            if (waiting != null) waiting.reject("The page did not answer the script request in time");
        };
        timeouts.put(id, timeout);
        handler.postDelayed(timeout, REPLY_TIMEOUT_MS);
        try { send(new JSONObject().put("id", id).put("code", script)); }
        catch (Exception error) {
            pending.remove(id);
            cancelTimeout(id);
            reply.reject("The script could not be sent to the page");
        }
    }

    public void failAll(String reason) {
        for (Runnable timeout : timeouts.values()) handler.removeCallbacks(timeout);
        timeouts.clear();
        for (Reply reply : new java.util.ArrayList<>(pending.values())) reply.reject(reason);
        pending.clear();
    }

    private void cancelTimeout(long id) {
        Runnable timeout = timeouts.remove(id);
        if (timeout != null) handler.removeCallbacks(timeout);
    }

    /** Forgets the document: the view was replaced or closed. */
    public void reset() {
        handler.post(() -> {
            Object gone = token;
            contextId = -1;
            token = null;
            failAll("The page was closed");
            if (gone != null) listener.documentGone(gone);
        });
    }

    @Override public void bridgeCalled(int context, String payload) {
        handler.post(() -> {
            JSONObject message;
            try { message = new JSONObject(payload); } catch (Exception error) { return; }
            if (context != contextId) {
                contextId = context;
                token = new Object();
                failAll("The page navigated away");
                listener.documentChanged(token);
            }
            if (message.has("id") && !message.has("type")) { settle(message); return; }
            listener.message(message, token);
        });
    }

    private void settle(JSONObject reply) {
        long id = reply.optLong("id", -1);
        Reply call = pending.remove(id);
        cancelTimeout(id);
        if (call == null) return;
        if (reply.has("error") && !reply.isNull("error")) { call.reject("The script failed: " + reply.optString("error")); return; }
        call.resolve(reply.optString("value", "null"));
    }

    @Override public void contextDestroyed(int context) {
        handler.post(() -> { if (context == contextId) gone(); });
    }

    @Override public void contextsCleared() { handler.post(this::gone); }

    private void gone() {
        if (contextId < 0) return;
        Object was = token;
        contextId = -1;
        token = null;
        failAll("The page navigated away");
        listener.documentGone(was);
    }
}
