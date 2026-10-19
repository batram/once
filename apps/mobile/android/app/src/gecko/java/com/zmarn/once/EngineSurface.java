package com.zmarn.once;

/** The GeckoView engine: Firefox's engine runs the built-in extensions itself. */
final class EngineSurface {
    /** Gecko's remote debugging and the shell's inspector follow the Allow Web Inspector switch. */
    static final boolean ALWAYS_INSPECTABLE = false;

    private EngineSurface() {}

    static void register(MainActivity activity) {
        activity.registerPlugin(InAppBrowserSurfacePlugin.class);
        activity.registerPlugin(ViolentmonkeyRelayPlugin.class);
    }
}
