package com.zmarn.once;

import android.app.Instrumentation;
import android.content.Intent;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Field;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.mozilla.geckoview.GeckoSession;
import static org.junit.Assert.*;

/** Real engine and content bridge; closed-session callbacks simulate Android process loss. */
@RunWith(AndroidJUnit4.class)
public class GeckoRecoveryTest {
    private final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();

    @Test public void firstPageAndRepeatedProcessLossRecoverWithContentBridge() throws Exception {
        assertTrue("This test must use the isolated Once Dev app", instrumentation.getTargetContext().getPackageName().endsWith(".dev"));
        Intent launch = new Intent(instrumentation.getTargetContext(), MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        MainActivity activity = (MainActivity) instrumentation.startActivitySync(launch);
        InAppBrowserSurfacePlugin plugin = (InAppBrowserSurfacePlugin) activity.getBridge().getPlugin("InAppBrowserSurface").getInstance();
        try (ServerSocket fixture = new ServerSocket(0)) {
            Thread server = new Thread(() -> {
                while (!fixture.isClosed()) {
                    try (Socket socket = fixture.accept()) {
                        java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(socket.getInputStream()));
                        String line;
                        while ((line = reader.readLine()) != null && !line.isEmpty()) {}
                        byte[] body = "<!doctype html><html><head><title>Once Gecko recovery fixture</title></head><body><p id='ready'>recovered</p></body></html>".getBytes(StandardCharsets.UTF_8);
                        socket.getOutputStream().write(("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: " + body.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                        socket.getOutputStream().write(body);
                    } catch (Exception error) { if (!fixture.isClosed()) throw new RuntimeException(error); }
                }
            }, "gecko-test-http");
            server.start();
            Call close = new Call(new JSObject());
            instrumentation.runOnMainSync(() -> plugin.close(close));
            close.await();
            JSObject options = new JSObject().put("url", "http://127.0.0.1:" + fixture.getLocalPort() + "/")
                .put("visible", true).put("bounds", new JSObject().put("x", 0).put("y", 100).put("width", 300).put("height", 400));
            Call open = new Call(options);
            instrumentation.runOnMainSync(() -> plugin.open(open));
            open.await();
            assertBridge(plugin);
            for (int cycle = 0; cycle < 3; cycle++) {
                final boolean crash = cycle % 2 == 0;
                instrumentation.runOnMainSync(() -> {
                    GeckoSession session = (GeckoSession) field(plugin, "session");
                    session.close();
                    if (crash) session.getContentDelegate().onCrash(session);
                    else session.getContentDelegate().onKill(session);
                });
                Call reload = new Call(new JSObject());
                instrumentation.runOnMainSync(() -> plugin.reload(reload));
                reload.await();
                assertBridge(plugin);
            }
            Call finalClose = new Call(new JSObject());
            instrumentation.runOnMainSync(() -> plugin.close(finalClose));
            finalClose.await();
        }
    }

    private void assertBridge(InAppBrowserSurfacePlugin plugin) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25);
        AtomicReference<Object> port = new AtomicReference<>();
        do {
            instrumentation.runOnMainSync(() -> port.set(field(plugin, "bridgePort")));
            if (port.get() != null) break;
            Thread.sleep(100);
        } while (System.nanoTime() < deadline);
        assertNotNull("The first recovered document must receive the bridge content script", port.get());
        String value = null;
        do {
            Call evaluate = new Call(new JSObject().put("script", "document.querySelector('#ready')?.textContent"));
            instrumentation.runOnMainSync(() -> plugin.evaluateJavaScript(evaluate));
            evaluate.await();
            value = evaluate.value.getString("value");
            if ("\"recovered\"".equals(value)) break;
            Thread.sleep(100);
        } while (System.nanoTime() < deadline);
        assertEquals("\"recovered\"", value);
    }

    private static Object field(Object owner, String name) {
        try {
            Field field = owner.getClass().getDeclaredField(name);
            field.setAccessible(true);
            return field.get(owner);
        } catch (Exception error) { throw new AssertionError(error); }
    }

    private static final class Call extends PluginCall {
        final CountDownLatch done = new CountDownLatch(1);
        volatile JSObject value;
        volatile String error;
        Call(JSObject data) { super(null, "InAppBrowserSurface", "test", "test", data); }
        @Override public void resolve() { done.countDown(); }
        @Override public void resolve(JSObject result) { value = result; done.countDown(); }
        @Override public void reject(String message) { error = message; done.countDown(); }
        @Override public void reject(String message, Exception cause) { error = message + ": " + cause; done.countDown(); }
        void await() throws InterruptedException {
            assertTrue("Native call must settle", done.await(35, TimeUnit.SECONDS));
            assertNull(error, error);
        }
    }
}
