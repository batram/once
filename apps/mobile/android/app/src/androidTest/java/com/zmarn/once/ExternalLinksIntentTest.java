package com.zmarn.once;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.net.URISyntaxException;
import org.junit.Test;
import org.junit.runner.RunWith;

/** The Intent a page link becomes: what a browser link could reach, nothing more. */
@RunWith(AndroidJUnit4.class)
public class ExternalLinksIntentTest {
    @Test
    public void intentLinkLosesItsComponentAndSelectorAndGainsBrowsable() throws URISyntaxException {
        Intent intent = ExternalLinks.parse("intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;"
            + "component=com.zmarn.once/.MainActivity;launchFlags=0x10000003;end");
        assertNull(intent.getComponent());
        assertNull(intent.getSelector());
        assertTrue(intent.hasCategory(Intent.CATEGORY_BROWSABLE));
        assertEquals("zxing", intent.getScheme());
        assertEquals("com.google.zxing.client.android", intent.getPackage());
        assertEquals(0, intent.getFlags() & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION));
    }

    @Test
    public void plainSchemeIsABrowsableView() throws URISyntaxException {
        Intent intent = ExternalLinks.parse("tel:+15551234567");
        assertEquals(Intent.ACTION_VIEW, intent.getAction());
        assertEquals("tel:+15551234567", intent.getDataString());
        assertTrue(intent.hasCategory(Intent.CATEGORY_BROWSABLE));
        assertNull(intent.getComponent());
    }

    @Test
    public void deviceSchemesAreRefused() {
        for (String url : new String[]{
            "file:///sdcard/Download/x.apk",
            "content://com.zmarn.once.fileprovider/cache/secret.db",
            "intent://cache/secret.db#Intent;scheme=content;package=com.evil;end",
            "intent:#Intent;scheme=file;end"
        }) {
            try {
                ExternalLinks.parse(url);
                fail(url);
            } catch (URISyntaxException expected) { /* refused */ }
        }
    }

    @Test
    public void describesTheLinkForTheFailedPage() {
        assertEquals("The page tried to open another app (com.google.zxing.client.android).",
            ExternalLinks.describe("intent://scan/#Intent;scheme=zxing;package=com.google.zxing.client.android;end"));
        assertEquals("The page tried to open a tel: link, which the browser cannot show.", ExternalLinks.describe("tel:1"));
        assertEquals("The page tried to open a link the browser cannot show.", ExternalLinks.describe("file:///etc/hosts"));
    }
}
