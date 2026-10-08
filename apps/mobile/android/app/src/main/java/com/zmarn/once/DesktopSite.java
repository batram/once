package com.zmarn.once;

import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.GeckoSessionSettings;

/**
 * Request desktop site for one tab: Gecko's desktop user agent and viewport,
 * so sites that detect a phone (and hand it to their app) serve their full
 * page instead. The choice holds for every page the tab opens.
 */
final class DesktopSite {
    private final java.util.function.Consumer<Boolean> chosen;
    private boolean enabled;

    /** `chosen` hears the reader's own changes, which the shell keeps with the tab. */
    DesktopSite(java.util.function.Consumer<Boolean> chosen) { this.chosen = chosen; }

    boolean isEnabled() { return enabled; }

    /** The tab's saved choice, as the shell hands it over. */
    void setEnabled(boolean value) { enabled = value; }

    /** The reader flipped the browser sheet's switch. */
    void choose(boolean value) {
        enabled = value;
        chosen.accept(value);
    }

    /** Applies the tab's choice to its session; the next load uses it. */
    void apply(GeckoSession session) {
        if (session == null) return;
        GeckoSessionSettings settings = session.getSettings();
        settings.setUserAgentMode(enabled
            ? GeckoSessionSettings.USER_AGENT_MODE_DESKTOP : GeckoSessionSettings.USER_AGENT_MODE_MOBILE);
        settings.setViewportMode(enabled
            ? GeckoSessionSettings.VIEWPORT_MODE_DESKTOP : GeckoSessionSettings.VIEWPORT_MODE_MOBILE);
    }
}
