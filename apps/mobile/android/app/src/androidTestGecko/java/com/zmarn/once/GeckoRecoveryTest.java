package com.zmarn.once;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mozilla.geckoview.GeckoSession;

/** Real engine and content bridge; closed-session callbacks simulate Android process loss. */
@RunWith(AndroidJUnit4.class)
public class GeckoRecoveryTest {
    private final GeckoTestSupport t = new GeckoTestSupport();

    @After public void stop() throws Exception { t.stop(); }

    @Test public void firstPageAndRepeatedProcessLossRecoverWithContentBridge() throws Exception {
        t.start();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            t.open(fixture.url("/recovered"));
            t.ready("recovered");
            for (int cycle = 0; cycle < 3; cycle++) {
                final boolean crash = cycle % 2 == 0;
                t.ui(() -> {
                    GeckoSession session = (GeckoSession) t.field("session");
                    session.close();
                    if (crash) session.getContentDelegate().onCrash(session);
                    else session.getContentDelegate().onKill(session);
                });
                GeckoTestSupport.Call reload = new GeckoTestSupport.Call(new JSObject());
                t.ui(() -> t.plugin.reload(reload));
                reload.await();
                // The recovered document must receive the bridge content script again.
                t.ready("recovered");
            }
        }
    }
}
