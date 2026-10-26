package com.zmarn.once;

import org.junit.Test;
import static org.junit.Assert.*;

public class GeckoAmoSourceTest {
    @Test public void acceptsOnlyHttpsMozillaListings() {
        for (String url : new String[]{
            "https://addons.mozilla.org/en-US/android/addon/consent-o-matic/",
            "https://addons.mozilla.org/firefox/addon/darkreader?src=search",
            "https://addons.mozilla.org/pt-BR/firefox/addon/ublock-origin/"
        }) assertTrue(url, GeckoExtensionSource.isListing(url));
        for (String url : new String[]{
            "http://addons.mozilla.org/firefox/addon/example/",
            "https://addons.mozilla.org.evil.test/firefox/addon/example/",
            "https://addons.mozilla.org@evil.test/firefox/addon/example/",
            "https://user@addons.mozilla.org/firefox/addon/example/",
            "https://addons.mozilla.org:8443/firefox/addon/example/",
            "https://addons.mozilla.org/firefox/downloads/file/1/example.xpi",
            "https://addons.mozilla.org/en-US/firefox/",
            "https://addons.mozilla.org/firefox/addon/example/../../other",
            "intent://firefox", "", null
        }) assertFalse(url, GeckoExtensionSource.isListing(url));
    }
}
