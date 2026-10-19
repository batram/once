package com.zmarn.once;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;

/** Links the reading surface cannot show itself (intent:, custom schemes) go to the app that handles them. */
final class ExternalLinks {
    private ExternalLinks() {}

    /** intent: URLs carry a whole Intent; anything else is a plain VIEW of the URL. */
    static Intent parse(String url) throws java.net.URISyntaxException {
        if (!url.regionMatches(true, 0, "intent:", 0, 7)) return new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        Intent intent = Intent.parseUri(url, Intent.URI_INTENT_SCHEME);
        // A page may only reach what a browser link could, never a named component.
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setComponent(null);
        intent.setSelector(null);
        return intent;
    }

    /** Why the page went blank, for the shell's failed-page message. */
    static String describe(String url) {
        String app = null;
        try { app = parse(url).getPackage(); } catch (Exception ignored) { /* described by scheme */ }
        if (app != null) return "The page tried to open another app (" + app + ").";
        String scheme = Uri.parse(url).getScheme();
        return scheme == null ? "The page tried to open a link the browser cannot show."
            : "The page tried to open a " + scheme + ": link, which the browser cannot show.";
    }

    /** True when an app took the link; the host UI remains usable when none handles the scheme. */
    static boolean open(Activity activity, String url) {
        if (url == null || activity == null) return false;
        try {
            activity.startActivity(parse(url));
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }
}
