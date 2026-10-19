package com.zmarn.once;

/** The fullscreen video presentation the activity forwards its lifecycle to. */
interface VideoPresentation {
    /** The user left the activity (home, recents); a playing video may enter PiP. */
    void leave();
    void pipChanged(boolean enabled);
    /** Another presentation takes over: leave fullscreen without the page's say. */
    void reset();
}
