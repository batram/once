package com.zmarn.once;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/** Links the reading surface cannot show itself (intent:, custom schemes) go to the app that handles them. */
final class ExternalLinks {
    private ExternalLinks() {}

    /**
     * Schemes a page may never hand out: they name this device's files, content
     * providers and app components rather than something another app shows.
     */
    private static final Set<String> REFUSED = Collections.unmodifiableSet(new HashSet<>(
        Arrays.asList("file", "content", "android-app", "javascript", "data"))); // Set.of needs API 30

    /** Flags an intent: URL may ask for but a page may not grant on the app's behalf. */
    private static final int GRANT_FLAGS = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION;

    /** The link's scheme in lower case, or null when it has none (RFC 3986 syntax; no Android class, so the JVM tests run it). */
    static String scheme(String url) {
        if (url == null) return null;
        int colon = url.indexOf(':');
        if (colon < 1) return null;
        for (int i = 0; i < colon; i++) {
            char c = url.charAt(i);
            boolean letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
            boolean trailing = i > 0 && ((c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.');
            if (!letter && !trailing) return null;
        }
        return url.substring(0, colon).toLowerCase(Locale.ROOT);
    }

    /**
     * The data scheme an intent: URL asks for (its "scheme=" field, as
     * Intent.parseUri reads it), lower-cased; null when it names none.
     */
    static String intentDataScheme(String url) {
        int fragment = url.indexOf("#Intent;");
        if (fragment < 0) return null;
        int field = url.indexOf(";scheme=", fragment + 7);
        if (field < 0) return null;
        int start = field + 8;
        int end = url.indexOf(';', start);
        return url.substring(start, end < 0 ? url.length() : end).toLowerCase(Locale.ROOT);
    }

    /** Why a page may not hand out this link, or null when another app may take it. */
    static String refusal(String url) {
        String scheme = scheme(url);
        if (scheme == null) return "a link without a scheme";
        if ("intent".equals(scheme)) scheme = intentDataScheme(url);
        if (scheme != null && REFUSED.contains(scheme)) return "a " + scheme + ": link";
        return null;
    }

    static boolean allowed(String url) { return refusal(url) == null; }

    /**
     * intent: URLs carry a whole Intent; anything else is a plain VIEW of the URL.
     * Either way the result is what a browser link could reach, nothing more: a
     * link a page may not hand out (see {@link #refusal}) throws instead.
     */
    static Intent parse(String url) throws URISyntaxException {
        String refusal = refusal(url);
        if (refusal != null) throw new URISyntaxException(url, "pages may not open " + refusal);
        Intent intent = "intent".equals(scheme(url))
            ? Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
            : new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        // An intent: URL names its own data scheme; refusal() reads it by hand, this reads what Android made of it.
        Uri data = intent.getData();
        if (data != null && data.getScheme() != null && REFUSED.contains(data.getScheme().toLowerCase(Locale.ROOT)))
            throw new URISyntaxException(url, "pages may not open a " + data.getScheme() + ": link");
        // Only activities that admit web links (Chrome does the same), never a named component.
        intent.addCategory(Intent.CATEGORY_BROWSABLE);
        intent.setComponent(null);
        intent.setSelector(null);
        intent.setFlags(intent.getFlags() & ~GRANT_FLAGS);
        return intent;
    }

    /** Why the page went blank, for the shell's failed-page message. */
    static String describe(String url) {
        if (!allowed(url)) return "The page tried to open a link the browser cannot show.";
        String app = null;
        try { app = parse(url).getPackage(); } catch (Exception ignored) { /* described by scheme */ }
        if (app != null) return "The page tried to open another app (" + app + ").";
        return "The page tried to open a " + scheme(url) + ": link, which the browser cannot show.";
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
