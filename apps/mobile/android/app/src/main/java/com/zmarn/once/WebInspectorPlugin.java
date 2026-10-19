package com.zmarn.once;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.webkit.WebView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Whether chrome://inspect (the shell's WebView) and Firefox's remote
 * debugging (GeckoView pages) may attach, release builds included. Off unless
 * the user turns it on in the error log; debuggable builds stay inspectable.
 * Once Lite keeps WebView debugging on always: its extension runtime attaches
 * to the app's own DevTools socket (see docs/plans/once-lite-plan.md), so the
 * switch reports as on and locked there.
 */
@CapacitorPlugin(name = "WebInspector")
public class WebInspectorPlugin extends Plugin {
    private static final String PREFS = "once_web_inspector";
    private static final String ENABLED = "enabled";

    static boolean enabled(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ENABLED, false);
    }

    static boolean allowed(Context context) {
        return EngineSurface.ALWAYS_INSPECTABLE || enabled(context)
            || (context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    @Override
    public void load() {
        if (EngineSurface.ALWAYS_INSPECTABLE || enabled(getContext())) WebView.setWebContentsDebuggingEnabled(true);
    }

    @PluginMethod
    public void get(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", EngineSurface.ALWAYS_INSPECTABLE || enabled(getContext()));
        if (EngineSurface.ALWAYS_INSPECTABLE) result.put("alwaysOn", true);
        call.resolve(result);
    }

    @PluginMethod
    public void set(PluginCall call) {
        boolean value = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        SharedPreferences.Editor editor = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        editor.putBoolean(ENABLED, value).apply();
        boolean allowed = allowed(getContext());
        getActivity().runOnUiThread(() -> {
            WebView.setWebContentsDebuggingEnabled(allowed);
            ReadingSurfaceEngine surface = ((MainActivity) getActivity()).surface();
            if (surface != null) surface.setRemoteDebugging(allowed);
            call.resolve();
        });
    }
}
