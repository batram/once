package com.zmarn.once;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The shell's userscript hand-off to Violentmonkey, under the plugin name the
 * GeckoView app registers. Violentmonkey runs on Once Lite only with the M2
 * runtime; until then it is "not running", which the shell treats as a
 * platform without Violentmonkey (ViolentmonkeyHandOff.ts), and no `connected`
 * event is ever emitted.
 */
@CapacitorPlugin(name = "GeckoViolentmonkey")
public class LiteViolentmonkeyPlugin extends Plugin {
    private static final String NOT_RUNNING = "NOT_RUNNING";

    @PluginMethod
    public void send(PluginCall call) {
        if (call.getString("cmd") == null) { call.reject("cmd is required"); return; }
        call.reject("Violentmonkey is not running", NOT_RUNNING);
    }

    @PluginMethod
    public void handingOff(PluginCall call) { call.resolve(); }

    @PluginMethod
    public void settled(PluginCall call) { call.resolve(); }
}
