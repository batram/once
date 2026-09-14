package com.zmarn.once;

import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Exercises the actual Capacitor shell coordinator, rather than opening the plugin directly. */
@RunWith(AndroidJUnit4.class)
public class GeckoReadingJourneyTest {
    @Test public void blankDocumentOffersRetryAndLateContentAppearsWithoutProcessReset() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        awaitShell(t, "document.body.dataset.onceReady === 'true'", 30);
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            submit(t, fixture.url("/blank-late"));
            t.until("Blank document bridge connects", () -> t.field("bridgePort") != null, 15);
            Object original = t.field("session");
            t.until("A blank document must offer a visible retry", () -> (boolean)t.field("blankWarning"), 20);
            awaitShell(t, "document.querySelector('#reading_content').dataset.loadState === 'error'", 5);
            t.ready("late-content");
            awaitShell(t, "document.querySelector('#reading_content').dataset.loadState === 'ready'", 10);
            assertSame("A responsive document must not lose its process", original, t.field("session"));
            t.ui(() -> assertEquals(android.view.View.GONE, ((android.view.View)t.field("recoveryView")).getVisibility()));
        }
    }

    @Test public void paintedInteractiveDocumentIsUsableWhileAnImageStalls() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        awaitShell(t, "document.body.dataset.onceReady === 'true'", 30);
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            submit(t, fixture.url("/interactive"));
            t.ready("interactive");
            assertEquals("\"interactive\"", t.evaluate("document.readyState"));
            t.until("A painted responding document must not wait for a stalled image",
                () -> (boolean)t.field("painted") && (long)t.field("navigationDeadline") == 0, 12);
            awaitShell(t, "document.querySelector('#reading_content').dataset.loadState === 'ready'", 5);
        }
    }

    @Test public void rapidAddressesAndBackSettleWithoutDelayedRecovery() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        awaitShell(t, "document.body.dataset.onceReady === 'true'", 30);
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            for (int run = 0; run < 3; run++) {
                submit(t, fixture.url("/base-" + run)); t.ready("base-" + run);
                for (int n = 0; n < 5; n++) { submit(t, fixture.url("/stall-" + n)); Thread.sleep(80); }
                submit(t, fixture.url("/destination-" + run)); t.ready("destination-" + run);
                t.until("Rapid navigation must settle", () -> (long)t.field("navigationDeadline") == 0, 12);
                Object before = t.field("session");
                t.instrumentation.getUiAutomation().performGlobalAction(1);
                t.ready("base-" + run);
                t.until("Back must clear its readiness deadline", () -> (long)t.field("navigationDeadline") == 0, 12);
                assertSame("Back must retain the working session", before, t.field("session"));
                awaitShell(t, "document.querySelector('#reading_content').dataset.loadState === 'ready'", 5);
            }
        }
    }

    @Test public void addressFormLoadsAndReopensWithoutEmptyHistoryClosingThePage() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport();
        t.start();
        awaitShell(t, "document.body.dataset.onceReady === 'true'", 30);
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            for (int run = 0; run < 3; run++) {
                String url = fixture.url("/shell-" + run);
                submit(t, url);
                awaitShell(t, "document.querySelector('#reading_url').value === " + JSONObject.quote(url)
                    + " && document.querySelector('#reading_content').dataset.loadState === 'ready'", 25);
                t.ready("shell-" + run);
                t.until("The real reading surface must paint and remain visible",
                    () -> (boolean)t.field("painted") && (boolean)t.field("visible"), 10);
                Thread.sleep(500);
                assertEquals("The shell must retain the requested address", url,
                    new org.json.JSONTokener(shell(t, "document.querySelector('#reading_url').value")).nextValue());
                // Close through the real controller, using Android Back on a first page.
                t.instrumentation.getUiAutomation().performGlobalAction(1);
                awaitShell(t, "document.querySelector('#reading_url').value === ''", 10);
            }
        }
    }

    @Test public void failedAddressRemainsVisibleAndAnotherAddressLoads() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport();
        t.start();
        awaitShell(t, "document.body.dataset.onceReady === 'true'", 30);
        int closedPort;
        try (java.net.ServerSocket reserve = new java.net.ServerSocket(0)) { closedPort = reserve.getLocalPort(); }
        String unavailable = "http://127.0.0.1:" + closedPort + "/unavailable";
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            submit(t, unavailable);
            awaitShell(t, "document.querySelector('#reading_url').value === " + JSONObject.quote(unavailable)
                + " && document.querySelector('#reading_content').dataset.loadState === 'error'"
                + " && !document.querySelector('#reading_error').hidden"
                + " && document.querySelector('#reading_error').textContent.length > 0", 25);
            t.ui(() -> assertEquals("Native failure remains visible", android.view.View.VISIBLE,
                ((android.view.View)t.field("recoveryView")).getVisibility()));
            submit(t, fixture.url("/after-error"));
            awaitShell(t, "document.querySelector('#reading_content').dataset.loadState === 'ready'"
                + " && document.querySelector('#reading_error').hidden", 25);
            t.ready("after-error");
            t.until("Next page paints", () -> (boolean)t.field("painted") && (boolean)t.field("visible"), 10);
        }
    }

    private void submit(GeckoTestSupport t, String url) throws Exception {
        shell(t, "(() => {document.querySelector('#reading_menu_btn').click();"
            + "const input=document.querySelector('#reading_url');input.focus();input.value=" + JSONObject.quote(url) + ";"
            + "input.dispatchEvent(new Event('input',{bubbles:true}));"
            + "document.querySelector('#reading_url_form').requestSubmit();return true;})()");
    }

    private String shell(GeckoTestSupport t, String script) throws Exception {
        AtomicReference<String> value = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        t.ui(() -> t.activity.getBridge().getWebView().evaluateJavascript(script, result -> {
            value.set(result); done.countDown();
        }));
        assertTrue("Shell JavaScript deadline", done.await(10, TimeUnit.SECONDS));
        return value.get();
    }

    private void awaitShell(GeckoTestSupport t, String condition, int seconds) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + seconds * 1000L;
        do {
            if ("true".equals(shell(t, condition))) return;
            Thread.sleep(100);
        } while (SystemClock.elapsedRealtime() < deadline);
        fail("Shell condition timed out: " + condition + "; state=" + shell(t,
            "JSON.stringify({url:document.querySelector('#reading_url')?.value,"
            + "state:document.querySelector('#reading_content')?.dataset,error:document.querySelector('#reading_error')?.textContent})"));
    }
}
