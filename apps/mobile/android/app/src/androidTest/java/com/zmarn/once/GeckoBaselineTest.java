package com.zmarn.once;

import android.os.SystemClock;
import android.util.Log;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.List;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mozilla.geckoview.*;
import static org.junit.Assert.*;

/** Same local document, device, runtime version and repetitions. External sites are observations only. */
@RunWith(AndroidJUnit4.class)
public class GeckoBaselineTest {
    @Test public void compareConfigurations() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        GeckoEngine engine = t.engine();
        List<WebExtension> installed = t.result(engine::ready);
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            for (String mode : new String[]{"gecko-bare", "bridge", "ublock", "full"}) {
                for (WebExtension extension : installed) {
                    boolean enabled = !mode.equals("gecko-bare") && (extension.id.equals(GeckoEngine.BRIDGE_ID)
                        || mode.equals("full") || mode.equals("ublock") && extension.id.equals("uBlock0@raymondhill.net"));
                    t.result(() -> enabled ? engine.runtime.getWebExtensionController().enable(extension, WebExtensionController.EnableSource.USER)
                        : engine.runtime.getWebExtensionController().disable(extension, WebExtensionController.EnableSource.USER));
                }
                for (int run = 0; run < 5; run++) {
                    long start = SystemClock.elapsedRealtime();
                    if (mode.equals("gecko-bare")) bare(t, engine, fixture.url("/baseline"));
                    else { t.open(fixture.url("/baseline")); t.ready("baseline"); t.close(); }
                    Log.i("OnceBaseline", mode + " run=" + run + " usableMs=" + (SystemClock.elapsedRealtime() - start));
                }
            }
            for (int run = 0; run < 5; run++) {
                long start = SystemClock.elapsedRealtime();
                CountDownLatch loaded = new CountDownLatch(1);
                AtomicReference<WebView> view = new AtomicReference<>();
                t.ui(() -> {
                    WebView web = new WebView(t.activity); view.set(web);
                    web.getSettings().setJavaScriptEnabled(true);
                    t.activity.addContentView(web, new android.view.ViewGroup.LayoutParams(320,500));
                    web.setWebViewClient(new WebViewClient() {
                        @Override public void onPageFinished(WebView v, String url) {
                            v.evaluateJavascript("document.querySelector('#ready')?.textContent", value -> { if ("\"baseline\"".equals(value)) loaded.countDown(); });
                        }
                    }); web.loadUrl(fixture.url("/baseline"));
                });
                assertTrue(loaded.await(30, TimeUnit.SECONDS));
                Log.i("OnceBaseline", "webview run=" + run + " usableMs=" + (SystemClock.elapsedRealtime() - start));
                t.ui(() -> { ((android.view.ViewGroup)view.get().getParent()).removeView(view.get()); view.get().destroy(); });
            }
        } finally {
            for (WebExtension extension : installed) t.result(() -> engine.runtime.getWebExtensionController().enable(extension, WebExtensionController.EnableSource.USER));
        }
    }
    private void bare(GeckoTestSupport t, GeckoEngine engine, String url) throws Exception {
        CountDownLatch painted = new CountDownLatch(1);
        AtomicReference<GeckoSession> session = new AtomicReference<>();
        AtomicReference<GeckoView> view = new AtomicReference<>();
        t.ui(() -> {
            GeckoSession s = new GeckoSession(); session.set(s);
            s.setContentDelegate(new GeckoSession.ContentDelegate() { @Override public void onFirstContentfulPaint(GeckoSession source) { painted.countDown(); } });
            s.open(engine.runtime); GeckoView v = new GeckoView(t.activity); view.set(v); v.setSession(s);
            t.activity.addContentView(v, new android.view.ViewGroup.LayoutParams(320,500));
            s.setActive(true); s.loadUri(url);
        });
        assertTrue("Bare Gecko must paint", painted.await(30, TimeUnit.SECONDS));
        t.ui(() -> { view.get().releaseSession(); session.get().close(); ((android.view.ViewGroup)view.get().getParent()).removeView(view.get()); });
    }
}
