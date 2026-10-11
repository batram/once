package com.zmarn.once;

import android.net.Uri;
import org.mozilla.geckoview.GeckoSession;

/** Address rules for the reading surface: what it embeds, loads and treats as the same page. */
final class ReadingAddress {
    private ReadingAddress() {}

    static boolean embeddable(String value) {
        if (value == null) return false;
        Uri uri = Uri.parse(value);
        return "http".equalsIgnoreCase(uri.getScheme()) ||
            "https".equalsIgnoreCase(uri.getScheme());
    }

    /**
     * Gecko can report a snapshot with no history entries (seen right after a
     * restored page starts); restoring one loads only about:blank. Only a
     * snapshot that ends at the page being recovered is restored.
     */
    static boolean restores(GeckoSession.SessionState state, String url) {
        if (state == null || url.isEmpty()) return false;
        int index = state.getCurrentIndex();
        return index >= 0 && index < state.size() && same(state.get(index).getUri(), url);
    }

    static boolean same(String first, String second) {
        if (java.util.Objects.equals(first, second)) return true;
        if (!embeddable(first) || !embeddable(second)) return false;
        Uri a = Uri.parse(first), b = Uri.parse(second);
        String ap = a.getEncodedPath(), bp = b.getEncodedPath();
        if (ap == null || ap.isEmpty()) ap = "/";
        if (bp == null || bp.isEmpty()) bp = "/";
        return a.getScheme().equalsIgnoreCase(b.getScheme()) && java.util.Objects.equals(a.getHost(), b.getHost())
            && a.getPort() == b.getPort() && ap.equals(bp) && java.util.Objects.equals(a.getEncodedQuery(), b.getEncodedQuery());
    }

    /** What the surface itself may show: web pages and the extensions' own pages. */
    static boolean surface(String value) {
        if (value == null) return false;
        if (embeddable(value) || "about:blank".equals(value)) return true;
        return "moz-extension".equalsIgnoreCase(Uri.parse(value).getScheme());
    }
}
