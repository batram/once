package com.zmarn.once;

import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mozilla.geckoview.*;
import static org.junit.Assert.*;

/** Opt-in graphics diagnosis: bare engine/view lifecycle, without Once surface recovery. */
@RunWith(AndroidJUnit4.class)
public class GeckoGraphicsProbeTest {
    @Test public void bareViewCreationAndRelease() throws Exception {
        org.junit.Assume.assumeTrue("Opt-in network/graphics diagnosis",
            "true".equals(InstrumentationRegistry.getArguments().getString("graphicsProbe")));
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        String mode = InstrumentationRegistry.getArguments().getString("mode", "gecko");
        String url = InstrumentationRegistry.getArguments().getString("url", "https://github.com/");
        GeckoEngine engine = mode.equals("gecko") ? t.engine() : null;
        if (engine != null) {
            for (WebExtension extension : t.result(() -> engine.runtime.getWebExtensionController().list()))
                t.result(() -> engine.runtime.getWebExtensionController().disable(extension, WebExtensionController.EnableSource.USER));
        }
        for (int run = 0; run < 3; run++) {
            CountDownLatch painted = new CountDownLatch(1);
            AtomicReference<Runnable> release = new AtomicReference<>();
            int cycle = run;
            ui(() -> {
                if (engine != null) {
                    GeckoSession session = new GeckoSession();
                    session.setContentDelegate(new GeckoSession.ContentDelegate() {
                        @Override public void onFirstContentfulPaint(GeckoSession s) { painted.countDown(); }
                    });
                    session.open(engine.runtime);
                    GeckoView view = new GeckoView(t.activity); view.setSession(session);
                    t.activity.addContentView(view, new ViewGroup.LayoutParams(960, 1500));
                    session.setActive(true);
                    release.set(() -> { view.releaseSession(); session.close(); ((ViewGroup)view.getParent()).removeView(view); });
                    session.loadUri(url);
                } else {
                    WebView view = new WebView(t.activity); view.getSettings().setJavaScriptEnabled(true);
                    view.setWebViewClient(new WebViewClient() {
                        @Override public void onPageCommitVisible(WebView v, String address) { painted.countDown(); }
                    });
                    t.activity.addContentView(view, new ViewGroup.LayoutParams(960, 1500));
                    release.set(() -> { ((ViewGroup)view.getParent()).removeView(view); view.destroy(); });
                    view.loadUrl(url);
                }
                Log.i("OnceGraphicsProbe", mode + " opened cycle=" + cycle);
            });
            assertTrue("Document must paint", painted.await(30, TimeUnit.SECONDS));
            Thread.sleep(3000);
            long started = SystemClock.elapsedRealtime();
            Log.i("OnceGraphicsProbe", mode + " releasing cycle=" + cycle);
            ui(release.get());
            Log.i("OnceGraphicsProbe", mode + " released cycle=" + cycle + " releaseMs=" + (SystemClock.elapsedRealtime()-started));
            Thread.sleep(3000);
            ui(() -> Log.i("OnceGraphicsProbe", "UI heartbeat cycle=" + cycle));
        }
    }

    private void ui(Runnable work) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<Throwable> error = new AtomicReference<>();
        new Handler(Looper.getMainLooper()).post(() -> {
            try { work.run(); } catch (Throwable failure) { error.set(failure); }
            finally { done.countDown(); }
        });
        assertTrue("Main thread operation exceeded 20 seconds", done.await(20, TimeUnit.SECONDS));
        if (error.get() != null) throw new AssertionError(error.get());
    }
}
