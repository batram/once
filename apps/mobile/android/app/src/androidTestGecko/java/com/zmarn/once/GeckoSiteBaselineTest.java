package com.zmarn.once;

import android.os.SystemClock;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.List;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mozilla.geckoview.*;

/** Live site observations: failures are reported separately from deterministic fixture assertions. */
@RunWith(AndroidJUnit4.class)
public class GeckoSiteBaselineTest {
    @Test public void publicSiteJourneysWithBridgeAndFullExtensions() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start(); t.close();
        GeckoEngine engine = t.engine();
        List<WebExtension> installed = t.result(engine::ready);
        try {
            String selected = androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("mode", "both");
            for (String mode : selected.equals("both") ? new String[]{"bridge", "full"} : new String[]{selected}) {
                for (WebExtension extension : installed) {
                    boolean enabled = mode.equals("full") || extension.id.equals(GeckoEngine.BRIDGE_ID);
                    t.result(() -> enabled ? engine.runtime.getWebExtensionController().enable(extension, WebExtensionController.EnableSource.USER)
                        : engine.runtime.getWebExtensionController().disable(extension, WebExtensionController.EnableSource.USER));
                }
                for (String url : new String[]{"https://www.linkedin.com/authwall", "https://batr.am/", "https://hackerone.com/batram", "https://github.com/"}) {
                    long start = SystemClock.elapsedRealtime();
                    try {
                        t.open(url);
                        t.until("Site did not become script-usable and paint", () -> t.field("bridgePort") != null && (boolean)t.field("painted"), 25);
                        String snapshot = t.evaluate("JSON.stringify({url:location.href,readyState:document.readyState,title:document.title,text:document.body?.innerText.length})");
                        Log.i("OnceSiteBaseline", mode + " requested=" + url + " usableMs=" + (SystemClock.elapsedRealtime()-start) + " " + snapshot);
                    } catch (AssertionError failure) {
                        Log.w("OnceSiteBaseline", mode + " requested=" + url + " FAILED afterMs=" + (SystemClock.elapsedRealtime()-start) + " " + failure.getMessage());
                    }
                    // Keep the session for the next destination: this exercises leaving
                    // a site, rather than hiding navigation failures by closing it first.
                }
                t.close();
            }
        } finally {
            t.close();
            for (WebExtension extension : installed) t.result(() -> engine.runtime.getWebExtensionController().enable(extension, WebExtensionController.EnableSource.USER));
        }
    }
}
