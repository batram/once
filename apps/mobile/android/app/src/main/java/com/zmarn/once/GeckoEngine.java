package com.zmarn.once;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import java.util.ArrayList;
import java.util.List;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoRuntime;
import org.mozilla.geckoview.GeckoRuntimeSettings;
import org.mozilla.geckoview.WebExtension;

/** Process-owned engine; activity-owned delegates are attached by the current host. */
final class GeckoEngine {
    static final String BRIDGE_ID = "once-surface@zmarn.com";
    private static GeckoEngine instance;
    final GeckoRuntime runtime;
    private GeckoResult<List<WebExtension>> ready;

    static synchronized GeckoEngine get(Context context) {
        if (instance == null) instance = new GeckoEngine(context.getApplicationContext());
        return instance;
    }

    private GeckoEngine(Context context) {
        runtime = GeckoRuntime.create(context, new GeckoRuntimeSettings.Builder()
            .remoteDebuggingEnabled((context.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0)
            .build());
    }

    GeckoResult<List<WebExtension>> ready() {
        if (ready != null) return ready.then(ignored -> runtime.getWebExtensionController().list());
        List<GeckoResult<WebExtension>> installs = new ArrayList<>();
        String[][] bundles = {
            { "once-surface", BRIDGE_ID },
            { "ublock-origin", "uBlock0@raymondhill.net" },
            { "violentmonkey", "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}" }
        };
        for (String[] bundle : bundles) {
            installs.add(runtime.getWebExtensionController().ensureBuiltIn(
                "resource://android/assets/" + bundle[0] + "/", bundle[1]));
        }
        ready = GeckoResult.allOf(installs).then(ignored -> runtime.getWebExtensionController().list());
        ready.accept(ignored -> {}, error -> ready = null);
        return ready;
    }

    static boolean bundled(String id) {
        return BRIDGE_ID.equals(id) || "uBlock0@raymondhill.net".equals(id) ||
            "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}".equals(id);
    }
}
