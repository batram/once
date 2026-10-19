package com.zmarn.once;

import android.util.Log;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.json.JSONObject;

/**
 * Once's own WebExtensions runtime on the WebView is M2 of
 * docs/plans/once-lite-plan.md. Until then the catalogue is empty, synced
 * settings are kept for the runtime to pick up, and management commands say
 * so; `extensionsChanged` is never fired.
 */
final class LiteExtensionManager {
    private JSONObject settings;

    /** The shell's `extensionCommand`: `list` answers the empty catalogue; nothing else exists yet. */
    void command(PluginCall call) {
        if ("list".equals(call.getString("action"))) {
            call.resolve(new JSObject().put("extensions", new JSArray()));
            return;
        }
        call.reject("Extensions are not available yet");
    }

    /** The shell's filter lists and userscripts, recorded for the runtime (M2). */
    void applySettings(JSONObject data) {
        settings = data;
        Log.i(LiteSurfaceHost.TAG, "extension settings recorded: " + data.optJSONArray("filterLists") + " filter lists; applied when the Lite runtime lands (M2)");
    }

    JSONObject settings() { return settings; }
}
