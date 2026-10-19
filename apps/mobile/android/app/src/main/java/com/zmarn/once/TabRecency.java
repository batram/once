package com.zmarn.once;

import android.util.Log;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * Each live page costs about 100 MB, and Android 14+ no longer reports memory
 * pressure while the app is in the foreground, so only the most recently used
 * hidden tabs stay live; the rest restore their saved state when selected.
 */
final class TabRecency {
    static final String TAG = "OnceSurface";
    private static final int LIVE_HIDDEN_TABS = 2;

    /** A tab runtime whose page can be released while hidden and restored when shown. */
    interface Tab {
        /** Whether a live page (session or view) is resident. */
        boolean isLive();
        /** Releases the hidden page, keeping its state; true when one was released. */
        boolean releaseHiddenSession();
    }

    // Closed tabs drop out on their own; nothing else holds them.
    private final Map<Tab, Long> lastUsed = new WeakHashMap<>();
    private long sequence;

    /** A tab was created or selected. */
    void used(Tab tab) {
        lastUsed.put(tab, ++sequence);
    }

    /** A tab was selected, or none (null): hidden tabs beyond the most recently used few close their sessions. */
    void selected(Collection<? extends Tab> tabs, Tab selected) {
        if (selected != null) used(selected);
        List<Tab> hidden = new ArrayList<>();
        for (Tab tab : tabs) if (tab != selected && tab.isLive()) hidden.add(tab);
        if (hidden.size() <= LIVE_HIDDEN_TABS) return;
        hidden.sort((a, b) -> Long.compare(lastUsed.getOrDefault(b, 0L), lastUsed.getOrDefault(a, 0L)));
        for (Tab tab : hidden.subList(LIVE_HIDDEN_TABS, hidden.size())) {
            if (tab.releaseHiddenSession()) Log.i(TAG, "Released the session of a tab not used recently");
        }
    }
}
