package com.zmarn.once;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import java.lang.reflect.Field;
import java.util.List;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mozilla.geckoview.GeckoResult;
import org.mozilla.geckoview.GeckoSession;
import org.mozilla.geckoview.WebExtension;
import static org.junit.Assert.*;

/** Real-engine tests with controlled catalog and filter barriers; only the dev identity is used. */
@RunWith(AndroidJUnit4.class)
public class GeckoParallelStartupTest {
    private GeckoTestSupport start() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        t.shellReady(); t.selectRoot();
        t.close();
        t.ui(() -> set(t.plugin, "navigationReady", false));
        return t;
    }

    @Test public void earlyBlankSessionKeepsCatalogFilterAndUserscriptBarriers() throws Exception {
        GeckoTestSupport t = start();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture(); HeldCatalog catalog = new HeldCatalog(t)) {
            GeckoTestSupport.Call settings = new GeckoTestSupport.Call(new JSObject()
                .put("filterLists", new JSObject().put("lists", new JSONArray().put(new JSObject().put("url", fixture.url("/held-filter")).put("enabled", true))))
                .put("userscripts", new JSObject().put("scripts", new JSONArray())));
            t.ui(() -> t.plugin.applyExtensionSettings(settings)); settings.await();
            GeckoTestSupport.Call open = openCall(fixture.url("/gated"));
            t.ui(() -> t.plugin.open(open));
            t.ui(() -> assertTrue("Blank session opens while catalog is still pending", t.plugin.session != null && t.plugin.session.isOpen()));
            t.ui(() -> assertNull("Blank startup must not display a reading surface", t.plugin.surface));
            t.ui(() -> {
                GeckoSession blank = t.plugin.session;
                t.plugin.trimMemory(android.content.ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL);
                assertSame("Memory pressure cannot discard a pending bootstrap", blank, t.plugin.session);
                assertFalse("Tab eviction must also keep the pending bootstrap", t.plugin.releaseHiddenSession());
            });
            assertFalse(open.done.await(250, TimeUnit.MILLISECONDS));
            assertFalse(fixture.requests.contains("/gated"));
            catalog.release();
            assertTrue("Background starts and fetches its held filter", fixture.filterRequested.await(10, TimeUnit.SECONDS));
            assertFalse(open.done.await(250, TimeUnit.MILLISECONDS));
            assertFalse("Requested URL cannot escape the settings barrier", fixture.requests.contains("/gated"));
            fixture.releaseFilter.countDown();
            open.await();
            t.ui(() -> {
                Object sync = t.field("settings");
                assertEquals(GeckoTestSupport.field(sync, "settingsRevision"), GeckoTestSupport.field(sync, "appliedSettingsRevision"));
                assertTrue("Userscripts must settle before accepting the page", !(boolean)staticField(ViolentmonkeyRelayPlugin.class, "expected")
                    || (boolean)staticField(ViolentmonkeyRelayPlugin.class, "settled"));
            });
            t.ready("gated");
            t.ui(() -> {
                t.plugin.setSurfaceVisible(false);
                assertTrue("Completed hidden pages remain reclaimable", t.plugin.releaseHiddenSession());
                assertNull(t.plugin.session);
            });
        } finally { t.close(); }
    }

    @Test public void closeAndSupersedeCannotNavigateAnEarlySession() throws Exception {
        GeckoTestSupport t = start();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            try (HeldCatalog catalog = new HeldCatalog(t)) {
                GeckoTestSupport.Call cancelled = openCall(fixture.url("/cancelled"));
                t.ui(() -> t.plugin.open(cancelled));
                GeckoSession early = t.plugin.session;
                assertNotNull(early);
                t.close();
                assertTrue(cancelled.done.await(5, TimeUnit.SECONDS));
                assertNotNull(cancelled.error);
                catalog.release();
                t.ui(() -> { assertNull(t.plugin.session); assertFalse(early.isOpen()); });
                assertFalse(fixture.requests.contains("/cancelled"));
            }
            try (HeldCatalog catalog = new HeldCatalog(t)) {
                GeckoTestSupport.Call old = openCall(fixture.url("/superseded"));
                GeckoTestSupport.Call latest = openCall(fixture.url("/latest"));
                t.ui(() -> { t.plugin.open(old); t.plugin.open(latest); });
                old.await();
                assertFalse(latest.done.await(250, TimeUnit.MILLISECONDS));
                catalog.release();
                latest.await(); t.ready("latest");
                assertFalse(fixture.requests.contains("/superseded"));
                assertTrue(fixture.requests.contains("/latest"));
            }
        } finally { t.close(); }
    }

    @Test public void catalogFailureDoesNotNavigateAndRetryReusesTheBlankSession() throws Exception {
        GeckoTestSupport t = start();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture(); HeldCatalog catalog = new HeldCatalog(t)) {
            GeckoTestSupport.Call failed = openCall(fixture.url("/failed"));
            t.ui(() -> t.plugin.open(failed));
            GeckoSession blank = t.plugin.session;
            t.ui(() -> catalog.held.completeExceptionally(new IllegalStateException("test catalog failure")));
            assertTrue(failed.done.await(5, TimeUnit.SECONDS));
            assertNotNull(failed.error);
            assertFalse(fixture.requests.contains("/failed"));
            catalog.restore();
            t.open(fixture.url("/retried")); t.ready("retried");
            t.ui(() -> assertSame("Retry does not allocate another session", blank, t.plugin.session));
        } finally { t.close(); }
    }

    @Test public void aClosedBootstrapIsReplacedBeforeNavigation() throws Exception {
        GeckoTestSupport t = start();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture(); HeldCatalog catalog = new HeldCatalog(t)) {
            GeckoTestSupport.Call open = openCall(fixture.url("/replacement"));
            t.ui(() -> t.plugin.open(open));
            GeckoSession closed = t.plugin.session;
            t.ui(() -> { closed.getContentDelegate().onKill(closed); closed.close(); });
            assertFalse(open.done.await(250, TimeUnit.MILLISECONDS));
            catalog.release();
            open.await(); t.ready("replacement");
            t.ui(() -> { assertNotSame(closed, t.plugin.session); assertTrue(t.plugin.session.isOpen()); assertFalse(t.plugin.killedWhileHidden); });
        } finally { t.close(); }
    }

    private static GeckoTestSupport.Call openCall(String url) {
        return new GeckoTestSupport.Call(new JSObject().put("url", url).put("visible", true)
            .put("bounds", new JSObject().put("x", 0).put("y", 100).put("width", 320).put("height", 500)));
    }

    /** Substitute a pending catalog; release runs the real catalog path on the real engine. */
    private static final class HeldCatalog implements AutoCloseable {
        final GeckoTestSupport t;
        final GeckoEngine engine;
        final Object previous;
        final boolean prepared;
        final GeckoResult<List<WebExtension>> held = new GeckoResult<>(new android.os.Handler(android.os.Looper.getMainLooper()));
        boolean released;
        HeldCatalog(GeckoTestSupport t) {
            this.t = t; engine = t.engine();
            previous = GeckoTestSupport.field(engine, "ready");
            prepared = (boolean)GeckoTestSupport.field(engine, "prepared");
            t.ui(() -> { set(engine, "prepared", false); set(engine, "ready", held); });
        }
        void release() throws Exception {
            if (released) return;
            restore();
            List<WebExtension> installed = t.result(engine::catalog);
            t.ui(() -> held.complete(installed));
        }
        void restore() {
            released = true;
            t.ui(() -> { set(engine, "ready", previous); set(engine, "prepared", prepared); });
        }
        @Override public void close() throws Exception { release(); }
    }
    private static Object staticField(Class<?> type, String name) {
        try { Field field = type.getDeclaredField(name); field.setAccessible(true); return field.get(null); }
        catch (Exception error) { throw new AssertionError(error); }
    }
    private static void set(Object target, String name, Object value) {
        try { Field field = target.getClass().getDeclaredField(name); field.setAccessible(true); field.set(target, value); }
        catch (Exception error) { throw new AssertionError(error); }
    }
}
