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

    /** Capacitor delivers calls on its own thread while the shell switches tabs on the UI thread. */
    @Test public void callsFromThePluginThreadRouteToTheirTabWhileTabsChange() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        String previous = (String) GeckoTestSupport.field(t.plugin, "selectedTab");
        TabState before = tabs(t);
        String first = UUID.randomUUID().toString(), second = UUID.randomUUID().toString();
        String generation = UUID.randomUUID().toString();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            select(t, first);
            open(t, first, generation, fixture.url("/first"));
            open(t, second, generation, fixture.url("/second"));
            ready(t, first, generation, "first");
            ready(t, second, generation, "second");
            java.util.concurrent.atomic.AtomicBoolean running = new java.util.concurrent.atomic.AtomicBoolean(true);
            java.util.concurrent.atomic.AtomicReference<Throwable> churnFailure = new java.util.concurrent.atomic.AtomicReference<>();
            Thread churn = new Thread(() -> {
                try {
                    for (int i = 0; running.get(); i++) {
                        String extra = UUID.randomUUID().toString();
                        GeckoTestSupport.Call select = new GeckoTestSupport.Call(new JSObject().put("tabId", i % 2 == 0 ? first : second));
                        GeckoTestSupport.Call close = new GeckoTestSupport.Call(identity(extra, generation));
                        GeckoTestSupport.Call open = new GeckoTestSupport.Call(identity(extra, generation).put("url", fixture.url("/third")).put("visible", false));
                        t.ui(() -> { t.plugin.selectTab(select); t.plugin.open(open); t.plugin.close(close); });
                        select.await(); close.await();
                        // The open raced a close of the same identity; it may settle either way.
                        assertTrue(open.done.await(40, java.util.concurrent.TimeUnit.SECONDS));
                    }
                } catch (Throwable error) { churnFailure.set(error); }
            }, "tab-churn");
            churn.start();
            try {
                for (int i = 0; i < 20; i++) {
                    String id = i % 2 == 0 ? first : second;
                    // Deliberately not t.ui(): the plugin itself must hop to the UI thread.
                    GeckoTestSupport.Call bounds = new GeckoTestSupport.Call(identity(id, generation)
                        .put("x", 0).put("y", 100).put("width", 320).put("height", 500));
                    t.plugin.setBounds(bounds);
                    GeckoTestSupport.Call hide = new GeckoTestSupport.Call(identity(id, generation).put("visible", false));
                    t.plugin.setVisible(hide);
                    GeckoTestSupport.Call script = new GeckoTestSupport.Call(identity(id, generation)
                        .put("script", "document.querySelector('#ready').textContent"));
                    t.plugin.evaluateJavaScript(script);
                    bounds.await(); hide.await(); script.await();
                    assertEquals("\"" + (id.equals(first) ? "first" : "second") + "\"", script.value.getString("value"));
                }
            } finally { running.set(false); churn.join(60000); }
            if (churnFailure.get() != null) throw new AssertionError(churnFailure.get());
            select(t, second);
            GeckoTestSupport.Call unscoped = new GeckoTestSupport.Call(new JSObject().put("script", "document.querySelector('#ready').textContent"));
            t.plugin.evaluateJavaScript(unscoped); unscoped.await();
            assertEquals("Unscoped calls follow the selected tab", "\"second\"", unscoped.value.getString("value"));
            java.util.Set<Object> remaining = tabs(t).ids;
            remaining.removeAll(before.ids);
            assertEquals("Closed transient tabs leave no runtime behind", new java.util.HashSet<>(java.util.Arrays.asList(first, second)), remaining);
        } finally {
            close(t, first, generation);
            close(t, second, generation);
            select(t, previous);
        }
    }

    @Test public void callsForUnknownTabsCreateNothing() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        TabState before = tabs(t);
        String unknown = UUID.randomUUID().toString(), generation = UUID.randomUUID().toString();
        for (String method : new String[] { "close", "clearFind", "setVisible", "setBounds", "capturePreview" }) {
            GeckoTestSupport.Call call = new GeckoTestSupport.Call(identity(unknown, generation));
            t.plugin.getClass().getMethod(method, com.getcapacitor.PluginCall.class).invoke(t.plugin, call);
            call.await();
            assertNull(method + " on an unknown tab has no result", call.value);
        }
        GeckoTestSupport.Call script = new GeckoTestSupport.Call(identity(unknown, generation).put("script", "1"));
        t.plugin.evaluateJavaScript(script);
        assertTrue(script.done.await(5, java.util.concurrent.TimeUnit.SECONDS));
        assertEquals("No such tab", script.error);
        TabState after = tabs(t);
        assertFalse("No runtime is created for an unknown tab", after.ids.contains(unknown));
        assertEquals(before.ids, after.ids);
        assertFalse("Nothing was opened, so nothing is retired", after.retired.stream().anyMatch(key -> key.startsWith(unknown)));
    }

    /** Every tab reports audible playback, even with background playback off, and never ends at a stale true. */
    @Test public void tabsReportMediaPlaybackChanges() throws Exception {
        GeckoTestSupport t = new GeckoTestSupport(); t.start();
        String previous = (String) GeckoTestSupport.field(t.plugin, "selectedTab");
        String id = UUID.randomUUID().toString(), generation = UUID.randomUUID().toString();
        java.util.concurrent.LinkedBlockingQueue<Boolean> events = new java.util.concurrent.LinkedBlockingQueue<>();
        // Observed without the background-playback opt-in, which this restores.
        java.util.concurrent.atomic.AtomicReference<Boolean> backgroundPlayback = new java.util.concurrent.atomic.AtomicReference<>();
        try (GeckoTestSupport.Fixture fixture = new GeckoTestSupport.Fixture()) {
            select(t, id);
            open(t, id, generation, fixture.url("/media"));
            // Test-only autoplay grant; Gecko consults it as the document loads, so it must precede readiness.
            t.ui(() -> {
                ReadingSurfaceHost tab = (ReadingSurfaceHost) ((Map<?, ?>) GeckoTestSupport.field(t.plugin, "tabs")).get(id);
                ((org.mozilla.geckoview.GeckoSession) GeckoTestSupport.field(tab, "session")).setPermissionDelegate(new org.mozilla.geckoview.GeckoSession.PermissionDelegate() {
                    @Override public org.mozilla.geckoview.GeckoResult<Integer> onContentPermissionRequest(org.mozilla.geckoview.GeckoSession session, ContentPermission permission) {
                        return org.mozilla.geckoview.GeckoResult.fromValue(ContentPermission.VALUE_ALLOW);
                    }
                });
            });
            GeckoTestSupport.Call show = new GeckoTestSupport.Call(identity(id, generation).put("visible", true));
            t.ui(() -> t.plugin.setVisible(show)); show.await();
            ready(t, id, generation, "media");
            t.ui(() -> {
                ReadingSurfaceHost tab = (ReadingSurfaceHost) ((Map<?, ?>) GeckoTestSupport.field(t.plugin, "tabs")).get(id);
                BackgroundMedia media = tab.backgroundMedia;
                backgroundPlayback.set(media.isEnabled());
                media.setEnabled(false);
                java.util.function.Consumer<Boolean> emit = media.playingChanged;
                media.playingChanged = playing -> { events.add(playing); emit.accept(playing); };
            });
            // A generated 440 Hz tone: audible media without fixtures on disk. Gecko never
            // activated a media session for a 10 s looping clip; a minute-long one is controllable.
            evaluate(t, id, generation, "(() => { const rate = 8000, n = rate * 60, view = new DataView(new ArrayBuffer(44 + n * 2));"
                + "const text = (at, s) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));"
                + "text(0, 'RIFF'); view.setUint32(4, 36 + n * 2, true); text(8, 'WAVEfmt '); view.setUint32(16, 16, true);"
                + "view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);"
                + "view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, n * 2, true);"
                + "for (let i = 0; i < n; i++) view.setInt16(44 + i * 2, Math.sin(i * 2 * Math.PI * 440 / rate) * 8000, true);"
                + "const audio = document.createElement('audio'); audio.id = 'media'; audio.loop = true;"
                + "audio.src = URL.createObjectURL(new Blob([view], {type: 'audio/wav'})); document.body.append(audio);"
                + "audio.play(); return true; })()");
            assertEquals("Play reports playing", Boolean.TRUE, events.poll(15, java.util.concurrent.TimeUnit.SECONDS));
            evaluate(t, id, generation, "document.querySelector('#media').pause(); true");
            assertEquals("Pause reports stopped", Boolean.FALSE, events.poll(10, java.util.concurrent.TimeUnit.SECONDS));
            evaluate(t, id, generation, "document.querySelector('#media').play(); true");
            assertEquals(Boolean.TRUE, events.poll(15, java.util.concurrent.TimeUnit.SECONDS));
            close(t, id, generation);
            assertEquals("Closing a playing tab reports stopped", Boolean.FALSE, events.poll(5, java.util.concurrent.TimeUnit.SECONDS));
            assertNull("Changes are reported once", events.poll(1, java.util.concurrent.TimeUnit.SECONDS));
        } finally {
            if (((Map<?, ?>) GeckoTestSupport.field(t.plugin, "tabs")).containsKey(id)) close(t, id, generation);
            if (backgroundPlayback.get() != null) new BackgroundMedia(t.plugin.getContext()).setEnabled(backgroundPlayback.get());
            select(t, previous);
        }
    }

    private static final class TabState { java.util.Set<Object> ids; java.util.Set<String> retired; }
    @SuppressWarnings("unchecked")
    private TabState tabs(GeckoTestSupport t) {
        TabState result = new TabState();
        t.ui(() -> {
            Map<Object, ?> tabs = (Map<Object, ?>) GeckoTestSupport.field(t.plugin, "tabs");
            result.ids = new java.util.HashSet<>(tabs.keySet());
            result.retired = new java.util.HashSet<>((java.util.Set<String>) GeckoTestSupport.field(t.plugin, "retiredTabs"));
        });
        return result;
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
