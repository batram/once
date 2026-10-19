package com.zmarn.once;

import android.os.Handler;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;
import org.mozilla.geckoview.WebExtension;

/**
 * Script calls in flight to the page's bridge content script. Each is settled
 * by its reply, a timeout, or the page going away, whichever comes first.
 */
final class PageScriptCalls {
    /** Who awaits a script's answer: the shell's call, or the app itself. */
    private interface Reply {
        void resolve(String value);
        void reject(String message, Exception cause);
    }

    private final Handler handler;
    private final Map<Long, Runnable> evaluationTimeouts = new HashMap<>();
    private final Map<Long, Reply> pendingEvaluations = new HashMap<>();
    private final AtomicLong evaluationSequence = new AtomicLong();

    PageScriptCalls(Handler handler) { this.handler = handler; }

    /** The shell's evaluateJavaScript: the call's script, once there is a page ready to run it. */
    void evaluate(PluginCall call, boolean pageOpen, WebExtension.Port bridgePort) {
        String script = call.getString("script");
        if (script == null || script.isEmpty()) call.reject("JavaScript source is required");
        else if (!pageOpen) call.reject("There is no open page");
        else if (bridgePort == null) call.reject("The page is not ready to run scripts");
        else send(call, script, bridgePort);
    }

    /** A script whose answer nobody awaits: no call waits on its id, as ours count from 1. The port is typed loosely for ImageTextOverlays. */
    void post(String script, Object port) {
        WebExtension.Port bridgePort = (WebExtension.Port) port;
        if (bridgePort == null) return;
        try {
            JSONObject message = new JSONObject();
            message.put("id", -1);
            message.put("code", script);
            bridgePort.postMessage(message);
        } catch (Exception ignored) {
            // The page is going away, and with it whatever the script was for.
        }
    }

    void send(PluginCall call, String script, WebExtension.Port bridgePort) {
        send(new Reply() {
            @Override public void resolve(String value) { call.resolve(new JSObject().put("value", value)); }
            @Override public void reject(String message, Exception cause) { call.reject(message, cause); }
        }, script, bridgePort);
    }

    /** A script for the app's own use: `answer` gets its JSON-encoded value, or null when it failed. */
    void request(String script, Object port, java.util.function.Consumer<String> answer) {
        WebExtension.Port bridgePort = (WebExtension.Port) port;
        if (bridgePort == null) { answer.accept(null); return; }
        send(new Reply() {
            @Override public void resolve(String value) { answer.accept(value); }
            @Override public void reject(String message, Exception cause) { answer.accept(null); }
        }, script, bridgePort);
    }

    private void send(Reply call, String script, WebExtension.Port bridgePort) {
        if (pendingEvaluations.size() >= 32) { call.reject("Too many pending page script requests", null); return; }
        long id = evaluationSequence.incrementAndGet();
        pendingEvaluations.put(id, call);
        Runnable timeout = () -> {
            evaluationTimeouts.remove(id);
            Reply pending = pendingEvaluations.remove(id);
            if (pending != null) pending.reject("The page did not answer the script request in time", null);
        };
        evaluationTimeouts.put(id, timeout);
        handler.postDelayed(timeout, 10000);
        try {
            JSONObject message = new JSONObject();
            message.put("id", id);
            message.put("code", script);
            bridgePort.postMessage(message);
        } catch (Exception error) {
            pendingEvaluations.remove(id);
            cancelEvaluationTimeout(id);
            call.reject("The script could not be sent to the page", error);
        }
    }

    /** Settles the call a bridge reply answers, as a WebView would: a JSON-encoded value. */
    void settle(JSONObject reply) {
        long id = reply.optLong("id", -1);
        Reply call = pendingEvaluations.remove(id);
        cancelEvaluationTimeout(id);
        if (call == null) return;
        String error = reply.optString("error", null);
        if (error != null && !reply.isNull("error")) {
            call.reject("The script failed: " + error, null);
            return;
        }
        call.resolve(reply.optString("value", "null"));
    }

    void failAll(String reason) {
        for (Runnable timeout : evaluationTimeouts.values()) handler.removeCallbacks(timeout);
        evaluationTimeouts.clear();
        for (Reply pending : pendingEvaluations.values()) pending.reject(reason, null);
        pendingEvaluations.clear();
    }

    private void cancelEvaluationTimeout(long id) {
        Runnable timeout = evaluationTimeouts.remove(id);
        if (timeout != null) handler.removeCallbacks(timeout);
    }
}
