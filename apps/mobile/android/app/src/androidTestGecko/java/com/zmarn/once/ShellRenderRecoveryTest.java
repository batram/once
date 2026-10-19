package com.zmarn.once;

import android.webkit.WebView;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mozilla.geckoview.GeckoSession;
import static org.junit.Assert.*;

/**
 * The shell WebView's renderer is a separate process lmkd can reap alone; Android
 * then ends the app unless the loss is claimed. chrome://crash and chrome://kill
 * end the real renderer, so this runs the same path as a low-memory kill.
 */
@RunWith(AndroidJUnit4.class)
public class ShellRenderRecoveryTest {
    private final GeckoTestSupport t = new GeckoTestSupport();

    @Test public void lostShellRendererIsReplacedAndReadingSessionSurvives() throws Exception {
        t.start();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.close();
            t.open(fixture.url("/kept"));
            t.ready("kept");
            GeckoSession reading = (GeckoSession) t.field("session");
            for (String cause : new String[] { "chrome://crash", "chrome://kill" }) {
                AtomicReference<WebView> lost = new AtomicReference<>();
                t.ui(() -> {
                    lost.set(t.activity.getBridge().getWebView());
                    lost.get().loadUrl(cause);
                });
                t.until(cause + " must leave a new shell WebView in place of the lost one", () -> {
                    WebView current = t.activity.getBridge().getWebView();
                    return current != lost.get() && current.getParent() != null && lost.get().getParent() == null;
                }, 30);
                assertFalse("The activity must survive the renderer loss", t.activity.isDestroyed());
                assertSame("The plugin, and its sessions, must outlive the shell page",
                    t.plugin, t.activity.getBridge().getPlugin("InAppBrowserSurface").getInstance());
                assertFalse("The restarted shell has not asked to show the page yet", (Boolean) t.field("visible"));
                awaitShell();
                assertSame("The reading session must be the same one", reading, t.field("session"));
                AtomicReference<Boolean> open = new AtomicReference<>();
                t.ui(() -> open.set(reading.isOpen()));
                assertTrue("The reading session must still be open", open.get());
                assertEquals("\"kept\"", t.evaluate("document.querySelector('#ready')?.textContent"));
            }
            t.close();
        }
    }

    /** The new shell runs the app with a working native bridge. */
    private void awaitShell() throws Exception {
        long end = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
        String value = null;
        do {
            CountDownLatch done = new CountDownLatch(1);
            AtomicReference<String> result = new AtomicReference<>();
            t.ui(() -> t.activity.getBridge().getWebView().evaluateJavascript(
                "String(!!(window.Capacitor && Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('InAppBrowserSurface') && typeof androidBridge !== 'undefined') && document.readyState === 'complete')",
                v -> { result.set(v); done.countDown(); }));
            assertTrue("Shell evaluation deadline", done.await(10, TimeUnit.SECONDS));
            value = result.get();
            if ("\"true\"".equals(value)) return;
            Thread.sleep(200);
        } while (System.nanoTime() < end);
        fail("The restarted shell did not load the app with its native bridge: " + value);
    }
}
