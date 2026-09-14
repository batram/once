package com.zmarn.once;

import android.app.ActivityManager;
import android.content.Context;
import android.content.ComponentCallbacks2;
import android.os.Process;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.ArrayList;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mozilla.geckoview.GeckoSession;
import static org.junit.Assert.*;

/** Faults target real content processes in the isolated development app only. */
@RunWith(AndroidJUnit4.class)
public class GeckoResilienceTest {
    @Test public void storyListDoesNotInitializeGecko() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        java.util.concurrent.atomic.AtomicReference<String> shellReady = new java.util.concurrent.atomic.AtomicReference<>();
        t.until("The real shell must finish startup", () -> {
            t.activity.getBridge().getWebView().evaluateJavascript("document.body.dataset.onceReady === 'true'", shellReady::set);
            return "true".equals(shellReady.get());
        }, 25);
        t.ui(() -> assertNull("The story list must not eagerly create Gecko", t.field("engine")));
        t.ui(() -> t.activity.getBridge().getWebView().evaluateJavascript(
            "document.querySelector('#extension_settings').closest('.settings_section').classList.add('active')", null));
        t.until("Opening extension settings must start Gecko on demand", () -> t.field("engine") != null, 15);
        t.close();
    }
    @Test public void actualProcessDeathsAutomaticallyRecoverAndPaint() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            for (int run = 0; run < 3; run++) {
                t.open(fixture.url("/alive")); t.ready("alive");
                // Let the spare service finish binding: this test kills running
                // renderers, not Android services partway through their launch.
                Thread.sleep(700);
                GeckoSession previous = (GeckoSession)t.field("session");
                long start = SystemClock.elapsedRealtime();
                List<Integer> children = children(t);
                assertFalse("Must find real Gecko content processes", children.isEmpty());
                t.ui(() -> children.forEach(Process::killProcess));
                t.until("Dead renderer must be replaced", () -> t.field("session") != previous, 15);
                t.ready("alive");
                t.until("Recovered view must paint", () -> (boolean)t.field("painted"), 10);
                Log.i("OnceResilience", "actual-kill run=" + run + " recoveryMs=" + (SystemClock.elapsedRealtime()-start));
            }
        } finally { t.close(); }
    }

    @Test public void frozenProcessDoesNotQueueObsoleteDestinations() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.open(fixture.url("/before")); t.ready("before");
            GeckoSession old = (GeckoSession)t.field("session");
            java.util.concurrent.atomic.AtomicReference<GeckoSession.ProgressDelegate> oldProgress = new java.util.concurrent.atomic.AtomicReference<>();
            t.ui(() -> oldProgress.set(old.getProgressDelegate()));
            List<Integer> children = children(t); assertFalse(children.isEmpty());
            t.ui(() -> children.forEach(child -> Process.sendSignal(child, 19)));
            long start = SystemClock.elapsedRealtime();
            for (int n = 0; n < 8; n++) t.navigate(fixture.url("/obsolete-" + n));
            t.navigate(fixture.url("/latest"));
            t.ready("latest");
            t.ui(() -> { oldProgress.get().onPageStart(old, fixture.url("/obsolete")); oldProgress.get().onPageStop(old, true); });
            assertEquals(fixture.url("/latest"), t.field("requestedUrl"));
            t.until("Replacement must paint", () -> (boolean)t.field("painted"), 10);
            assertPaint(t, "frozen-recovered");
            Thread.sleep(1500);
            assertEquals("\"latest\"", t.evaluate("document.querySelector('#ready').textContent"));
            Log.i("OnceResilience", "frozen-navigation recoveryMs=" + (SystemClock.elapsedRealtime()-start));
        } finally { t.close(); }
    }

    @Test public void idleFrozenPageRecoversWithoutAnotherNavigation() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.open(fixture.url("/idle")); t.ready("idle");
            for (int run = 0; run < 3; run++) {
                t.until("Page must answer a completed-document health check before the next fault",
                    () -> (long)t.field("navigationDeadline") == 0 && (int)t.field("recoveryAttempts") == 0, 15);
                GeckoSession previous = (GeckoSession)t.field("session");
                List<Integer> children = children(t); assertFalse(children.isEmpty());
                t.ui(() -> children.forEach(child -> Process.sendSignal(child, 19)));
                long start = SystemClock.elapsedRealtime();
                t.until("Heartbeat must replace frozen content", () -> t.field("session") != previous, 35);
                t.ready("idle");
                Log.i("OnceResilience", "frozen-idle run=" + run + " recoveryMs=" + (SystemClock.elapsedRealtime()-start));
            }
        } finally { t.close(); }
    }

    @Test public void networkThatNeverAnswersEndsInNativeRetryThenNewStoryWorks() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.open(fixture.url("/stall"));
            t.until("Repeated stall must end, not retry forever", () -> (boolean)t.field("recoveryFailed"), 75);
            t.ui(() -> assertEquals(View.VISIBLE, ((View)t.field("recoveryView")).getVisibility()));
            android.graphics.Bitmap retry = t.instrumentation.getUiAutomation().takeScreenshot();
            try (java.io.FileOutputStream output = new java.io.FileOutputStream(new java.io.File(t.activity.getExternalFilesDir(null), "native-retry.png"))) {
                retry.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
            }
            retry.recycle();
            assertEquals(0L, t.field("navigationDeadline"));
            fixture.stall = false;
            t.ui(() -> ((android.widget.LinearLayout)t.field("recoveryView")).getChildAt(1).performClick());
            t.ready("stall");
            t.navigate(fixture.url("/after-stall")); t.ready("after-stall");
            Log.i("OnceResilience", "network-stall native retry and next story passed");
        } finally { t.close(); }
    }

    @Test public void hiddenMemoryHeavyPagesReleaseAndResumeRepeatedly() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            for (int run = 0; run < 3; run++) {
                t.open(fixture.url("/memory")); t.ready("memory");
                t.ui(() -> {
                    t.plugin.handleOnStop();
                    t.plugin.trimMemory(ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW);
                    assertNull("Hidden renderer session must be released", t.field("session"));
                    t.plugin.handleOnResume();
                });
                t.ready("memory");
                Log.i("OnceResilience", "memory-release-resume run=" + run);
            }
        } finally { t.close(); }
    }

    @Test public void realInfiniteScriptCanBeLeftForAnotherStory() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.open(fixture.url("/spin")); Thread.sleep(2000);
            long start = SystemClock.elapsedRealtime();
            t.navigate(fixture.url("/after-spin")); t.ready("after-spin");
            Log.i("OnceResilience", "script-loop recoveryMs=" + (SystemClock.elapsedRealtime()-start));
        } finally { t.close(); }
    }

    @Test public void redirectsAndBackRemainUsable() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.open(fixture.url("/first")); t.ready("first");
            t.navigate(fixture.url("/redirect")); t.ready("redirected");
            t.until("History should become available", () -> (boolean)t.field("canGoBack"), 10);
            long start = SystemClock.elapsedRealtime();
            GeckoSession beforeBack = (GeckoSession)t.field("session");
            GeckoTestSupport.Call back = new GeckoTestSupport.Call(new com.getcapacitor.JSObject());
            t.ui(() -> t.plugin.goBack(back)); back.await(); t.ready("first");
            assertSame("Back must not need watchdog recovery", beforeBack, t.field("session"));
            assertTrue("Cached Back should be immediately usable", SystemClock.elapsedRealtime()-start < 5000);
            Log.i("OnceResilience", "redirect and back passed");
        } finally { t.close(); }
    }

    @Test public void extensionPageReattachesAfterLossAndHiddenPagesTrim() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        java.util.concurrent.atomic.AtomicReference<GeckoSession> extension = new java.util.concurrent.atomic.AtomicReference<>();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.open(fixture.url("/reader")); t.ready("reader");
            GeckoEngine engine = (GeckoEngine)t.field("engine");
            GeckoExtensionManager manager = (GeckoExtensionManager)t.field("extensions");
            t.ui(() -> {
                GeckoSession s = manager.pages.create("fixture", "Fixture", false, true); extension.set(s);
                manager.pages.setBounds(new com.getcapacitor.JSObject().put("x",0).put("y",100).put("width",320).put("height",500));
                s.open(engine.runtime); s.loadUri(fixture.url("/extension"));
            });
            t.until("Extension page must finish", () -> {
                Object page = ((java.util.Map<?,?>)GeckoTestSupport.field(manager.pages,"pages")).get(extension.get());
                return fixture.url("/extension").equals(GeckoTestSupport.field(page,"url")) && "".equals(GeckoTestSupport.field(page,"status"));
            }, 25);
            t.ui(() -> {
                GeckoSession s = extension.get(); s.close(); s.getContentDelegate().onKill(s);
                manager.pages.reloadVisible();
            });
            t.until("Extension reload must finish", () -> {
                Object page = ((java.util.Map<?,?>)GeckoTestSupport.field(manager.pages,"pages")).get(extension.get());
                return "".equals(GeckoTestSupport.field(page,"status"));
            }, 25);
            Object page = ((java.util.Map<?,?>)GeckoTestSupport.field(manager.pages,"pages")).get(extension.get());
            android.graphics.Bitmap pixels = fixturePixels(t, () -> (org.mozilla.geckoview.GeckoView)GeckoTestSupport.field(page,"view"));
            pixels.recycle();
            t.ui(() -> {
                manager.pages.create("fixture", "Hidden", false, false);
                manager.pages.trimHidden();
                assertEquals(1, ((java.util.Map<?,?>)GeckoTestSupport.field(manager.pages,"pages")).size());
                manager.pages.closeVisible();
            });
            Log.i("OnceResilience", "extension reattach and hidden trim passed");
        } finally { t.ui(() -> {
            GeckoExtensionManager manager = (GeckoExtensionManager)t.field("extensions");
            if (manager != null) manager.pages.closeOwner("fixture");
        }); t.close(); }
    }

    private List<Integer> children(GeckoTestSupport t) {
        List<Integer> ids = new ArrayList<>();
        String prefix = t.instrumentation.getTargetContext().getPackageName() + ":tab";
        ActivityManager manager = (ActivityManager)t.activity.getSystemService(Context.ACTIVITY_SERVICE);
        for (ActivityManager.RunningAppProcessInfo p : manager.getRunningAppProcesses())
            if (p.uid == Process.myUid() && p.processName.startsWith(prefix) && GeckoEngine.hasContentThread(p.pid)) ids.add(p.pid);
        return ids;
    }

    private void assertPaint(GeckoTestSupport t, String name) throws Exception {
        android.graphics.Bitmap pixels = fixturePixels(t, () -> (org.mozilla.geckoview.GeckoView)t.field("surface"));
        try (java.io.FileOutputStream output = new java.io.FileOutputStream(new java.io.File(t.activity.getExternalFilesDir(null), name + ".png"))) {
            pixels.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, output);
        }
        pixels.recycle();
    }

    private android.graphics.Bitmap fixturePixels(GeckoTestSupport t, java.util.function.Supplier<org.mozilla.geckoview.GeckoView> view) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + 10000;
        do {
            android.graphics.Bitmap pixels = t.result(() -> view.get().capturePixels());
            if (pixels.getPixel(pixels.getWidth()/2, pixels.getHeight()/2) == 0xff123456) return pixels;
            pixels.recycle(); Thread.sleep(100);
        } while (SystemClock.elapsedRealtime() < deadline);
        throw new AssertionError("Recovered compositor never displayed the fixture background");
    }
}
