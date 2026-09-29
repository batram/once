package com.zmarn.once;

import android.graphics.Bitmap;
import android.view.View;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Physical-device regressions: verify display ownership and pixels, not just DOM completion. */
@RunWith(AndroidJUnit4.class)
public class GeckoDisplayTest {
    @Test public void hiddenBootstrapWaitsForRealViewport() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            GeckoTestSupport.Call open = new GeckoTestSupport.Call(new JSObject()
                .put("url", fixture.url("/display")).put("visible", false)
                .put("bounds", bounds(517.4)));
            t.ui(() -> t.plugin.open(open)); open.await();
            t.ui(() -> assertNull("Hidden bootstrap must not acquire a temporary display", t.plugin.surface.getSession()));
            t.ui(() -> t.plugin.setSurfaceVisible(true));
            t.ready("display");
            assertDisplayed(t);
            t.ui(() -> assertSame(t.plugin.session, t.plugin.surface.getSession()));
        }
    }

    @Test public void loadedUnpaintedPageRepairsDisplayWithoutReload() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.open(fixture.url("/repair")); t.ready("repair"); assertDisplayed(t);
            Object session = t.field("session");
            String origin = t.evaluate("performance.timeOrigin");
            long navigation = (long)t.field("activeNavigation");
            t.ui(() -> t.plugin.session.getContentDelegate().onPaintStatusReset(t.plugin.session));
            t.until("Responsive unpainted page must get one display repair", () -> t.plugin.displayReattached, 5);
            assertDisplayed(t);
            assertSame("Display repair must retain the session", session, t.field("session"));
            assertEquals("Display repair must not navigate", navigation, t.field("activeNavigation"));
            assertEquals("Document and scripts must survive", origin, t.evaluate("performance.timeOrigin"));
            t.ui(() -> assertFalse(t.plugin.blankWarning));
        }
    }

    @Test public void viewportChangesAndLoadingStatusPreservePixels() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.open(fixture.url("/viewport-0")); t.ready("viewport-0"); assertDisplayed(t);
            for (int run = 1; run <= 8; run++) {
                int cycle = run;
                t.ui(() -> {
                    t.plugin.setSurfaceVisible(false);
                    t.plugin.applyBounds(bounds(cycle % 2 == 0 ? 517.4 : 653));
                });
                t.navigate(fixture.url("/viewport-" + run));
                t.ui(() -> t.plugin.setSurfaceVisible(true));
                t.ready("viewport-" + run); assertDisplayed(t);
            }
            t.navigate(fixture.url("/stall"));
            t.ui(() -> {
                assertEquals(View.VISIBLE, t.plugin.loadStatus.getVisibility());
                assertTrue(t.plugin.loadStatus.getText().toString().contains("Loading"));
            });
            int height = t.plugin.surface.getHeight();
            android.graphics.Bitmap status = t.instrumentation.getUiAutomation().takeScreenshot();
            try (java.io.FileOutputStream output = new java.io.FileOutputStream(
                    new java.io.File(t.activity.getExternalFilesDir(null), "loading-status.png"))) {
                status.compress(Bitmap.CompressFormat.PNG, 100, output);
            } finally { status.recycle(); }
            fixture.stall = false;
            t.navigate(fixture.url("/after-stall")); t.ready("after-stall"); assertDisplayed(t);
            t.ui(() -> assertEquals("Progress must not resize content", height, t.plugin.surface.getHeight()));
        }
    }

    private JSObject bounds(double height) {
        return new JSObject().put("x", 0).put("y", 120).put("width", 360).put("height", height);
    }

    private void assertDisplayed(GeckoTestSupport t) throws Exception {
        t.until("Document must paint and report ready", () -> t.plugin.painted && t.plugin.navigationCompleted, 8);
        String css = (String)new org.json.JSONTokener(t.evaluate("(() => { const root=getComputedStyle(document.documentElement).backgroundColor; return root === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.body).backgroundColor : root; })()")).nextValue();
        String[] channels = css.replaceAll("[^0-9,]", "").split(",");
        int expected = android.graphics.Color.rgb(Integer.parseInt(channels[0]), Integer.parseInt(channels[1]), Integer.parseInt(channels[2]));
        android.util.Log.i("OnceDisplay", "computedBackground=" + css + " expected=" + Integer.toHexString(expected));
        Bitmap pixels = t.result(() -> t.plugin.surface.capturePixels());
        try {
            int background = pixels.getPixel(pixels.getWidth()/2, pixels.getHeight()/2);
            assertEquals("Actual Gecko surface must display the computed page background", expected, background);
            // A flat clear colour can match the background while text is still
            // missing. Require contrasting rendered glyphs near the fixture's p.
            int contrast = 0;
            for (int y = 0; y < Math.min(pixels.getHeight(), 220); y++) {
                for (int x = 0; x < pixels.getWidth()/2; x++) {
                    int pixel = pixels.getPixel(x, y);
                    if (Math.abs(android.graphics.Color.red(pixel) - android.graphics.Color.red(background)) > 40
                        || Math.abs(android.graphics.Color.green(pixel) - android.graphics.Color.green(background)) > 40
                        || Math.abs(android.graphics.Color.blue(pixel) - android.graphics.Color.blue(background)) > 40) contrast++;
                }
            }
            assertTrue("Fixture text must actually be rendered", contrast > 30);
        }
        finally { pixels.recycle(); }
        t.ui(() -> assertEquals("Status disappears when displayed", View.GONE, t.plugin.loadStatus.getVisibility()));
    }
}
