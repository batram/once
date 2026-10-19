package com.zmarn.once;

import android.webkit.WebView;

/**
 * Once Lite: the system WebView is the reading engine. Its extension runtime
 * (docs/plans/once-lite-plan.md) drives Chromium through the app's own
 * DevTools socket, which only exists while WebView debugging is on; so it is
 * on always, release builds included, and the Allow Web Inspector switch
 * reports it as such.
 */
final class EngineSurface {
    static final boolean ALWAYS_INSPECTABLE = true;

    private EngineSurface() {}

    static void register(MainActivity activity) {
        WebView.setWebContentsDebuggingEnabled(true);
        activity.registerPlugin(LiteSurfacePlugin.class);
        activity.registerPlugin(LiteViolentmonkeyPlugin.class);
    }
}
