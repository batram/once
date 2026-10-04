package com.zmarn.once;

import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import java.util.Map;
import java.util.UUID;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;

/** Real-engine coverage: switching must retain documents and independent histories. */
@RunWith(AndroidJUnit4.class)
public class GeckoTabsTest {
    @Test public void retainedTabsKeepDocumentsHistoryAndRejectClosedGenerations() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        String previous = (String) GeckoTestSupport.field(t.plugin, "selectedTab");
        String first = UUID.randomUUID().toString(), second = UUID.randomUUID().toString();
        String generation = UUID.randomUUID().toString();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            select(t, first);
            open(t, first, generation, fixture.url("/first"));
            ready(t, first, generation, "first");
            evaluate(t, first, generation, "window.retainedMarker = 123");
            // A second page starts hidden and finishes without changing selection.
            open(t, second, generation, fixture.url("/second"));
            ready(t, second, generation, "second");
            assertEquals(first, GeckoTestSupport.field(t.plugin, "selectedTab"));
            select(t, second);
            GeckoTestSupport.Call navigate = new GeckoTestSupport.Call(identity(second, generation).put("url", fixture.url("/second-next")));
            t.ui(() -> t.plugin.navigate(navigate)); navigate.await();
            ready(t, second, generation, "second-next");
            select(t, first);
            assertEquals("123", evaluate(t, first, generation, "window.retainedMarker"));
            assertEquals("\"first\"", evaluate(t, first, generation, "document.querySelector('#ready').textContent"));
            Map<?, ?> tabs = (Map<?, ?>) GeckoTestSupport.field(t.plugin, "tabs");
            assertNotSame(GeckoTestSupport.field(tabs.get(first), "session"), GeckoTestSupport.field(tabs.get(second), "session"));
            assertEquals(false, GeckoTestSupport.field(tabs.get(first), "canGoBack"));
            assertEquals(true, GeckoTestSupport.field(tabs.get(second), "canGoBack"));
            close(t, second, generation);
            GeckoTestSupport.Call stale = new GeckoTestSupport.Call(identity(second, generation).put("url", fixture.url("/stale")));
            t.ui(() -> t.plugin.navigate(stale));
            assertTrue(stale.done.await(5, java.util.concurrent.TimeUnit.SECONDS));
            assertNotNull("Closed runtimes reject late commands", stale.error);
        } finally {
            close(t, first, generation);
            if (((Map<?, ?>)GeckoTestSupport.field(t.plugin, "tabs")).containsKey(second)) close(t, second, generation);
            select(t, previous);
        }
    }

    private JSObject identity(String id, String generation) { return new JSObject().put("tabId", id).put("generation", generation); }
    private void select(GeckoTestSupport t, String id) throws Exception {
        GeckoTestSupport.Call call = new GeckoTestSupport.Call(new JSObject().put("tabId", id));
        t.ui(() -> t.plugin.selectTab(call)); call.await();
    }
    private void open(GeckoTestSupport t, String id, String generation, String url) throws Exception {
        GeckoTestSupport.Call call = new GeckoTestSupport.Call(identity(id, generation).put("url", url).put("visible", false)
            .put("bounds", new JSObject().put("x", 0).put("y", 100).put("width", 320).put("height", 500)));
        t.ui(() -> t.plugin.open(call)); call.await();
    }
    private String evaluate(GeckoTestSupport t, String id, String generation, String script) throws Exception {
        GeckoTestSupport.Call call = new GeckoTestSupport.Call(identity(id, generation).put("script", script));
        t.ui(() -> t.plugin.evaluateJavaScript(call)); call.await();
        return call.value.getString("value");
    }
    private void ready(GeckoTestSupport t, String id, String generation, String marker) throws Exception {
        long deadline = System.currentTimeMillis() + 35000;
        while (System.currentTimeMillis() < deadline) {
            try { if (("\"" + marker + "\"").equals(evaluate(t, id, generation, "document.querySelector('#ready')?.textContent"))) return; }
            catch (AssertionError ignored) { }
            Thread.sleep(100);
        }
        fail("Tab did not finish: " + marker);
    }
    private void close(GeckoTestSupport t, String id, String generation) throws Exception {
        GeckoTestSupport.Call call = new GeckoTestSupport.Call(identity(id, generation));
        t.ui(() -> t.plugin.close(call)); call.await();
    }
}
