package com.zmarn.once;

/**
 * Request desktop site for one tab: the engine's desktop user agent and
 * viewport, so sites that detect a phone (and hand it to their app) serve
 * their full page instead. The choice holds for every page the tab opens.
 */
final class DesktopSite {
    private final java.util.function.Consumer<Boolean> chosen;
    private boolean enabled;

    /** `chosen` hears the reader's own changes: the engine applies them to the page and the shell keeps them with the tab. */
    DesktopSite(java.util.function.Consumer<Boolean> chosen) { this.chosen = chosen; }

    boolean isEnabled() { return enabled; }

    /** The tab's saved choice, as the shell hands it over. */
    void setEnabled(boolean value) { enabled = value; }

    /** The reader flipped the browser sheet's switch. */
    void choose(boolean value) {
        enabled = value;
        chosen.accept(value);
    }
}
