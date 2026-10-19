package com.zmarn.once;

import android.os.SystemClock;
import android.util.Log;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Run in a fresh instrumentation process to separate engine startup from warm navigation. */
@RunWith(AndroidJUnit4.class)
public class GeckoStartupTest {
    @Test public void firstPageAndWarmSwitches() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        GeckoTestSupport.Call settings = new GeckoTestSupport.Call(new com.getcapacitor.JSObject()
            .put("filterLists", new com.getcapacitor.JSObject().put("lists", new org.json.JSONArray()))
            .put("userscripts", new com.getcapacitor.JSObject().put("scripts", new org.json.JSONArray())));
        t.ui(() -> t.plugin.applyExtensionSettings(settings)); settings.await();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            for (int run = 0; run < 4; run++) {
                long start = SystemClock.elapsedRealtime();
                if (run == 0) t.open(fixture.url("/startup-" + run));
                else t.navigate(fixture.url("/startup-" + run));
                long accepted = SystemClock.elapsedRealtime();
                if (run == 0) t.ui(() -> assertEquals("The first requested URL must wait for applied settings, not their timeout",
                    t.field("settingsRevision"), t.field("appliedSettingsRevision")));
                t.ready("startup-" + run);
                long bridgeReady = SystemClock.elapsedRealtime();
                t.until("Navigation must paint and complete", () -> (boolean)t.field("painted")
                    && (boolean)t.field("navigationCompleted"), 15);
                Log.i("OnceStartup", "run=" + run + " acceptedMs=" + (accepted-start)
                    + " bridgeMs=" + (bridgeReady-start) + " readyMs=" + (SystemClock.elapsedRealtime()-start));
            }
        }
    }

    @Test public void paintResetInvalidatesOldReadiness() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.open(fixture.url("/paint-reset")); t.ready("paint-reset");
            t.until("Initial page paints", () -> (boolean)t.field("painted"), 15);
            t.ui(() -> {
                t.plugin.session.getContentDelegate().onPaintStatusReset(t.plugin.session);
                assertFalse("Previously painted content is no longer displayed", t.plugin.painted);
                assertFalse("A fresh paint must be able to clear a later blank-page warning", t.plugin.navigationCompleted);
            });
        }
    }
}
