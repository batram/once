package com.zmarn.once;

/** The browser sheet's "Keep media playing in background" switch, whichever engine plays. */
interface BackgroundPlayback {
    boolean isEnabled();
    void setEnabled(boolean enabled);
}
