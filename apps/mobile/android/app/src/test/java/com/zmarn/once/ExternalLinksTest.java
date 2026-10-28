package com.zmarn.once;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The scheme policy behind ExternalLinks.parse; the Intent it builds is ExternalLinksIntentTest's (instrumented). */
public class ExternalLinksTest {
    @Test
    public void refusesSchemesThatNameTheDevice() {
        for (String url : new String[]{
            "file:///etc/hosts", "FILE:///sdcard/Download/x.apk",
            "content://com.zmarn.once.fileprovider/cache/secret.db", "content://media/external/images/1",
            "android-app://com.zmarn.once/https/once.zmarn.com/",
            "javascript:alert(1)", "data:text/html,<script>alert(1)</script>",
            // The offer must agree with parse(), which refuses an intent: URL's own data scheme too.
            "intent://cache/secret.db#Intent;scheme=content;package=com.evil;end",
            "intent:#Intent;scheme=FILE;end"
        }) {
            assertFalse(url, ExternalLinks.allowed(url));
            assertEquals(url, "The page tried to open a link the browser cannot show.", ExternalLinks.describe(url));
        }
    }

    @Test
    public void refusesLinksWithoutAScheme() {
        for (String url : new String[]{"", "/etc/hosts", "no-colon", ":leading", "1abc:x", "a b:c", "::", null}) {
            assertNull(url, ExternalLinks.scheme(url));
            assertFalse(url, ExternalLinks.allowed(url));
        }
    }

    @Test
    public void allowsLinksAnotherAppMayShow() {
        for (String url : new String[]{
            "tel:+15551234567", "mailto:someone@example.com", "sms:+1555", "geo:0,0?q=coffee",
            "intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end",
            "intent:#Intent;package=com.google.zxing.client.android;end",
            "https://example.com/file.zip", "market://details?id=org.mozilla.firefox", "x-custom+scheme.1:thing"
        }) assertTrue(url, ExternalLinks.allowed(url));
    }

    @Test
    public void readsTheDataSchemeOfAnIntentLink() {
        assertEquals("zxing", ExternalLinks.intentDataScheme("intent://scan/#Intent;scheme=zxing;package=x;end"));
        assertEquals("content", ExternalLinks.intentDataScheme("intent:#Intent;action=android.intent.action.VIEW;scheme=Content;end"));
        assertNull(ExternalLinks.intentDataScheme("intent:#Intent;package=x;end"));
        assertNull(ExternalLinks.intentDataScheme("intent://scan/"));
    }

    @Test
    public void schemeIsLowerCasedAndStopsAtTheFirstColon() {
        assertEquals("tel", ExternalLinks.scheme("TEL:1"));
        assertEquals("intent", ExternalLinks.scheme("Intent://x#Intent;scheme=https;end"));
        assertEquals("https", ExternalLinks.scheme("https://host:8443/path"));
    }
}
