package com.zmarn.once;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.zmarn.once.lite.BrokerChannel;
import com.zmarn.once.lite.LiteExtensionEngine;
import org.json.JSONObject;

/**
 * The shell's userscript hand-off to Violentmonkey, under the plugin name the
 * GeckoView app registers, relayed to the Lite broker's `violentmonkey.*`
 * requests (liteViolentmonkey.ts answers them the Electron way). `NOT_RUNNING`
 * comes back while Violentmonkey is not loaded; `connected` and
 * `dashboardChanged` are raised from the broker's events.
 */
@CapacitorPlugin(name = "GeckoViolentmonkey")
public class LiteViolentmonkeyPlugin extends Plugin {
    private static final String NOT_RUNNING = "NOT_RUNNING";
    private static LiteViolentmonkeyPlugin current;

    @Override
    public void load() { current = this; }

    static void connected() { if (current != null) current.notifyListeners("connected", new JSObject()); }
    static void dashboardChanged() { if (current != null) current.notifyListeners("dashboardChanged", new JSObject()); }

    private LiteExtensionEngine engine() { return LiteExtensionEngine.get(getContext()); }

    @PluginMethod
    public void send(PluginCall call) {
        String cmd = call.getString("cmd");
        if (cmd == null) { call.reject("cmd is required"); return; }
        JSONObject params = new JSONObject();
        try { params.put("cmd", cmd); params.put("data", call.getData().opt("data") == null ? JSONObject.NULL : call.getData().opt("data")); }
        catch (Exception error) { call.reject("Unable to encode the command", error); return; }
        getActivity().runOnUiThread(() -> engine().violentmonkey("send", params).whenComplete((result, error) -> {
            if (error == null) {
                JSObject answer = new JSObject();
                try { answer.put("value", result.opt("value")); } catch (Exception failure) { call.reject("Unable to read the answer", failure); return; }
                call.resolve(answer);
                return;
            }
            Throwable cause = error instanceof java.util.concurrent.CompletionException && error.getCause() != null ? error.getCause() : error;
            if (cause instanceof BrokerChannel.BrokerError && NOT_RUNNING.equals(((BrokerChannel.BrokerError) cause).code)) call.reject(cause.getMessage(), NOT_RUNNING);
            else call.reject(cause.getMessage() == null ? "Violentmonkey did not answer " + cmd : cause.getMessage());
        }));
    }

    @PluginMethod
    public void handingOff(PluginCall call) { relay("handingOff", call); }

    @PluginMethod
    public void settled(PluginCall call) { relay("settled", call); }

    private void relay(String method, PluginCall call) {
        getActivity().runOnUiThread(() -> engine().violentmonkey(method, new JSONObject()).whenComplete((result, error) -> call.resolve()));
    }
}
