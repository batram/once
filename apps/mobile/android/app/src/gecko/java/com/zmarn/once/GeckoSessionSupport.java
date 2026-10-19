package com.zmarn.once;

import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSessionSettings;
import org.mozilla.geckoview.GeckoSession.ContentDelegate.ContextElement;

/** Gecko-specific readings of the shared reading-surface types. */
final class GeckoSessionSupport {
    private GeckoSessionSupport() {}

    /**
     * Gecko can report a snapshot with no history entries (seen right after a
     * restored page starts); restoring one loads only about:blank. Only a
     * snapshot that ends at the page being recovered is restored.
     */
    static boolean restores(GeckoSession.SessionState state, String url) {
        if (state == null || url.isEmpty()) return false;
        int index = state.getCurrentIndex();
        return index >= 0 && index < state.size() && ReadingAddress.same(state.get(index).getUri(), url);
    }

    /** Applies the tab's desktop-site choice to its session; the next load uses it. */
    static void applyDesktopSite(GeckoSession session, boolean enabled) {
        if (session == null) return;
        GeckoSessionSettings settings = session.getSettings();
        settings.setUserAgentMode(enabled
            ? GeckoSessionSettings.USER_AGENT_MODE_DESKTOP : GeckoSessionSettings.USER_AGENT_MODE_MOBILE);
        settings.setViewportMode(enabled
            ? GeckoSessionSettings.VIEWPORT_MODE_DESKTOP : GeckoSessionSettings.VIEWPORT_MODE_MOBILE);
    }

    /** The painted page's pixels, as GeckoView captures them. */
    static ReadingPreview.PageCapture preview(ReadingSurfaceHost host) {
        return new ReadingPreview.PageCapture() {
            @Override public boolean available() { return host.surface != null && host.surface.isShown() && host.documentPainted; }
            @Override public void capture(java.util.function.Consumer<android.graphics.Bitmap> image, Runnable failed) {
                host.surface.capturePixels().accept(image::accept, error -> failed.run());
            }
        };
    }

    /** What Gecko's long-press hit: ContextElement types are the menu's own numbering. */
    static LinkContextMenu.Target target(ContextElement element) {
        return new LinkContextMenu.Target(element.linkUri, element.linkText,
            element.type == ContextElement.TYPE_NONE ? null : element.srcUri, element.type, element.baseUri, true);
    }
}
