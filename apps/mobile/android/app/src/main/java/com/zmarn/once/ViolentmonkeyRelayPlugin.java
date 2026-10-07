package com.zmarn.once;

import android.os.Handler;
import android.os.Looper;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;
import org.mozilla.geckoview.WebExtension;

/**
 * Carries the shell's userscript hand-off to the bundled Violentmonkey, as
 * Electron does through its dashboard's commands. The Android copy of
 * Violentmonkey runs a relay in its background page (see
 * scripts/gecko-violentmonkey-relay.js) that connects here over native
 * messaging; the shell sends commands and gets Violentmonkey's answers back.
 * The background outlives the activity, so the port is held process-wide.
 */
@CapacitorPlugin(name = "GeckoViolentmonkey")
public class ViolentmonkeyRelayPlugin extends Plugin {
    static final String NATIVE_APP = "once_violentmonkey";
    /** The engine has not started, or Violentmonkey is turned off; "connected" follows a start. */
    private static final String NOT_RUNNING = "NOT_RUNNING";
    /** Every command answers from Violentmonkey's memory once it has started. */
    private static final long REPLY_TIMEOUT_MS = 30000;
    private static final Handler main = new Handler(Looper.getMainLooper());
    private static final Map<Long, PluginCall> pending = new HashMap<>();
    private static WebExtension.Port port;
    private static long nextId;
    private static ViolentmonkeyRelayPlugin current;
    /** Violentmonkey is installed and turned on, so pages wait for its hand-off. */
    private static boolean expected;
    /** The shell finished a hand-off since Violentmonkey last started. */
    private static boolean settled;
    private static final List<Runnable> settledWaiters = new ArrayList<>();

    @Override
    public void load() { current = this; }

    /** Listens for the relay on each Violentmonkey object the engine hands out. */
    static void attach(Iterable<WebExtension> extensions) {
        boolean found = false;
        for (WebExtension extension : extensions) {
            if (!GeckoEngine.VIOLENTMONKEY_ID.equals(extension.id)) continue;
            extension.setMessageDelegate(RELAY, NATIVE_APP);
            found = extension.metaData.enabled;
        }
        expected = found;
        if (!expected) releaseWaiters();
    }

    /**
     * Runs `work` once the shell has handed its userscripts to a started
     * Violentmonkey, so a page that opens with the engine gets them. Bounded
     * like the bridge's own barrier: a hand-off that never finishes must not
     * keep pages from opening.
     */
    static void whenSettled(Runnable work, long timeoutMs) {
        if (!expected || settled) { work.run(); return; }
        Runnable[] waiter = new Runnable[1];
        waiter[0] = () -> { if (settledWaiters.remove(waiter[0])) work.run(); };
        settledWaiters.add(waiter[0]);
        main.postDelayed(waiter[0], timeoutMs);
    }

    private static void releaseWaiters() {
        for (Runnable waiter : new ArrayList<>(settledWaiters)) { main.removeCallbacks(waiter); waiter.run(); }
    }

    @PluginMethod
    public void settled(PluginCall call) {
        main.post(() -> {
            if (port != null) { settled = true; releaseWaiters(); }
            call.resolve();
        });
    }

    @PluginMethod
    public void send(PluginCall call) {
        String cmd = call.getString("cmd");
        Object data = call.getData().opt("data");
        if (cmd == null) { call.reject("cmd is required"); return; }
        main.post(() -> {
            if (port == null) { call.reject("Violentmonkey is not running", NOT_RUNNING); return; }
            long id = ++nextId;
            JSONObject message = new JSONObject();
            try {
                message.put("id", id);
                message.put("cmd", cmd);
                message.put("data", data == null ? JSONObject.NULL : data);
            } catch (Exception error) { call.reject("Unable to encode the command", error); return; }
            pending.put(id, call);
            main.postDelayed(() -> {
                PluginCall unanswered = pending.remove(id);
                if (unanswered != null) unanswered.reject("Violentmonkey did not answer " + cmd);
            }, REPLY_TIMEOUT_MS);
            port.postMessage(message);
        });
    }

    private static final WebExtension.MessageDelegate RELAY = new WebExtension.MessageDelegate() {
        @Override
        public void onConnect(WebExtension.Port connected) {
            // Only the relay in Violentmonkey's background; its content
            // scripts lack nativeMessagingFromContent and never reach here.
            if (connected.sender.environmentType != WebExtension.MessageSender.ENV_TYPE_EXTENSION) {
                connected.disconnect();
                return;
            }
            WebExtension.Port previous = port;
            port = connected;
            settled = false;
            connected.setDelegate(REPLIES);
            if (previous != null) { previous.disconnect(); failPending("Violentmonkey restarted"); }
            if (current != null) current.notifyListeners("connected", new JSObject());
        }
    };

    private static final WebExtension.PortDelegate REPLIES = new WebExtension.PortDelegate() {
        @Override
        public void onPortMessage(Object message, WebExtension.Port from) {
            if (from != port || !(message instanceof JSONObject)) return;
            JSONObject reply = (JSONObject) message;
            if ("dashboard-changed".equals(reply.optString("type"))) {
                if (current != null) current.notifyListeners("dashboardChanged", new JSObject());
                return;
            }
            PluginCall call = pending.remove(reply.optLong("id", -1));
            if (call == null) return;
            if (reply.has("error")) { call.reject(reply.optString("error")); return; }
            JSObject result = new JSObject();
            try { result.put("value", reply.opt("value")); } catch (Exception error) { call.reject("Unable to read the answer", error); return; }
            call.resolve(result);
        }

        @Override
        public void onDisconnect(WebExtension.Port from) {
            if (from != port) return;
            port = null;
            failPending("Violentmonkey stopped");
        }
    };

    private static void failPending(String reason) {
        for (PluginCall call : new ArrayList<>(pending.values())) call.reject(reason);
        pending.clear();
    }
}
