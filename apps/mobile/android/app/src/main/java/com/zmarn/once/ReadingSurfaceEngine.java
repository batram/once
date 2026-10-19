package com.zmarn.once;

/**
 * What the shell's own code asks of the engine's InAppBrowserSurface plugin,
 * whichever engine a flavour builds (GeckoView, or Once Lite's system
 * WebView). The plugin classes live in the engine source sets; the shell
 * only ever sees this.
 */
interface ReadingSurfaceEngine {
    /** The shell page restarted in a new renderer; hide pages until it opens its tabs again. */
    void shellRestarted();

    /** Android's memory pressure signal, forwarded to every tab. */
    void trimMemory(int level);

    /** The Allow Web Inspector switch changed; engines that can, follow it. */
    void setRemoteDebugging(boolean allowed);
}
